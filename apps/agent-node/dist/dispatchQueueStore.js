export function enqueueDispatch(db, msg, state = 'queued') {
    const now = Date.now();
    db.prepare(`INSERT OR REPLACE INTO node_dispatch_queue(
       run_id,
       host_key,
       session_key,
       conversation_id,
       payload_json,
       state,
       created_at,
       updated_at
     ) VALUES(?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM node_dispatch_queue WHERE run_id = ?), ?), ?)`).run(msg.runId, msg.hostKey, msg.sessionKey, msg.conversationId, JSON.stringify(msg), state, msg.runId, now, now);
}
export function updateDispatchState(db, runId, state) {
    db.prepare(`UPDATE node_dispatch_queue SET state = ?, updated_at = ? WHERE run_id = ?`).run(state, Date.now(), runId);
}
export function removeDispatch(db, runId) {
    db.prepare(`DELETE FROM node_dispatch_queue WHERE run_id = ?`).run(runId);
}
export function listPendingDispatches(db) {
    const rows = db.prepare(`SELECT run_id as runId, host_key as hostKey, state, payload_json as payloadJson
       FROM node_dispatch_queue
      ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, created_at ASC`).all();
    return rows.flatMap((row) => {
        try {
            const payload = JSON.parse(row.payloadJson);
            return [{ runId: row.runId, hostKey: row.hostKey, state: row.state, payload }];
        }
        catch {
            return [];
        }
    });
}
