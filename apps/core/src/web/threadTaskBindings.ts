import type { TaskInfo } from '@agent-collab/protocol';
import type { Db } from '@agent-collab/runtime-acp';
import { buildThreadShortId } from '@agent-collab/protocol';
import {
  listRecentTargetParticipants,
  setTargetOwner,
  TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
} from './targetParticipants.js';
import { findThreadRootMessageId } from './threadRoots.js';

type TaskThreadRow = {
  taskId: string;
  channelId: string;
  taskNumber: number;
  title: string;
  description?: string | null;
  status: string;
  assigneeId: string | null;
  assigneeName: string | null;
  messageId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type BoundThreadTask = {
  taskId: string;
  channelId: string;
  threadRootId: string;
  linkedThreadId: string;
  linkedThreadShortId: string;
  taskNumber: number;
  title: string;
  description?: string | null;
  status: string;
  assigneeId: string | null;
  assigneeName: string | null;
  boundAt: number;
};

export type ThreadCollaborationSummary = {
  boundTask?: BoundThreadTask;
  ownerAgentId?: string | null;
  ownerName?: string | null;
  participants: string[];
};

function normalizeThreadRootId(threadRootId?: string | null): string {
  return threadRootId ?? '';
}

function getTaskThreadRootIds(messageId?: string | null): string[] {
  if (!messageId) return [];
  return [buildThreadShortId(messageId)];
}

export function getTaskThreadRootId(messageId?: string | null): string | null {
  return messageId ? buildThreadShortId(messageId) : null;
}

function toBoundThreadTask(row: TaskThreadRow): BoundThreadTask | undefined {
  const threadRootId = getTaskThreadRootId(row.messageId);
  if (!threadRootId) return undefined;

  return {
    taskId: row.taskId,
    channelId: row.channelId,
    threadRootId,
    linkedThreadId: threadRootId,
    linkedThreadShortId: threadRootId,
    taskNumber: row.taskNumber,
    title: row.title,
    description: row.description,
    status: row.status,
    assigneeId: row.assigneeId,
    assigneeName: row.assigneeName,
    boundAt: row.createdAt,
  };
}

function toTaskInfo(row: TaskThreadRow): TaskInfo {
  const linkedThreadId = getTaskThreadRootId(row.messageId);
  return {
    taskId: row.taskId,
    channelId: row.channelId,
    taskNumber: row.taskNumber,
    title: row.title,
    ...(row.description != null ? { description: row.description } : {}),
    status: row.status as TaskInfo['status'],
    assigneeId: row.assigneeId,
    assigneeName: row.assigneeName,
    messageId: row.messageId,
    linkedThreadId,
    linkedThreadShortId: linkedThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getBoundTaskForThread(
  db: Db,
  params: { channelId: string; threadRootId?: string | null },
): BoundThreadTask | undefined {
  const threadRootId = normalizeThreadRootId(params.threadRootId);
  if (!threadRootId) return undefined;
  const rootMessageId = findThreadRootMessageId(db, params.channelId, threadRootId);
  if (!rootMessageId) return undefined;

  const row = db.prepare(
    `SELECT t.task_id as taskId,
            t.channel_id as channelId,
            t.task_number as taskNumber,
            t.title as title,
            t.description as description,
            t.status as status,
            t.claimed_by_agent_id as assigneeId,
            t.claimed_by_name as assigneeName,
            t.message_id as messageId,
            t.created_at as createdAt,
            t.updated_at as updatedAt
     FROM tasks t
     WHERE t.channel_id = ? AND t.message_id = ?
     LIMIT 1`,
  ).get(params.channelId, rootMessageId) as TaskThreadRow | undefined;

  return row ? toBoundThreadTask(row) : undefined;
}

export function getThreadBindingForTask(
  db: Db,
  taskId: string,
): { channelId: string; threadRootId: string; threadRootIds: string[] } | undefined {
  const row = db.prepare(
    `SELECT channel_id as channelId, message_id as messageId
     FROM tasks
     WHERE task_id = ? AND message_id IS NOT NULL
     LIMIT 1`,
  ).get(taskId) as { channelId: string; messageId: string | null } | undefined;

  const threadRootId = getTaskThreadRootId(row?.messageId);
  const threadRootIds = getTaskThreadRootIds(row?.messageId);
  if (!row || !threadRootId) return undefined;
  return { channelId: row.channelId, threadRootId, threadRootIds };
}

export function syncTaskThreadOwner(
  db: Db,
  params: {
    taskId: string;
    agentId?: string | null;
    lastActiveAt?: number;
  },
): void {
  const binding = getThreadBindingForTask(db, params.taskId);
  if (!binding) return;

  for (const threadRootId of binding.threadRootIds) {
    setTargetOwner(db, {
      channelId: binding.channelId,
      threadRootId,
      agentId: params.agentId ?? null,
      lastActiveAt: params.lastActiveAt,
    });
  }
}

export function clearTaskThreadState(
  db: Db,
  params: { channelId: string; taskId: string },
): void {
  const binding = getThreadBindingForTask(db, params.taskId);
  if (!binding) return;

  for (const threadRootId of binding.threadRootIds) {
    db.prepare(
      `DELETE FROM target_participants
       WHERE channel_id = ? AND thread_root_id = ?`,
    ).run(binding.channelId, threadRootId);

    db.prepare(
      `DELETE FROM agent_message_checkpoints
       WHERE channel_id = ? AND thread_root_id = ?`,
    ).run(binding.channelId, threadRootId);
  }
}

export function listChannelTasks(
  db: Db,
  params: { channelId: string; status?: TaskInfo['status'] | 'all' },
): TaskInfo[] {
  const rows = params.status && params.status !== 'all'
    ? db.prepare(
      `SELECT t.task_id as taskId,
              t.channel_id as channelId,
              t.task_number as taskNumber,
              t.title as title,
              t.description as description,
              t.status as status,
              t.claimed_by_agent_id as assigneeId,
              t.claimed_by_name as assigneeName,
              t.message_id as messageId,
              t.created_at as createdAt,
              t.updated_at as updatedAt
       FROM tasks t
       WHERE t.channel_id = ? AND t.status = ?
       ORDER BY t.task_number ASC`,
    ).all(params.channelId, params.status)
    : db.prepare(
      `SELECT t.task_id as taskId,
              t.channel_id as channelId,
              t.task_number as taskNumber,
              t.title as title,
              t.description as description,
              t.status as status,
              t.claimed_by_agent_id as assigneeId,
              t.claimed_by_name as assigneeName,
              t.message_id as messageId,
              t.created_at as createdAt,
              t.updated_at as updatedAt
       FROM tasks t
       WHERE t.channel_id = ?
       ORDER BY t.task_number ASC`,
    ).all(params.channelId);

  return (rows as TaskThreadRow[]).map(toTaskInfo);
}

export function getChannelTaskByNumber(
  db: Db,
  params: { channelId: string; taskNumber: number },
): TaskInfo | undefined {
  const row = db.prepare(
    `SELECT t.task_id as taskId,
            t.channel_id as channelId,
            t.task_number as taskNumber,
            t.title as title,
            t.description as description,
            t.status as status,
            t.claimed_by_agent_id as assigneeId,
            t.claimed_by_name as assigneeName,
            t.message_id as messageId,
            t.created_at as createdAt,
            t.updated_at as updatedAt
     FROM tasks t
     WHERE t.channel_id = ? AND t.task_number = ?
     LIMIT 1`,
  ).get(params.channelId, params.taskNumber) as TaskThreadRow | undefined;

  return row ? toTaskInfo(row) : undefined;
}

export function getThreadCollaborationSummary(
  db: Db,
  params: { channelId: string; threadRootId?: string | null },
): ThreadCollaborationSummary {
  const boundTask = getBoundTaskForThread(db, params);
  const participants = listRecentTargetParticipants(db, {
    channelId: params.channelId,
    threadRootId: params.threadRootId,
    activeSince: Date.now() - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
  });
  const ownerParticipant = participants.find((participant) => participant.role === 'owner');
  const suppressOwner = boundTask?.status === 'done';
  const taskOwner = boundTask && boundTask.status !== 'done' && boundTask.assigneeName
    ? { ownerAgentId: boundTask.assigneeId ?? null, ownerName: boundTask.assigneeName }
    : null;
  return {
    ...(boundTask ? { boundTask } : {}),
    ownerAgentId: suppressOwner ? null : taskOwner?.ownerAgentId ?? ownerParticipant?.agentId ?? null,
    ownerName: suppressOwner ? null : taskOwner?.ownerName ?? ownerParticipant?.name ?? null,
    participants: participants.map((participant) => participant.name),
  };
}
