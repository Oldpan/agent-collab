import type { Db } from '@agent-collab/runtime-acp';
import {
  buildLegacyThreadShortId,
  buildThreadShortId,
  matchesThreadShortId,
  normalizeThreadShortIdInput,
} from '@agent-collab/protocol';

export type ThreadRootLookup = {
  canonicalThreadRootId: string;
  alternateThreadRootIds: string[];
  messageId: string | null;
};

function listTopLevelMessageIds(db: Db, channelId: string): string[] {
  const rows = db.prepare(
    `SELECT message_id as messageId
     FROM channel_messages
     WHERE channel_id = ?
       AND thread_root_id IS NULL
     ORDER BY created_at ASC, seq ASC`,
  ).all(channelId) as Array<{ messageId: string }>;
  return rows.map((row) => row.messageId);
}

export function findThreadRootMessageId(
  db: Db,
  channelId: string,
  threadRootId: string | null | undefined,
): string | null {
  const normalizedThreadRootId = normalizeThreadShortIdInput(threadRootId);
  if (!normalizedThreadRootId) return null;

  const match = listTopLevelMessageIds(db, channelId).find((messageId) =>
    matchesThreadShortId(messageId, normalizedThreadRootId),
  );
  return match ?? null;
}

export function resolveThreadRootLookup(
  db: Db,
  channelId: string,
  threadRootId: string | null | undefined,
): ThreadRootLookup | null {
  const normalizedThreadRootId = normalizeThreadShortIdInput(threadRootId);
  if (!normalizedThreadRootId) return null;

  const messageId = findThreadRootMessageId(db, channelId, normalizedThreadRootId);
  if (!messageId) {
    return {
      canonicalThreadRootId: normalizedThreadRootId,
      alternateThreadRootIds: [normalizedThreadRootId],
      messageId: null,
    };
  }

  const canonicalThreadRootId = buildThreadShortId(messageId);
  const alternateThreadRootIds = Array.from(new Set([
    normalizedThreadRootId,
    canonicalThreadRootId,
    buildLegacyThreadShortId(messageId),
  ]));

  return {
    canonicalThreadRootId,
    alternateThreadRootIds,
    messageId,
  };
}
