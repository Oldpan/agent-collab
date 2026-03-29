import type { Db } from '@agent-collab/runtime-acp';
import { listTargetParticipants } from './targetParticipants.js';

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

export function getBoundTaskForThread(
  db: Db,
  params: { channelId: string; threadRootId?: string | null },
): BoundThreadTask | undefined {
  const threadRootId = normalizeThreadRootId(params.threadRootId);
  if (!threadRootId) return undefined;
  return db.prepare(
    `SELECT t.task_id as taskId,
            t.channel_id as channelId,
            b.thread_root_id as threadRootId,
            b.thread_root_id as linkedThreadId,
            b.thread_root_id as linkedThreadShortId,
            t.task_number as taskNumber,
            t.title as title,
            t.description as description,
            t.status as status,
            t.claimed_by_agent_id as assigneeId,
            t.claimed_by_name as assigneeName,
            b.bound_at as boundAt
     FROM thread_task_bindings b
     JOIN tasks t ON t.task_id = b.task_id
     WHERE b.channel_id = ? AND b.thread_root_id = ?
     LIMIT 1`,
  ).get(params.channelId, threadRootId) as BoundThreadTask | undefined;
}

export function getThreadBindingForTask(db: Db, taskId: string): { channelId: string; threadRootId: string } | undefined {
  return db.prepare(
    `SELECT channel_id as channelId, thread_root_id as threadRootId
     FROM thread_task_bindings
     WHERE task_id = ?
     LIMIT 1`,
  ).get(taskId) as { channelId: string; threadRootId: string } | undefined;
}

export function bindTaskToThread(
  db: Db,
  params: {
    channelId: string;
    threadRootId?: string | null;
    taskId: string;
    boundAt?: number;
  },
): { ok: true } | { ok: false; reason: string } {
  const threadRootId = normalizeThreadRootId(params.threadRootId);
  if (!threadRootId) {
    return { ok: false, reason: 'Tasks can only be bound inside a thread' };
  }

  const existingThreadBinding = getBoundTaskForThread(db, {
    channelId: params.channelId,
    threadRootId,
  });
  if (existingThreadBinding && existingThreadBinding.taskId !== params.taskId) {
    return {
      ok: false,
      reason: `Thread is already bound to #t${existingThreadBinding.taskNumber}`,
    };
  }

  const existingTaskBinding = getThreadBindingForTask(db, params.taskId);
  if (
    existingTaskBinding &&
    (existingTaskBinding.channelId !== params.channelId || existingTaskBinding.threadRootId !== threadRootId)
  ) {
    return {
      ok: false,
      reason: `Task is already bound to thread ${existingTaskBinding.threadRootId}`,
    };
  }

  db.prepare(
    `INSERT OR IGNORE INTO thread_task_bindings(channel_id, thread_root_id, task_id, bound_at)
     VALUES(?, ?, ?, ?)`,
  ).run(params.channelId, threadRootId, params.taskId, params.boundAt ?? Date.now());

  return { ok: true };
}

export function unbindTaskFromThread(
  db: Db,
  params: { channelId: string; threadRootId?: string | null },
): void {
  const threadRootId = normalizeThreadRootId(params.threadRootId);
  if (!threadRootId) return;
  db.prepare(
    `DELETE FROM thread_task_bindings
     WHERE channel_id = ? AND thread_root_id = ?`,
  ).run(params.channelId, threadRootId);
}

export function getThreadCollaborationSummary(
  db: Db,
  params: { channelId: string; threadRootId?: string | null },
): ThreadCollaborationSummary {
  const boundTask = getBoundTaskForThread(db, params);
  const participants = listTargetParticipants(db, params);
  const ownerParticipant = participants.find((participant) => participant.role === 'owner');
  const taskOwner = boundTask && boundTask.status !== 'done' && boundTask.assigneeId
    ? { ownerAgentId: boundTask.assigneeId, ownerName: boundTask.assigneeName }
    : null;
  return {
    ...(boundTask ? { boundTask } : {}),
    ownerAgentId: taskOwner?.ownerAgentId ?? ownerParticipant?.agentId ?? null,
    ownerName: taskOwner?.ownerName ?? ownerParticipant?.name ?? null,
    participants: participants.map((participant) => participant.name),
  };
}
