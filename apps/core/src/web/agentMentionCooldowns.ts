import type { Db } from '@agent-collab/runtime-acp';

function normalizeThreadRootId(threadRootId?: string | null): string {
  return threadRootId ?? '';
}

export function recordAgentMentionNotification(
  db: Db,
  params: {
    channelId: string;
    threadRootId?: string | null;
    fromAgentId: string;
    toAgentId: string;
    notifiedAt?: number;
  },
): void {
  const notifiedAt = params.notifiedAt ?? Date.now();
  db.prepare(
    `INSERT INTO agent_mention_cooldowns(channel_id, thread_root_id, from_agent_id, to_agent_id, last_notified_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_root_id, from_agent_id, to_agent_id) DO UPDATE
       SET last_notified_at = excluded.last_notified_at`,
  ).run(
    params.channelId,
    normalizeThreadRootId(params.threadRootId),
    params.fromAgentId,
    params.toAgentId,
    notifiedAt,
  );
}

export function shouldTriggerAgentMention(
  db: Db,
  params: {
    channelId: string;
    threadRootId?: string | null;
    fromAgentId: string;
    toAgentId: string;
    now?: number;
    cooldownMs: number;
  },
): boolean {
  const now = params.now ?? Date.now();
  const row = db.prepare(
    `SELECT last_notified_at as lastNotifiedAt
     FROM agent_mention_cooldowns
     WHERE channel_id = ? AND thread_root_id = ? AND from_agent_id = ? AND to_agent_id = ?`,
  ).get(
    params.channelId,
    normalizeThreadRootId(params.threadRootId),
    params.fromAgentId,
    params.toAgentId,
  ) as { lastNotifiedAt: number } | undefined;

  return !row || (now - row.lastNotifiedAt) >= params.cooldownMs;
}
