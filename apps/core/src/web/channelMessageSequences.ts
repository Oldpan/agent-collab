import type { Db } from '@agent-collab/runtime-acp';

export function allocateNextChannelMessageSeq(db: Db, channelId: string): number {
  const tx = db.transaction((targetChannelId: string) => {
    db.prepare(
      `INSERT INTO channel_message_sequences(channel_id, next_seq)
       VALUES(
         ?,
         COALESCE((SELECT MAX(seq) FROM channel_messages WHERE channel_id = ?), 0) + 1
       )
       ON CONFLICT(channel_id) DO NOTHING`,
    ).run(targetChannelId, targetChannelId);

    const row = db.prepare(
      `UPDATE channel_message_sequences
       SET next_seq = next_seq + 1
       WHERE channel_id = ?
       RETURNING next_seq - 1 as seq`,
    ).get(targetChannelId) as { seq: number } | undefined;

    if (!row) {
      throw new Error(`Failed to allocate message sequence for channel ${targetChannelId}`);
    }

    return row.seq;
  });

  return tx(channelId);
}
