function normalizeThreadRootId(threadRootId) {
    return threadRootId ?? '';
}
export function upsertTargetParticipant(db, params) {
    const now = params.lastActiveAt ?? Date.now();
    const joinedAt = params.joinedAt ?? now;
    const threadRootId = normalizeThreadRootId(params.threadRootId);
    const incomingRole = params.role ?? 'participant';
    const existing = db.prepare(`SELECT role, joined_at as joinedAt
     FROM target_participants
     WHERE agent_id = ? AND channel_id = ? AND thread_root_id = ?`).get(params.agentId, params.channelId, threadRootId);
    const role = existing?.role === 'owner' || incomingRole === 'owner' ? 'owner' : 'participant';
    db.prepare(`INSERT INTO target_participants(agent_id, channel_id, thread_root_id, role, joined_at, last_active_at)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, channel_id, thread_root_id) DO UPDATE SET
       role = excluded.role,
       joined_at = MIN(target_participants.joined_at, excluded.joined_at),
       last_active_at = MAX(target_participants.last_active_at, excluded.last_active_at)`).run(params.agentId, params.channelId, threadRootId, role, existing?.joinedAt ?? joinedAt, now);
}
export function listTargetParticipants(db, params) {
    return db.prepare(`SELECT tp.agent_id as agentId,
            a.name as name,
            tp.role as role,
            tp.joined_at as joinedAt,
            tp.last_active_at as lastActiveAt
     FROM target_participants tp
     JOIN agents a ON a.agent_id = tp.agent_id
     WHERE tp.channel_id = ? AND tp.thread_root_id = ?
     ORDER BY
       CASE tp.role WHEN 'owner' THEN 0 ELSE 1 END ASC,
       tp.last_active_at DESC,
       a.name ASC`).all(params.channelId, normalizeThreadRootId(params.threadRootId));
}
export function setTargetOwner(db, params) {
    const threadRootId = normalizeThreadRootId(params.threadRootId);
    db.prepare(`UPDATE target_participants
     SET role = 'participant'
     WHERE channel_id = ? AND thread_root_id = ?`).run(params.channelId, threadRootId);
    if (params.agentId) {
        upsertTargetParticipant(db, {
            agentId: params.agentId,
            channelId: params.channelId,
            threadRootId,
            role: 'owner',
            lastActiveAt: params.lastActiveAt,
        });
    }
}
export function deleteTargetParticipantsForAgent(db, agentId) {
    db.prepare('DELETE FROM target_participants WHERE agent_id = ?').run(agentId);
}
export function deleteTargetParticipantsForChannel(db, channelId) {
    db.prepare('DELETE FROM target_participants WHERE channel_id = ?').run(channelId);
}
