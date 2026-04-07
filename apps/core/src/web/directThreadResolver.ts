import type { Db } from '@agent-collab/runtime-acp';

export function resolveDirectThreadRootMessage(
  db: Db,
  params: {
    agentId: string;
    directTarget: string;
    requestedThreadRootId?: string | null;
    requestedMessageId?: string | null;
  },
): { messageId: string; threadRootId: string } | null {
  const dmChannelId = `dm:${params.agentId}`;
  let resolvedThreadRootId = params.requestedThreadRootId ?? null;

  if (!resolvedThreadRootId && params.requestedMessageId) {
    const requestedMessageId = params.requestedMessageId.trim();
    const exactMessage = db.prepare(
      `SELECT message_id as messageId, thread_root_id as threadRootId, message_kind as messageKind
       FROM channel_messages
       WHERE channel_id = ?
         AND (message_id = ? OR message_id LIKE ?)
       ORDER BY CASE WHEN message_id = ? THEN 0 ELSE 1 END, seq ASC
       LIMIT 1`,
    ).get(dmChannelId, requestedMessageId, `${requestedMessageId.slice(0, 8)}%`, requestedMessageId) as {
      messageId: string;
      threadRootId: string | null;
      messageKind: string | null;
    } | undefined;

    if (exactMessage?.threadRootId) {
      resolvedThreadRootId = exactMessage.threadRootId;
    } else if (exactMessage?.messageKind === 'task') {
      resolvedThreadRootId = exactMessage.messageId.slice(0, 8);
    } else {
      const snapshotRow = db.prepare(
        `SELECT thread_root_id as threadRootId
         FROM dm_thread_context_snapshots
         WHERE channel_id = ?
           AND (trigger_message_id = ? OR trigger_message_id LIKE ?)
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(dmChannelId, requestedMessageId, `${requestedMessageId.slice(0, 8)}%`) as { threadRootId: string } | undefined;
      if (snapshotRow?.threadRootId) {
        resolvedThreadRootId = snapshotRow.threadRootId.slice(0, 8);
      }
    }
  }

  if (!resolvedThreadRootId) return null;

  const rootRow = db.prepare(
    `SELECT message_id as messageId
     FROM channel_messages
     WHERE channel_id = ?
       AND (
         target = ?
         OR (
           message_kind = 'task'
           AND target = ?
           AND EXISTS(
             SELECT 1
             FROM channel_messages thread_msgs
             WHERE thread_msgs.channel_id = channel_messages.channel_id
               AND thread_msgs.thread_root_id = SUBSTR(channel_messages.message_id, 1, 8)
               AND thread_msgs.target LIKE ?
             LIMIT 1
           )
         )
       )
       AND thread_root_id IS NULL
       AND message_id LIKE ?
     LIMIT 1`,
  ).get(dmChannelId, params.directTarget, `#${dmChannelId}`, `${params.directTarget}:%`, `${resolvedThreadRootId}%`) as {
    messageId: string;
  } | undefined;

  if (!rootRow) return null;
  return {
    messageId: rootRow.messageId,
    threadRootId: rootRow.messageId.slice(0, 8),
  };
}
