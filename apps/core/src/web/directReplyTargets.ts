import type { Db } from '@agent-collab/runtime-acp';

export function resolveDirectUserName(
  db: Db,
  userId: string | null | undefined,
  fallbackHumanUserName: string,
): string {
  if (!userId) return fallbackHumanUserName;
  const row = db.prepare(
    'SELECT username FROM users WHERE id = ?',
  ).get(userId) as { username: string | null } | undefined;
  return row?.username?.trim() || fallbackHumanUserName;
}

export function buildDirectReplyTarget(params: {
  isPrimaryThread: boolean;
  userName: string;
  threadRootId?: string | null;
}): string {
  return params.isPrimaryThread
    ? `dm:@${params.userName}`
    : params.threadRootId?.trim()
      ? `dm:@${params.userName}:${params.threadRootId.trim().slice(0, 8)}`
      : `dm:@${params.userName}`;
}

export function resolveConversationReplyTarget(
  db: Db,
  conversationId: string,
  fallbackHumanUserName: string,
): string | null {
  const row = db.prepare(
    `SELECT c.id as conversationId,
            c.reply_target as replyTarget,
            c.thread_kind as threadKind,
            c.is_primary_thread as isPrimaryThread,
            c.thread_root_id as threadRootId,
            c.channel_id as channelId,
            c.user_id as userId,
            ch.name as channelName
     FROM conversations c
     LEFT JOIN channels ch ON ch.channel_id = c.channel_id
     WHERE c.id = ?`,
  ).get(conversationId) as {
    conversationId: string;
    replyTarget: string | null;
    threadKind: 'direct' | 'branch';
    isPrimaryThread: number;
    threadRootId: string | null;
    channelId: string;
    userId: string | null;
    channelName: string | null;
  } | undefined;

  if (!row) return null;

  if (row.threadKind === 'direct') {
    const userName = resolveDirectUserName(db, row.userId, fallbackHumanUserName);
    return buildDirectReplyTarget({
      isPrimaryThread: row.isPrimaryThread !== 0,
      userName,
      threadRootId: row.threadRootId,
    });
  }

  if (row.replyTarget?.trim()) return row.replyTarget;
  const channelName = row.channelName ?? row.channelId;
  const baseTarget = `#${channelName}`;
  return row.threadRootId ? `${baseTarget}:${row.threadRootId}` : baseTarget;
}
