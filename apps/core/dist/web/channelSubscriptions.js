export function upsertChannelSubscription(db, params) {
    const now = params.lastActiveAt ?? Date.now();
    const subscribedAt = params.subscribedAt ?? now;
    db.prepare(`INSERT INTO channel_subscriptions(channel_id, agent_id, subscribed_at, last_active_at)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(channel_id, agent_id) DO UPDATE SET
       subscribed_at = MIN(channel_subscriptions.subscribed_at, excluded.subscribed_at),
       last_active_at = MAX(channel_subscriptions.last_active_at, excluded.last_active_at)`).run(params.channelId, params.agentId, subscribedAt, now);
}
export function listChannelSubscriptions(db, channelId) {
    return db.prepare(`SELECT s.agent_id as agentId,
            a.name as name,
            s.subscribed_at as subscribedAt,
            s.last_active_at as lastActiveAt
     FROM channel_subscriptions s
     JOIN agents a ON a.agent_id = s.agent_id
     WHERE s.channel_id = ?
     ORDER BY s.last_active_at DESC, a.name ASC`).all(channelId);
}
export function deleteChannelSubscription(db, channelId, agentId) {
    db.prepare(`DELETE FROM channel_subscriptions
     WHERE channel_id = ? AND agent_id = ?`).run(channelId, agentId);
}
export function deleteChannelSubscriptionsForChannel(db, channelId) {
    db.prepare('DELETE FROM channel_subscriptions WHERE channel_id = ?').run(channelId);
}
