import type { Db } from '@agent-collab/runtime-acp';
import { buildThreadShortId } from '@agent-collab/protocol';
import { getAgentMessageCheckpoint } from './messageCheckpoints.js';
import {
  listRecentTargetParticipants,
  TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
  type TargetParticipant,
} from './targetParticipants.js';
import { getBoundTaskForThread } from './threadTaskBindings.js';
import { findThreadRootMessageId } from './threadRoots.js';
import { hasVisiblePromptHistoryContent } from './promptHistorySanitizer.js';

export type ActivationContextMessage = {
  messageId: string;
  seq: number;
  target: string;
  senderName: string;
  senderType: 'user' | 'agent' | 'system';
  content: string;
  createdAt: number;
};

export type DmThreadContextSnapshot = {
  triggerMessageId: string | null;
  messages: ActivationContextMessage[];
};

export type DmActiveTaskThreadSummary = {
  agentTaskRef: string | null;
  taskNumber: number;
  title: string;
  status: string;
  claimedByName: string | null;
  threadTarget: string;
};

export type TargetActivationContext = {
  replyTarget: string;
  recentMessages: ActivationContextMessage[];
  unreadCount: number;
  oldestVisibleSeq?: number;
  participants: TargetParticipant[];
  boundTask?: { taskNumber: number; title: string; description?: string | null; status: string; claimedByName: string | null };
  openTasks: Array<{ taskNumber: number; title: string; status: string; claimedByName: string | null }>;
  rootMessage?: ActivationContextMessage;
  dmContextSnapshot?: DmThreadContextSnapshot;
  dmActiveTaskThreads?: DmActiveTaskThreadSummary[];
};

const DM_THREAD_CONTEXT_SNAPSHOT_LIMIT = 6;

function ensureDmThreadContextSnapshotTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dm_thread_context_snapshots (
      channel_id TEXT NOT NULL,
      thread_root_id TEXT NOT NULL,
      trigger_message_id TEXT,
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, thread_root_id)
    );
  `);
}

function loadActivationMessageById(
  db: Db,
  channelId: string,
  messageId: string,
): ActivationContextMessage | undefined {
  return db.prepare(
    `SELECT message_id as messageId, seq, target, sender_name as senderName, sender_type as senderType,
            content, created_at as createdAt
     FROM channel_messages
     WHERE channel_id = ? AND message_id = ?
     LIMIT 1`,
  ).get(channelId, messageId) as ActivationContextMessage | undefined;
}

function loadThreadRootMessage(
  db: Db,
  channelId: string,
  threadRootId: string,
  rootMessageId?: string,
): ActivationContextMessage | undefined {
  if (rootMessageId) {
    const exact = loadActivationMessageById(db, channelId, rootMessageId);
    if (exact) return exact;
  }
  const matchedMessageId = findThreadRootMessageId(db, channelId, threadRootId);
  return matchedMessageId
    ? loadActivationMessageById(db, channelId, matchedMessageId)
    : undefined;
}

function parseDmThreadContextSnapshot(raw: string): ActivationContextMessage[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is ActivationContextMessage => (
        !!value
        && typeof value === 'object'
        && typeof (value as ActivationContextMessage).messageId === 'string'
        && typeof (value as ActivationContextMessage).seq === 'number'
        && typeof (value as ActivationContextMessage).target === 'string'
        && typeof (value as ActivationContextMessage).senderName === 'string'
        && typeof (value as ActivationContextMessage).senderType === 'string'
        && typeof (value as ActivationContextMessage).content === 'string'
        && typeof (value as ActivationContextMessage).createdAt === 'number'
      ))
      .sort((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}

export function getDmThreadContextSnapshot(
  db: Db,
  params: {
    channelId: string;
    threadRootId: string;
  },
): DmThreadContextSnapshot | undefined {
  ensureDmThreadContextSnapshotTable(db);
  const row = db.prepare(
    `SELECT trigger_message_id as triggerMessageId, snapshot_json as snapshotJson
     FROM dm_thread_context_snapshots
     WHERE channel_id = ? AND thread_root_id = ?
     LIMIT 1`,
  ).get(params.channelId, params.threadRootId) as {
    triggerMessageId: string | null;
    snapshotJson: string;
  } | undefined;
  if (!row) return undefined;
  return {
    triggerMessageId: row.triggerMessageId,
    messages: parseDmThreadContextSnapshot(row.snapshotJson),
  };
}

export function ensureDmThreadContextSnapshot(
  db: Db,
  params: {
    channelId: string;
    directTarget: string;
    threadRootId: string;
    rootMessageId?: string;
    recentLimit?: number;
  },
): DmThreadContextSnapshot | undefined {
  ensureDmThreadContextSnapshotTable(db);
  const existing = getDmThreadContextSnapshot(db, {
    channelId: params.channelId,
    threadRootId: params.threadRootId,
  });
  if (existing) return existing;

  const rootMessage = loadThreadRootMessage(db, params.channelId, params.threadRootId, params.rootMessageId);
  if (!rootMessage) return undefined;

  const recentLimit = Math.max(1, params.recentLimit ?? DM_THREAD_CONTEXT_SNAPSHOT_LIMIT);
  const recentMessages = (
    db.prepare(
      `SELECT message_id as messageId, seq, target, sender_name as senderName, sender_type as senderType,
              content, created_at as createdAt
       FROM channel_messages
       WHERE channel_id = ?
         AND target = ?
         AND thread_root_id IS NULL
         AND seq < ?
       ORDER BY seq DESC
       LIMIT ?`,
    ).all(params.channelId, params.directTarget, rootMessage.seq, recentLimit) as ActivationContextMessage[]
  ).reverse();

  const latestUserMessage = db.prepare(
    `SELECT message_id as messageId, seq, target, sender_name as senderName, sender_type as senderType,
            content, created_at as createdAt
     FROM channel_messages
     WHERE channel_id = ?
       AND target = ?
       AND thread_root_id IS NULL
       AND sender_type = 'user'
       AND seq < ?
     ORDER BY seq DESC
     LIMIT 1`,
  ).get(params.channelId, params.directTarget, rootMessage.seq) as ActivationContextMessage | undefined;

  const fallbackTriggerMessage = latestUserMessage ?? db.prepare(
    `SELECT message_id as messageId, seq, target, sender_name as senderName, sender_type as senderType,
            content, created_at as createdAt
     FROM channel_messages
     WHERE channel_id = ?
       AND target = ?
       AND thread_root_id IS NULL
       AND seq < ?
     ORDER BY seq DESC
     LIMIT 1`,
  ).get(params.channelId, params.directTarget, rootMessage.seq) as ActivationContextMessage | undefined;

  const triggerMessageId = rootMessage.senderType === 'user' && rootMessage.target === params.directTarget
    ? rootMessage.messageId
    : fallbackTriggerMessage?.messageId ?? null;

  const messageMap = new Map(recentMessages.map((message) => [message.messageId, message]));
  if (triggerMessageId && triggerMessageId !== rootMessage.messageId && !messageMap.has(triggerMessageId)) {
    const triggerMessage = loadActivationMessageById(db, params.channelId, triggerMessageId);
    if (triggerMessage && triggerMessage.target === params.directTarget) {
      messageMap.set(triggerMessage.messageId, triggerMessage);
    }
  }

  const snapshot: DmThreadContextSnapshot = {
    triggerMessageId,
    messages: [...messageMap.values()].sort((a, b) => a.seq - b.seq),
  };

  db.prepare(
    `INSERT INTO dm_thread_context_snapshots(channel_id, thread_root_id, trigger_message_id, snapshot_json, created_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_root_id) DO UPDATE SET
       trigger_message_id = excluded.trigger_message_id,
       snapshot_json = excluded.snapshot_json`,
  ).run(
    params.channelId,
    params.threadRootId,
    snapshot.triggerMessageId,
    JSON.stringify(snapshot.messages),
    Date.now(),
  );

  return snapshot;
}

export function buildTargetActivationContext(
  db: Db,
  params: {
    agentId: string;
    channelId: string;
    replyTarget: string;
    triggerSeq: number;
    threadRootId?: string | null;
    recentLimit?: number;
  },
): TargetActivationContext {
  const recentLimit = Math.max(1, params.recentLimit ?? 8);
  const normalizedThreadRootId = params.threadRootId ?? null;
  const threadClause = normalizedThreadRootId == null
    ? 'thread_root_id IS NULL'
    : 'thread_root_id = ?';
  const threadArgs = normalizedThreadRootId == null ? [] : [normalizedThreadRootId];

  const recentMessages = (
    db.prepare(
      `SELECT message_id as messageId, seq, target, sender_name as senderName, sender_type as senderType,
              content, created_at as createdAt
       FROM channel_messages
       WHERE channel_id = ? AND target = ? AND ${threadClause} AND seq < ?
       ORDER BY seq DESC
       LIMIT ?`,
    ).all(params.channelId, params.replyTarget, ...threadArgs, params.triggerSeq, recentLimit) as ActivationContextMessage[]
  )
    .reverse()
    .filter((message) => hasVisiblePromptHistoryContent(message.content, message.senderType));

  const checkpoint = getAgentMessageCheckpoint(db, params.agentId, params.channelId, normalizedThreadRootId);
  const oldestVisibleSeq = recentMessages.length > 0
    ? recentMessages[0].seq
    : undefined;
  const unreadUpperBound = oldestVisibleSeq ?? params.triggerSeq;

  const unreadRow = db.prepare(
    `SELECT COUNT(*) as count
     FROM channel_messages
     WHERE channel_id = ?
       AND target = ?
       AND ${threadClause}
       AND seq > ?
       AND seq < ?
       AND sender_id != ?`,
  ).get(params.channelId, params.replyTarget, ...threadArgs, checkpoint, unreadUpperBound, params.agentId) as { count: number };

  const rootMessage = normalizedThreadRootId
    ? (() => {
        const matchedMessageId = findThreadRootMessageId(db, params.channelId, normalizedThreadRootId);
        return matchedMessageId
          ? loadActivationMessageById(db, params.channelId, matchedMessageId)
          : undefined;
      })()
    : undefined;
  const directTarget = normalizedThreadRootId && params.replyTarget.startsWith('dm:@')
    ? params.replyTarget.replace(/:[^:]+$/, '')
    : null;
  const dmContextSnapshot = normalizedThreadRootId && directTarget
    ? ensureDmThreadContextSnapshot(db, {
        channelId: params.channelId,
        directTarget,
        threadRootId: normalizedThreadRootId,
        rootMessageId: rootMessage?.messageId,
      })
    : undefined;

  const recentParticipants = listRecentTargetParticipants(db, {
    channelId: params.channelId,
    threadRootId: normalizedThreadRootId,
    activeSince: Date.now() - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
  });

  const boundTaskRow = getBoundTaskForThread(db, {
    channelId: params.channelId,
    threadRootId: normalizedThreadRootId,
  });

  const boundTask = boundTaskRow
    ? {
        taskNumber: boundTaskRow.taskNumber,
        title: boundTaskRow.title,
        description: boundTaskRow.description ?? null,
        status: boundTaskRow.status,
        claimedByName: boundTaskRow.assigneeName,
      }
    : undefined;
  const participants = boundTaskRow?.status === 'done'
    ? recentParticipants.map((participant) => ({
        ...participant,
        role: 'participant' as const,
      }))
    : recentParticipants;

  const openTasks = db.prepare(
    `SELECT task_number as taskNumber,
            title,
            status,
            claimed_by_name as claimedByName
     FROM tasks
     WHERE channel_id = ? AND status != 'done'
     ORDER BY
       CASE status
         WHEN 'in_progress' THEN 0
         WHEN 'in_review' THEN 1
         WHEN 'todo' THEN 2
         ELSE 3
       END ASC,
       task_number ASC
     LIMIT 5`,
  ).all(params.channelId) as Array<{
    taskNumber: number;
    title: string;
    status: string;
    claimedByName: string | null;
  }>;

  const dmActiveTaskThreads = normalizedThreadRootId === null && params.replyTarget.startsWith('dm:@')
    ? (db.prepare(
      `SELECT t.agent_task_ref as agentTaskRef,
              t.task_number as taskNumber,
              t.title,
              t.status,
              t.claimed_by_name as claimedByName,
              cm.message_id as messageId
       FROM tasks t
       JOIN channel_messages cm ON cm.message_id = t.message_id
       WHERE t.channel_id = ?
         AND cm.target = ?
         AND cm.thread_root_id IS NULL
         AND t.status IN ('todo', 'in_progress', 'in_review')
       ORDER BY t.updated_at DESC, t.task_number DESC`,
    ).all(params.channelId, params.replyTarget) as Array<{
      agentTaskRef: string | null;
      taskNumber: number;
      title: string;
      status: string;
      claimedByName: string | null;
      messageId: string;
    }>).map((task) => ({
      agentTaskRef: task.agentTaskRef,
      taskNumber: task.taskNumber,
      title: task.title,
      status: task.status,
      claimedByName: task.claimedByName,
      threadTarget: `${params.replyTarget}:${buildThreadShortId(task.messageId)}`,
    }))
    : [];

  return {
    replyTarget: params.replyTarget,
    recentMessages,
    unreadCount: unreadRow.count,
    ...(oldestVisibleSeq ? { oldestVisibleSeq } : {}),
    participants,
    ...(boundTask ? { boundTask } : {}),
    openTasks: boundTask ? [] : openTasks,
    ...(rootMessage ? { rootMessage } : {}),
    ...(dmContextSnapshot ? { dmContextSnapshot } : {}),
    ...(dmActiveTaskThreads.length > 0 ? { dmActiveTaskThreads } : {}),
  };
}
