import type { Db } from '@agent-collab/runtime-acp';

export function checkpointThreadKey(threadRootId?: string | null): string {
  return threadRootId ?? '';
}

export function getAgentMessageCheckpoint(
  db: Db,
  agentId: string,
  channelId: string,
  threadRootId?: string | null,
): number {
  const row = db.prepare(
    `SELECT last_seq as lastSeq FROM agent_message_checkpoints
     WHERE agent_id = ? AND channel_id = ? AND thread_root_id = ?`,
  ).get(agentId, channelId, checkpointThreadKey(threadRootId)) as { lastSeq: number } | undefined;
  return row?.lastSeq ?? 0;
}

export function setAgentMessageCheckpoint(
  db: Db,
  agentId: string,
  channelId: string,
  lastSeq: number,
  threadRootId?: string | null,
): void {
  db.prepare(
    `INSERT INTO agent_message_checkpoints(agent_id, channel_id, thread_root_id, last_seq)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(agent_id, channel_id, thread_root_id) DO UPDATE SET last_seq = excluded.last_seq`,
  ).run(agentId, channelId, checkpointThreadKey(threadRootId), lastSeq);
}

export function bumpAgentMessageCheckpoint(
  db: Db,
  agentId: string,
  channelId: string,
  lastSeq: number,
  threadRootId?: string | null,
): void {
  db.prepare(
    `INSERT INTO agent_message_checkpoints(agent_id, channel_id, thread_root_id, last_seq)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(agent_id, channel_id, thread_root_id) DO UPDATE
       SET last_seq = MAX(agent_message_checkpoints.last_seq, excluded.last_seq)`,
  ).run(agentId, channelId, checkpointThreadKey(threadRootId), lastSeq);
}
