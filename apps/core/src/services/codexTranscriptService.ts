import { buildAgentSessionSystemPromptText } from '@agent-collab/memory';
import type { AgentInfo, ConversationInfo, RuntimeDispatchMode } from '@agent-collab/protocol';
import { log } from '@agent-collab/runtime-acp';
import type { Db } from '@agent-collab/runtime-acp';
import type { CodexTranscriptBroker } from './codexTranscriptBroker.js';

const MAX_INLINE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

type CodexFunctionCall = {
  callId: string;
  name: string;
  arguments: string;
  timestamp: string;
  output?: string;
  outputTimestamp?: string;
};

type CodexTokenUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  modelContextWindow?: number;
};

export type CodexDebugTurn = {
  turnId: string;
  timestamp: string;
  cwd?: string;
  replyTarget?: string;
  triggerTarget?: string;
  inputBlocks: string[];
  combinedUserMessage?: string;
  functionCalls: CodexFunctionCall[];
  assistantOutputs: Array<{ text: string; phase?: string; timestamp: string }>;
  reasoningSummaries: string[];
  hasEncryptedReasoning: boolean;
  tokenUsage?: CodexTokenUsage;
  platformInput?: CodexPlatformInput;
};

export type CodexPlatformInput = {
  runId: string;
  startedAt: number;
  endedAt: number | null;
  stopReason?: string;
  error?: string;
  dispatchMode?: RuntimeDispatchMode;
  acpSessionId?: string;
  isFreshSession?: boolean;
  source: 'exact_snapshot' | 'reconstructed';
  systemPromptText?: string;
  contextText?: string;
  promptText: string;
  dispatchedPromptText?: string;
};

export type CodexDebugRollout = {
  path: string;
  modifiedAt: number;
  size: number;
  sessionId?: string;
  cwd?: string;
  baseInstructions?: string;
  preludeDeveloperMessages: string[];
  preludeUserMessages: string[];
  turns: CodexDebugTurn[];
};

export type CodexConversationDebugResult = {
  conversationId: string;
  agentType: string;
  workspacePath: string;
  replyTarget: string;
  acpSessionId?: string;
  matchMode: 'acp_session_id' | 'heuristic';
  sessionMatchMissed: boolean;
  truncated: boolean;
  rollouts: CodexDebugRollout[];
  unmatchedPlatformInputs: CodexPlatformInput[];
};

export class CodexTranscriptService {
  private readonly db: Db;
  private readonly broker: CodexTranscriptBroker;
  private readonly getConversationById: (conversationId: string) => ConversationInfo | null;
  private readonly getAgentById: (agentId: string) => AgentInfo | null;
  private readonly getAcpSessionIdByConversationId: (conversationId: string) => string | null;

  constructor(params: {
    db: Db;
    broker: CodexTranscriptBroker;
    getConversationById: (conversationId: string) => ConversationInfo | null;
    getAgentById: (agentId: string) => AgentInfo | null;
    getAcpSessionIdByConversationId?: (conversationId: string) => string | null;
  }) {
    this.db = params.db;
    this.broker = params.broker;
    this.getConversationById = params.getConversationById;
    this.getAgentById = params.getAgentById;
    this.getAcpSessionIdByConversationId = params.getAcpSessionIdByConversationId ?? (() => null);
  }

  async getConversationDebug(conversationId: string): Promise<CodexConversationDebugResult> {
    const conversation = this.getConversationById(conversationId);
    if (!conversation) throw new Error('Conversation not found.');
    if (conversation.agentType !== 'codex_acp') throw new Error('Codex debug is only supported for codex_acp conversations.');
    if (!conversation.nodeId) throw new Error('Conversation is not assigned to a remote node.');
    if (!conversation.workspacePath) throw new Error('Conversation has no workspace path.');
    const replyTarget = (conversation.replyTarget ?? '').trim();
    if (!replyTarget) throw new Error('Conversation has no reply target.');
    const acpSessionId = this.getAcpSessionIdByConversationId(conversationId)?.trim() || undefined;

    const listing = await this.broker.listFiles(conversation.nodeId);
    const exactSessionRollouts: CodexDebugRollout[] = [];
    const heuristicRollouts: CodexDebugRollout[] = [];

    for (const file of listing.files) {
      if (file.size > MAX_INLINE_TRANSCRIPT_BYTES) {
        continue;
      }
      let content: string;
      try {
        const result = await this.broker.readFile(conversation.nodeId, file.path);
        content = result.content;
      } catch (error) {
        log.warn('[codex-debug] failed to read transcript', {
          conversationId,
          path: file.path,
          error: String((error as Error)?.message ?? error),
        });
        continue;
      }

      const parsed = parseCodexRollout(content, {
        path: file.path,
        modifiedAt: file.modifiedAt,
        size: file.size,
      });
      const sessionCwd = parsed.cwd?.trim();
      if (!sessionCwd || sessionCwd !== conversation.workspacePath) continue;

      const matchedTurns = parsed.turns.filter((turn) => (turn.replyTarget ?? '').trim() === replyTarget);
      if (matchedTurns.length === 0) continue;

      const matchedRollout: CodexDebugRollout = {
        ...parsed,
        turns: matchedTurns,
      };

      if (acpSessionId && parsed.sessionId === acpSessionId) {
        exactSessionRollouts.push(matchedRollout);
      } else {
        heuristicRollouts.push(matchedRollout);
      }
    }

    const sessionMatchMissed = Boolean(acpSessionId) && exactSessionRollouts.length === 0;
    const usingExactSession = Boolean(acpSessionId) && exactSessionRollouts.length > 0;
    const rollouts = usingExactSession ? exactSessionRollouts : heuristicRollouts;

    rollouts.sort((a, b) => {
      const aTime = getRolloutSortTime(a);
      const bTime = getRolloutSortTime(b);
      return usingExactSession ? aTime - bTime : bTime - aTime;
    });
    const platformInputs = listPlatformInputsForConversation(this.db, {
      conversation,
      getAgentById: this.getAgentById,
      newestFirst: !usingExactSession,
    });
    const unmatchedPlatformInputs = attachPlatformInputsToTurns(rollouts, platformInputs);

    return {
      conversationId: conversation.id,
      agentType: conversation.agentType,
      workspacePath: conversation.workspacePath,
      replyTarget,
      acpSessionId,
      matchMode: usingExactSession ? 'acp_session_id' : 'heuristic',
      sessionMatchMissed,
      truncated: listing.truncated,
      rollouts,
      unmatchedPlatformInputs,
    };
  }
}

type PlatformRunRow = {
  runId: string;
  runPromptText: string;
  startedAt: number;
  endedAt: number | null;
  stopReason: string | null;
  error: string | null;
  acpSessionId: string | null;
  isFreshSession: number | null;
  isExact: number | null;
  dispatchMode: RuntimeDispatchMode | null;
  snapshotSystemPromptText: string | null;
  snapshotContextText: string | null;
  snapshotPromptText: string | null;
  snapshotDispatchedPromptText: string | null;
};

type ParseContext = {
  path: string;
  modifiedAt: number;
  size: number;
};

type CodexJsonlLine = {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

function parseCodexRollout(
  content: string,
  meta: ParseContext,
): CodexDebugRollout {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let baseInstructions: string | undefined;
  const preludeDeveloperMessages: string[] = [];
  const preludeUserMessages: string[] = [];
  const turns: CodexDebugTurn[] = [];
  let currentTurn: CodexDebugTurn | null = null;
  const functionCallById = new Map<string, CodexFunctionCall>();

  const pushCurrentTurn = () => {
    if (!currentTurn) return;
    turns.push(currentTurn);
    currentTurn = null;
    functionCallById.clear();
  };

  for (const line of lines) {
    let parsedLine: CodexJsonlLine;
    try {
      parsedLine = JSON.parse(line) as CodexJsonlLine;
    } catch {
      continue;
    }
    const timestamp = typeof parsedLine.timestamp === 'string' ? parsedLine.timestamp : new Date(meta.modifiedAt).toISOString();
    const payload = parsedLine.payload ?? {};

    if (parsedLine.type === 'session_meta') {
      sessionId = stringValue(payload.id);
      cwd = stringValue(payload.cwd);
      const base = payload.base_instructions as { text?: unknown } | undefined;
      baseInstructions = stringValue(base?.text);
      continue;
    }

    if (parsedLine.type === 'turn_context') {
      pushCurrentTurn();
      currentTurn = {
        turnId: stringValue(payload.turn_id) ?? `turn-${turns.length + 1}`,
        timestamp,
        cwd: stringValue(payload.cwd),
        inputBlocks: [],
        functionCalls: [],
        assistantOutputs: [],
        reasoningSummaries: [],
        hasEncryptedReasoning: false,
      };
      continue;
    }

    if (!currentTurn) {
      const preludeText = extractMessageText(payload);
      if (!preludeText) continue;
      if (payload.type === 'message' && payload.role === 'developer') preludeDeveloperMessages.push(preludeText);
      if (payload.type === 'message' && payload.role === 'user') preludeUserMessages.push(preludeText);
      continue;
    }

    if (parsedLine.type === 'response_item') {
      const payloadType = stringValue(payload.type);
      if (payloadType === 'message') {
        const role = stringValue(payload.role);
        const messageText = extractMessageText(payload);
        if (role === 'user' && messageText) {
          currentTurn.inputBlocks.push(...extractInputBlocks(payload));
          currentTurn.replyTarget = currentTurn.replyTarget ?? parseReplyTarget(messageText);
          currentTurn.triggerTarget = currentTurn.triggerTarget ?? parseTriggerTarget(messageText);
        } else if (role === 'assistant') {
          for (const text of extractAssistantOutputs(payload)) {
            currentTurn.assistantOutputs.push({
              text,
              phase: stringValue(payload.phase) ?? undefined,
              timestamp,
            });
          }
        }
      } else if (payloadType === 'function_call') {
        const callId = stringValue(payload.call_id) ?? `call-${currentTurn.functionCalls.length + 1}`;
        const call: CodexFunctionCall = {
          callId,
          name: stringValue(payload.name) ?? 'unknown',
          arguments: stringValue(payload.arguments) ?? '',
          timestamp,
        };
        functionCallById.set(callId, call);
        currentTurn.functionCalls.push(call);
      } else if (payloadType === 'function_call_output') {
        const callId = stringValue(payload.call_id);
        if (!callId) continue;
        const existing = functionCallById.get(callId);
        if (existing) {
          existing.output = stringValue(payload.output) ?? '';
          existing.outputTimestamp = timestamp;
        }
      } else if (payloadType === 'reasoning') {
        const summary = Array.isArray(payload.summary) ? payload.summary.map((item) => {
          if (!item || typeof item !== 'object') return '';
          return stringValue((item as { text?: unknown }).text) ?? '';
        }).filter(Boolean) : [];
        currentTurn.reasoningSummaries.push(...summary);
        if (typeof payload.encrypted_content === 'string' && payload.encrypted_content.trim()) {
          currentTurn.hasEncryptedReasoning = true;
        }
      }
      continue;
    }

    if (parsedLine.type === 'event_msg') {
      const eventType = stringValue(payload.type);
      if (eventType === 'user_message') {
        const combined = stringValue(payload.message);
        if (combined) {
          currentTurn.combinedUserMessage = combined;
          currentTurn.replyTarget = currentTurn.replyTarget ?? parseReplyTarget(combined);
          currentTurn.triggerTarget = currentTurn.triggerTarget ?? parseTriggerTarget(combined);
        }
      } else if (eventType === 'token_count') {
        currentTurn.tokenUsage = parseTokenUsage(payload);
      } else if (eventType === 'agent_message') {
        const message = stringValue(payload.message);
        if (message) {
          currentTurn.assistantOutputs.push({
            text: message,
            phase: stringValue(payload.phase) ?? undefined,
            timestamp,
          });
        }
      }
    }
  }

  pushCurrentTurn();

  return {
    path: meta.path,
    modifiedAt: meta.modifiedAt,
    size: meta.size,
    sessionId,
    cwd,
    baseInstructions,
    preludeDeveloperMessages,
    preludeUserMessages,
    turns,
  };
}

function getRolloutSortTime(rollout: CodexDebugRollout): number {
  const turnTimes = rollout.turns
    .map((turn) => Date.parse(turn.timestamp))
    .filter((value) => Number.isFinite(value));
  if (turnTimes.length > 0) {
    return Math.max(...turnTimes);
  }
  return rollout.modifiedAt;
}

function attachPlatformInputsToTurns(
  rollouts: CodexDebugRollout[],
  platformInputs: CodexPlatformInput[],
): CodexPlatformInput[] {
  const turnRefs: CodexDebugTurn[] = [];
  for (const rollout of rollouts) {
    for (const turn of rollout.turns) {
      turnRefs.push(turn);
    }
  }

  const pairCount = Math.min(turnRefs.length, platformInputs.length);
  for (let index = 0; index < pairCount; index += 1) {
    turnRefs[index]!.platformInput = platformInputs[index];
  }

  return platformInputs.slice(pairCount);
}

function listPlatformInputsForConversation(
  db: Db,
  params: {
    conversation: ConversationInfo;
    getAgentById: (agentId: string) => AgentInfo | null;
    newestFirst: boolean;
  },
): CodexPlatformInput[] {
  const rows = db.prepare(
    `SELECT r.run_id as runId,
            r.prompt_text as runPromptText,
            r.started_at as startedAt,
            r.ended_at as endedAt,
            r.stop_reason as stopReason,
            r.error,
            d.acp_session_id as acpSessionId,
            d.is_fresh_session as isFreshSession,
            d.is_exact as isExact,
            d.dispatch_mode as dispatchMode,
            d.system_prompt_text as snapshotSystemPromptText,
            d.context_text as snapshotContextText,
            d.prompt_text as snapshotPromptText,
            d.dispatched_prompt_text as snapshotDispatchedPromptText
       FROM conversations c
       JOIN runs r ON r.session_key = c.session_key
       LEFT JOIN run_debug_inputs d ON d.run_id = r.run_id
      WHERE c.id = ?
      ORDER BY r.started_at ${params.newestFirst ? 'DESC' : 'ASC'}`,
  ).all(params.conversation.id) as PlatformRunRow[];

  const agent = params.conversation.agentId ? params.getAgentById(params.conversation.agentId) : null;
  const reconstructedSystemPrompt = agent && params.conversation.workspacePath
    ? buildAgentSessionSystemPromptText({
      agentName: agent.name,
      agentBio: agent.description || undefined,
      agentDescription: agent.systemPrompt || undefined,
      workspacePath: params.conversation.workspacePath,
    })
    : undefined;

  return rows.map((row) => ({
    runId: row.runId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    stopReason: row.stopReason ?? undefined,
    error: row.error ?? undefined,
    dispatchMode: row.dispatchMode ?? undefined,
    acpSessionId: row.acpSessionId ?? undefined,
    isFreshSession: row.isFreshSession == null ? undefined : Boolean(row.isFreshSession),
    source: row.isExact ? 'exact_snapshot' : 'reconstructed',
    systemPromptText: row.isExact
      ? row.snapshotSystemPromptText ?? undefined
      : row.snapshotSystemPromptText ?? reconstructedSystemPrompt,
    contextText: row.snapshotContextText ?? undefined,
    promptText: row.snapshotPromptText ?? row.runPromptText,
    dispatchedPromptText: row.snapshotDispatchedPromptText ?? undefined,
  }));
}

function extractInputBlocks(payload: Record<string, unknown>): string[] {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== 'input_text') return [];
    const text = stringValue(typed.text);
    return text ? [text] : [];
  });
}

function extractAssistantOutputs(payload: Record<string, unknown>): string[] {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== 'output_text') return [];
    const text = stringValue(typed.text);
    return text ? [text] : [];
  });
}

function extractMessageText(payload: Record<string, unknown>): string | undefined {
  const blocks = extractInputBlocks(payload);
  if (blocks.length > 0) return blocks.join('\n\n');
  const assistantOutputs = extractAssistantOutputs(payload);
  if (assistantOutputs.length > 0) return assistantOutputs.join('\n\n');
  return undefined;
}

function parseReplyTarget(text: string): string | undefined {
  const match = /\[Current conversation target\][\s\S]*?reply_target:\s*([^\n]+)/.exec(text);
  return match?.[1]?.trim() || undefined;
}

function parseTriggerTarget(text: string): string | undefined {
  const match = /\[Triggered message metadata\][\s\S]*?target:\s*([^\n]+)/.exec(text);
  return match?.[1]?.trim() || undefined;
}

function parseTokenUsage(payload: Record<string, unknown>): CodexTokenUsage | undefined {
  const info = payload.info as Record<string, unknown> | undefined;
  const total = info?.total_token_usage as Record<string, unknown> | undefined;
  const contextWindow = numberValue(info?.model_context_window);
  if (!total && contextWindow === undefined) return undefined;
  return {
    inputTokens: numberValue(total?.input_tokens),
    cachedInputTokens: numberValue(total?.cached_input_tokens),
    outputTokens: numberValue(total?.output_tokens),
    reasoningOutputTokens: numberValue(total?.reasoning_output_tokens),
    totalTokens: numberValue(total?.total_tokens),
    modelContextWindow: contextWindow,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
