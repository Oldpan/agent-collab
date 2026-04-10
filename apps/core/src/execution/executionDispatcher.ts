import { randomUUID } from 'node:crypto';

import type { AgentInfo, ConversationStatus } from '@agent-collab/protocol';
import { getRuntimeDriver, type RuntimeDispatchMode } from '@agent-collab/protocol';
import { buildAgentSessionSystemPromptText } from '@agent-collab/memory';
import { createRun, finishRun, log } from '@agent-collab/runtime-acp';
import type { Db } from '@agent-collab/runtime-acp';
import type { AppConfig } from '../config.js';
import type { NodeRegistry } from '../services/nodeRegistry.js';
import { bumpAgentMessageCheckpoint } from '../web/messageCheckpoints.js';
import { buildDirectActivationPrompt } from '../web/directActivationPrompt.js';
import { buildDirectActivationContextText } from '../web/directActivationPrompt.js';
import { resolveConversationReplyTarget } from '../web/directReplyTargets.js';
import { allocateNextChannelMessageSeq } from '../web/channelMessageSequences.js';
import { buildTargetActivationContext, type ActivationContextMessage } from '../web/activationContext.js';
import { sanitizePromptHistoryContent } from '../web/promptHistorySanitizer.js';

const TURN_REPLY_CONTRACT = [
  '\n',
  '[Reply contract]',
  'Reply only via mcp__chat__send_message(...). Do not output user-visible text directly.',
  'Use mcp__chat__send_message(..., kind="progress") only while work is still ongoing.',
  'Before this run ends, send one final user-visible message with mcp__chat__send_message(..., kind="final").',
  'Use kind="final" only when your current answer is complete. The runtime decides when the run ends.',
].join('\n');

type PendingDispatchAcceptance = {
  nodeId: string;
  conversationId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type PromptActivationMetadata = {
  mentionSuppression?: {
    mode: 'root_user_multi_mention';
    triggerSeq: number;
    peerMentionedAgentIds: string[];
  };
};

type PromptSubmitOptions = {
  recordAsUserMessage?: boolean;
  activationContextText?: string;
  replayOverlapRecentMessages?: ActivationContextMessage[];
  senderName?: string;
  clientMessageId?: string;
  activationMetadata?: PromptActivationMetadata;
};

export class ExecutionDispatcher {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly nodeRegistry?: NodeRegistry;
  private readonly getAgentById: (agentId: string) => AgentInfo | null;
  private readonly pendingDispatchAcceptances = new Map<string, PendingDispatchAcceptance>();

  constructor(params: {
    db: Db;
    config: AppConfig;
    nodeRegistry?: NodeRegistry;
    getAgentById: (agentId: string) => AgentInfo | null;
  }) {
    this.db = params.db;
    this.config = params.config;
    this.nodeRegistry = params.nodeRegistry;
    this.getAgentById = params.getAgentById;
  }

  async dispatchPrompt(
    conversationId: string,
    promptText: string,
    options?: PromptSubmitOptions,
  ): Promise<{ runId: string; dispatchMode: RuntimeDispatchMode; hostKey: string }> {
    const row = this.db.prepare(
      `SELECT session_key as sessionKey, agent_type as agentType,
              workspace_path as workspacePath, env_vars as envVarsJson,
              node_id as nodeId, agent_id as agentId, reply_target as replyTarget
       FROM conversations WHERE id = ?`
    ).get(conversationId) as {
      sessionKey: string;
      agentType: AgentInfo['agentType'];
      workspacePath: string | null;
      envVarsJson: string | null;
      nodeId: string | null;
      agentId: string | null;
      replyTarget: string | null;
    } | undefined;

    if (!row) throw new Error(`Unknown conversation: ${conversationId}`);
    if (!row.nodeId) throw new Error('No agent node assigned. Connect an agent-node first.');

    const runId = randomUUID();
    const hostKey = `conversation:${conversationId}:${row.agentType}`;
    const dispatchMode = this.getDispatchMode(row.sessionKey);
    const driver = getRuntimeDriver(row.agentType);
    const recordAsUserMessage = options?.recordAsUserMessage ?? true;

    // Persist run and user message BEFORE node connectivity check so they survive
    // even if the node is offline — the user's message will still be visible after refresh.
    createRun(this.db, { runId, sessionKey: row.sessionKey, promptText });

    let contextText = '';
    let systemPromptText = '';
    let agentEnvVars: Record<string, string> | undefined;
    let disabledToolKinds: AgentInfo['disabledToolKinds'];
    let dmActivationCheckpoint: { channelId: string; seq: number } | undefined;
    if (row.agentId) {
      const agent = this.getAgentById(row.agentId);
      if (agent) {
        agentEnvVars = agent.envVars;
        disabledToolKinds = agent.disabledToolKinds;
        systemPromptText = buildAgentSessionSystemPromptText({
          agentName: agent.name,
          agentBio: agent.description || undefined,
          agentDescription: agent.systemPrompt || undefined,
          workspacePath: row.workspacePath ?? this.config.workspaceRoot,
        });
        let replayOverlapMessages = options?.replayOverlapRecentMessages;
        let dmActivationContextText = '';

        if (recordAsUserMessage) {
          // Persist DM user messages to channel_messages so history/replay stay complete
          // even though the triggering message is also injected directly into this run prompt.
          const dmChannelId = `dm:${row.agentId}`;
          const humanUserName = options?.senderName ?? this.config.humanUserName;
          const dmReplyTarget = resolveConversationReplyTarget(
            this.db,
            conversationId,
            humanUserName,
          ) ?? row.replyTarget?.trim() ?? `dm:@${humanUserName}`;
          const msgSeq = allocateNextChannelMessageSeq(this.db, dmChannelId);
          // Strip the [Attached image] note from display content; it's only for the agent
          const attachNoteIdx = promptText.indexOf('\n\n[Attached image');
          const displayContent = attachNoteIdx >= 0 ? promptText.slice(0, attachNoteIdx) : promptText;
          const parsedAttachIds = attachNoteIdx >= 0
            ? [...promptText.slice(attachNoteIdx).matchAll(/^ID: ([a-f0-9-]{36})$/gm)].map((m) => m[1])
            : [];
          this.db.prepare(
            `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, attachment_ids)
             VALUES(?, ?, 'user', ?, 'user', ?, ?, ?, ?, ?)`,
          ).run(options?.clientMessageId ?? randomUUID(), dmChannelId, humanUserName, dmReplyTarget, displayContent, msgSeq, Date.now(), parsedAttachIds.length ? JSON.stringify(parsedAttachIds) : null);

          // Checkpoint will be bumped after confirmed delivery to avoid silent message
          // loss if the node is offline or the send fails.
          dmActivationCheckpoint = { channelId: dmChannelId, seq: msgSeq };

          promptText = buildDirectActivationPrompt({
            agentName: agent.name,
            senderName: humanUserName,
            replyTarget: dmReplyTarget,
            content: promptText,
          });

          if (dispatchMode !== 'cold_start') {
            const dmActivationContext = buildTargetActivationContext(this.db, {
              agentId: row.agentId,
              channelId: dmChannelId,
              replyTarget: dmReplyTarget,
              triggerSeq: msgSeq,
            });
            replayOverlapMessages = dmActivationContext.recentMessages;
            dmActivationContextText = buildDirectActivationContextText({
              target: dmReplyTarget,
              recentMessages: dmActivationContext.recentMessages,
              unreadCount: dmActivationContext.unreadCount,
              oldestVisibleSeq: dmActivationContext.oldestVisibleSeq,
              rootMessage: dmActivationContext.rootMessage,
              dmContextSnapshot: dmActivationContext.dmContextSnapshot,
              dmActiveTaskThreads: dmActivationContext.dmActiveTaskThreads,
            });
          }
        }

        if (dispatchMode !== 'cold_start') {
          const replayText = this.buildConversationReplayText(
            conversationId,
            row.sessionKey,
            runId,
            replayOverlapMessages,
          );
          if (replayText) contextText += '\n\n' + replayText;
        }

        if (dmActivationContextText) {
          contextText += '\n\n' + dmActivationContextText;
        }

        if (options?.activationContextText?.trim()) {
          contextText += '\n\n' + options.activationContextText;
        }

      }
    }

    const dispatchedPrompt = prependTurnReplyContract(promptText);
    const candidateSystemPromptText =
      dispatchMode === 'cold_start'
        ? systemPromptText
        : getSessionSystemPromptText(this.db, row.sessionKey) || systemPromptText;
    upsertPendingRunDebugInput(this.db, {
      runId,
      conversationId,
      sessionKey: row.sessionKey,
      dispatchMode,
      replyTarget: row.replyTarget?.trim() || null,
      systemPromptText: candidateSystemPromptText || null,
      contextText: contextText || null,
      promptText,
      dispatchedPromptText: dispatchedPrompt,
      activationMetadataJson: serializePromptActivationMetadata(options?.activationMetadata),
    });

    const node = this.nodeRegistry?.getNode(row.nodeId);
    if (!node) {
      finishRun(this.db, { runId, error: 'Node not connected' });
      this.updateStatus(conversationId, 'idle');
      log.warn('[dispatcher] node not connected', { nodeId: row.nodeId, conversationId });
      throw new Error(`Node not connected: ${row.nodeId}`);
    }

    log.info('[dispatcher] dispatching prompt', {
      nodeId: row.nodeId,
      conversationId,
      runId,
      dispatchMode,
      hostKey,
    });

    let channelBridgeConfig: { agentId: string; conversationId: string; serverUrl: string; authToken: string } | undefined;
    if (row.agentId) {
      const serverUrl = this.resolveChannelBridgeServerUrl();
      channelBridgeConfig = {
        agentId: row.agentId,
        conversationId,
        serverUrl,
        authToken: this.config.internalAgentAuthToken,
      };
    }

    const acceptance = this.waitForDispatchAcceptance(runId, row.nodeId, conversationId);

    const sent = this.nodeRegistry!.send(row.nodeId, {
      type: 'run.dispatch',
      runId,
      conversationId,
      agentType: row.agentType,
      ...(row.agentId ? { model: this.getAgentById(row.agentId)?.model } : {}),
      ...(row.agentId ? { reasoningEffort: this.getAgentById(row.agentId)?.reasoningEffort } : {}),
      workspacePath: row.workspacePath,
      ...(row.agentId ? { skillRoots: this.getAgentById(row.agentId)?.skillRoots } : {}),
      envVars: {
        ...(agentEnvVars ?? {}),
        ...(parseEnvVars(row.envVarsJson) ?? {}),
        ...(driver.defaultEnv ?? {}),
      },
      disabledToolKinds,
      prompt: dispatchedPrompt,
      sessionKey: row.sessionKey,
      hostKey,
      dispatchMode,
      systemPromptText: systemPromptText || undefined,
      contextText: contextText || undefined,
      channelBridgeConfig,
    });

    if (!sent) {
      this.clearPendingDispatchAcceptance(runId);
      finishRun(this.db, { runId, error: 'Node disconnected during dispatch' });
      this.updateStatus(conversationId, 'idle');
      throw new Error(`Node disconnected: ${row.nodeId}`);
    }

    try {
      await acceptance;
    } catch (error) {
      finishRun(this.db, { runId, error: String((error as Error)?.message ?? error) });
      this.updateStatus(conversationId, 'failed');
      throw error;
    }

    if (dmActivationCheckpoint) {
      bumpAgentMessageCheckpoint(this.db, row.agentId!, dmActivationCheckpoint.channelId, dmActivationCheckpoint.seq, null);
    }

    return { runId, dispatchMode, hostKey };
  }

  async submitPrompt(
    conversationId: string,
    promptText: string,
    options?: PromptSubmitOptions,
  ): Promise<{ queued: boolean; runId?: string }> {
    const row = this.db.prepare(
      `SELECT agent_id as agentId
       FROM conversations
       WHERE id = ?`,
    ).get(conversationId) as { agentId: string | null } | undefined;

    if (!row) throw new Error(`Unknown conversation: ${conversationId}`);

    if (!row.agentId) {
      const dispatched = await this.dispatchPrompt(conversationId, promptText, options);
      return { queued: false, runId: dispatched.runId };
    }

    const blocking = this.findBlockingConversation(conversationId);
    if (blocking) {
      this.enqueuePrompt(row.agentId, conversationId, promptText, options);
      this.updateStatus(conversationId, 'queued');
      return { queued: true };
    }

    const dispatched = await this.dispatchPrompt(conversationId, promptText, options);
    return { queued: false, runId: dispatched.runId };
  }

  async handleApproval(
    conversationId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ): Promise<{ ok: boolean; message: string }> {
    const convRow = this.db
      .prepare('SELECT node_id as nodeId FROM conversations WHERE id = ?')
      .get(conversationId) as { nodeId: string | null } | undefined;

    if (!convRow) return { ok: false, message: 'Unknown conversation.' };
    if (!convRow.nodeId) return { ok: false, message: 'No agent node assigned to this conversation.' };

    const sent = this.nodeRegistry?.send(convRow.nodeId, {
      type: 'permission.response',
      requestId,
      decision,
    });
    if (sent) {
      this.updateStatus(conversationId, 'active');
      return { ok: true, message: '' };
    }
    return { ok: false, message: 'Node not connected.' };
  }

  cancelConversationRun(
    conversationId: string,
  ): { ok: boolean; message: string; runId?: string } {
    const row = this.db.prepare(
      `SELECT c.node_id as nodeId, r.run_id as runId
       FROM conversations c
       LEFT JOIN runs r ON r.session_key = c.session_key AND r.ended_at IS NULL
       WHERE c.id = ?
       ORDER BY r.started_at DESC
       LIMIT 1`
    ).get(conversationId) as { nodeId: string | null; runId: string | null } | undefined;

    if (!row) return { ok: false, message: 'Unknown conversation.' };
    if (!row.runId) return { ok: false, message: 'No active run to cancel.' };
    if (!row.nodeId) return { ok: false, message: 'No agent node assigned to this conversation.' };

    const sent = this.nodeRegistry?.send(row.nodeId, {
      type: 'run.cancel',
      runId: row.runId,
    });
    return sent
      ? { ok: true, message: '', runId: row.runId }
      : { ok: false, message: 'Node not connected.' };
  }

  async handleConversationSettled(conversationId: string): Promise<void> {
    const row = this.db.prepare(
      `SELECT agent_id as agentId
       FROM conversations
       WHERE id = ?`,
    ).get(conversationId) as { agentId: string | null } | undefined;

    if (!row?.agentId) return;
    if (this.findBlockingConversation(conversationId)) return;

    const next = this.db.prepare(
      `SELECT queue_id as queueId, agent_id as agentId, conversation_id as conversationId,
              prompt_text as promptText, record_as_user_message as recordAsUserMessage,
              activation_context_text as activationContextText,
              replay_overlap_recent_messages_json as replayOverlapRecentMessagesJson,
              activation_metadata_json as activationMetadataJson,
              sender_name as senderName,
              client_message_id as clientMessageId
       FROM conversation_prompt_queue
       WHERE conversation_id = ?
       ORDER BY created_at ASC, queue_id ASC
       LIMIT 1`,
    ).get(conversationId) as {
      queueId: number;
      agentId: string;
      conversationId: string;
      promptText: string;
      recordAsUserMessage: number;
      activationContextText: string | null;
      replayOverlapRecentMessagesJson: string | null;
      activationMetadataJson: string | null;
      senderName: string | null;
      clientMessageId: string | null;
    } | undefined;

    if (!next) return;

    this.db.prepare('DELETE FROM conversation_prompt_queue WHERE queue_id = ?').run(next.queueId);
    try {
      await this.dispatchPrompt(next.conversationId, next.promptText, {
        recordAsUserMessage: next.recordAsUserMessage !== 0,
        activationContextText: next.activationContextText ?? undefined,
        replayOverlapRecentMessages: parseReplayOverlapRecentMessages(next.replayOverlapRecentMessagesJson),
        activationMetadata: parsePromptActivationMetadata(next.activationMetadataJson),
        senderName: next.senderName ?? undefined,
        clientMessageId: next.clientMessageId ?? undefined,
      });
    } catch {
      this.updateStatus(next.conversationId, 'failed');
    }
  }

  handleRunAccepted(runId: string, conversationId: string): boolean {
    const pending = this.pendingDispatchAcceptances.get(runId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingDispatchAcceptances.delete(runId);
    this.updateStatus(conversationId, 'active');
    pending.resolve();
    return true;
  }

  rejectPendingDispatchesForNode(nodeId: string, errorMessage: string): void {
    for (const [runId, pending] of this.pendingDispatchAcceptances.entries()) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(errorMessage));
      this.pendingDispatchAcceptances.delete(runId);
    }
  }

  ensureConversationSessionAgent(
    agentType: AgentInfo['agentType'],
  ): { command: string; args: string[] } {
    const driver = getRuntimeDriver(agentType);
    return { command: driver.command, args: [...driver.args] };
  }

  private isIgnorableReplayAssistantText(text: string): boolean {
    return text.includes(`Empty response: {'content':`)
      || text.trim() === '[stop_reason] handoff';
  }

  private getDispatchMode(sessionKey: string): RuntimeDispatchMode {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM runs WHERE session_key = ?')
      .get(sessionKey) as { count: number };
    return row.count > 0 ? 'resume' : 'cold_start';
  }

  /**
   * Rebuild recent conversation history from core's DB (content.delta events) so that
   * a freshly restarted ACP process can recover context it would otherwise have lost.
   */
  private buildConversationReplayText(
    conversationId: string,
    sessionKey: string,
    excludeRunId: string,
    overlapRecentMessages?: ActivationContextMessage[],
  ): string {
    if (!this.config.contextReplayEnabled || this.config.contextReplayRuns <= 0) return '';

    const conversationAgentName = getConversationAgentName(this.db, conversationId);

    const resetRow = this.db.prepare(
      `SELECT history_reset_at as historyResetAt
       FROM conversations
       WHERE id = ?`,
    ).get(conversationId) as { historyResetAt: number | null } | undefined;
    const historyResetAt = resetRow?.historyResetAt ?? null;

    const runs = this.db.prepare(
      `SELECT run_id as runId, prompt_text as promptText, stop_reason as stopReason, error
       FROM runs
       WHERE session_key = ?
         AND run_id != ?
         AND ended_at IS NOT NULL
         AND (? IS NULL OR started_at >= ?)
       ORDER BY started_at DESC
       LIMIT ?`,
    ).all(sessionKey, excludeRunId, historyResetAt, historyResetAt, this.config.contextReplayRuns) as Array<{
      runId: string;
      promptText: string;
      stopReason: string | null;
      error: string | null;
    }>;

    const chronological = runs.slice().reverse();
    const blocks: string[] = [];

    for (const run of chronological) {
      const visibleAgentMessages = this.db.prepare(
        `SELECT content, message_kind as messageKind, sender_name as senderName
         FROM channel_messages
         WHERE run_id = ?
           AND sender_type = 'agent'
         ORDER BY created_at ASC, seq ASC`,
      ).all(run.runId) as Array<{ content: string; messageKind: string | null; senderName: string | null }>;

      let assistantLine = '';
      const finalMessage = [...visibleAgentMessages].reverse().find((row) => row.messageKind === 'final');
      const lastVisibleMessage = visibleAgentMessages.length > 0
        ? visibleAgentMessages[visibleAgentMessages.length - 1]
        : undefined;
      if (finalMessage?.content?.trim()) {
        assistantLine = sanitizePromptHistoryContent(finalMessage.content, 'agent');
      } else if (lastVisibleMessage?.content?.trim()) {
        assistantLine = sanitizePromptHistoryContent(lastVisibleMessage.content, 'agent');
      }

      const events = this.db.prepare(
        `SELECT payload_json as payloadJson FROM events
         WHERE run_id = ? AND method = 'node/event'
         ORDER BY seq ASC`,
      ).all(run.runId) as Array<{ payloadJson: string }>;

      if (!assistantLine) {
        let assistantText = '';
        for (const ev of events) {
          try {
            const parsed = JSON.parse(ev.payloadJson) as { type?: string; text?: string };
            if (parsed?.type === 'content.delta' && typeof parsed.text === 'string') {
              assistantText += parsed.text;
            }
          } catch { /* ignore malformed rows */ }
        }

        const cleanedAssistantText = assistantText.trim();
        assistantLine = cleanedAssistantText && !this.isIgnorableReplayAssistantText(cleanedAssistantText)
          ? cleanedAssistantText
          : run.error
            ? `[error] ${run.error}`
            : run.stopReason
              ? `[stop_reason] ${run.stopReason}`
              : '';
      }

      const normalizedUserText = normalizeReplayUserText(run.promptText);
      if (normalizedUserText) {
        blocks.push(`User: ${normalizedUserText}`);
      }
      if (assistantLine) {
        const assistantLabel = finalMessage?.senderName?.trim()
          || lastVisibleMessage?.senderName?.trim()
          || conversationAgentName
          || 'Assistant';
        blocks.push(`${assistantLabel}: ${assistantLine}`);
      }
    }

    const trimmedBlocks = trimReplayBlocksAgainstRecentMessages(blocks, overlapRecentMessages);
    const raw = trimmedBlocks.join('\n');
    if (!raw.trim()) return '';

    const header = 'Context (previous messages, for continuity after restart):\n';
    const full = header + raw;
    if (full.length <= this.config.contextReplayMaxChars) return full;
    return header + raw.slice(Math.max(0, raw.length - this.config.contextReplayMaxChars));
  }

  private updateStatus(conversationId: string, status: ConversationStatus): void {
    this.db
      .prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), conversationId);
  }

  private findBlockingConversation(
    conversationId: string,
  ): { id: string; status: ConversationStatus } | null {
    const row = this.db.prepare(
      `SELECT c.id, c.status
       FROM conversations c
       LEFT JOIN runs r ON r.session_key = c.session_key AND r.ended_at IS NULL
       WHERE c.id = ?
         AND (
           r.run_id IS NOT NULL
           OR c.status IN ('active', 'recovering', 'awaiting_approval')
         )
       LIMIT 1`,
    ).get(conversationId) as {
      id: string;
      status: ConversationStatus;
    } | undefined;
    return row ?? null;
  }

  private enqueuePrompt(
    agentId: string,
    conversationId: string,
    promptText: string,
    options?: PromptSubmitOptions,
  ): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO conversation_prompt_queue(
         agent_id, conversation_id, prompt_text, record_as_user_message, activation_context_text, replay_overlap_recent_messages_json, activation_metadata_json, sender_name, client_message_id, created_at, updated_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agentId,
      conversationId,
      promptText,
      (options?.recordAsUserMessage ?? true) ? 1 : 0,
      options?.activationContextText?.trim() || null,
      serializeReplayOverlapRecentMessages(options?.replayOverlapRecentMessages),
      serializePromptActivationMetadata(options?.activationMetadata),
      options?.senderName ?? null,
      options?.clientMessageId ?? null,
      now,
      now,
    );
  }

  private waitForDispatchAcceptance(
    runId: string,
    nodeId: string,
    conversationId: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDispatchAcceptances.delete(runId);
        reject(new Error('Node did not acknowledge dispatch in time'));
      }, this.config.nodeDispatchAckTimeoutMs);
      this.pendingDispatchAcceptances.set(runId, {
        nodeId,
        conversationId,
        resolve,
        reject,
        timer,
      });
    });
  }

  private clearPendingDispatchAcceptance(runId: string): void {
    const pending = this.pendingDispatchAcceptances.get(runId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDispatchAcceptances.delete(runId);
  }

  private resolveChannelBridgeServerUrl(): string {
    const configured = this.config.publicServerUrl?.trim();
    if (configured) {
      return configured.replace(/\/+$/, '');
    }
    const host = this.config.webHost === '0.0.0.0' ? '10.104.9.253' : this.config.webHost;
    return `http://${host}:${this.config.webPort}`;
  }
}

function parseEnvVars(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function stripReplyContract(promptText: string): string {
  if (!promptText.startsWith('[Reply contract]')) return promptText;
  const splitIndex = promptText.indexOf('\n\n');
  return splitIndex >= 0 ? promptText.slice(splitIndex + 2) : promptText;
}

function extractTriggeredMessageBody(promptText: string): string | null {
  const marker = '[Triggered message body]\n';
  const start = promptText.indexOf(marker);
  if (start < 0) return null;
  return promptText.slice(start + marker.length).trim() || null;
}

function normalizeReplayUserText(promptText: string): string {
  const stripped = stripReplyContract(promptText).trim();
  return extractTriggeredMessageBody(stripped) ?? stripped;
}

function getConversationAgentName(db: Db, conversationId: string): string | null {
  const row = db.prepare(
    `SELECT a.name as agentName
     FROM conversations c
     LEFT JOIN agents a ON a.agent_id = c.agent_id
     WHERE c.id = ?`,
  ).get(conversationId) as { agentName: string | null } | undefined;
  return row?.agentName?.trim() || null;
}

function trimReplayBlocksAgainstRecentMessages(
  replayBlocks: string[],
  recentMessages?: ActivationContextMessage[],
): string[] {
  if (!recentMessages?.length || replayBlocks.length === 0) return replayBlocks;

  const recentReplayBlocks = recentMessages
    .map(formatReplayBlockForRecentMessage)
    .filter((block): block is string => Boolean(block));
  if (recentReplayBlocks.length === 0) return replayBlocks;

  let replayIndex = replayBlocks.length - 1;
  let recentIndex = recentReplayBlocks.length - 1;
  let matchedCount = 0;

  while (replayIndex >= 0 && recentIndex >= 0) {
    if (replayBlocks[replayIndex] === recentReplayBlocks[recentIndex]) {
      matchedCount += 1;
      replayIndex -= 1;
      recentIndex -= 1;
      continue;
    }

    recentIndex -= 1;
  }

  if (matchedCount <= 0) return replayBlocks;
  return replayBlocks.slice(0, replayBlocks.length - matchedCount);
}

function formatReplayBlockForRecentMessage(message: ActivationContextMessage): string | null {
  const content = sanitizePromptHistoryContent(message.content, message.senderType);
  if (!content) return null;
  if (message.senderType === 'agent') {
    return `${message.senderName}: ${content}`;
  }
  return `User: ${content}`;
}

function serializeReplayOverlapRecentMessages(messages?: ActivationContextMessage[]): string | null {
  if (!messages?.length) return null;
  return JSON.stringify(messages);
}

function parseReplayOverlapRecentMessages(raw: string | null): ActivationContextMessage[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(isActivationContextMessage);
  } catch {
    return undefined;
  }
}

function isActivationContextMessage(value: unknown): value is ActivationContextMessage {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.messageId === 'string'
    && typeof row.seq === 'number'
    && typeof row.target === 'string'
    && typeof row.senderName === 'string'
    && (row.senderType === 'user' || row.senderType === 'agent')
    && typeof row.content === 'string'
    && typeof row.createdAt === 'number';
}

function prependTurnReplyContract(promptText: string): string {
  if (promptText.includes('[Reply contract]')) return promptText;
  return `${TURN_REPLY_CONTRACT}\n\n${promptText}`;
}

function getSessionSystemPromptText(db: Db, sessionKey: string): string | null {
  const row = db.prepare(
    'SELECT system_prompt_text as systemPromptText FROM sessions WHERE session_key = ?',
  ).get(sessionKey) as { systemPromptText: string | null } | undefined;
  return row?.systemPromptText ?? null;
}

function upsertPendingRunDebugInput(
  db: Db,
  params: {
    runId: string;
    conversationId: string;
    sessionKey: string;
    dispatchMode: RuntimeDispatchMode;
    replyTarget: string | null;
    systemPromptText: string | null;
    contextText: string | null;
    promptText: string;
    dispatchedPromptText: string;
    activationMetadataJson: string | null;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO run_debug_inputs(
       run_id, conversation_id, session_key, dispatch_mode, reply_target,
       system_prompt_text, context_text, prompt_text, dispatched_prompt_text, activation_metadata_json,
       created_at, updated_at
     )
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       conversation_id = excluded.conversation_id,
       session_key = excluded.session_key,
       dispatch_mode = excluded.dispatch_mode,
       reply_target = excluded.reply_target,
       system_prompt_text = excluded.system_prompt_text,
       context_text = excluded.context_text,
       prompt_text = excluded.prompt_text,
       dispatched_prompt_text = excluded.dispatched_prompt_text,
       activation_metadata_json = excluded.activation_metadata_json,
       updated_at = excluded.updated_at`,
  ).run(
    params.runId,
    params.conversationId,
    params.sessionKey,
    params.dispatchMode,
    params.replyTarget,
    params.systemPromptText,
    params.contextText,
    params.promptText,
    params.dispatchedPromptText,
    params.activationMetadataJson,
    now,
    now,
  );
}

function serializePromptActivationMetadata(metadata: PromptActivationMetadata | undefined): string | null {
  if (!metadata) return null;
  if (!metadata.mentionSuppression) return null;
  const peerMentionedAgentIds = metadata.mentionSuppression.peerMentionedAgentIds
    .map((agentId) => agentId.trim())
    .filter(Boolean);
  if (peerMentionedAgentIds.length === 0) return null;
  return JSON.stringify({
    mentionSuppression: {
      mode: metadata.mentionSuppression.mode,
      triggerSeq: metadata.mentionSuppression.triggerSeq,
      peerMentionedAgentIds,
    },
  });
}

function parsePromptActivationMetadata(value: string | null | undefined): PromptActivationMetadata | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as PromptActivationMetadata;
    const mentionSuppression = parsed?.mentionSuppression;
    if (!mentionSuppression) return undefined;
    const peerMentionedAgentIds = Array.isArray(mentionSuppression.peerMentionedAgentIds)
      ? mentionSuppression.peerMentionedAgentIds.filter((agentId): agentId is string => typeof agentId === 'string' && agentId.trim().length > 0)
      : [];
    if (mentionSuppression.mode !== 'root_user_multi_mention' || !Number.isFinite(mentionSuppression.triggerSeq) || peerMentionedAgentIds.length === 0) {
      return undefined;
    }
    return {
      mentionSuppression: {
        mode: 'root_user_multi_mention',
        triggerSeq: mentionSuppression.triggerSeq,
        peerMentionedAgentIds,
      },
    };
  } catch {
    return undefined;
  }
}
