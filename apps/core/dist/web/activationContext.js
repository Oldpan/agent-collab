import { getAgentMessageCheckpoint } from './messageCheckpoints.js';
export function buildTargetActivationContext(db, params) {
    const recentLimit = Math.max(1, params.recentLimit ?? 8);
    const normalizedThreadRootId = params.threadRootId ?? null;
    const threadClause = normalizedThreadRootId == null
        ? 'thread_root_id IS NULL'
        : 'thread_root_id = ?';
    const threadArgs = normalizedThreadRootId == null ? [] : [normalizedThreadRootId];
    const recentMessages = db.prepare(`SELECT message_id as messageId, target, sender_name as senderName, sender_type as senderType,
              content, created_at as createdAt
       FROM channel_messages
       WHERE channel_id = ? AND ${threadClause} AND seq < ?
       ORDER BY seq DESC
       LIMIT ?`).all(params.channelId, ...threadArgs, params.triggerSeq, recentLimit).reverse();
    const checkpoint = getAgentMessageCheckpoint(db, params.agentId, params.channelId, normalizedThreadRootId);
    const unreadRow = db.prepare(`SELECT COUNT(*) as count
     FROM channel_messages
     WHERE channel_id = ?
       AND ${threadClause}
       AND seq > ?
       AND seq < ?
       AND sender_id != ?`).get(params.channelId, ...threadArgs, checkpoint, params.triggerSeq, params.agentId);
    const rootMessage = normalizedThreadRootId
        ? db.prepare(`SELECT message_id as messageId, target, sender_name as senderName, sender_type as senderType,
              content, created_at as createdAt
       FROM channel_messages
       WHERE channel_id = ? AND substr(message_id, 1, 8) = ?
       ORDER BY created_at ASC, seq ASC
       LIMIT 1`).get(params.channelId, normalizedThreadRootId)
        : undefined;
    return {
        replyTarget: params.replyTarget,
        recentMessages,
        unreadCount: unreadRow.count,
        ...(rootMessage ? { rootMessage } : {}),
    };
}
