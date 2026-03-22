import type { Db } from '@agent-collab/runtime-acp';
import { log } from '@agent-collab/runtime-acp';

export function reconcileNodeStateOnStartup(db: Db): {
  offlinedNodes: number;
  failedConversations: number;
  backfilledConversationAgents: number;
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

  const backfilledAgentResult = db
    .prepare(
      `UPDATE conversations
          SET agent_id = (
            SELECT a.agent_id
              FROM agents a
             WHERE a.agent_type = conversations.agent_type
               AND a.channel_id = conversations.channel_id
               AND (
                 (a.node_id IS NULL AND conversations.node_id IS NULL)
                 OR a.node_id = conversations.node_id
               )
               AND (
                 (a.workspace_path IS NULL AND conversations.workspace_path IS NULL)
                 OR a.workspace_path = conversations.workspace_path
               )
          )
        WHERE agent_id IS NULL
          AND 1 = (
            SELECT COUNT(*)
              FROM agents a
             WHERE a.agent_type = conversations.agent_type
               AND a.channel_id = conversations.channel_id
               AND (
                 (a.node_id IS NULL AND conversations.node_id IS NULL)
                 OR a.node_id = conversations.node_id
               )
               AND (
                 (a.workspace_path IS NULL AND conversations.workspace_path IS NULL)
                 OR a.workspace_path = conversations.workspace_path
               )
          )`,
    )
    .run();

  const summary = {
    offlinedNodes: offlineResult.changes,
    failedConversations: failedResult.changes,
    backfilledConversationAgents: backfilledAgentResult.changes,
  };

  if (
    summary.offlinedNodes > 0
    || summary.failedConversations > 0
    || summary.backfilledConversationAgents > 0
  ) {
    log.warn('[startup-reconcile] reset stale runtime state on startup', summary);
  }

  return summary;
}
