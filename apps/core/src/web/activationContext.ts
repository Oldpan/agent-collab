import type { Db } from '@agent-collab/runtime-acp';
import { getAgentMessageCheckpoint } from './messageCheckpoints.js';
import {
  listRecentTargetParticipants,
  TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
  type TargetParticipant,
} from './targetParticipants.js';
import { getBoundTaskForThread } from './threadTaskBindings.js';

export type ActivationContextMessage = {
  messageId: string;
  seq: number;
  target: string;
  senderName: string;
  senderType: 'user' | 'agent' | 'system';
  content: string;
  createdAt: number;
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
};

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
       WHERE channel_id = ? AND ${threadClause} AND seq < ?
       ORDER BY seq DESC
       LIMIT ?`,
    ).all(params.channelId, ...threadArgs, params.triggerSeq, recentLimit) as ActivationContextMessage[]
  ).reverse();

  const checkpoint = getAgentMessageCheckpoint(db, params.agentId, params.channelId, normalizedThreadRootId);
  const oldestVisibleSeq = recentMessages.length > 0
    ? recentMessages[0].seq
    : undefined;
  const unreadUpperBound = oldestVisibleSeq ?? params.triggerSeq;

  const unreadRow = db.prepare(
    `SELECT COUNT(*) as count
     FROM channel_messages
     WHERE channel_id = ?
       AND ${threadClause}
       AND seq > ?
       AND seq < ?
       AND sender_id != ?`,
  ).get(params.channelId, ...threadArgs, checkpoint, unreadUpperBound, params.agentId) as { count: number };

  const rootMessage = normalizedThreadRootId
    ? db.prepare(
      `SELECT message_id as messageId, seq, target, sender_name as senderName, sender_type as senderType,
              content, created_at as createdAt
       FROM channel_messages
       WHERE channel_id = ? AND substr(message_id, 1, 8) = ?
       ORDER BY created_at ASC, seq ASC
       LIMIT 1`,
    ).get(params.channelId, normalizedThreadRootId) as ActivationContextMessage | undefined
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

  return {
    replyTarget: params.replyTarget,
    recentMessages,
    unreadCount: unreadRow.count,
    ...(oldestVisibleSeq ? { oldestVisibleSeq } : {}),
    participants,
    ...(boundTask ? { boundTask } : {}),
    openTasks: boundTask ? [] : openTasks,
    ...(rootMessage ? { rootMessage } : {}),
  };
}
