import type { Db } from '@agent-collab/runtime-acp';
import type { RunDispatchMsg } from '@agent-collab/protocol';

export type PersistedDispatchState = 'queued' | 'running';

export type PersistedDispatch = {
  runId: string;
  hostKey: string;
  state: PersistedDispatchState;
  payload: RunDispatchMsg;
};

export function enqueueDispatch(
  db: Db,
  msg: RunDispatchMsg,
  state: PersistedDispatchState = 'queued',
): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO node_dispatch_queue(
       run_id,
       host_key,
       session_key,
       conversation_id,
       payload_json,
       state,
       created_at,
       updated_at
     ) VALUES(?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM node_dispatch_queue WHERE run_id = ?), ?), ?)`,
  ).run(
    msg.runId,
    msg.hostKey,
    msg.sessionKey,
    msg.conversationId,
    JSON.stringify(msg),
    state,
    msg.runId,
    now,
    now,
  );
}

export function updateDispatchState(
  db: Db,
  runId: string,
  state: PersistedDispatchState,
): void {
  db.prepare(
    `UPDATE node_dispatch_queue SET state = ?, updated_at = ? WHERE run_id = ?`,
  ).run(state, Date.now(), runId);
}

export function removeDispatch(db: Db, runId: string): void {
  db.prepare(`DELETE FROM node_dispatch_queue WHERE run_id = ?`).run(runId);
}

export function listPendingDispatches(db: Db): PersistedDispatch[] {
  const rows = db.prepare(
    `SELECT run_id as runId, host_key as hostKey, state, payload_json as payloadJson
       FROM node_dispatch_queue
      ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, created_at ASC`,
  ).all() as Array<{
    runId: string;
    hostKey: string;
    state: PersistedDispatchState;
    payloadJson: string;
  }>;

  return rows.flatMap((row) => {
    try {
      const payload = JSON.parse(row.payloadJson) as RunDispatchMsg;
      return [{ runId: row.runId, hostKey: row.hostKey, state: row.state, payload }];
    } catch {
      return [];
    }
  });
}
