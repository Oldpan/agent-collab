export function checkpointThreadKey(threadRootId) {
    return threadRootId ?? '';
}
export function getAgentMessageCheckpoint(db, agentId, channelId, threadRootId) {
    const row = db.prepare(`SELECT last_seq as lastSeq FROM agent_message_checkpoints
     WHERE agent_id = ? AND channel_id = ? AND thread_root_id = ?`).get(agentId, channelId, checkpointThreadKey(threadRootId));
    return row?.lastSeq ?? 0;
}
export function setAgentMessageCheckpoint(db, agentId, channelId, lastSeq, threadRootId) {
    db.prepare(`INSERT INTO agent_message_checkpoints(agent_id, channel_id, thread_root_id, last_seq)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(agent_id, channel_id, thread_root_id) DO UPDATE SET last_seq = excluded.last_seq`).run(agentId, channelId, checkpointThreadKey(threadRootId), lastSeq);
}
export function bumpAgentMessageCheckpoint(db, agentId, channelId, lastSeq, threadRootId) {
    db.prepare(`INSERT INTO agent_message_checkpoints(agent_id, channel_id, thread_root_id, last_seq)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(agent_id, channel_id, thread_root_id) DO UPDATE
       SET last_seq = MAX(agent_message_checkpoints.last_seq, excluded.last_seq)`).run(agentId, channelId, checkpointThreadKey(threadRootId), lastSeq);
}
