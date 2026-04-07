import type { AgentInfo, ConversationInfo } from '@agent-collab/protocol';
import type { Db } from '@agent-collab/runtime-acp';
import type { ClaudeTranscriptBroker } from './claudeTranscriptBroker.js';
import {
  attachPlatformInputsToTurns,
  getRolloutSortTime,
  listPlatformInputsForConversation,
  parseReplyTarget,
  parseTriggerTarget,
  type CodexConversationDebugResult,
  type CodexDebugRollout,
  type CodexDebugTurn,
  type CodexFunctionCall,
  type CodexTokenUsage,
} from './codexTranscriptService.js';

const MAX_INLINE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

export class ClaudeTranscriptService {
  private readonly db: Db;
  private readonly broker: ClaudeTranscriptBroker;
  private readonly getConversationById: (conversationId: string) => ConversationInfo | null;
  private readonly getAgentById: (agentId: string) => AgentInfo | null;
  private readonly getAcpSessionIdByConversationId: (conversationId: string) => string | null;

  constructor(params: {
    db: Db;
    broker: ClaudeTranscriptBroker;
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
    if (conversation.agentType !== 'claude_acp') throw new Error('Claude debug is only supported for claude_acp conversations.');
    if (!conversation.nodeId) throw new Error('Conversation is not assigned to a remote node.');
    if (!conversation.workspacePath) throw new Error('Conversation has no workspace path.');
    const replyTarget = (conversation.replyTarget ?? '').trim();
    if (!replyTarget) throw new Error('Conversation has no reply target.');
    const acpSessionId = this.getAcpSessionIdByConversationId(conversationId)?.trim() || undefined;

    const listing = await this.broker.listFiles(conversation.nodeId, conversation.workspacePath);
    const exactSessionRollouts: CodexDebugRollout[] = [];
    const heuristicRollouts: CodexDebugRollout[] = [];

    for (const file of listing.files) {
      if (file.size > MAX_INLINE_TRANSCRIPT_BYTES) continue;
      const result = await this.broker.readFile(conversation.nodeId, conversation.workspacePath, file.path).catch(() => null);
      if (!result) continue;
      const parsed = parseClaudeRollout(result.content, {
        path: file.path,
        modifiedAt: file.modifiedAt,
        size: file.size,
      });
      const sessionCwd = parsed.cwd?.trim();
      if (!sessionCwd || sessionCwd !== conversation.workspacePath) continue;

      const exactSessionMatch = Boolean(acpSessionId) && parsed.sessionId === acpSessionId;
      let matchedTurns = parsed.turns.filter((turn) => (turn.replyTarget ?? '').trim() === replyTarget);
      if (matchedTurns.length === 0 && exactSessionMatch) {
        matchedTurns = parsed.turns.filter((turn) => !(turn.replyTarget ?? '').trim());
        if (matchedTurns.length === 0) {
          matchedTurns = parsed.turns;
        }
      }
      if (matchedTurns.length === 0) continue;

      const matchedRollout: CodexDebugRollout = {
        ...parsed,
        turns: matchedTurns,
      };
      if (exactSessionMatch) {
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
      provider: 'claude',
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

type ParseContext = {
  path: string;
  modifiedAt: number;
  size: number;
};

type ClaudeJsonlLine = Record<string, unknown>;

function parseClaudeRollout(content: string, meta: ParseContext): CodexDebugRollout {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let sessionId: string | undefined;
  let cwd: string | undefined;
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
    let parsedLine: ClaudeJsonlLine;
    try {
      parsedLine = JSON.parse(line) as ClaudeJsonlLine;
    } catch {
      continue;
    }

    const lineType = stringValue(parsedLine.type);
    const timestamp = stringValue(parsedLine.timestamp) ?? new Date(meta.modifiedAt).toISOString();
    sessionId = sessionId ?? stringValue(parsedLine.sessionId);
    cwd = cwd ?? stringValue(parsedLine.cwd);

    if (lineType === 'user') {
      const message = objectValue(parsedLine.message);
      const role = stringValue(message?.role);
      const textBlocks = extractClaudeTextBlocks(message?.content);
      const toolResults = extractClaudeToolResults(message?.content);
      if (role === 'user' && textBlocks.length > 0) {
        pushCurrentTurn();
        const combined = textBlocks.join('\n\n');
        currentTurn = {
          turnId: stringValue(parsedLine.uuid) ?? `turn-${turns.length + 1}`,
          timestamp,
          cwd: stringValue(parsedLine.cwd) ?? cwd,
          replyTarget: parseReplyTarget(combined),
          triggerTarget: parseTriggerTarget(combined),
          inputBlocks: textBlocks,
          combinedUserMessage: combined,
          functionCalls: [],
          assistantOutputs: [],
          reasoningSummaries: [],
          hasEncryptedReasoning: false,
        };
      } else if (currentTurn && toolResults.length > 0) {
        const toolUseId = stringValueArray(message?.content, 'tool_use_id')[0];
        const outputText = toolResults.join('\n\n');
        if (toolUseId) {
          const existing = functionCallById.get(toolUseId);
          if (existing) {
            existing.output = outputText;
            existing.outputTimestamp = timestamp;
          }
        }
      }
      continue;
    }

    if (lineType === 'assistant') {
      if (!currentTurn) continue;
      const message = objectValue(parsedLine.message);
      const assistantTexts = extractClaudeTextBlocks(message?.content);
      for (const text of assistantTexts) {
        currentTurn.assistantOutputs.push({
          text,
          phase: stringValue(message?.stop_reason) ?? undefined,
          timestamp,
        });
      }

      const toolUses = extractClaudeToolUses(message?.content);
      for (const toolUse of toolUses) {
        const call: CodexFunctionCall = {
          callId: toolUse.id,
          name: toolUse.name,
          arguments: toolUse.input,
          timestamp,
        };
        functionCallById.set(call.callId, call);
        currentTurn.functionCalls.push(call);
      }

      const usage = objectValue(message?.usage);
      if (usage) {
        currentTurn.tokenUsage = parseClaudeTokenUsage(usage);
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
    preludeDeveloperMessages: [],
    preludeUserMessages: [],
    turns,
  };
}

function extractClaudeTextBlocks(content: unknown): string[] {
  const blocks = Array.isArray(content) ? content : [];
  return blocks.flatMap((block) => {
    const typed = objectValue(block);
    if (!typed) return [];
    if (stringValue(typed.type) !== 'text') return [];
    const text = stringValue(typed.text);
    return text ? [text] : [];
  });
}

function extractClaudeToolResults(content: unknown): string[] {
  const blocks = Array.isArray(content) ? content : [];
  return blocks.flatMap((block) => {
    const typed = objectValue(block);
    if (!typed) return [];
    if (stringValue(typed.type) !== 'tool_result') return [];
    return extractClaudeTextBlocks(typed.content);
  });
}

function extractClaudeToolUses(content: unknown): Array<{ id: string; name: string; input: string }> {
  const blocks = Array.isArray(content) ? content : [];
  return blocks.flatMap((block) => {
    const typed = objectValue(block);
    if (!typed) return [];
    if (stringValue(typed.type) !== 'tool_use') return [];
    const id = stringValue(typed.id);
    const name = stringValue(typed.name);
    if (!id || !name) return [];
    return [{
      id,
      name,
      input: JSON.stringify(typed.input ?? {}, null, 2),
    }];
  });
}

function parseClaudeTokenUsage(usage: Record<string, unknown>): CodexTokenUsage {
  const inputTokens = numberValue(usage.input_tokens) ?? numberValue(usage.prompt_tokens);
  const cachedInputTokens = numberValue(usage.cache_read_input_tokens) ?? numberValue(usage.cached_tokens);
  return {
    currentInputTokens: inputTokens,
    inputTokens,
    cachedInputTokens,
    currentCachedInputTokens: cachedInputTokens,
    outputTokens: numberValue(usage.output_tokens),
    totalTokens: addNumbers(inputTokens, numberValue(usage.output_tokens)),
    modelContextWindow: 256000,
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function addNumbers(a?: number, b?: number): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function stringValueArray(content: unknown, key: string): string[] {
  const blocks = Array.isArray(content) ? content : [];
  return blocks.flatMap((block) => {
    const typed = objectValue(block);
    const value = stringValue(typed?.[key]);
    return value ? [value] : [];
  });
}
