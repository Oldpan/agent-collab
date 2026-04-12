import type { Db } from '@agent-collab/runtime-acp';
import {
  buildThreadShortId,
  normalizeThreadShortIdInput,
} from '@agent-collab/protocol';
import { findThreadRootMessageId } from './threadRoots.js';

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
  let resolvedThreadRootId = normalizeThreadShortIdInput(params.requestedThreadRootId);

  if (!resolvedThreadRootId && params.requestedMessageId) {
    const requestedMessageId = params.requestedMessageId.trim();
    const exactMessage = db.prepare(
      `SELECT message_id as messageId, thread_root_id as threadRootId, message_kind as messageKind
       FROM channel_messages
       WHERE channel_id = ?
         AND message_id LIKE ?
       ORDER BY CASE WHEN message_id = ? THEN 0 ELSE 1 END, seq ASC
       LIMIT 1`,
    ).get(dmChannelId, `${requestedMessageId}%`, requestedMessageId) as {
      messageId: string;
      threadRootId: string | null;
      messageKind: string | null;
    } | undefined;

    if (exactMessage?.threadRootId) {
      resolvedThreadRootId = normalizeThreadShortIdInput(exactMessage.threadRootId);
    } else if (exactMessage?.messageKind === 'task') {
      resolvedThreadRootId = buildThreadShortId(exactMessage.messageId);
    } else {
      const snapshotRow = db.prepare(
        `SELECT thread_root_id as threadRootId
         FROM dm_thread_context_snapshots
         WHERE channel_id = ?
           AND trigger_message_id LIKE ?
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(dmChannelId, `${requestedMessageId}%`) as { threadRootId: string } | undefined;
      if (snapshotRow?.threadRootId) {
        resolvedThreadRootId = normalizeThreadShortIdInput(snapshotRow.threadRootId);
      }
    }
  }

  if (!resolvedThreadRootId) return null;

  const rootMessageId = findThreadRootMessageId(db, dmChannelId, resolvedThreadRootId);
  if (!rootMessageId) return null;

  const rootRow = db.prepare(
    `SELECT target, message_kind as messageKind
     FROM channel_messages
     WHERE channel_id = ?
       AND thread_root_id IS NULL
       AND message_id = ?
     LIMIT 1`,
  ).get(dmChannelId, rootMessageId) as {
    target: string;
    messageKind: string | null;
  } | undefined;

  if (!rootRow) return null;
  if (rootRow.target !== params.directTarget) {
    if (!(rootRow.messageKind === 'task' && rootRow.target === `#${dmChannelId}`)) {
      return null;
    }

    const hasDirectThreadMessages = db.prepare(
      `SELECT 1
       FROM channel_messages
       WHERE channel_id = ?
         AND thread_root_id = ?
         AND target LIKE ?
       LIMIT 1`,
    ).get(
      dmChannelId,
      buildThreadShortId(rootMessageId),
      `${params.directTarget}:%`,
    ) as { 1: number } | undefined;
    if (!hasDirectThreadMessages) return null;
  }

  return {
    messageId: rootMessageId,
    threadRootId: buildThreadShortId(rootMessageId),
  };
}
