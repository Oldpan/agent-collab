import type { Db } from '@agent-collab/runtime-acp';
import { log } from '@agent-collab/runtime-acp';

export function reconcileNodeStateOnStartup(db: Db): {
  offlinedNodes: number;
  failedConversations: number;
} {
  const now = Date.now();
  const offlineResult = db
    .prepare(`UPDATE nodes SET status = 'offline', last_seen = ? WHERE status = 'online'`)
    .run(now);

  const failedResult = db
    .prepare(
      `UPDATE conversations
          SET status = 'failed', updated_at = ?
        WHERE node_id IS NOT NULL
          AND status IN ('active', 'awaiting_approval')`,
    )
    .run(now);

  const summary = {
    offlinedNodes: offlineResult.changes,
    failedConversations: failedResult.changes,
  };

  if (summary.offlinedNodes > 0 || summary.failedConversations > 0) {
    log.warn('[node-reconcile] reset stale runtime state on startup', summary);
  }

  return summary;
}
