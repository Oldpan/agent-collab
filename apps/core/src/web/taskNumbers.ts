import type { Db } from '@agent-collab/runtime-acp';

export function allocateNextTaskNumber(db: Db, channelId: string): number {
  db.prepare(
    `INSERT INTO channel_task_sequences(channel_id, next_task_number)
     VALUES(
       ?,
       COALESCE((SELECT MAX(task_number) FROM tasks WHERE channel_id = ?), 0) + 1
     )
     ON CONFLICT(channel_id) DO NOTHING`,
  ).run(channelId, channelId);

  const row = db.prepare(
    `UPDATE channel_task_sequences
     SET next_task_number = next_task_number + 1
     WHERE channel_id = ?
     RETURNING next_task_number - 1 as taskNumber`,
  ).get(channelId) as { taskNumber: number } | undefined;

  if (!row) {
    throw new Error(`Failed to allocate task number for channel ${channelId}`);
  }

  return row.taskNumber;
}
