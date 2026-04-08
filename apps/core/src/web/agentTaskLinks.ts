import type { Db } from '@agent-collab/runtime-acp';

type UpsertAgentTaskLinkParams = {
  agentId: string | null | undefined;
  taskId: string;
  linkedAt?: number;
  created?: boolean;
  assigned?: boolean;
};

export function upsertAgentTaskLink(db: Db, params: UpsertAgentTaskLinkParams): void {
  const agentId = params.agentId?.trim();
  if (!agentId) return;

  const createdRelation = params.created ? 1 : 0;
  const assignedRelation = params.assigned ? 1 : 0;
  if (!createdRelation && !assignedRelation) return;

  const linkedAt = params.linkedAt ?? Date.now();
  db.prepare(
    `INSERT INTO agent_task_links(
       agent_id,
       task_id,
       created_relation,
       assigned_relation,
       first_linked_at,
       last_linked_at
     )
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, task_id) DO UPDATE SET
       created_relation = MAX(agent_task_links.created_relation, excluded.created_relation),
       assigned_relation = MAX(agent_task_links.assigned_relation, excluded.assigned_relation),
       first_linked_at = MIN(agent_task_links.first_linked_at, excluded.first_linked_at),
       last_linked_at = MAX(agent_task_links.last_linked_at, excluded.last_linked_at)`,
  ).run(agentId, params.taskId, createdRelation, assignedRelation, linkedAt, linkedAt);
}
