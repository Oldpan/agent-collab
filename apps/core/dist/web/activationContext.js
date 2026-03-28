import { getAgentMessageCheckpoint } from './messageCheckpoints.js';
import { listTargetParticipants } from './targetParticipants.js';
import { getBoundTaskForThread } from './threadTaskBindings.js';
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
    const participants = listTargetParticipants(db, {
        channelId: params.channelId,
        threadRootId: normalizedThreadRootId,
    });
    const boundTaskRow = getBoundTaskForThread(db, {
        channelId: params.channelId,
        threadRootId: normalizedThreadRootId,
    });
    const boundTask = boundTaskRow
        ? {
            taskNumber: boundTaskRow.taskNumber,
            title: boundTaskRow.title,
            status: boundTaskRow.status,
            claimedByName: boundTaskRow.assigneeName,
        }
        : undefined;
    const openTasks = db.prepare(`SELECT task_number as taskNumber,
            title,
            status,
            claimed_by_name as claimedByName
     FROM tasks
     WHERE channel_id = ? AND status != 'done'
     ORDER BY
       CASE status
         WHEN 'in_progress' THEN 0
         WHEN 'in_review' THEN 1
         WHEN 'todo' THEN 2
         ELSE 3
       END ASC,
       task_number ASC
     LIMIT 5`).all(params.channelId);
    return {
        replyTarget: params.replyTarget,
        recentMessages,
        unreadCount: unreadRow.count,
        participants,
        ...(boundTask ? { boundTask } : {}),
        openTasks: boundTask ? [] : openTasks,
        ...(rootMessage ? { rootMessage } : {}),
    };
}
