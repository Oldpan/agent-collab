import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Db } from '@agent-collab/runtime-acp';
import { buildThreadShortId, type ConversationStatus, type ServerEvent } from '@agent-collab/protocol';
import type { ConversationManager } from './conversationManager.js';
import type { AgentSkillsService } from '../services/agentSkillsService.js';
import { AgentSkillsServiceError } from '../services/agentSkillsService.js';
import {
  bumpAgentMessageCheckpoint,
  checkpointThreadKey,
  getAgentMessageCheckpoint,
  setAgentMessageCheckpoint,
} from './messageCheckpoints.js';
import { buildTargetActivationContext } from './activationContext.js';
import { buildDirectActivationContextText } from './directActivationPrompt.js';
import { recordAgentMentionNotification, shouldTriggerAgentMention } from './agentMentionCooldowns.js';
import { buildChannelActivationContextText, buildChannelActivationPrompt } from './channelActivationPrompt.js';
import { findMentionedAgents } from './channelMentions.js';
import { resolveConversationReplyTarget } from './directReplyTargets.js';
import {
  listRecentTargetParticipants,
  setTargetOwner,
  TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
  upsertTargetParticipant,
} from './targetParticipants.js';
import {
  type BoundThreadTask,
  getThreadCollaborationSummary,
  syncTaskThreadOwner,
} from './threadTaskBindings.js';
import { allocateNextChannelMessageSeq } from './channelMessageSequences.js';
import { allocateNextTaskNumber } from './taskNumbers.js';
import { isValidTransition } from './taskStatusTransitions.js';
import { upsertAgentTaskLink } from './agentTaskLinks.js';
import { findThreadRootMessageId } from './threadRoots.js';
import { appendTaskEvent, buildTaskEventThreadTarget } from './taskEvents.js';

const AGENT_MENTION_COOLDOWN_MS = 60_000;
const DM_TASK_HANDOFF_EVENT_METHOD = 'platform/handoff';
const DM_TASK_LIFECYCLE_SOURCE = 'task_lifecycle';

type MessageRow = {
  messageId: string;
  channelId: string;
  senderId: string;
  senderName: string;
  senderType: string;
  target: string;
  content: string;
  seq: number;
  createdAt: number;
  threadRootId: string | null;
};

type BroadcastChannelMessage = ServerEvent & {
  type: 'channel.message';
  message: {
    id: string;
    senderName: string;
    senderType: 'user' | 'agent' | 'system';
    content: string;
    createdAt: string;
    seq?: number;
    threadRootId?: string;
    messageSource?: string;
    taskNumber?: number;
    taskStatus?: string;
    taskAssigneeName?: string | null;
    attachmentIds?: string[];
  };
};

type TaskRow = {
  taskId: string;
  agentTaskRef: string | null;
  channelId: string;
  taskNumber: number;
  title: string;
  description?: string | null;
  status: string;
  claimedByAgentId: string | null;
  claimedByName: string | null;
  createdByAgentId: string | null;
  createdByName: string | null;
  createdAt: number;
  updatedAt: number;
};

type ContextMsg = { senderName: string; senderType: string; content: string; seq: number };
type MessageScope = { clause: string; params: Array<string | number> };
type ClaimableMessageRow = {
  messageId: string;
  content: string;
  threadRootId: string | null;
  senderType: string;
  senderName: string;
  target: string;
  seq: number;
  createdAt: number;
  attachmentIds: string | null;
};

type TaskMessageBroadcastRow = {
  messageId: string;
  senderName: string;
  senderType: 'user' | 'agent' | 'system';
  target: string;
  content: string;
  seq: number;
  createdAt: number;
  attachmentIds: string | null;
};

type DmTaskHandoffState = {
  primaryConversationId: string;
  primaryTarget: string;
  threadTarget: string;
  threadConversationId: string | null;
  taskNumber: number;
  handoffStarted: boolean;
  handoffError?: string | null;
};

type BoundTaskThreadContext = {
  channelId: string;
  replyTarget: string;
  threadRootId: string;
  rootMessageId: string | null;
  boundTask: BoundThreadTask;
};

type RunActivationMetadata = {
  mentionSuppression?: {
    mode: 'root_user_multi_mention';
    triggerSeq: number;
    peerMentionedAgentIds: string[];
  };
  triggerMessage?: {
    messageId: string;
    seq: number;
    target: string;
  };
};

type TaskHistoryEventRow = {
  eventId: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  claimedByAgentIdAfter: string | null;
  claimedByNameAfter: string | null;
  messageId: string | null;
  threadTarget: string | null;
  createdAt: number;
};

function parseBoundedPositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function buildMessageScope(
  alias: string,
  channelId: string,
  threadRootId: string | null,
  target?: string,
): MessageScope {
  const params: Array<string | number> = [channelId];
  if (threadRootId !== null) {
    params.push(threadRootId);
    if (target?.startsWith('dm:@')) {
      params.push(target);
      return {
        clause: `${alias}.channel_id = ? AND (${alias}.thread_root_id = ? OR (${alias}.thread_root_id IS NULL AND ${alias}.target = ?))`,
        params,
      };
    }
    return {
      clause: `${alias}.channel_id = ? AND ${alias}.thread_root_id = ?`,
      params,
    };
  }

  return {
    clause: `${alias}.channel_id = ? AND ${alias}.thread_root_id IS NULL`,
    params,
  };
}

function buildFtsMatchQuery(rawQuery: string): string {
  return rawQuery
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' AND ');
}

/** 获取 task 对应消息之前的 K 条主线消息作为上下文 */
function fetchTaskContext(db: Db, channelId: string, messageId: string, limit = 8): ContextMsg[] {
  const seqRow = db.prepare(
    `SELECT seq FROM channel_messages WHERE message_id = ?`,
  ).get(messageId) as { seq: number } | undefined;
  if (!seqRow) return [];

  return (db.prepare(
    `SELECT cm.sender_name as senderName, cm.sender_type as senderType,
            cm.content, cm.seq
     FROM channel_messages cm
     WHERE cm.channel_id = ? AND cm.seq < ? AND cm.thread_root_id IS NULL
     ORDER BY cm.seq DESC LIMIT ?`,
  ).all(channelId, seqRow.seq, limit) as ContextMsg[]).reverse();
}

function doesThreadRootExist(db: Db, channelId: string, threadRootId: string): boolean {
  return Boolean(findThreadRootMessageId(db, channelId, threadRootId));
}

function getRunActivationMetadata(db: Db, runId: string | null): RunActivationMetadata | null {
  if (!runId) return null;
  const row = db.prepare(
    `SELECT activation_metadata_json as activationMetadataJson
     FROM run_debug_inputs
     WHERE run_id = ?
     LIMIT 1`,
  ).get(runId) as { activationMetadataJson: string | null } | undefined;
  if (!row?.activationMetadataJson) return null;
  try {
    const parsed = JSON.parse(row.activationMetadataJson) as RunActivationMetadata;
    const result: RunActivationMetadata = {};
    const mentionSuppression = parsed?.mentionSuppression;
    if (
      mentionSuppression?.mode === 'root_user_multi_mention'
      && Number.isFinite(mentionSuppression.triggerSeq)
      && Array.isArray(mentionSuppression.peerMentionedAgentIds)
    ) {
      const peerMentionedAgentIds = mentionSuppression.peerMentionedAgentIds
        .filter((agentId): agentId is string => typeof agentId === 'string' && agentId.trim().length > 0);
      if (peerMentionedAgentIds.length > 0) {
        result.mentionSuppression = {
          mode: 'root_user_multi_mention',
          triggerSeq: mentionSuppression.triggerSeq,
          peerMentionedAgentIds,
        };
      }
    }
    const triggerMessage = parsed?.triggerMessage;
    if (
      triggerMessage
      && typeof triggerMessage.messageId === 'string'
      && triggerMessage.messageId.trim()
      && Number.isFinite(triggerMessage.seq)
      && typeof triggerMessage.target === 'string'
      && triggerMessage.target.trim()
    ) {
      result.triggerMessage = {
        messageId: triggerMessage.messageId.trim(),
        seq: triggerMessage.seq,
        target: triggerMessage.target.trim(),
      };
    }
    return result.mentionSuppression || result.triggerMessage ? result : null;
  } catch {
    return null;
  }
}

function fetchClaimableMessageById(
  db: Db,
  channelId: string,
  messageId: string,
): ClaimableMessageRow | null {
  const row = db.prepare(
    `SELECT message_id as messageId, content, thread_root_id as threadRootId, sender_type as senderType, sender_name as senderName,
            target, seq, created_at as createdAt, attachment_ids as attachmentIds
     FROM channel_messages
     WHERE channel_id = ? AND message_id = ?
     LIMIT 1`,
  ).get(channelId, messageId) as ClaimableMessageRow | undefined;
  return row ?? null;
}

function fetchLatestTopLevelUserMessageForTarget(
  db: Db,
  channelId: string,
  target: string,
  beforeTimestamp?: number,
): ClaimableMessageRow | null {
  // 当指定 beforeTimestamp 时，只查找该时间点之前的消息（用于定位触发当前 run 的消息）
  if (beforeTimestamp != null) {
    const row = db.prepare(
      `SELECT message_id as messageId, content, thread_root_id as threadRootId, sender_type as senderType, sender_name as senderName,
              target, seq, created_at as createdAt, attachment_ids as attachmentIds
       FROM channel_messages
       WHERE channel_id = ?
         AND target = ?
         AND thread_root_id IS NULL
         AND sender_type = 'user'
         AND created_at <= ?
       ORDER BY seq DESC
       LIMIT 1`,
    ).get(channelId, target, beforeTimestamp) as ClaimableMessageRow | undefined;
    return row ?? null;
  }
  const row = db.prepare(
    `SELECT message_id as messageId, content, thread_root_id as threadRootId, sender_type as senderType, sender_name as senderName,
            target, seq, created_at as createdAt, attachment_ids as attachmentIds
     FROM channel_messages
     WHERE channel_id = ?
       AND target = ?
       AND thread_root_id IS NULL
       AND sender_type = 'user'
     ORDER BY seq DESC
     LIMIT 1`,
  ).get(channelId, target) as ClaimableMessageRow | undefined;
  return row ?? null;
}

function getRunStartedAt(db: Db, runId: string): number | null {
  const row = db.prepare('SELECT started_at FROM runs WHERE run_id = ?').get(runId) as { started_at: number } | undefined;
  return row?.started_at ?? null;
}

function resolveRunTriggerMessage(
  db: Db,
  runId: string | null,
  channelId: string,
  target: string,
): ClaimableMessageRow | null {
  const activationMetadata = getRunActivationMetadata(db, runId);
  const triggerMessageId = activationMetadata?.triggerMessage?.messageId;
  if (triggerMessageId) {
    const row = fetchClaimableMessageById(db, channelId, triggerMessageId);
    if (row && row.target === target && row.threadRootId === null && row.senderType === 'user') {
      return row;
    }
  }
  const runStartedAt = runId ? getRunStartedAt(db, runId) : null;
  return fetchLatestTopLevelUserMessageForTarget(db, channelId, target, runStartedAt ?? undefined);
}

function isKnownDmTargetPeer(db: Db, target: string): boolean {
  const match = target.match(/^dm:@([^:]+)(?::[a-zA-Z0-9-]+)?$/);
  if (!match) return false;
  const name = match[1];
  const userRow = db.prepare(
    `SELECT 1 FROM users WHERE username = ? LIMIT 1`,
  ).get(name) as { 1: number } | undefined;
  if (userRow) return true;
  const agentRow = db.prepare(
    `SELECT 1 FROM agents WHERE name = ? LIMIT 1`,
  ).get(name) as { 1: number } | undefined;
  return Boolean(agentRow);
}

/**
 * Registers internal agent API routes — used by channel-bridge MCP server.
 *
 * These endpoints let agents (via the channel-bridge) send messages to channels,
 * poll for new messages, browse the server directory, and manage task boards.
 */
export function registerInternalAgentRoutes(
  app: FastifyInstance,
  db: Db,
  conversationManager: ConversationManager,
  broadcastToAgent: (agentId: string, event: ServerEvent, conversationId?: string) => void,
  broadcastToChannel: (channelId: string, event: ServerEvent) => void,
  broadcastConversationStatus: (conversationId: string, status: ConversationStatus) => void,
  humanUserName: string,
  skillsService?: AgentSkillsService,
  internalAuthToken?: string,
  attachmentsDir?: string,
): void {
  const runThreadSendOverrides = new Map<string, string>();
  const runDmTaskHandoffs = new Map<string, DmTaskHandoffState>();
  const runBoundTaskFinalReplySent = new Set<string>();

  const buildDmTaskThreadTarget = (primaryTarget: string, messageId: string) => `${primaryTarget}:${buildThreadShortId(messageId)}`;

  // 从任意 DM 会话（primary 或 task-thread）提取 canonical peer（如 dm:@userName）
  const resolveDmConversationPeer = (
    agentIdParam: string,
    channelId: string,
    conversationId: string | undefined,
  ): string => {
    const conv = typeof conversationId === 'string' && conversationId.trim()
      ? conversationManager.getConversation(conversationId.trim())
      : null;
    if (!conv) return '';
    if (conv.agentId !== agentIdParam) return '';
    if (conv.threadKind !== 'direct') return '';
    if (channelId !== `dm:${agentIdParam}`) return '';
    const replyTarget = (conv.replyTarget ?? resolveDefaultReplyTarget(db, conv.id, humanUserName) ?? '').trim();
    if (!replyTarget) return '';
    // dm:@peerName 或 dm:@peerName:threadShortId → 提取 dm:@peerName
    const peerMatch = replyTarget.match(/^dm:@[^:]+/);
    return peerMatch ? peerMatch[0] : replyTarget;
  };

  const nextSyntheticRunEventSeq = (runId: string): number => {
    const row = db.prepare(
      `SELECT COALESCE(MAX(seq), 0) as maxSeq
       FROM events
       WHERE run_id = ?`,
    ).get(runId) as { maxSeq: number } | undefined;
    return (row?.maxSeq ?? 0) + 1;
  };

  const markRunAsDmTaskHandedOff = (params: {
    runId: string;
    status: 'started' | 'failed';
    primaryTarget: string;
    threadTarget: string;
    threadConversationId: string | null;
    taskNumber: number;
    error?: string | null;
  }) => {
    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, ?, ?, ?)`,
    ).run(
      params.runId,
      nextSyntheticRunEventSeq(params.runId),
      DM_TASK_HANDOFF_EVENT_METHOD,
      JSON.stringify({
        status: params.status,
        primaryTarget: params.primaryTarget,
        threadTarget: params.threadTarget,
        threadConversationId: params.threadConversationId,
        taskNumber: params.taskNumber,
        ...(params.error ? { error: params.error } : {}),
      }),
      Date.now(),
    );
  };

  const buildDmTaskHandoffBlockedError = (handoff: DmTaskHandoffState): string => {
    if (handoff.handoffStarted) {
      return `This run already handed off DM task work to ${handoff.threadTarget}. Do not continue work in ${handoff.primaryTarget}; the platform mirrors task status there and detailed execution belongs in the task thread conversation.`;
    }
    return `This run already attempted DM task handoff for ${handoff.threadTarget}, but the handoff failed (${handoff.handoffError ?? 'unknown error'}). Do not continue detailed work in ${handoff.primaryTarget}; ask the user to retry or open the task thread instead.`;
  };

  const fetchPersistedRunDmTaskHandoff = (runId: string, conversationId: string): DmTaskHandoffState | null => {
    const row = db.prepare(
      `SELECT payload_json as payloadJson
       FROM events
       WHERE run_id = ? AND method = ?
       ORDER BY seq DESC
       LIMIT 1`,
    ).get(runId, DM_TASK_HANDOFF_EVENT_METHOD) as { payloadJson: string } | undefined;
    if (!row?.payloadJson) return null;
    try {
      const payload = JSON.parse(row.payloadJson) as {
        status?: unknown;
        primaryTarget?: unknown;
        threadTarget?: unknown;
        threadConversationId?: unknown;
        taskNumber?: unknown;
        error?: unknown;
      };
      if (payload.status !== 'started' && payload.status !== 'failed') return null;
      if (typeof payload.primaryTarget !== 'string' || !payload.primaryTarget.trim()) return null;
      if (typeof payload.threadTarget !== 'string' || !payload.threadTarget.trim()) return null;
      if (typeof payload.taskNumber !== 'number' || !Number.isFinite(payload.taskNumber)) return null;
      return {
        primaryConversationId: conversationId,
        primaryTarget: payload.primaryTarget,
        threadTarget: payload.threadTarget,
        threadConversationId: typeof payload.threadConversationId === 'string' ? payload.threadConversationId : null,
        taskNumber: Math.floor(payload.taskNumber),
        handoffStarted: payload.status === 'started',
        ...(typeof payload.error === 'string' && payload.error.trim() ? { handoffError: payload.error } : {}),
      };
    } catch {
      return null;
    }
  };

  const getActiveRunHandoff = (conversationId?: string | null): { runId: string; handoff: DmTaskHandoffState } | null => {
    if (!conversationId) return null;
    const runId = findActiveConversationRunId(db, conversationId);
    if (!runId) return null;
    const handoff = runDmTaskHandoffs.get(runId) ?? fetchPersistedRunDmTaskHandoff(runId, conversationId);
    if (!handoff) return null;
    runDmTaskHandoffs.set(runId, handoff);
    return { runId, handoff };
  };

  const getBoundTaskThreadContext = (conversationId?: string | null): BoundTaskThreadContext | null => {
    if (!conversationId) return null;
    const conversation = conversationManager.getConversation(conversationId);
    if (!conversation) return null;

    const replyTarget = (resolveDefaultReplyTarget(db, conversationId, humanUserName) ?? conversation.replyTarget ?? '').trim();
    if (!replyTarget) return null;
    const threadRootId = resolveThreadRootId(replyTarget) ?? conversation.threadRootId ?? null;
    if (!threadRootId) return null;

    const channelId = conversation.threadKind === 'direct'
      ? (conversation.agentId ? `dm:${conversation.agentId}` : null)
      : (conversation.channelId ?? null);
    if (!channelId) return null;

    const summary = getThreadCollaborationSummary(db, { channelId, threadRootId });
    if (!summary.boundTask) return null;

    return {
      channelId,
      replyTarget,
      threadRootId,
      rootMessageId: findThreadRootMessageId(db, channelId, threadRootId),
      boundTask: summary.boundTask,
    };
  };

  const buildBoundTaskThreadReclaimError = (boundTask: BoundThreadTask): string => (
    `This thread is already bound to #${boundTask.taskNumber} "${boundTask.title}". Do not claim it again here; continue the work in this thread and update its status when appropriate.`
  );

  const getLatestConversationDispatchState = (conversationId: string): { queueId: number | null; runId: string | null } => {
    const queuedPrompt = db.prepare(
      `SELECT queue_id as queueId
       FROM conversation_prompt_queue
       WHERE conversation_id = ?
       ORDER BY queue_id DESC
       LIMIT 1`,
    ).get(conversationId) as { queueId: number } | undefined;
    const existingRun = db.prepare(
      `SELECT r.run_id as runId
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ?
       ORDER BY r.started_at DESC
       LIMIT 1`,
    ).get(conversationId) as { runId: string } | undefined;
    return {
      queueId: queuedPrompt?.queueId ?? null,
      runId: existingRun?.runId ?? null,
    };
  };

  const fetchTaskMessageBroadcastRow = (messageId: string): TaskMessageBroadcastRow | null => {
    const row = db.prepare(
      `SELECT message_id as messageId,
              sender_name as senderName,
              sender_type as senderType,
              target,
              content,
              seq,
              created_at as createdAt,
              attachment_ids as attachmentIds
       FROM channel_messages
       WHERE message_id = ?
       LIMIT 1`,
    ).get(messageId) as TaskMessageBroadcastRow | undefined;
    return row ?? null;
  };

  const broadcastPrimaryDmEvent = (agentId: string, primaryTarget: string, event: BroadcastChannelMessage) => {
    const conversationId = findConversationIdForReplyTarget(db, agentId, primaryTarget);
    if (conversationId) {
      broadcastToAgent(agentId, event, conversationId);
    }
  };

  const broadcastDmTaskRootUpdate = (params: {
    agentId: string;
    primaryTarget: string;
    messageId: string;
    taskNumber: number;
    taskStatus: string;
    taskAssigneeName: string | null;
  }) => {
    const message = fetchTaskMessageBroadcastRow(params.messageId);
    if (!message) return;
    broadcastPrimaryDmEvent(params.agentId, params.primaryTarget, {
      type: 'channel.message',
      message: {
        id: message.messageId,
        senderName: message.senderName,
        senderType: message.senderType,
        content: message.content,
        createdAt: new Date(message.createdAt).toISOString(),
        seq: message.seq,
        taskNumber: params.taskNumber,
        taskStatus: params.taskStatus,
        taskAssigneeName: params.taskAssigneeName,
        ...(message.attachmentIds ? { attachmentIds: JSON.parse(message.attachmentIds) as string[] } : {}),
      },
    });
  };

  const buildDmTaskLifecycleText = (params: {
    kind: 'started' | 'in_review' | 'done' | 'handoff_failed';
    taskNumber: number;
    title: string;
  }): string => {
    const label = `#${params.taskNumber} "${params.title}"`;
    switch (params.kind) {
      case 'started':
        return `Started ${label}. Detailed work continues in the task thread.`;
      case 'in_review':
        return `${label} moved to in review.`;
      case 'done':
        return `${label} marked done.`;
      case 'handoff_failed':
        return `${label} could not start its task thread automatically.`;
      default:
        return label;
    }
  };

  const emitDmTaskLifecycleEvent = (params: {
    agentId: string;
    primaryTarget: string;
    taskNumber: number;
    title: string;
    taskStatus: string;
    kind: 'started' | 'in_review' | 'done' | 'handoff_failed';
    taskAssigneeName?: string | null;
  }) => {
    const channelId = `dm:${params.agentId}`;
    const now = Date.now();
    const messageId = randomUUID();
    const seq = allocateNextChannelMessageSeq(db, channelId);
    const content = buildDmTaskLifecycleText(params);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id, message_kind, message_source)
       VALUES(?, ?, 'system', 'system', 'system', ?, ?, ?, ?, NULL, 'task_event', ?)`,
    ).run(
      messageId,
      channelId,
      params.primaryTarget,
      content,
      seq,
      now,
      DM_TASK_LIFECYCLE_SOURCE,
    );
    broadcastPrimaryDmEvent(params.agentId, params.primaryTarget, {
      type: 'channel.message',
      message: {
        id: messageId,
        senderName: 'system',
        senderType: 'system',
        content,
        createdAt: new Date(now).toISOString(),
        seq,
        messageSource: DM_TASK_LIFECYCLE_SOURCE,
        taskNumber: params.taskNumber,
        taskStatus: params.taskStatus,
        taskAssigneeName: params.taskAssigneeName ?? null,
      },
    });
  };

  const buildDmTaskHandoffPrompt = (params: {
    taskNumber: number;
    title: string;
    description: string;
    threadTarget: string;
    rootMessageId: string;
    triggerMessage?: ClaimableMessageRow | null;
  }): string => {
    const lines = [
      '[DM Task Thread Handoff]',
      'A task was just created or claimed from the main DM. Execution now continues in this task thread as the expected next phase.',
      '',
      '[Current conversation target]',
      `reply_target: ${params.threadTarget}`,
      `Task: #${params.taskNumber} ${params.title}`,
      `Task thread target: ${params.threadTarget}`,
      `Task root message id: ${params.rootMessageId}`,
      '',
      'Task brief / goal / done criteria:',
      params.description,
    ];
    if (params.triggerMessage?.content?.trim()) {
      lines.push(
        '',
        '[Triggered message metadata]',
        `target: ${params.triggerMessage.target}`,
        `sender: @${params.triggerMessage.senderName}`,
        '',
        '[Triggered message body]',
        params.triggerMessage.content,
      );
    }
    lines.push(
      '',
      'Rules:',
      '- This task thread is now the primary work surface for the task.',
      '- The task already exists and is already claimed for this run. Do not call claim_tasks or claim_message again for the same task in this thread.',
      '- Put substantive progress updates, tool results, and the final answer in this thread.',
      '- Send one substantive final result for the task. After that, update the task to in_review unless the work is trivial or a human explicitly approved done.',
      '- Do not append a second redundant completion-summary message after the substantive final result.',
      '- Do not send any manual follow-up in the main DM after this handoff.',
      '- The platform will mirror task lifecycle status in the main DM separately.',
      '- Start working on the task now.',
    );
    return lines.join('\n');
  };

  const startDmTaskHandoff = async (params: {
    agentId: string;
    currentConversationId: string | null;
    currentConversationRunId: string | null;
    currentPrimaryDmTarget: string;
    taskId: string;
    agentTaskRef: string | null;
    taskNumber: number;
    title: string;
    description: string;
    messageId: string;
    triggerMessage?: ClaimableMessageRow | null;
  }): Promise<{
    handoffStarted: boolean;
    threadConversationId: string | null;
    threadTarget: string;
    handoffError?: string;
  }> => {
    const threadTarget = buildDmTaskThreadTarget(params.currentPrimaryDmTarget, params.messageId);
    let threadConversationId: string | null = null;
    const closePrimaryRun = (handoffStarted: boolean, handoffError?: string) => {
      if (!params.currentConversationId || !params.currentConversationRunId) return;
      runThreadSendOverrides.delete(params.currentConversationRunId);
      runDmTaskHandoffs.set(params.currentConversationRunId, {
        primaryConversationId: params.currentConversationId,
        primaryTarget: params.currentPrimaryDmTarget,
        threadTarget,
        threadConversationId,
        taskNumber: params.taskNumber,
        handoffStarted,
        ...(handoffError ? { handoffError } : {}),
      });
      markRunAsDmTaskHandedOff({
        runId: params.currentConversationRunId,
        status: handoffStarted ? 'started' : 'failed',
        primaryTarget: params.currentPrimaryDmTarget,
        threadTarget,
        threadConversationId,
        taskNumber: params.taskNumber,
        ...(handoffError ? { error: handoffError } : {}),
      });
      conversationManager.cancelConversationRun(params.currentConversationId);
    };
    threadConversationId = ensureConversationIdForReplyTarget(
      db,
      conversationManager,
      params.agentId,
      threadTarget,
    );
    if (!threadConversationId) {
      const handoffError = `Failed to open task thread conversation for ${threadTarget}`;
      appendTaskEvent(db, {
        taskId: params.taskId,
        agentTaskRef: params.agentTaskRef,
        channelId: `dm:${params.agentId}`,
        taskNumber: params.taskNumber,
        eventType: 'handoff_failed',
        actorType: 'system',
        actorName: 'system',
        claimedByAgentIdAfter: params.agentId,
        claimedByNameAfter: conversationManager.getAgent(params.agentId)?.name ?? null,
        messageId: params.messageId,
        threadTarget,
      });
      emitDmTaskLifecycleEvent({
        agentId: params.agentId,
        primaryTarget: params.currentPrimaryDmTarget,
        taskNumber: params.taskNumber,
        title: params.title,
        taskStatus: 'in_progress',
        kind: 'handoff_failed',
      });
      closePrimaryRun(false, handoffError);
      return {
        handoffStarted: false,
        threadConversationId: null,
        threadTarget,
        handoffError,
      };
    }
    const beforeDispatchState = getLatestConversationDispatchState(threadConversationId);
    const rootMessageRow = db.prepare(
      `SELECT seq
       FROM channel_messages
       WHERE channel_id = ?
         AND message_id = ?
       LIMIT 1`,
    ).get(`dm:${params.agentId}`, params.messageId) as { seq: number } | undefined;
    const threadActivationContext = rootMessageRow
      ? buildTargetActivationContext(db, {
          agentId: params.agentId,
          channelId: `dm:${params.agentId}`,
          replyTarget: threadTarget,
          triggerSeq: rootMessageRow.seq + 1,
          threadRootId: buildThreadShortId(params.messageId),
        })
      : null;
    try {
      const result = await conversationManager.submitPrompt(
        threadConversationId,
        buildDmTaskHandoffPrompt({
          taskNumber: params.taskNumber,
          title: params.title,
          description: params.description,
          threadTarget,
          rootMessageId: params.messageId,
          triggerMessage: params.triggerMessage,
        }),
        {
          recordAsUserMessage: false,
          activationContextText: threadActivationContext
            ? buildDirectActivationContextText({
                target: threadTarget,
                recentMessages: threadActivationContext.recentMessages,
                unreadCount: threadActivationContext.unreadCount,
                oldestVisibleSeq: threadActivationContext.oldestVisibleSeq,
                rootMessage: threadActivationContext.rootMessage,
                dmContextSnapshot: threadActivationContext.dmContextSnapshot,
              })
            : undefined,
          activationMetadata: {
            expectedTermination: {
              kind: 'dm_handoff_bootstrap',
              stopReason: 'handoff_bootstrap',
            },
          },
        },
      );
      if (result.queued) {
        broadcastConversationStatus(threadConversationId, 'queued');
      }
      appendTaskEvent(db, {
        taskId: params.taskId,
        agentTaskRef: params.agentTaskRef,
        channelId: `dm:${params.agentId}`,
        taskNumber: params.taskNumber,
        eventType: 'handoff_started',
        actorType: 'system',
        actorName: 'system',
        claimedByAgentIdAfter: params.agentId,
        claimedByNameAfter: conversationManager.getAgent(params.agentId)?.name ?? null,
        messageId: params.messageId,
        threadTarget,
      });
      emitDmTaskLifecycleEvent({
        agentId: params.agentId,
        primaryTarget: params.currentPrimaryDmTarget,
        taskNumber: params.taskNumber,
        title: params.title,
        taskStatus: 'in_progress',
        kind: 'started',
        taskAssigneeName: conversationManager.getAgent(params.agentId)?.name ?? null,
      });
      closePrimaryRun(true);
      return { handoffStarted: true, threadConversationId, threadTarget };
    } catch (error) {
      const afterDispatchState = getLatestConversationDispatchState(threadConversationId);
      if (
        (afterDispatchState.queueId !== null && afterDispatchState.queueId !== beforeDispatchState.queueId)
        || (afterDispatchState.runId !== null && afterDispatchState.runId !== beforeDispatchState.runId)
      ) {
        appendTaskEvent(db, {
          taskId: params.taskId,
          agentTaskRef: params.agentTaskRef,
          channelId: `dm:${params.agentId}`,
          taskNumber: params.taskNumber,
          eventType: 'handoff_started',
          actorType: 'system',
          actorName: 'system',
          claimedByAgentIdAfter: params.agentId,
          claimedByNameAfter: conversationManager.getAgent(params.agentId)?.name ?? null,
          messageId: params.messageId,
          threadTarget,
        });
        emitDmTaskLifecycleEvent({
          agentId: params.agentId,
          primaryTarget: params.currentPrimaryDmTarget,
          taskNumber: params.taskNumber,
          title: params.title,
          taskStatus: 'in_progress',
          kind: 'started',
          taskAssigneeName: conversationManager.getAgent(params.agentId)?.name ?? null,
        });
        closePrimaryRun(true);
        return { handoffStarted: true, threadConversationId, threadTarget };
      }
      const handoffError = String((error as Error)?.message ?? error);
      appendTaskEvent(db, {
        taskId: params.taskId,
        agentTaskRef: params.agentTaskRef,
        channelId: `dm:${params.agentId}`,
        taskNumber: params.taskNumber,
        eventType: 'handoff_failed',
        actorType: 'system',
        actorName: 'system',
        claimedByAgentIdAfter: params.agentId,
        claimedByNameAfter: conversationManager.getAgent(params.agentId)?.name ?? null,
        messageId: params.messageId,
        threadTarget,
      });
      emitDmTaskLifecycleEvent({
        agentId: params.agentId,
        primaryTarget: params.currentPrimaryDmTarget,
        taskNumber: params.taskNumber,
        title: params.title,
        taskStatus: 'in_progress',
        kind: 'handoff_failed',
      });
      closePrimaryRun(false, handoffError);
      return {
        handoffStarted: false,
        threadConversationId,
        threadTarget,
        handoffError,
      };
    }
  };

  const broadcastChannelTasksChanged = (channelId: string) => {
    broadcastToChannel(channelId, {
      type: 'channel.tasks.changed',
      channelId,
      changedAt: Date.now(),
    });
  };

  const normalizeRequiredText = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };

  const deriveTaskTitle = (
    explicitTitle: unknown,
    fallbackContent?: string | null,
  ): string | null => {
    const normalizedTitle = normalizeRequiredText(explicitTitle);
    if (normalizedTitle) return normalizedTitle;
    const fallback = normalizeRequiredText(fallbackContent);
    return fallback ? fallback.slice(0, 120) : null;
  };

  const shouldSyncTaskRootMessageContent = (
    task: { messageId: string | null; taskCreatedAt: number; messageCreatedAt: number | null },
  ): boolean => !!task.messageId && task.messageCreatedAt === task.taskCreatedAt;

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/internal/agent/')) return;
    if (!internalAuthToken) return;
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (token !== internalAuthToken) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // ─── Messaging ───────────────────────────────────────────────────────────

  /**
   * POST /api/internal/agent/:agentId/send
   * Send a message to a target (channel, DM, or thread).
   * Body: { target: string; content: string; attachmentIds?: string[] }
   */
  app.post<{
    Params: { agentId: string };
    Body: {
      target?: string;
      content: string;
      kind?: 'progress' | 'final';
      attachmentIds?: string[];
      conversationId?: string;
    };
  }>('/api/internal/agent/:agentId/send', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { target, content, kind, conversationId, attachmentIds } = req.body ?? {};
    const explicitTarget = target?.trim() || null;
    const normalizedContent = typeof content === 'string' ? content.trim() : '';
    if (!normalizedContent) {
      reply.code(400);
      return { error: 'content must not be empty' };
    }
    if (kind && kind !== 'progress' && kind !== 'final') {
      reply.code(400);
      return { error: 'kind must be "progress" or "final"' };
    }

    if (conversationId) {
      const conversation = conversationManager.getConversation(conversationId);
      if (!conversation || conversation.agentId !== agentId) {
        reply.code(400);
        return { error: 'conversationId does not belong to this agent' };
      }
    }

    const activeRunId = conversationId ? findActiveConversationRunId(db, conversationId) : null;
    const activeRunActivationMetadata = getRunActivationMetadata(db, activeRunId);
    const activeConversationHandoff = getActiveRunHandoff(conversationId);
    if (activeConversationHandoff) {
      reply.code(409);
      return { error: buildDmTaskHandoffBlockedError(activeConversationHandoff.handoff) };
    }
    const boundTaskThreadContext = getBoundTaskThreadContext(conversationId);
    if (activeRunId && boundTaskThreadContext?.boundTask && runBoundTaskFinalReplySent.has(activeRunId)) {
      reply.code(409);
      return {
        error: `This task-thread run already sent its substantive final reply for #${boundTaskThreadContext.boundTask.taskNumber}. Update the task status or stop instead of sending another user-visible message.`,
      };
    }
    const defaultTarget = conversationId ? resolveDefaultReplyTarget(db, conversationId, humanUserName) : null;
    const initialTarget = target?.trim() || (activeRunId ? runThreadSendOverrides.get(activeRunId) : null) || defaultTarget;
    if (!initialTarget) {
      reply.code(400);
      return { error: 'target is required unless conversationId is provided for the current conversation reply' };
    }
    const resolvedTarget = conversationId
      ? normalizeTargetForConversation(db, conversationId, initialTarget)
      : initialTarget;

    if (explicitTarget !== null && resolvedTarget.startsWith('dm:') && !isKnownDmTargetPeer(db, resolvedTarget)) {
      reply.code(400);
      return { error: `Cannot resolve DM target: ${resolvedTarget}` };
    }

    // For DM targets that don't resolve to a known agent (e.g. dm:@User — a human),
    // fall back to the sending agent's own DM channel so the reply is visible to frontend.
    const channelId = resolveChannelFromTarget(resolvedTarget, db) ?? (resolvedTarget.startsWith('dm:') ? `dm:${agentId}` : null);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel from target: ${resolvedTarget}` };
    }

    const now = Date.now();
    const messageId = randomUUID();
    const seq = allocateNextChannelMessageSeq(db, channelId);
    const runId = activeRunId;
    const threadRootId = resolveThreadRootId(resolvedTarget);
    const isCurrentConversationTarget = Boolean(conversationId && defaultTarget && resolvedTarget === defaultTarget);
    if (threadRootId && !isCurrentConversationTarget && !doesThreadRootExist(db, channelId, threadRootId)) {
      reply.code(400);
      return { error: `Thread root not found for target: ${resolvedTarget}` };
    }
    if (activeRunId && explicitTarget !== null) {
      if (threadRootId) {
        runThreadSendOverrides.set(activeRunId, resolvedTarget);
      } else {
        runThreadSendOverrides.delete(activeRunId);
      }
    }
    const attachmentIdsJson = Array.isArray(attachmentIds) && attachmentIds.length > 0
      ? JSON.stringify(attachmentIds)
      : null;
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id, message_kind, message_source, attachment_ids)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      messageId,
      channelId,
      agentId,
      agent.name,
      resolvedTarget,
      normalizedContent,
      seq,
      now,
      runId,
      threadRootId,
      kind ?? null,
      'agent_send',
      attachmentIdsJson,
    );
    if (activeRunId && boundTaskThreadContext?.boundTask && kind === 'final') {
      runBoundTaskFinalReplySent.add(activeRunId);
    }

    if (!channelId.startsWith('dm:')) {
      upsertTargetParticipant(db, {
        agentId,
        channelId,
        threadRootId,
        role: threadRootId ? 'participant' : 'participant',
        lastActiveAt: now,
      });
    }

    const channelMessageEvent: ServerEvent = {
      type: 'channel.message',
      message: {
        id: messageId,
        senderName: agent.name,
        senderType: 'agent',
        content: normalizedContent,
        createdAt: new Date(now).toISOString(),
        seq,
        ...(threadRootId ? { threadRootId } : {}),
      },
    };

    const targetConversationId = isCurrentConversationTarget && conversationId
      ? conversationId
      : ensureConversationIdForReplyTarget(
        db,
        conversationManager,
        agentId,
        resolvedTarget,
      );
    if (targetConversationId) {
      broadcastToAgent(agentId, channelMessageEvent, targetConversationId);
    }

    // Public channels (not DMs) also broadcast to channel-level WS subscribers
    if (!channelId.startsWith('dm:')) {
      broadcastToChannel(channelId, channelMessageEvent);
    }

    if (!channelId.startsWith('dm:')) {
      const channel = conversationManager.getChannel(channelId);
      const mentionableAgents = conversationManager
        .listAgents(channelId)
        .filter((candidate) => candidate.agentId !== agentId);
      const mentionedAgents = findMentionedAgents(normalizedContent, mentionableAgents);
      const suppressedPeerMentionAgentIds = !threadRootId
        && activeRunActivationMetadata?.mentionSuppression?.mode === 'root_user_multi_mention'
          ? new Set(activeRunActivationMetadata.mentionSuppression.peerMentionedAgentIds)
          : null;
      const pendingNotifications = new Map<string, { reason: 'thread_reply' | 'agent_mention'; role: 'owner' | 'participant' }>();
      const reasonPriority = (reason: 'thread_reply' | 'agent_mention'): number => (
        reason === 'agent_mention' ? 2 : 1
      );
      const rolePriority = (role: 'owner' | 'participant'): number => (
        role === 'owner' ? 2 : 1
      );
      const queueAgentNotification = (
        targetAgentId: string,
        reason: 'thread_reply' | 'agent_mention',
        role: 'owner' | 'participant',
      ): void => {
        if (targetAgentId === agentId) return;
        const existing = pendingNotifications.get(targetAgentId);
        if (!existing) {
          pendingNotifications.set(targetAgentId, { reason, role });
          return;
        }
        pendingNotifications.set(targetAgentId, {
          reason: reasonPriority(reason) > reasonPriority(existing.reason) ? reason : existing.reason,
          role: rolePriority(role) > rolePriority(existing.role) ? role : existing.role,
        });
      };

      if (threadRootId) {
        const summary = getThreadCollaborationSummary(db, {
          channelId,
          threadRootId,
        });
        const recentParticipants = listRecentTargetParticipants(db, {
          channelId,
          threadRootId,
          activeSince: now - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
        });
        const normalizedRecentParticipants = summary.boundTask?.status === 'done'
          ? recentParticipants.map((participant) => ({
              ...participant,
              role: 'participant' as const,
            }))
          : recentParticipants;

        if (summary.ownerAgentId) {
          queueAgentNotification(summary.ownerAgentId, 'thread_reply', 'owner');
        }

        if (normalizedRecentParticipants.length === 0 && !summary.ownerAgentId) {
          const rootMessageId = findThreadRootMessageId(db, channelId, threadRootId);
          const rootMsg = rootMessageId
            ? (db.prepare(
              `SELECT sender_id as senderId, sender_type as senderType
               FROM channel_messages
               WHERE channel_id = ? AND message_id = ?
               LIMIT 1`,
            ).get(channelId, rootMessageId) as { senderId: string; senderType: string } | undefined)
            : undefined;
          if (rootMsg?.senderType === 'agent') {
            queueAgentNotification(rootMsg.senderId, 'thread_reply', 'owner');
          }
        } else {
          for (const participant of normalizedRecentParticipants) {
            queueAgentNotification(participant.agentId, 'thread_reply', participant.role);
          }
        }
      }

      for (const mentionedAgent of mentionedAgents) {
        if (suppressedPeerMentionAgentIds?.has(mentionedAgent.agentId)) {
          continue;
        }
        if (!shouldTriggerAgentMention(db, {
          channelId,
          threadRootId,
          fromAgentId: agentId,
          toAgentId: mentionedAgent.agentId,
          now,
          cooldownMs: AGENT_MENTION_COOLDOWN_MS,
        })) {
          continue;
        }
        queueAgentNotification(mentionedAgent.agentId, 'agent_mention', 'participant');
      }

      for (const [targetAgentId, { role }] of pendingNotifications.entries()) {
        upsertTargetParticipant(db, {
          agentId: targetAgentId,
          channelId,
          threadRootId,
          role,
          lastActiveAt: now,
        });
      }

      for (const [targetAgentId, { reason }] of pendingNotifications.entries()) {
        const conv = conversationManager.openAgentChannelThread(targetAgentId, channelId, threadRootId ?? null);
        if (!conv || !channel) continue;

        const activationContext = buildTargetActivationContext(db, {
          agentId: targetAgentId,
          channelId,
          replyTarget: conv.replyTarget ?? resolvedTarget,
          triggerSeq: seq,
          threadRootId,
        });

        if (reason === 'agent_mention') {
          recordAgentMentionNotification(db, {
            channelId,
            threadRootId,
            fromAgentId: agentId,
            toAgentId: targetAgentId,
            notifiedAt: now,
          });

          const mentionedAgent = conversationManager.getAgent(targetAgentId);
          if (mentionedAgent) {
            broadcastToChannel(channelId, {
              type: 'channel.notice',
              notice: {
                message: `@${mentionedAgent.name} was mentioned by @${agent.name} and notified.`,
                createdAt: new Date(now).toISOString(),
              },
            });
          }
        }

        conversationManager.submitPrompt(
          conv.id,
          buildChannelActivationPrompt({
            channelName: channel.name,
            target: resolvedTarget,
            replyTarget: activationContext.replyTarget,
            senderName: agent.name,
            content: normalizedContent,
            reason,
          }),
          {
            recordAsUserMessage: false,
            activationContextText: buildChannelActivationContextText({
              target: resolvedTarget,
              recentMessages: activationContext.recentMessages,
              rootMessage: activationContext.rootMessage,
              unreadCount: activationContext.unreadCount,
              oldestVisibleSeq: activationContext.oldestVisibleSeq,
              participants: activationContext.participants,
              boundTask: activationContext.boundTask,
              openTasks: activationContext.openTasks,
            }) || undefined,
            replayOverlapRecentMessages: activationContext.recentMessages,
          },
        ).then((result) => {
          if (result.queued) {
            broadcastConversationStatus(conv.id, 'queued');
          }
          bumpAgentMessageCheckpoint(db, targetAgentId, channelId, seq, threadRootId);
        }).catch(() => {});
      }
    }

    return { messageId, seq, runId, target: resolvedTarget, kind: kind ?? null };
  });

  /**
   * POST /api/internal/agent/:agentId/upload
   * Upload a file (image) and store it as an attachment.
   * Multipart form: file field + optional channelId text field.
   * Returns { id, filename, sizeBytes }.
   */
  app.post<{ Params: { agentId: string } }>(
    '/api/internal/agent/:agentId/upload',
    async (req, reply) => {
      const { agentId } = req.params;
      if (!conversationManager.getAgent(agentId)) {
        reply.code(404);
        return { error: 'Agent not found' };
      }
      if (!attachmentsDir) {
        reply.code(503);
        return { error: 'Attachment storage not configured' };
      }

      const data = await req.file();
      if (!data) { reply.code(400); return { error: 'No file uploaded' }; }

      const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedMimes.includes(data.mimetype)) {
        reply.code(400);
        return { error: `Unsupported file type: ${data.mimetype}. Allowed: JPEG, PNG, GIF, WebP` };
      }

      const buffer = await data.toBuffer();
      if (buffer.length > 5 * 1024 * 1024) {
        reply.code(400);
        return { error: 'File too large (max 5MB)' };
      }

      const id = randomUUID();
      const ext = extname(data.filename) || '.bin';
      const storagePath = join(attachmentsDir, `${id}${ext}`);
      writeFileSync(storagePath, buffer);

      // Optional channelId from form fields
      const fields = data.fields as Record<string, { value?: string }> | undefined;
      const channelId = fields?.channelId?.value ?? null;

      db.prepare(
        `INSERT INTO attachments(id, filename, mime_type, size_bytes, storage_path, channel_id, agent_id, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, data.filename, data.mimetype, buffer.length, storagePath, channelId, agentId, Date.now());

      return { id, filename: data.filename, sizeBytes: buffer.length };
    },
  );

  /**
   * GET /api/internal/agent/:agentId/receive
   * Poll for new messages since the agent's last-read checkpoint.
   * Returns immediately with pending messages (or empty array).
   */
  app.get<{ Params: { agentId: string }; Querystring: { channel?: string } }>(
    '/api/internal/agent/:agentId/receive',
    async (req, reply) => {
      const { agentId } = req.params;
      if (!conversationManager.getAgent(agentId)) {
        reply.code(404);
        return { error: 'Agent not found' };
      }

      // Query all channels the agent has joined, plus the user DM channel
      const agent = conversationManager.getAgent(agentId)!;
      const dmChannelId = `dm:${agentId}`;

      let channelsToQuery: string[];
      const channelFilter = req.query.channel?.trim();
      if (channelFilter) {
        const filteredId = resolveChannelFromTarget(channelFilter, db)
          ?? (channelFilter.startsWith('dm:') ? dmChannelId : null);
        if (!filteredId) {
          reply.code(400);
          return { error: `Cannot resolve channel: ${channelFilter}` };
        }
        const memberOf = new Set([...(agent.channelIds ?? []), dmChannelId]);
        channelsToQuery = memberOf.has(filteredId) ? [filteredId] : [];
      } else {
        channelsToQuery = Array.from(new Set([...(agent.channelIds ?? []), dmChannelId]));
      }

      let allRows: MessageRow[] = [];
      for (const channelId of channelsToQuery) {
        const threadKeys = Array.from(new Set(
          (db.prepare(
            `SELECT thread_root_id as threadRootId, target
             FROM channel_messages
             WHERE channel_id = ? AND sender_id != ?`,
          ).all(channelId, agentId) as Array<{ threadRootId: string | null; target: string }>)
            .map((row) => checkpointThreadKey(row.threadRootId ?? resolveThreadRootId(row.target))),
        )).sort();

        for (const threadKey of threadKeys) {
          const checkpoint = getAgentMessageCheckpoint(db, agentId, channelId, threadKey || null);
          const rows = (db
          .prepare(
            `SELECT cm.message_id as messageId, cm.channel_id as channelId, cm.sender_id as senderId,
                    cm.sender_name as senderName, cm.sender_type as senderType,
                    cm.target, cm.content, cm.seq, cm.created_at as createdAt, cm.thread_root_id as threadRootId,
                    t.task_number as taskNumber, t.status as taskStatus, t.claimed_by_name as taskAssigneeName
             FROM channel_messages cm
             LEFT JOIN tasks t ON t.message_id = cm.message_id
             WHERE cm.channel_id = ? AND cm.seq > ? AND cm.sender_id != ?
             ORDER BY cm.seq ASC
             LIMIT 200`,
          )
          .all(channelId, checkpoint, agentId) as MessageRow[])
            .map((row) => {
              const effectiveThreadRootId = row.threadRootId ?? resolveThreadRootId(row.target);
              return effectiveThreadRootId === row.threadRootId
                ? row
                : { ...row, threadRootId: effectiveThreadRootId };
            })
            .filter((row) => checkpointThreadKey(row.threadRootId) === threadKey)
            .slice(0, 50);

          allRows = allRows.concat(rows);
        }
      }

      // Merge and sort by createdAt
      const rows = allRows
        .sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq))
        .slice(0, 50);

      if (rows.length > 0) {
        const maxSeqByThread = new Map<string, { channelId: string; threadKey: string; maxSeq: number }>();
        for (const row of rows) {
          const threadKey = checkpointThreadKey(row.threadRootId);
          const aggregateKey = `${row.channelId}::${threadKey}`;
          const current = maxSeqByThread.get(aggregateKey);
          if (!current || row.seq > current.maxSeq) {
            maxSeqByThread.set(aggregateKey, { channelId: row.channelId, threadKey, maxSeq: row.seq });
          }
        }
        for (const { channelId, threadKey, maxSeq } of maxSeqByThread.values()) {
          setAgentMessageCheckpoint(db, agentId, channelId, maxSeq, threadKey || null);
        }
      }

      const messages = rows.map((r) => ({
        message_id: r.messageId,
        channel_id: r.channelId,
        sender_id: r.senderId,
        sender_name: r.senderName,
        sender_type: r.senderType,
        target: r.target,
        content: r.content,
        seq: r.seq,
        timestamp: new Date(r.createdAt).toISOString(),
        ...((r as MessageRow & { taskNumber?: number | null; taskStatus?: string | null; taskAssigneeName?: string | null }).taskNumber != null ? {
          task_number: (r as MessageRow & { taskNumber?: number | null }).taskNumber,
          task_status: (r as MessageRow & { taskStatus?: string | null }).taskStatus,
          task_assignee_name: (r as MessageRow & { taskAssigneeName?: string | null }).taskAssigneeName,
        } : {}),
      }));

      return { messages };
    },
  );

  /**
   * GET /api/internal/agent/:agentId/server
   * Returns channels (with joined status), other agents, and humans.
   */
  app.get<{ Params: { agentId: string } }>(
    '/api/internal/agent/:agentId/server',
    async (req, reply) => {
      const { agentId } = req.params;
      const agent = conversationManager.getAgent(agentId);
      if (!agent) {
        reply.code(404);
        return { error: 'Agent not found' };
      }

      const joinedSet = new Set(agent.channelIds ?? []);
      const channels = conversationManager.listChannels().map((ch) => ({
        name: ch.name,
        joined: joinedSet.has(ch.channelId),
        description: ch.description,
      }));

      const allAgents = conversationManager.listAgents().filter((a) => a.agentId !== agentId);
      const agents = allAgents.map((a) => ({
        name: a.name,
        status: 'online',
      }));

      const humanRows = db.prepare(
        `SELECT DISTINCT sender_name as name FROM channel_messages
         WHERE sender_type = 'user' ORDER BY created_at DESC LIMIT 20`,
      ).all() as Array<{ name: string }>;
      const humans = humanRows;

      return { channels, agents, humans };
    },
  );

  /**
   * GET /api/internal/agent/:agentId/history
   * Read message history for a target.
   * Query: channel (target string), limit?, before?, after?
   */
  app.get<{
    Params: { agentId: string };
    Querystring: { q: string; channel?: string; limit?: string };
  }>('/api/internal/agent/:agentId/search', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) {
      reply.code(400);
      return { error: 'q query parameter is required' };
    }

    const ftsQuery = buildFtsMatchQuery(query);
    if (!ftsQuery) {
      reply.code(400);
      return { error: 'q query parameter is required' };
    }

    const limit = parseBoundedPositiveInt(req.query.limit, 10, 20);
    const visibleChannelIds = Array.from(new Set([`dm:${agentId}`, ...(agent.channelIds ?? [])]));
    const whereParts: string[] = [`cm.channel_id IN (${visibleChannelIds.map(() => '?').join(', ')})`];
    const params: Array<string | number> = [ftsQuery, ...visibleChannelIds];

    const channelTarget = typeof req.query.channel === 'string' ? req.query.channel.trim() : '';
    if (channelTarget) {
      const channelId = resolveChannelFromTarget(channelTarget, db) ?? (channelTarget.startsWith('dm:') ? `dm:${agentId}` : null);
      if (!channelId) {
        reply.code(400);
        return { error: `Cannot resolve channel: ${channelTarget}` };
      }
      if (channelTarget.startsWith('#') && !(agent.channelIds ?? []).includes(channelId)) {
        reply.code(403);
        return { error: 'Agent is not a member of this channel' };
      }

      whereParts.push('cm.channel_id = ?');
      params.push(channelId);

      const threadRootId = resolveThreadRootId(channelTarget);
      if (threadRootId !== null) {
        if (channelTarget.startsWith('dm:@')) {
          whereParts.push('(cm.thread_root_id = ? OR (cm.thread_root_id IS NULL AND cm.target = ?))');
          params.push(threadRootId, channelTarget);
        } else {
          whereParts.push('cm.thread_root_id = ?');
          params.push(threadRootId);
        }
      }
    }

    const rows = db.prepare(
      `SELECT
         cm.message_id as messageId,
         cm.channel_id as channelId,
         cm.sender_id as senderId,
         cm.sender_name as senderName,
         cm.sender_type as senderType,
         cm.target,
         cm.content,
         cm.seq,
         cm.created_at as createdAt,
         cm.thread_root_id as threadRootId,
         snippet(channel_messages_fts, 4, '[', ']', '...', 12) as snippet
       FROM channel_messages_fts
       JOIN channel_messages cm ON cm.message_id = channel_messages_fts.message_id
       WHERE channel_messages_fts MATCH ?
         AND ${whereParts.join(' AND ')}
       ORDER BY bm25(channel_messages_fts), cm.created_at DESC
       LIMIT ?`,
    ).all(...params, limit) as Array<MessageRow & { snippet: string | null }>;

    return {
      results: rows.map((row) => ({
        id: row.messageId,
        target: row.target,
        senderName: row.senderName,
        senderType: row.senderType,
        content: row.content,
        seq: row.seq,
        createdAt: new Date(row.createdAt).toISOString(),
        snippet: row.snippet ?? row.content,
      })),
    };
  });

  app.get<{
    Params: { agentId: string };
    Querystring: { channel: string; limit?: string; around?: string; before?: string; after?: string };
  }>('/api/internal/agent/:agentId/history', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, limit: limitStr, around: aroundStr, before: beforeStr, after: afterStr } = req.query;
    if (!channel) {
      reply.code(400);
      return { error: 'channel query parameter is required' };
    }

    const channelId = resolveChannelFromTarget(channel, db) ?? (channel.startsWith('dm:') ? `dm:${agentId}` : null);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }
    if (channel.startsWith('#') && !(agent.channelIds ?? []).includes(channelId)) {
      reply.code(403);
      return { error: 'Agent is not a member of this channel' };
    }

    const limit = parseBoundedPositiveInt(limitStr, 50, 100);
    const before = parseOptionalPositiveInt(beforeStr);
    const after = parseOptionalPositiveInt(afterStr);
    const around = typeof aroundStr === 'string' ? aroundStr.trim() : '';
    if (around && (before !== undefined || after !== undefined)) {
      reply.code(400);
      return { error: 'around cannot be combined with before or after' };
    }

    // Thread filter: "#channel:shortId" reads thread; "#channel" reads main channel only
    const targetThreadRootId = resolveThreadRootId(channel);
    const scope = buildMessageScope('cm', channelId, targetThreadRootId, channel);

    const taskJoinSelect = `cm.message_id as messageId, cm.channel_id as channelId, cm.sender_id as senderId,
                  cm.sender_name as senderName, cm.sender_type as senderType,
                  cm.target, cm.content, cm.seq, cm.created_at as createdAt,
                  t.task_number as taskNumber, t.status as taskStatus, t.claimed_by_name as taskAssigneeName`;
    const taskJoin = `LEFT JOIN tasks t ON t.message_id = cm.message_id`;

    const selectRows = (extraWhere: string, extraParams: Array<string | number>, order: 'ASC' | 'DESC', rowLimit: number): MessageRow[] =>
      db
        .prepare(
          `SELECT ${taskJoinSelect}
           FROM channel_messages cm ${taskJoin}
           WHERE ${scope.clause}${extraWhere ? ` AND ${extraWhere}` : ''}
           ORDER BY cm.seq ${order} LIMIT ?`,
        )
        .all(...scope.params, ...extraParams, rowLimit) as MessageRow[];

    const findAroundAnchorSeq = (): number | null => {
      if (!around) return null;
      if (/^\d+$/.test(around)) {
        const row = db.prepare(
          `SELECT cm.seq as seq
           FROM channel_messages cm
           WHERE ${scope.clause} AND cm.seq = ?
           LIMIT 1`,
        ).get(...scope.params, Number(around)) as { seq: number } | undefined;
        return row?.seq ?? null;
      }

      const row = db.prepare(
        `SELECT cm.seq as seq
         FROM channel_messages cm
         WHERE ${scope.clause} AND cm.message_id LIKE ?
         ORDER BY cm.seq ASC
         LIMIT 1`,
      ).get(...scope.params, `${around}%`) as { seq: number } | undefined;
      return row?.seq ?? null;
    };

    let rows: MessageRow[];
    if (around) {
      const anchorSeq = findAroundAnchorSeq();
      if (anchorSeq === null) {
        reply.code(404);
        return { error: `Cannot resolve message around ${around}` };
      }

      const beforeBase = Math.floor((limit - 1) / 2);
      const afterBase = Math.max(limit - beforeBase - 1, 0);

      let beforeRows = selectRows('cm.seq < ?', [anchorSeq], 'DESC', beforeBase);
      let afterRows = selectRows('cm.seq > ?', [anchorSeq], 'ASC', afterBase);

      if (beforeRows.length < beforeBase) {
        afterRows = selectRows('cm.seq > ?', [anchorSeq], 'ASC', afterBase + (beforeBase - beforeRows.length));
      }
      if (afterRows.length < afterBase) {
        beforeRows = selectRows('cm.seq < ?', [anchorSeq], 'DESC', beforeBase + (afterBase - afterRows.length));
      }

      const anchorRows = selectRows('cm.seq = ?', [anchorSeq], 'ASC', 1);
      rows = beforeRows.reverse().concat(anchorRows, afterRows);
    } else if (after !== undefined) {
      rows = selectRows('cm.seq > ?', [after], 'ASC', limit);
    } else if (before !== undefined) {
      rows = selectRows('cm.seq < ?', [before], 'DESC', limit).reverse();
    } else {
      rows = selectRows('', [], 'DESC', limit).reverse();
    }

    const hasOlder = rows.length > 0
      ? !!db.prepare(
        `SELECT 1
         FROM channel_messages cm
         WHERE ${scope.clause} AND cm.seq < ?
         LIMIT 1`,
      ).get(...scope.params, rows[0].seq)
      : false;
    const hasNewer = rows.length > 0
      ? !!db.prepare(
        `SELECT 1
         FROM channel_messages cm
         WHERE ${scope.clause} AND cm.seq > ?
         LIMIT 1`,
      ).get(...scope.params, rows[rows.length - 1].seq)
      : false;
    const messages = rows.map((r) => {
      const ext = r as MessageRow & { taskNumber?: number | null; taskStatus?: string | null; taskAssigneeName?: string | null };
      return {
        id: r.messageId,
        senderName: r.senderName,
        senderType: r.senderType,
        content: r.content,
        seq: r.seq,
        createdAt: new Date(r.createdAt).toISOString(),
        ...(ext.taskNumber != null ? {
          taskNumber: ext.taskNumber,
          taskStatus: ext.taskStatus,
          taskAssigneeName: ext.taskAssigneeName,
        } : {}),
      };
    });

    return { messages, has_more: hasOlder || hasNewer, has_older: hasOlder, has_newer: hasNewer };
  });

  app.get<{
    Params: { agentId: string };
    Querystring: { path?: string };
  }>('/api/internal/agent/:agentId/skills', async (req, reply) => {
    if (!skillsService) {
      reply.code(503);
      return { error: 'Skill service unavailable' };
    }
    if (!conversationManager.getAgent(req.params.agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    try {
      return await skillsService.listSkills(req.params.agentId, normalizeSkillPath(req.query.path));
    } catch (error) {
      if (error instanceof AgentSkillsServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      reply.code(500);
      return { error: String((error as Error)?.message ?? error) };
    }
  });

  app.get<{
    Params: { agentId: string };
    Querystring: { path?: string };
  }>('/api/internal/agent/:agentId/skills/file', async (req, reply) => {
    if (!skillsService) {
      reply.code(503);
      return { error: 'Skill service unavailable' };
    }
    if (!conversationManager.getAgent(req.params.agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const skillPath = normalizeSkillPath(req.query.path);
    if (!skillPath) {
      reply.code(400);
      return { error: 'path query parameter is required' };
    }

    try {
      return await skillsService.readSkillFile(req.params.agentId, skillPath);
    } catch (error) {
      if (error instanceof AgentSkillsServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      reply.code(500);
      return { error: String((error as Error)?.message ?? error) };
    }
  });

  // ─── Task board ──────────────────────────────────────────────────────────

  /**
   * GET /api/internal/agent/:agentId/tasks
   * List tasks for a channel.
   * Query: channel (target string), status?
   */
  app.get<{
    Params: { agentId: string };
    Querystring: { channel: string; status?: string };
  }>('/api/internal/agent/:agentId/tasks', async (req, reply) => {
    const { agentId } = req.params;
    if (!conversationManager.getAgent(agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, status } = req.query;
    if (!channel) {
      reply.code(400);
      return { error: 'channel query parameter is required' };
    }

    const channelId = resolveTaskChannelId(agentId, channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }

    const rows: TaskRow[] = status && status !== 'all'
      ? db
        .prepare(
          `SELECT task_id as taskId, agent_task_ref as agentTaskRef, channel_id as channelId, task_number as taskNumber,
                  title, description, status, claimed_by_agent_id as claimedByAgentId,
                  claimed_by_name as claimedByName, created_by_agent_id as createdByAgentId,
                  created_by_name as createdByName, created_at as createdAt, updated_at as updatedAt,
                  message_id as messageId
           FROM tasks WHERE channel_id = ? AND status = ? ORDER BY task_number ASC`,
        )
        .all(channelId, status) as TaskRow[]
      : db
        .prepare(
          `SELECT task_id as taskId, agent_task_ref as agentTaskRef, channel_id as channelId, task_number as taskNumber,
                  title, description, status, claimed_by_agent_id as claimedByAgentId,
                  claimed_by_name as claimedByName, created_by_agent_id as createdByAgentId,
                  created_by_name as createdByName, created_at as createdAt, updated_at as updatedAt,
                  message_id as messageId
           FROM tasks WHERE channel_id = ? ORDER BY task_number ASC`,
        )
        .all(channelId) as TaskRow[];

    const tasks = rows.map((r) => ({
      taskId: r.taskId,
      agentTaskRef: r.agentTaskRef,
      taskNumber: r.taskNumber,
      title: r.title,
      description: r.description ?? null,
      status: r.status,
      claimedByName: r.claimedByName,
      createdByName: r.createdByName,
      messageId: (r as TaskRow & { messageId?: string | null }).messageId ?? null,
    }));

    return { tasks };
  });

  app.get<{
    Params: { agentId: string };
    Querystring: { status?: string; scope?: string };
  }>('/api/internal/agent/:agentId/my-tasks', async (req, reply) => {
    const { agentId } = req.params;
    if (!conversationManager.getAgent(agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const requestedScope = (req.query.scope ?? 'all').trim().toLowerCase();
    const requestedStatus = (req.query.status ?? 'all').trim().toLowerCase();
    if (!['all', 'dm', 'channel'].includes(requestedScope)) {
      reply.code(400);
      return { error: `Invalid scope: ${req.query.scope}` };
    }
    if (!['all', 'todo', 'in_progress', 'in_review', 'done'].includes(requestedStatus)) {
      reply.code(400);
      return { error: `Invalid status: ${req.query.status}` };
    }

    const params: Array<string> = [agentId];
    const conditions = ['atl.agent_id = ?'];
    if (requestedStatus !== 'all') {
      conditions.push('t.status = ?');
      params.push(requestedStatus);
    }
    if (requestedScope === 'dm') {
      conditions.push(`t.channel_id LIKE 'dm:%'`);
    } else if (requestedScope === 'channel') {
      conditions.push(`t.channel_id NOT LIKE 'dm:%'`);
    }

    const rows = db.prepare(
      `SELECT t.task_id as taskId,
              t.agent_task_ref as agentTaskRef,
              t.channel_id as channelId,
              t.task_number as taskNumber,
              t.title,
              t.description,
              t.status,
              t.claimed_by_agent_id as claimedByAgentId,
              t.claimed_by_name as claimedByName,
              t.created_by_agent_id as createdByAgentId,
              t.created_by_name as createdByName,
              t.created_at as createdAt,
              t.updated_at as updatedAt,
              t.message_id as messageId,
              cm.target as sourceTarget,
              ch.name as channelName
       FROM agent_task_links atl
       JOIN tasks t ON t.task_id = atl.task_id
       LEFT JOIN channel_messages cm ON cm.message_id = t.message_id
       LEFT JOIN channels ch ON ch.channel_id = t.channel_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.updated_at DESC, t.created_at DESC`,
    ).all(...params) as Array<TaskRow & {
      messageId?: string | null;
      sourceTarget?: string | null;
      channelName?: string | null;
    }>;

    const tasks = rows.map((row) => {
      const sourceTarget = buildTaskSourceTarget(row.channelId, row.sourceTarget ?? null, row.channelName ?? null);
      return {
        taskId: row.taskId,
        agentTaskRef: row.agentTaskRef,
        channelId: row.channelId,
        taskNumber: row.taskNumber,
        title: row.title,
        description: row.description ?? null,
        status: row.status,
        claimedByName: row.claimedByName,
        createdByName: row.createdByName,
        messageId: row.messageId ?? null,
        sourceTarget,
        sourceLabel: buildTaskSourceLabel(row.channelId, sourceTarget, row.channelName ?? null),
        threadTarget: buildTaskThreadTarget(sourceTarget, row.messageId ?? null),
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
      };
    });

    return { tasks };
  });

  app.get<{
    Params: { agentId: string };
    Querystring: { task_ref: string };
  }>('/api/internal/agent/:agentId/tasks/by-ref', async (req, reply) => {
    const { agentId } = req.params;
    if (!conversationManager.getAgent(agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const taskRef = req.query.task_ref?.trim().toLowerCase();
    if (!taskRef) {
      reply.code(400);
      return { error: 'task_ref query parameter is required' };
    }

    const row = db.prepare(
      `SELECT t.task_id as taskId,
              t.agent_task_ref as agentTaskRef,
              t.channel_id as channelId,
              t.task_number as taskNumber,
              t.title,
              t.description,
              t.status,
              t.claimed_by_agent_id as claimedByAgentId,
              t.claimed_by_name as claimedByName,
              t.created_by_agent_id as createdByAgentId,
              t.created_by_name as createdByName,
              t.created_at as createdAt,
              t.updated_at as updatedAt,
              t.message_id as messageId,
              cm.target as sourceTarget,
              ch.name as channelName
       FROM agent_task_links atl
       JOIN tasks t ON t.task_id = atl.task_id
       LEFT JOIN channel_messages cm ON cm.message_id = t.message_id
       LEFT JOIN channels ch ON ch.channel_id = t.channel_id
       WHERE t.agent_task_ref = ?
         AND atl.agent_id = ?
       LIMIT 1`,
    ).get(taskRef, agentId) as (TaskRow & {
      messageId?: string | null;
      sourceTarget?: string | null;
      channelName?: string | null;
    }) | undefined;

    if (!row) {
      reply.code(404);
      return { error: 'Task not found' };
    }

    const sourceTarget = buildTaskSourceTarget(row.channelId, row.sourceTarget ?? null, row.channelName ?? null);
    return {
      task: {
        taskId: row.taskId,
        agentTaskRef: row.agentTaskRef,
        channelId: row.channelId,
        taskNumber: row.taskNumber,
        title: row.title,
        description: row.description ?? null,
        status: row.status,
        claimedByName: row.claimedByName,
        createdByName: row.createdByName,
        messageId: row.messageId ?? null,
        sourceTarget,
        sourceLabel: buildTaskSourceLabel(row.channelId, sourceTarget, row.channelName ?? null),
        threadTarget: buildTaskThreadTarget(sourceTarget, row.messageId ?? null),
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
      },
    };
  });

  app.get<{
    Params: { agentId: string };
    Querystring: { task_ref: string; limit?: string };
  }>('/api/internal/agent/:agentId/tasks/history', async (req, reply) => {
    const { agentId } = req.params;
    if (!conversationManager.getAgent(agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const taskRef = req.query.task_ref?.trim().toLowerCase();
    if (!taskRef) {
      reply.code(400);
      return { error: 'task_ref query parameter is required' };
    }
    const limit = parseBoundedPositiveInt(req.query.limit, 50, 200);

    const row = db.prepare(
      `SELECT t.task_id as taskId,
              t.agent_task_ref as agentTaskRef,
              t.channel_id as channelId,
              t.task_number as taskNumber,
              t.title,
              t.description,
              t.status,
              t.claimed_by_agent_id as claimedByAgentId,
              t.claimed_by_name as claimedByName,
              t.created_by_agent_id as createdByAgentId,
              t.created_by_name as createdByName,
              t.created_at as createdAt,
              t.updated_at as updatedAt,
              t.message_id as messageId,
              cm.target as sourceTarget,
              ch.name as channelName
       FROM agent_task_links atl
       JOIN tasks t ON t.task_id = atl.task_id
       LEFT JOIN channel_messages cm ON cm.message_id = t.message_id
       LEFT JOIN channels ch ON ch.channel_id = t.channel_id
       WHERE t.agent_task_ref = ?
         AND atl.agent_id = ?
       LIMIT 1`,
    ).get(taskRef, agentId) as (TaskRow & {
      messageId?: string | null;
      sourceTarget?: string | null;
      channelName?: string | null;
    }) | undefined;

    if (!row) {
      reply.code(404);
      return { error: 'Task not found' };
    }

    const sourceTarget = buildTaskSourceTarget(row.channelId, row.sourceTarget ?? null, row.channelName ?? null);
    const events = db.prepare(
      `SELECT event_id as eventId,
              event_type as eventType,
              actor_type as actorType,
              actor_id as actorId,
              actor_name as actorName,
              from_status as fromStatus,
              to_status as toStatus,
              claimed_by_agent_id_after as claimedByAgentIdAfter,
              claimed_by_name_after as claimedByNameAfter,
              message_id as messageId,
              thread_target as threadTarget,
              created_at as createdAt
       FROM task_events
       WHERE task_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(row.taskId, limit) as TaskHistoryEventRow[];

    return {
      task: {
        taskId: row.taskId,
        agentTaskRef: row.agentTaskRef,
        channelId: row.channelId,
        taskNumber: row.taskNumber,
        title: row.title,
        description: row.description ?? null,
        status: row.status,
        claimedByName: row.claimedByName,
        createdByName: row.createdByName,
        messageId: row.messageId ?? null,
        sourceTarget,
        sourceLabel: buildTaskSourceLabel(row.channelId, sourceTarget, row.channelName ?? null),
        threadTarget: buildTaskThreadTarget(sourceTarget, row.messageId ?? null),
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
      },
      events: events.map((event) => ({
        eventId: event.eventId,
        type: event.eventType,
        actorType: event.actorType,
        actorId: event.actorId,
        actorName: event.actorName,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        claimedByAgentIdAfter: event.claimedByAgentIdAfter,
        claimedByNameAfter: event.claimedByNameAfter,
        messageId: event.messageId,
        threadTarget: event.threadTarget,
        createdAt: new Date(event.createdAt).toISOString(),
      })),
    };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks
   * Create one or more tasks on a channel's task board.
   * Body: { channel: string; tasks: Array<{ title: string }> }
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; tasks: Array<{ title: string; description?: string }>; conversationId?: string };
  }>('/api/internal/agent/:agentId/tasks', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, tasks, conversationId } = req.body ?? {};
    if (!channel || !Array.isArray(tasks) || tasks.length === 0) {
      reply.code(400);
      return { error: 'channel and non-empty tasks array are required' };
    }

    const channelId = resolveTaskChannelId(agentId, channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }

    const normalizedTasks: Array<{ title: string; description: string }> = [];
    for (const task of tasks) {
      const title = normalizeRequiredText(task?.title);
      const description = normalizeRequiredText(task?.description);
      if (!title || !description) {
        reply.code(400);
        return { error: 'Each task requires non-empty title and description' };
      }
      normalizedTasks.push({ title, description });
    }

    const now = Date.now();
    const created: Array<{
      taskId: string;
      agentTaskRef: string;
      taskNumber: number;
      title: string;
      description: string;
      messageId: string;
      handoffStarted?: boolean;
      threadConversationId?: string | null;
      threadTarget?: string | null;
      handoffError?: string;
    }> = [];
    const currentConversation = typeof conversationId === 'string' && conversationId.trim()
      ? conversationManager.getConversation(conversationId.trim())
      : null;
    const currentPrimaryDmTarget = currentConversation
      && currentConversation.agentId === agentId
      && currentConversation.threadKind === 'direct'
      && currentConversation.isPrimaryThread
      && channelId === `dm:${agentId}`
      ? (currentConversation.replyTarget ?? resolveDefaultReplyTarget(db, currentConversation.id, humanUserName) ?? '').trim()
      : '';
    const currentConversationRunId = currentConversation ? findActiveConversationRunId(db, currentConversation.id) : null;
    const activeConversationHandoff = getActiveRunHandoff(currentConversation?.id);
    if (activeConversationHandoff) {
      reply.code(409);
      return { error: buildDmTaskHandoffBlockedError(activeConversationHandoff.handoff) };
    }
    const autoClaimInPrimaryDm = Boolean(currentPrimaryDmTarget);
    if (autoClaimInPrimaryDm && normalizedTasks.length > 1) {
      reply.code(400);
      return { error: 'A primary DM can only create one task per request before handing work off to its task thread' };
    }

    const insertMessage = db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id, message_kind)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, NULL, NULL, 'task')`,
    );

    const insertTask = db.prepare(
      `INSERT INTO tasks(task_id, agent_task_ref, channel_id, task_number, title, description, status, message_id,
                         created_by_agent_id, created_by_name, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?)`,
    );
    const insertClaimedTask = db.prepare(
      `INSERT INTO tasks(task_id, agent_task_ref, channel_id, task_number, title, description, status, message_id,
                         claimed_by_agent_id, claimed_by_name,
                         created_by_agent_id, created_by_name, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, ?)`,
    );

    db.transaction(() => {
      for (const taskDef of normalizedTasks) {
        const taskId = randomUUID();
        const agentTaskRef = generateUniqueAgentTaskRef(db, taskId);
        const messageId = randomUUID();
        const taskNumber = allocateNextTaskNumber(db, channelId);
        const seq = allocateNextChannelMessageSeq(db, channelId);
        const target = canonicalTaskTarget(channelId, channel, db);
        const threadTarget = buildTaskEventThreadTarget({ sourceTarget: target, messageId });
        insertMessage.run(messageId, channelId, agentId, agent.name, target, taskDef.title, seq, now);
        if (autoClaimInPrimaryDm) {
          insertClaimedTask.run(
            taskId,
            agentTaskRef,
            channelId,
            taskNumber,
            taskDef.title,
            taskDef.description,
            messageId,
            agentId,
            agent.name,
            agentId,
            agent.name,
            now,
            now,
          );
          syncTaskThreadOwner(db, {
            taskId,
            agentId,
            lastActiveAt: now,
          });
          upsertAgentTaskLink(db, {
            agentId,
            taskId,
            linkedAt: now,
            created: true,
            assigned: true,
          });
          appendTaskEvent(db, {
            taskId,
            agentTaskRef,
            channelId,
            taskNumber,
            eventType: 'created',
            actorType: 'agent',
            actorId: agentId,
            actorName: agent.name,
            toStatus: 'in_progress',
            claimedByAgentIdAfter: agentId,
            claimedByNameAfter: agent.name,
            messageId,
            threadTarget,
            createdAt: now,
          });
          appendTaskEvent(db, {
            taskId,
            agentTaskRef,
            channelId,
            taskNumber,
            eventType: 'claimed',
            actorType: 'agent',
            actorId: agentId,
            actorName: agent.name,
            claimedByAgentIdAfter: agentId,
            claimedByNameAfter: agent.name,
            messageId,
            threadTarget,
            createdAt: now,
          });
        } else {
          insertTask.run(taskId, agentTaskRef, channelId, taskNumber, taskDef.title, taskDef.description, messageId, agentId, agent.name, now, now);
          upsertAgentTaskLink(db, {
            agentId,
            taskId,
            linkedAt: now,
            created: true,
          });
          appendTaskEvent(db, {
            taskId,
            agentTaskRef,
            channelId,
            taskNumber,
            eventType: 'created',
            actorType: 'agent',
            actorId: agentId,
            actorName: agent.name,
            toStatus: 'todo',
            messageId,
            threadTarget,
            createdAt: now,
          });
        }
        created.push({ taskId, agentTaskRef, taskNumber, title: taskDef.title, description: taskDef.description, messageId });
        const taskMessageEvent: ServerEvent = {
          type: 'channel.message',
          message: {
            id: messageId, senderName: agent.name, senderType: 'agent', content: taskDef.title,
            createdAt: new Date(now).toISOString(), seq,
            taskNumber,
            taskStatus: autoClaimInPrimaryDm ? 'in_progress' : 'todo',
            taskAssigneeName: autoClaimInPrimaryDm ? agent.name : null,
          },
        };
        if (channelId.startsWith('dm:')) {
          const targetConversationId = ensureConversationIdForReplyTarget(
            db,
            conversationManager,
            agentId,
            target,
          );
          if (targetConversationId) {
            broadcastToAgent(agentId, taskMessageEvent, targetConversationId);
          }
        } else {
          broadcastToChannel(channelId, taskMessageEvent);
        }
      }
    })();

    if (currentPrimaryDmTarget) {
      const triggerMessage = resolveRunTriggerMessage(db, currentConversationRunId, channelId, currentPrimaryDmTarget);
      for (const task of created) {
        const handoff = await startDmTaskHandoff({
          agentId,
          currentConversationId: currentConversation?.id ?? null,
          currentConversationRunId,
          currentPrimaryDmTarget,
          taskId: task.taskId,
          agentTaskRef: task.agentTaskRef,
          taskNumber: task.taskNumber,
          title: task.title,
          description: task.description,
          messageId: task.messageId,
          triggerMessage,
        });
        task.handoffStarted = handoff.handoffStarted;
        task.threadConversationId = handoff.threadConversationId;
        task.threadTarget = handoff.threadTarget;
        task.handoffError = handoff.handoffError;
      }
    }

    if (created.length > 0) broadcastChannelTasksChanged(channelId);

    reply.code(201);
    return { tasks: created };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks/claim-message
   * Promote one or more existing messages to tasks (Slock-style claim by message_id).
   * Body: { channel: string; message_ids: string[]; title?: string }
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; message_ids: string[]; title?: string; description?: string; conversationId?: string };
  }>('/api/internal/agent/:agentId/tasks/claim-message', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) { reply.code(404); return { error: 'Agent not found' }; }

    const { channel, message_ids, title, description, conversationId } = req.body ?? {};
    if (!channel || !Array.isArray(message_ids) || message_ids.length === 0) {
      reply.code(400);
      return { error: 'channel and non-empty message_ids array are required' };
    }

    const channelId = resolveTaskChannelId(agentId, channel, db);
    if (!channelId) { reply.code(400); return { error: `Cannot resolve channel: ${channel}` }; }
    const normalizedDescription = normalizeRequiredText(description);
    if (!normalizedDescription) {
      reply.code(400);
      return { error: 'description is required' };
    }
    const currentConversation = typeof conversationId === 'string' && conversationId.trim()
      ? conversationManager.getConversation(conversationId.trim())
      : null;
    const dmConversationPeer = resolveDmConversationPeer(agentId, channelId, conversationId);
    const currentPrimaryDmTarget = currentConversation
      && currentConversation.agentId === agentId
      && currentConversation.threadKind === 'direct'
      && currentConversation.isPrimaryThread
      && channelId === `dm:${agentId}`
      ? (currentConversation.replyTarget ?? resolveDefaultReplyTarget(db, currentConversation.id, humanUserName) ?? '').trim()
      : '';
    const currentConversationRunId = currentConversation ? findActiveConversationRunId(db, currentConversation.id) : null;
    const activeConversationHandoff = getActiveRunHandoff(currentConversation?.id);
    if (activeConversationHandoff) {
      reply.code(409);
      return { error: buildDmTaskHandoffBlockedError(activeConversationHandoff.handoff) };
    }
    const boundTaskThreadContext = getBoundTaskThreadContext(currentConversation?.id);
    if (currentPrimaryDmTarget && message_ids.length > 1) {
      reply.code(400);
      return { error: 'A primary DM can only hand off one task per request' };
    }

    const now = Date.now();
    const results: Array<{
      messageId: string;
      taskNumber?: number;
      agentTaskRef?: string;
      success: boolean;
      reason?: string;
      context?: ContextMsg[];
      handoffStarted?: boolean;
      threadConversationId?: string | null;
      threadTarget?: string | null;
      handoffError?: string;
    }> = [];
    let changed = false;

    for (const msgShortId of message_ids) {
      // Fix 7: 使用 .all() 检测前缀歧义
      const msgMatches = db.prepare(
        `SELECT message_id as messageId,
                content,
                thread_root_id as threadRootId,
                sender_type as senderType,
                sender_name as senderName,
                target,
                seq,
                created_at as createdAt,
                attachment_ids as attachmentIds
         FROM channel_messages
         WHERE message_id LIKE ? AND channel_id = ?`,
      ).all(`${msgShortId}%`, channelId) as ClaimableMessageRow[];

      if (msgMatches.length === 0) {
        results.push({ messageId: msgShortId, success: false, reason: 'Message not found' });
        continue;
      }
      if (msgMatches.length > 1) {
        results.push({ messageId: msgShortId, success: false, reason: 'Ambiguous message ID prefix — matches multiple messages' });
        continue;
      }
      const msg = msgMatches[0];
      // 覆盖 primary DM 和 DM task-thread 的 peer 隔离
      if (dmConversationPeer && msg.target !== dmConversationPeer) {
        results.push({ messageId: msg.messageId, success: false, reason: 'Message does not belong to the current DM context' });
        continue;
      }
      if (currentPrimaryDmTarget && msg.senderType !== 'user') {
        results.push({
          messageId: msg.messageId,
          success: false,
          reason: 'In a primary DM, claim by message_ids must use a user message. Use message_ids=["current"] for the current request.',
        });
        continue;
      }
      if (msg.threadRootId) {
        results.push({ messageId: msg.messageId, success: false, reason: 'Cannot promote a thread reply to task' });
        continue;
      }
      if (boundTaskThreadContext && boundTaskThreadContext.rootMessageId === msg.messageId) {
        results.push({
          messageId: msg.messageId,
          success: false,
          reason: buildBoundTaskThreadReclaimError(boundTaskThreadContext.boundTask),
        });
        continue;
      }

      const existing = db.prepare(
        `SELECT task_id as taskId, agent_task_ref as agentTaskRef, task_number as taskNumber, claimed_by_agent_id as claimedByAgentId
         FROM tasks WHERE message_id = ?`,
      ).get(msg.messageId) as { taskId: string; agentTaskRef: string | null; taskNumber: number; claimedByAgentId: string | null } | undefined;
      if (existing) {
        results.push({
          messageId: msg.messageId,
          agentTaskRef: existing.agentTaskRef ?? undefined,
          taskNumber: existing.taskNumber,
          success: false,
          reason: existing.claimedByAgentId && existing.claimedByAgentId !== agentId
            ? 'Already claimed by another agent'
            : 'Message is already a task',
        });
        continue;
      }

      const taskTitle = deriveTaskTitle(title, msg.content);
      if (!taskTitle) {
        results.push({ messageId: msg.messageId, success: false, reason: 'title is required' });
        continue;
      }

      const nextTaskNumberRow = db.prepare(
        `SELECT COALESCE(MAX(task_number), 0) + 1 as nextTaskNumber FROM tasks WHERE channel_id = ?`,
      ).get(channelId) as { nextTaskNumber: number };
      const taskId = randomUUID();
      const agentTaskRef = generateUniqueAgentTaskRef(db, taskId);
      const taskNumber = nextTaskNumberRow.nextTaskNumber;
      db.transaction(() => {
        db.prepare(
          `INSERT INTO tasks(task_id, agent_task_ref, channel_id, task_number, title, description, status, message_id,
                             claimed_by_agent_id, claimed_by_name,
                             created_by_agent_id, created_by_name, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(taskId, agentTaskRef, channelId, taskNumber, taskTitle, normalizedDescription, msg.messageId, agentId, agent.name, agentId, agent.name, now, now);
        db.prepare(`UPDATE channel_messages SET message_kind = 'task' WHERE message_id = ?`).run(msg.messageId);
        syncTaskThreadOwner(db, {
          taskId,
          agentId,
          lastActiveAt: now,
        });
        upsertAgentTaskLink(db, {
          agentId,
          taskId,
          linkedAt: now,
          created: true,
          assigned: true,
        });
        appendTaskEvent(db, {
          taskId,
          agentTaskRef,
          channelId,
          taskNumber,
          eventType: 'created',
          actorType: 'agent',
          actorId: agentId,
          actorName: agent.name,
          toStatus: 'in_progress',
          claimedByAgentIdAfter: agentId,
          claimedByNameAfter: agent.name,
          messageId: msg.messageId,
          threadTarget: buildTaskEventThreadTarget({ sourceTarget: msg.target, messageId: msg.messageId }),
          createdAt: now,
        });
        appendTaskEvent(db, {
          taskId,
          agentTaskRef,
          channelId,
          taskNumber,
          eventType: 'claimed',
          actorType: 'agent',
          actorId: agentId,
          actorName: agent.name,
          claimedByAgentIdAfter: agentId,
          claimedByNameAfter: agent.name,
          messageId: msg.messageId,
          threadTarget: buildTaskEventThreadTarget({ sourceTarget: msg.target, messageId: msg.messageId }),
          createdAt: now,
        });
      })();
      changed = true;

      const result: {
        messageId: string;
        taskNumber?: number;
        agentTaskRef?: string;
        success: boolean;
        reason?: string;
        context?: ContextMsg[];
        handoffStarted?: boolean;
        threadConversationId?: string | null;
        threadTarget?: string | null;
        handoffError?: string;
      } = {
        messageId: msg.messageId,
        taskNumber,
        agentTaskRef,
        success: true,
        context: fetchTaskContext(db, channelId, msg.messageId),
      };

      if (currentPrimaryDmTarget && msg.target === currentPrimaryDmTarget) {
        const handoff = await startDmTaskHandoff({
          agentId,
          currentConversationId: currentConversation?.id ?? null,
          currentConversationRunId,
          currentPrimaryDmTarget,
          taskId,
          agentTaskRef,
          taskNumber,
          title: taskTitle,
          description: normalizedDescription,
          messageId: msg.messageId,
          triggerMessage: msg,
        });
        result.handoffStarted = handoff.handoffStarted;
        result.threadConversationId = handoff.threadConversationId;
        result.threadTarget = handoff.threadTarget;
        result.handoffError = handoff.handoffError;
      }

      results.push(result);
    }

    if (changed) broadcastChannelTasksChanged(channelId);

    reply.code(201);
    return { results };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks/update-details
   * Update a task's title and description.
   * Body: { channel: string; task_number: number; title: string; description: string }
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; task_number: number; title: string; description: string; conversationId?: string };
  }>('/api/internal/agent/:agentId/tasks/update-details', async (req, reply) => {
    const { agentId } = req.params;
    if (!conversationManager.getAgent(agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, task_number, title, description, conversationId } = req.body ?? {};
    if (!channel || task_number == null) {
      reply.code(400);
      return { error: 'channel, task_number, title, and description are required' };
    }

    const normalizedTitle = normalizeRequiredText(title);
    const normalizedDescription = normalizeRequiredText(description);
    if (!normalizedTitle || !normalizedDescription) {
      reply.code(400);
      return { error: 'channel, task_number, title, and description are required' };
    }

    const channelId = resolveTaskChannelId(agentId, channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }
    const activeConversationHandoff = getActiveRunHandoff(conversationId);
    if (activeConversationHandoff) {
      reply.code(409);
      return { error: buildDmTaskHandoffBlockedError(activeConversationHandoff.handoff) };
    }

    const row = db.prepare(
      `SELECT t.task_id as taskId,
              t.message_id as messageId,
              t.created_at as taskCreatedAt,
              cm.created_at as messageCreatedAt,
              cm.target as messageTarget
       FROM tasks t
       LEFT JOIN channel_messages cm ON cm.message_id = t.message_id
       WHERE t.channel_id = ? AND t.task_number = ?`,
    ).get(channelId, task_number) as {
      taskId: string;
      messageId: string | null;
      taskCreatedAt: number;
      messageCreatedAt: number | null;
      messageTarget: string | null;
    } | undefined;

    if (!row) {
      reply.code(404);
      return { error: 'Task not found' };
    }

    // DM 上下文隔离（覆盖 primary DM 和 task-thread）
    const dmPeerDetails = resolveDmConversationPeer(agentId, channelId, conversationId);
    if (dmPeerDetails && row.messageTarget && row.messageTarget !== dmPeerDetails) {
      reply.code(403);
      return { error: 'Task does not belong to the current DM context' };
    }

    const now = Date.now();
    db.transaction(() => {
      db.prepare(
        `UPDATE tasks
         SET title = ?, description = ?, updated_at = ?
         WHERE task_id = ?`,
      ).run(normalizedTitle, normalizedDescription, now, row.taskId);

      if (shouldSyncTaskRootMessageContent(row)) {
        db.prepare(
          `UPDATE channel_messages
           SET content = ?
           WHERE message_id = ?`,
        ).run(normalizedTitle, row.messageId);
      }
    })();

    broadcastChannelTasksChanged(channelId);

    return {
      ok: true,
      task_number,
      title: normalizedTitle,
      description: normalizedDescription,
    };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks/claim
   * Claim one or more tasks atomically (prevents race conditions).
   * Body: { channel: string; task_numbers?: number[]; message_ids?: string[]; title?: string; description?: string }
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; task_numbers?: number[]; message_ids?: string[]; title?: string; description?: string; conversationId?: string };
  }>('/api/internal/agent/:agentId/tasks/claim', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, task_numbers, message_ids, title, description, conversationId } = req.body ?? {};
    if (
      !channel
      || ((!Array.isArray(task_numbers) || task_numbers.length === 0)
        && (!Array.isArray(message_ids) || message_ids.length === 0))
    ) {
      reply.code(400);
      return { error: 'channel and at least one of task_numbers or message_ids are required' };
    }
    if (Array.isArray(message_ids) && message_ids.length > 0 && !description?.trim()) {
      reply.code(400);
      return { error: 'description is required when claiming by message_ids' };
    }

    const channelId = resolveTaskChannelId(agentId, channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }

    const currentConversation = typeof conversationId === 'string' && conversationId.trim()
      ? conversationManager.getConversation(conversationId.trim())
      : null;
    const dmConversationPeer = resolveDmConversationPeer(agentId, channelId, conversationId);
    const currentPrimaryDmTarget = currentConversation
      && currentConversation.agentId === agentId
      && currentConversation.threadKind === 'direct'
      && currentConversation.isPrimaryThread
      && channelId === `dm:${agentId}`
      ? (currentConversation.replyTarget ?? resolveDefaultReplyTarget(db, currentConversation.id, humanUserName) ?? '').trim()
      : '';
    const currentConversationRunId = currentConversation ? findActiveConversationRunId(db, currentConversation.id) : null;
    const normalizedDescription = description?.trim() ?? '';
    const activeConversationHandoff = getActiveRunHandoff(currentConversation?.id);
    if (activeConversationHandoff) {
      reply.code(409);
      return { error: buildDmTaskHandoffBlockedError(activeConversationHandoff.handoff) };
    }
    const boundTaskThreadContext = getBoundTaskThreadContext(currentConversation?.id);
    const requestedClaimCount = (task_numbers?.length ?? 0) + (message_ids?.length ?? 0);
    if (currentPrimaryDmTarget && requestedClaimCount > 1) {
      reply.code(400);
      return { error: 'A primary DM can only hand off one task per request' };
    }

    const resolveClaimMessageRow = (messageIdPrefix: string) => {
      const normalizedPrefix = messageIdPrefix.trim();
      if (!normalizedPrefix) {
        return { reason: 'Message ID is required' } as const;
      }
      if (/^(current|trigger)$/i.test(normalizedPrefix)) {
        if (!currentPrimaryDmTarget) {
          return { reason: '"current" is only available in the current primary DM conversation' } as const;
        }
        const row = resolveRunTriggerMessage(db, currentConversationRunId, channelId, currentPrimaryDmTarget);
        if (!row) {
          return { reason: 'No current user DM message is available to claim' } as const;
        }
        return { row } as const;
      }

      // Fix 7: 使用 .all() 检测前缀歧义
      const matches = db.prepare(
        `SELECT message_id as messageId, content, thread_root_id as threadRootId, sender_type as senderType, sender_name as senderName,
                target, seq, created_at as createdAt, attachment_ids as attachmentIds
         FROM channel_messages
         WHERE message_id LIKE ? AND channel_id = ?`,
      ).all(`${normalizedPrefix}%`, channelId) as ClaimableMessageRow[];
      if (matches.length === 0) {
        return { reason: 'Message not found' } as const;
      }
      if (matches.length > 1) {
        return { reason: 'Ambiguous message ID prefix — matches multiple messages' } as const;
      }
      const row = matches[0];
      if (dmConversationPeer && row.target !== dmConversationPeer) {
        return { reason: 'Message does not belong to the current DM context' } as const;
      }
      return { row } as const;
    };

    const now = Date.now();
    const results: Array<{
      taskNumber?: number;
      agentTaskRef?: string;
      success: boolean;
      reason?: string;
      messageId?: string | null;
      context?: ContextMsg[];
      handoffStarted?: boolean;
      threadConversationId?: string | null;
      threadTarget?: string | null;
      handoffError?: string;
    }> = [];
    let changed = false;

    for (const taskNumber of task_numbers ?? []) {
      const row = db
        .prepare(
          `SELECT t.task_id as taskId, t.agent_task_ref as agentTaskRef, t.status, t.claimed_by_agent_id as claimedByAgentId, t.message_id as messageId,
                  t.title, t.description, cm.target as messageTarget
           FROM tasks t
           LEFT JOIN channel_messages cm ON cm.message_id = t.message_id
           WHERE t.channel_id = ? AND t.task_number = ?`,
        )
        .get(channelId, taskNumber) as {
          taskId: string;
          agentTaskRef: string | null;
          status: string;
          claimedByAgentId: string | null;
          messageId: string | null;
          title: string;
          description: string | null;
          messageTarget: string | null;
        } | undefined;

      if (!row) {
        results.push({ taskNumber, success: false, reason: 'Task not found' });
        continue;
      }
      if (
        boundTaskThreadContext
        && (
          boundTaskThreadContext.boundTask.taskId === row.taskId
          || (boundTaskThreadContext.rootMessageId && row.messageId === boundTaskThreadContext.rootMessageId)
        )
      ) {
        results.push({
          taskNumber,
          agentTaskRef: row.agentTaskRef ?? undefined,
          success: false,
          messageId: row.messageId ?? null,
          reason: buildBoundTaskThreadReclaimError(boundTaskThreadContext.boundTask),
        });
        continue;
      }
      if (dmConversationPeer && row.messageTarget && row.messageTarget !== dmConversationPeer) {
        results.push({ taskNumber, agentTaskRef: row.agentTaskRef ?? undefined, success: false, reason: 'Task does not belong to the current DM context' });
        continue;
      }
      if (row.claimedByAgentId && row.claimedByAgentId !== agentId) {
        results.push({ taskNumber, agentTaskRef: row.agentTaskRef ?? undefined, success: false, reason: 'Already claimed by another agent' });
        continue;
      }
      if (row.status === 'done') {
        results.push({ taskNumber, agentTaskRef: row.agentTaskRef ?? undefined, success: false, reason: 'Task is already done' });
        continue;
      }

      const newStatus = row.status === 'todo' ? 'in_progress' : row.status;
      db.transaction(() => {
        db.prepare(
          `UPDATE tasks SET claimed_by_agent_id = ?, claimed_by_name = ?, status = ?, updated_at = ?
           WHERE task_id = ?`,
        ).run(agentId, agent.name, newStatus, now, row.taskId);

        syncTaskThreadOwner(db, {
          taskId: row.taskId,
          agentId,
          lastActiveAt: now,
        });
        upsertAgentTaskLink(db, {
          agentId,
          taskId: row.taskId,
          linkedAt: now,
          assigned: true,
        });
        appendTaskEvent(db, {
          taskId: row.taskId,
          agentTaskRef: row.agentTaskRef,
          channelId,
          taskNumber,
          eventType: 'claimed',
          actorType: 'agent',
          actorId: agentId,
          actorName: agent.name,
          fromStatus: row.status,
          toStatus: newStatus,
          claimedByAgentIdAfter: agentId,
          claimedByNameAfter: agent.name,
          messageId: row.messageId,
          threadTarget: buildTaskEventThreadTarget({ sourceTarget: row.messageTarget, messageId: row.messageId }),
          createdAt: now,
        });
      })();
      changed = true;

      const claimResult: {
        taskNumber?: number;
        agentTaskRef?: string;
        success: boolean;
        reason?: string;
        messageId?: string | null;
        context?: ContextMsg[];
        handoffStarted?: boolean;
        threadConversationId?: string | null;
        threadTarget?: string | null;
        handoffError?: string;
      } = {
        taskNumber,
        agentTaskRef: row.agentTaskRef ?? undefined,
        success: true,
        messageId: row.messageId ?? null,
        context: row.messageId ? fetchTaskContext(db, channelId, row.messageId) : [],
      };
      if (currentPrimaryDmTarget && row.messageId && row.messageTarget === currentPrimaryDmTarget) {
        broadcastDmTaskRootUpdate({
          agentId,
          primaryTarget: currentPrimaryDmTarget,
          messageId: row.messageId,
          taskNumber,
          taskStatus: newStatus,
          taskAssigneeName: agent.name,
        });
        const handoff = await startDmTaskHandoff({
          agentId,
          currentConversationId: currentConversation?.id ?? null,
          currentConversationRunId,
          currentPrimaryDmTarget,
          taskId: row.taskId,
          agentTaskRef: row.agentTaskRef,
          taskNumber,
          title: row.title,
          description: row.description?.trim() || row.title,
          messageId: row.messageId,
        });
        claimResult.handoffStarted = handoff.handoffStarted;
        claimResult.threadConversationId = handoff.threadConversationId;
        claimResult.threadTarget = handoff.threadTarget;
        claimResult.handoffError = handoff.handoffError;
      }
      results.push(claimResult);
    }

    for (const messageIdPrefix of message_ids ?? []) {
      const resolvedMessage = resolveClaimMessageRow(messageIdPrefix);
      if (!('row' in resolvedMessage)) {
        results.push({ success: false, messageId: messageIdPrefix, reason: resolvedMessage.reason });
        continue;
      }
      const messageRow = resolvedMessage.row as ClaimableMessageRow;

      if (currentPrimaryDmTarget && messageRow.senderType !== 'user') {
        results.push({
          success: false,
          messageId: messageRow.messageId,
          reason: 'In a primary DM, claim by message_ids must use a user message. Use message_ids=["current"] for the current request.',
        });
        continue;
      }
      if (messageRow.threadRootId) {
        results.push({ success: false, messageId: messageRow.messageId, reason: 'Thread messages cannot become tasks' });
        continue;
      }
      if (boundTaskThreadContext && boundTaskThreadContext.rootMessageId === messageRow.messageId) {
        results.push({
          success: false,
          messageId: messageRow.messageId,
          reason: buildBoundTaskThreadReclaimError(boundTaskThreadContext.boundTask),
        });
        continue;
      }

      const existingTask = db.prepare(
        `SELECT task_id as taskId, agent_task_ref as agentTaskRef, task_number as taskNumber, status, claimed_by_agent_id as claimedByAgentId
         FROM tasks WHERE channel_id = ? AND message_id = ?`,
      ).get(channelId, messageRow.messageId) as {
        taskId: string;
        agentTaskRef: string | null;
        taskNumber: number;
        status: string;
        claimedByAgentId: string | null;
      } | undefined;

      if (existingTask) {
        results.push({
          taskNumber: existingTask.taskNumber,
          agentTaskRef: existingTask.agentTaskRef ?? undefined,
          success: false,
          messageId: messageRow.messageId,
          reason: existingTask.claimedByAgentId && existingTask.claimedByAgentId !== agentId
            ? 'Already claimed by another agent'
            : 'Message is already a task; claim it by task number',
        });
        continue;
      }

      const nextTaskNumberRow = db.prepare(
        `SELECT COALESCE(MAX(task_number), 0) + 1 as nextTaskNumber FROM tasks WHERE channel_id = ?`,
      ).get(channelId) as { nextTaskNumber: number };
      const taskId = randomUUID();
      const agentTaskRef = generateUniqueAgentTaskRef(db, taskId);
      const taskNumber = nextTaskNumberRow.nextTaskNumber;
      const taskTitle = title?.trim() || messageRow.content.trim().slice(0, 120) || `Task #${taskNumber}`;

      db.transaction(() => {
        db.prepare(
          `INSERT INTO tasks(task_id, agent_task_ref, channel_id, task_number, title, description, status, message_id,
                             claimed_by_agent_id, claimed_by_name, created_by_agent_id, created_by_name, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(taskId, agentTaskRef, channelId, taskNumber, taskTitle, normalizedDescription, messageRow.messageId, agentId, agent.name, agentId, agent.name, now, now);

        db.prepare(
          `UPDATE channel_messages
           SET message_kind = 'task'
           WHERE message_id = ?`,
        ).run(messageRow.messageId);

        syncTaskThreadOwner(db, {
          taskId,
          agentId,
          lastActiveAt: now,
        });
        upsertAgentTaskLink(db, {
          agentId,
          taskId,
          linkedAt: now,
          created: true,
          assigned: true,
        });
        appendTaskEvent(db, {
          taskId,
          agentTaskRef,
          channelId,
          taskNumber,
          eventType: 'created',
          actorType: 'agent',
          actorId: agentId,
          actorName: agent.name,
          toStatus: 'in_progress',
          claimedByAgentIdAfter: agentId,
          claimedByNameAfter: agent.name,
          messageId: messageRow.messageId,
          threadTarget: buildTaskEventThreadTarget({ sourceTarget: messageRow.target, messageId: messageRow.messageId }),
          createdAt: now,
        });
        appendTaskEvent(db, {
          taskId,
          agentTaskRef,
          channelId,
          taskNumber,
          eventType: 'claimed',
          actorType: 'agent',
          actorId: agentId,
          actorName: agent.name,
          claimedByAgentIdAfter: agentId,
          claimedByNameAfter: agent.name,
          messageId: messageRow.messageId,
          threadTarget: buildTaskEventThreadTarget({ sourceTarget: messageRow.target, messageId: messageRow.messageId }),
          createdAt: now,
        });
      })();
      changed = true;

      const claimResult: {
        taskNumber?: number;
        agentTaskRef?: string;
        success: boolean;
        reason?: string;
        messageId?: string | null;
        context?: ContextMsg[];
        handoffStarted?: boolean;
        threadConversationId?: string | null;
        threadTarget?: string | null;
        handoffError?: string;
      } = {
        taskNumber,
        agentTaskRef,
        success: true,
        messageId: messageRow.messageId,
        context: fetchTaskContext(db, channelId, messageRow.messageId),
      };
      if (currentPrimaryDmTarget && messageRow.target === currentPrimaryDmTarget) {
        const handoff = await startDmTaskHandoff({
          agentId,
          currentConversationId: currentConversation?.id ?? null,
          currentConversationRunId,
          currentPrimaryDmTarget,
          taskId,
          agentTaskRef,
          taskNumber,
          title: taskTitle,
          description: normalizedDescription,
          messageId: messageRow.messageId,
          triggerMessage: messageRow,
        });
        claimResult.handoffStarted = handoff.handoffStarted;
        claimResult.threadConversationId = handoff.threadConversationId;
        claimResult.threadTarget = handoff.threadTarget;
        claimResult.handoffError = handoff.handoffError;
      }
      results.push(claimResult);

      if (currentPrimaryDmTarget && messageRow.target === currentPrimaryDmTarget) {
        const taskRootEvent: BroadcastChannelMessage = {
          type: 'channel.message',
          message: {
            id: messageRow.messageId,
            senderName: messageRow.senderName,
            senderType: messageRow.senderType as 'user' | 'agent' | 'system',
            content: messageRow.content,
            createdAt: new Date(messageRow.createdAt).toISOString(),
            seq: messageRow.seq,
            taskNumber,
            taskStatus: 'in_progress',
            taskAssigneeName: agent.name,
            ...(messageRow.attachmentIds ? { attachmentIds: JSON.parse(messageRow.attachmentIds) as string[] } : {}),
          },
        };
        const targetConversationId = ensureConversationIdForReplyTarget(
          db,
          conversationManager,
          agentId,
          currentPrimaryDmTarget,
        );
        if (targetConversationId) {
          broadcastToAgent(agentId, taskRootEvent, targetConversationId);
        }
      }
    }

    if (changed) broadcastChannelTasksChanged(channelId);

    return { results };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks/unclaim
   * Release the agent's claim on a task.
   * Body: { channel: string; task_number: number }
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; task_number: number; conversationId?: string };
  }>('/api/internal/agent/:agentId/tasks/unclaim', async (req, reply) => {
    const { agentId } = req.params;
    if (!conversationManager.getAgent(agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, task_number, conversationId } = req.body ?? {};
    if (!channel || task_number == null) {
      reply.code(400);
      return { error: 'channel and task_number are required' };
    }

    const channelId = resolveTaskChannelId(agentId, channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }
    const activeConversationHandoff = getActiveRunHandoff(conversationId);
    if (activeConversationHandoff) {
      reply.code(409);
      return { error: buildDmTaskHandoffBlockedError(activeConversationHandoff.handoff) };
    }

    const row = db
      .prepare(
        `SELECT t.task_id as taskId, t.claimed_by_agent_id as claimedByAgentId, t.status,
                t.message_id as messageId, cm.target as messageTarget
         FROM tasks t
         LEFT JOIN channel_messages cm ON cm.message_id = t.message_id
         WHERE t.channel_id = ? AND t.task_number = ?`,
      )
      .get(channelId, task_number) as {
        taskId: string;
        claimedByAgentId: string | null;
        status: 'todo' | 'in_progress' | 'in_review' | 'done';
        messageId: string | null;
        messageTarget: string | null;
      } | undefined;

    if (!row) {
      reply.code(404);
      return { error: 'Task not found' };
    }
    // DM 上下文隔离（覆盖 primary DM 和 task-thread）
    const dmPeerUnclaim = resolveDmConversationPeer(agentId, channelId, conversationId);
    if (dmPeerUnclaim && row.messageTarget && row.messageTarget !== dmPeerUnclaim) {
      reply.code(403);
      return { error: 'Task does not belong to the current DM context' };
    }
    if (row.claimedByAgentId !== agentId) {
      reply.code(403);
      return { error: 'You do not own this task' };
    }

    const newStatus = row.status === 'in_progress' ? 'todo' : row.status;
    const now = Date.now();
    db.transaction(() => {
      db.prepare(
        `UPDATE tasks SET claimed_by_agent_id = NULL, claimed_by_name = NULL, assigned_by_user = NULL, status = ?, updated_at = ?
         WHERE task_id = ?`,
      ).run(newStatus, now, row.taskId);

      syncTaskThreadOwner(db, {
        taskId: row.taskId,
        agentId: null,
        lastActiveAt: now,
      });
      appendTaskEvent(db, {
        taskId: row.taskId,
        agentTaskRef: null,
        channelId,
        taskNumber: task_number,
        eventType: 'unclaimed',
        actorType: 'agent',
        actorId: agentId,
        actorName: conversationManager.getAgent(agentId)?.name ?? null,
        fromStatus: row.status,
        toStatus: newStatus,
        messageId: row.messageId,
        threadTarget: buildTaskEventThreadTarget({ sourceTarget: row.messageTarget, messageId: row.messageId }),
        createdAt: now,
      });
    })();

    broadcastChannelTasksChanged(channelId);

    // Fix 8: unclaim 时向主 DM 广播 task root 状态更新
    if (channelId.startsWith('dm:') && row.messageId && row.messageTarget) {
      broadcastDmTaskRootUpdate({
        agentId,
        primaryTarget: row.messageTarget,
        messageId: row.messageId,
        taskNumber: task_number,
        taskStatus: newStatus,
        taskAssigneeName: null,
      });
    }

    return { ok: true };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks/update-status
   * Update a task's progress status.
   * Body: { channel: string; task_number: number; status: string }
   * Valid transitions: todo→in_progress, in_progress→in_review, in_progress→done,
   *                    in_review→done, in_review→in_progress
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; task_number: number; status: string; conversationId?: string };
  }>('/api/internal/agent/:agentId/tasks/update-status', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, task_number, status, conversationId } = req.body ?? {};
    if (!channel || task_number == null || !status) {
      reply.code(400);
      return { error: 'channel, task_number, and status are required' };
    }

    const validStatuses = ['todo', 'in_progress', 'in_review', 'done'];
    if (!validStatuses.includes(status)) {
      reply.code(400);
      return { error: `Invalid status: ${status}` };
    }
    const nextStatus = status as 'todo' | 'in_progress' | 'in_review' | 'done';

    const channelId = resolveTaskChannelId(agentId, channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }
    const activeConversationHandoff = getActiveRunHandoff(conversationId);
    if (activeConversationHandoff) {
      reply.code(409);
      return { error: buildDmTaskHandoffBlockedError(activeConversationHandoff.handoff) };
    }

    const row = db
      .prepare(
        `SELECT t.task_id as taskId,
                t.status as currentStatus,
                t.claimed_by_agent_id as claimedByAgentId,
                t.message_id as messageId,
                t.title as title,
                cm.target as messageTarget
         FROM tasks t
         LEFT JOIN channel_messages cm ON cm.message_id = t.message_id
         WHERE t.channel_id = ? AND t.task_number = ?`,
      )
      .get(channelId, task_number) as {
        taskId: string;
        currentStatus: 'todo' | 'in_progress' | 'in_review' | 'done';
        claimedByAgentId: string | null;
        messageId: string | null;
        title: string;
        messageTarget: string | null;
      } | undefined;

    if (!row) {
      reply.code(404);
      return { error: 'Task not found' };
    }
    // DM 上下文隔离（覆盖 primary DM 和 task-thread）
    const dmPeerStatus = resolveDmConversationPeer(agentId, channelId, conversationId);
    if (dmPeerStatus && row.messageTarget && row.messageTarget !== dmPeerStatus) {
      reply.code(403);
      return { error: 'Task does not belong to the current DM context' };
    }
    if (!isValidTransition(row.currentStatus, nextStatus)) {
      reply.code(400);
      return { error: `Invalid transition: ${row.currentStatus} → ${nextStatus}` };
    }

    if (nextStatus === 'done') {
      reply.code(403);
      return { error: 'Only a human user can mark a task done. If your work is complete, move it to in_review first unless the user explicitly approved done.' };
    }

    if (row.claimedByAgentId !== agentId) {
      reply.code(403);
      return { error: 'You must be the task assignee to update its status' };
    }

    const now = Date.now();
    const nextOwnerAgentId = row.claimedByAgentId ?? null;
    db.transaction(() => {
      db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?`).run(
        nextStatus,
        now,
        row.taskId,
      );

      syncTaskThreadOwner(db, {
        taskId: row.taskId,
        agentId: nextOwnerAgentId,
        lastActiveAt: now,
      });
      appendTaskEvent(db, {
        taskId: row.taskId,
        agentTaskRef: null,
        channelId,
        taskNumber: task_number,
        eventType: 'status_changed',
        actorType: 'agent',
        actorId: agentId,
        actorName: agent.name,
        fromStatus: row.currentStatus,
        toStatus: nextStatus,
        claimedByAgentIdAfter: row.claimedByAgentId,
        claimedByNameAfter: agent.name,
        messageId: row.messageId,
        threadTarget: buildTaskEventThreadTarget({ sourceTarget: row.messageTarget, messageId: row.messageId }),
        createdAt: now,
      });
    })();

    broadcastChannelTasksChanged(channelId);
    if (channelId.startsWith('dm:') && row.messageId && row.messageTarget?.startsWith('dm:@')) {
      broadcastDmTaskRootUpdate({
        agentId,
        primaryTarget: row.messageTarget,
        messageId: row.messageId,
        taskNumber: task_number,
        taskStatus: nextStatus,
        taskAssigneeName: agent.name,
      });
      if (nextStatus === 'in_review') {
        emitDmTaskLifecycleEvent({
          agentId,
          primaryTarget: row.messageTarget,
          taskNumber: task_number,
          title: row.title,
          taskStatus: nextStatus,
          kind: 'in_review',
          taskAssigneeName: agent.name,
        });
      }
    }

    return { ok: true, taskNumber: task_number, status: nextStatus };
  });
}

function normalizeSkillPath(rawPath?: string): string | null {
  const trimmed = (rawPath ?? '').trim();
  return trimmed || null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolves a target string (e.g. "#general", "dm:@alice", "#general:msgid") to a channelId.
 * For now, targets are resolved by channel name. DM and thread targets use the base channel.
 */
function resolveChannelFromTarget(target: string, db: Db): string | null {
  // "#channel:threadid" or "#channel"
  const channelMatch = target.match(/^#([^:]+)/);
  if (channelMatch) {
    const name = channelMatch[1];
    const row = db
      .prepare('SELECT channel_id as channelId FROM channels WHERE name = ?')
      .get(name) as { channelId: string } | undefined;
    return row?.channelId ?? null;
  }

  // "dm:@agentname" or "dm:@agentname:threadid" — resolve to dm:{agentId} virtual channel
  if (target.startsWith('dm:')) {
    const match = target.match(/^dm:@([^:]+)/);
    if (match) {
      const agentName = match[1];
      const agentRow = db
        .prepare('SELECT agent_id as agentId FROM agents WHERE name = ?')
        .get(agentName) as { agentId: string } | undefined;
      if (agentRow) return `dm:${agentRow.agentId}`;
    }
    // Non-agent DM target (e.g. dm:@User) — return null so the caller can fall back to dm:{agentId}
    return null;
  }

  return null;
}

function resolveTaskChannelId(agentId: string, channel: string, db: Db): string | null {
  return resolveChannelFromTarget(channel, db) ?? (channel.startsWith('dm:') ? `dm:${agentId}` : null);
}

function resolveDefaultReplyTarget(db: Db, conversationId: string, humanUserName: string): string | null {
  return resolveConversationReplyTarget(db, conversationId, humanUserName);
}

function canonicalTaskTarget(channelId: string, requestedTarget: string, db: Db): string {
  if (channelId.startsWith('dm:')) {
    const dmMatch = requestedTarget.trim().match(/^dm:@[^:]+/);
    return dmMatch ? dmMatch[0] : requestedTarget.trim();
  }

  const channelRow = db.prepare('SELECT name FROM channels WHERE channel_id = ?').get(channelId) as { name: string } | undefined;
  const channelName = channelRow?.name ?? channelId;
  return `#${channelName}`;
}

function buildAgentTaskRefCandidate(taskId: string, length: number): string {
  const normalized = taskId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const sliceLength = Math.max(8, Math.min(length, normalized.length));
  return `task_${normalized.slice(0, sliceLength)}`;
}

function generateUniqueAgentTaskRef(db: Db, taskId: string): string {
  const normalized = taskId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const lookup = db.prepare(
    `SELECT task_id as taskId
     FROM tasks
     WHERE agent_task_ref = ?
     LIMIT 1`,
  );
  const candidateLengths = [12, 16, 20, 24, 28, normalized.length];
  for (const length of candidateLengths) {
    const candidate = buildAgentTaskRefCandidate(taskId, length);
    const existing = lookup.get(candidate) as { taskId: string } | undefined;
    if (!existing || existing.taskId === taskId) return candidate;
  }

  const fullBase = buildAgentTaskRefCandidate(taskId, normalized.length);
  let suffix = 2;
  while (true) {
    const candidate = `${fullBase}_${suffix}`;
    const existing = lookup.get(candidate) as { taskId: string } | undefined;
    if (!existing || existing.taskId === taskId) return candidate;
    suffix += 1;
  }
}

function buildTaskSourceTarget(channelId: string, sourceTarget: string | null, channelName: string | null): string | null {
  if (sourceTarget?.trim()) return sourceTarget.trim();
  if (channelId.startsWith('dm:')) return null;
  return `#${channelName ?? channelId}`;
}

function buildTaskSourceLabel(channelId: string, sourceTarget: string | null, channelName: string | null): string {
  if (sourceTarget?.startsWith('dm:@')) return sourceTarget;
  if (channelName) return `#${channelName}`;
  if (channelId.startsWith('dm:')) return 'DM';
  if (sourceTarget?.trim()) return sourceTarget.trim();
  return channelId;
}

function isThreadTargetValue(target: string): boolean {
  if (target.startsWith('dm:@')) return target.split(':').length >= 3;
  if (target.startsWith('#')) return target.includes(':');
  return false;
}

function buildTaskThreadTarget(sourceTarget: string | null, messageId: string | null): string | null {
  if (!sourceTarget || !messageId) return null;
  const normalizedTarget = sourceTarget.trim();
  if (!(normalizedTarget.startsWith('dm:@') || normalizedTarget.startsWith('#'))) return null;
  if (isThreadTargetValue(normalizedTarget)) return normalizedTarget;
  return `${normalizedTarget}:${buildThreadShortId(messageId)}`;
}

function normalizeTargetForConversation(db: Db, conversationId: string, target: string): string {
  const row = db.prepare(
    `SELECT c.channel_id as channelId, c.thread_kind as threadKind, c.thread_root_id as threadRootId,
            ch.name as channelName
     FROM conversations c
     LEFT JOIN channels ch ON ch.channel_id = c.channel_id
     WHERE c.id = ?`,
  ).get(conversationId) as {
    channelId: string;
    threadKind: 'direct' | 'branch';
    threadRootId: string | null;
    channelName: string | null;
  } | undefined;

  if (!row || row.threadKind !== 'branch') return target;

  const channelName = row.channelName ?? row.channelId;
  if (row.threadRootId) {
    const canonicalThreadTarget = `#${channelName}:${row.threadRootId}`;
    const sameChannelThread = target.match(/^#([^:]+):([a-zA-Z0-9-]+)$/);
    if (sameChannelThread) {
      const [, targetChannel, targetThreadRootId] = sameChannelThread;
      if (
        (targetChannel === channelName || targetChannel === row.channelId)
        && targetThreadRootId === row.threadRootId
      ) {
        return canonicalThreadTarget;
      }
    }
    return target;
  }

  const canonicalBaseTarget = `#${channelName}`;
  const sameChannelThread = target.match(/^#([^:]+):([a-zA-Z0-9-]+)$/);
  if (sameChannelThread) {
    const [, targetChannel] = sameChannelThread;
    if (targetChannel === channelName || targetChannel === row.channelId) {
      return canonicalBaseTarget;
    }
  }

  return target;
}

/** Extracts the thread shortId from targets like "#general:a1b2c3d4". Returns null for non-thread targets. */
function resolveThreadRootId(target: string): string | null {
  const match = target.match(/^(?:#[^:]+|dm:@[^:]+):([a-zA-Z0-9-]+)$/);
  return match ? match[1] : null;
}


function findActiveConversationRunId(db: Db, conversationId: string): string | null {
  const row = db
    .prepare(
      `SELECT r.run_id as runId
       FROM conversations c
       JOIN runs r ON r.session_key = c.session_key
       WHERE c.id = ? AND r.ended_at IS NULL
       ORDER BY r.started_at DESC
       LIMIT 1`,
    )
    .get(conversationId) as { runId: string } | undefined;
  return row?.runId ?? null;
}

function findConversationIdForReplyTarget(db: Db, agentId: string, replyTarget: string): string | null {
  const row = db.prepare(
    `SELECT id
     FROM conversations
     WHERE agent_id = ? AND reply_target = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
  ).get(agentId, replyTarget) as { id: string } | undefined;
  return row?.id ?? null;
}

function ensureConversationIdForReplyTarget(
  db: Db,
  conversationManager: ConversationManager,
  agentId: string,
  replyTarget: string,
): string | null {
  const existingId = findConversationIdForReplyTarget(db, agentId, replyTarget);
  if (existingId) return existingId;

  const threadRootId = resolveThreadRootId(replyTarget);
  const dmMatch = replyTarget.match(/^dm:@([^:]+)(?::([a-zA-Z0-9-]+))?$/);
  if (dmMatch) {
    const userName = dmMatch[1];
    const userRow = db.prepare(
      `SELECT id FROM users WHERE username = ? LIMIT 1`,
    ).get(userName) as { id: string } | undefined;
    if (!userRow) return null;
    if (threadRootId) {
      if (!doesThreadRootExist(db, `dm:${agentId}`, threadRootId)) return null;
      return conversationManager.openAgentDirectThread(agentId, userRow?.id ?? null, threadRootId)?.id ?? null;
    }
    return conversationManager.openAgentThread(agentId, userRow.id)?.id ?? null;
  }

  if (threadRootId) {
    const channelId = resolveChannelFromTarget(replyTarget, db);
    if (!channelId) return null;
    if (!doesThreadRootExist(db, channelId, threadRootId)) return null;
    return conversationManager.openAgentChannelThread(agentId, channelId, threadRootId)?.id ?? null;
  }

  return null;
}
