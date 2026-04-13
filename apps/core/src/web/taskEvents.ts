import { randomUUID } from 'node:crypto';
import type { Db } from '@agent-collab/runtime-acp';
import { buildThreadShortId } from '@agent-collab/protocol';

export type TaskEventType =
  | 'created'
  | 'claimed'
  | 'unclaimed'
  | 'status_changed'
  | 'handoff_started'
  | 'handoff_failed';

export type TaskEventActorType = 'agent' | 'user' | 'system';

type AppendTaskEventParams = {
  taskId: string;
  agentTaskRef: string | null;
  channelId: string;
  taskNumber: number;
  eventType: TaskEventType;
  actorType: TaskEventActorType;
  actorId?: string | null;
  actorName?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  claimedByAgentIdAfter?: string | null;
  claimedByNameAfter?: string | null;
  messageId?: string | null;
  threadTarget?: string | null;
  createdAt?: number;
};

function isThreadTarget(target: string): boolean {
  if (target.startsWith('dm:@')) return target.split(':').length >= 3;
  if (target.startsWith('#')) return target.includes(':');
  return false;
}

export function buildTaskEventThreadTarget(params: {
  sourceTarget?: string | null;
  messageId?: string | null;
  explicitThreadTarget?: string | null;
}): string | null {
  if (params.explicitThreadTarget?.trim()) return params.explicitThreadTarget.trim();
  const sourceTarget = params.sourceTarget?.trim();
  const messageId = params.messageId?.trim();
  if (!sourceTarget || !messageId) return null;
  if (!(sourceTarget.startsWith('#') || sourceTarget.startsWith('dm:@'))) return null;
  if (isThreadTarget(sourceTarget)) return sourceTarget;
  return `${sourceTarget}:${buildThreadShortId(messageId)}`;
}

export function appendTaskEvent(db: Db, params: AppendTaskEventParams): void {
  db.prepare(
    `INSERT INTO task_events(
       event_id,
       task_id,
       agent_task_ref,
       channel_id,
       task_number,
       event_type,
       actor_type,
       actor_id,
       actor_name,
       from_status,
       to_status,
       claimed_by_agent_id_after,
       claimed_by_name_after,
       message_id,
       thread_target,
       created_at
     )
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    params.taskId,
    params.agentTaskRef,
    params.channelId,
    params.taskNumber,
    params.eventType,
    params.actorType,
    params.actorId ?? null,
    params.actorName ?? null,
    params.fromStatus ?? null,
    params.toStatus ?? null,
    params.claimedByAgentIdAfter ?? null,
    params.claimedByNameAfter ?? null,
    params.messageId ?? null,
    params.threadTarget ?? null,
    params.createdAt ?? Date.now(),
  );
}

export function deleteTaskEventsForChannel(db: Db, channelId: string): void {
  db.prepare(`DELETE FROM task_events WHERE channel_id = ?`).run(channelId);
}

export function deleteTaskEventsForTask(db: Db, taskId: string): void {
  db.prepare(`DELETE FROM task_events WHERE task_id = ?`).run(taskId);
}
