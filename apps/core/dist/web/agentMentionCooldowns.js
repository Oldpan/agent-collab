function normalizeThreadRootId(threadRootId) {
    return threadRootId ?? '';
}
export function recordAgentMentionNotification(db, params) {
    const notifiedAt = params.notifiedAt ?? Date.now();
    db.prepare(`INSERT INTO agent_mention_cooldowns(channel_id, thread_root_id, from_agent_id, to_agent_id, last_notified_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_root_id, from_agent_id, to_agent_id) DO UPDATE
       SET last_notified_at = excluded.last_notified_at`).run(params.channelId, normalizeThreadRootId(params.threadRootId), params.fromAgentId, params.toAgentId, notifiedAt);
}
export function shouldTriggerAgentMention(db, params) {
    const now = params.now ?? Date.now();
    const row = db.prepare(`SELECT last_notified_at as lastNotifiedAt
     FROM agent_mention_cooldowns
     WHERE channel_id = ? AND thread_root_id = ? AND from_agent_id = ? AND to_agent_id = ?`).get(params.channelId, normalizeThreadRootId(params.threadRootId), params.fromAgentId, params.toAgentId);
    return !row || (now - row.lastNotifiedAt) >= params.cooldownMs;
}
