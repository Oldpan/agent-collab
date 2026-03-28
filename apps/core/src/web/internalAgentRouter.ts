import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db } from '@agent-collab/runtime-acp';
import type { ServerEvent } from '@agent-collab/protocol';
import type { ConversationManager } from './conversationManager.js';
import {
  checkpointThreadKey,
  getAgentMessageCheckpoint,
  setAgentMessageCheckpoint,
} from './messageCheckpoints.js';

type MessageRow = {
  messageId: string;
  channelId: string;
  senderId: string;
  senderName: string;
  senderType: string;
  target: string;
  content: string;
  seq: number;
  createdAt: number;
  threadRootId: string | null;
};

type TaskRow = {
  taskId: string;
  channelId: string;
  taskNumber: number;
  title: string;
  status: string;
  claimedByAgentId: string | null;
  claimedByName: string | null;
  createdByAgentId: string | null;
  createdByName: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * Registers internal agent API routes — used by channel-bridge MCP server.
 *
 * These endpoints let agents (via the channel-bridge) send messages to channels,
 * poll for new messages, browse the server directory, and manage task boards.
 */
export function registerInternalAgentRoutes(
  app: FastifyInstance,
  db: Db,
  conversationManager: ConversationManager,
  broadcastToAgent: (agentId: string, event: ServerEvent, conversationId?: string) => void,
  broadcastToChannel: (channelId: string, event: ServerEvent) => void,
  humanUserName: string,
): void {
  // ─── Messaging ───────────────────────────────────────────────────────────

  /**
   * POST /api/internal/agent/:agentId/send
   * Send a message to a target (channel, DM, or thread).
   * Body: { target: string; content: string; attachmentIds?: string[] }
   */
  app.post<{
    Params: { agentId: string };
    Body: {
      target?: string;
      content: string;
      kind?: 'progress' | 'final';
      attachmentIds?: string[];
      conversationId?: string;
    };
  }>('/api/internal/agent/:agentId/send', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { target, content, kind, conversationId } = req.body ?? {};
    const normalizedContent = typeof content === 'string' ? content.trim() : '';
    if (!normalizedContent) {
      reply.code(400);
      return { error: 'content must not be empty' };
    }
    if (kind && kind !== 'progress' && kind !== 'final') {
      reply.code(400);
      return { error: 'kind must be "progress" or "final"' };
    }

    if (conversationId) {
      const conversation = conversationManager.getConversation(conversationId);
      if (!conversation || conversation.agentId !== agentId) {
        reply.code(400);
        return { error: 'conversationId does not belong to this agent' };
      }
    }

    const defaultTarget = conversationId ? resolveDefaultReplyTarget(db, conversationId, humanUserName) : null;
    const initialTarget = target?.trim() || defaultTarget;
    if (!initialTarget) {
      reply.code(400);
      return { error: 'target is required unless conversationId is provided for the current conversation reply' };
    }
    const resolvedTarget = conversationId
      ? normalizeTargetForConversation(db, conversationId, initialTarget)
      : initialTarget;

    // For DM targets that don't resolve to a known agent (e.g. dm:@User — a human),
    // fall back to the sending agent's own DM channel so the reply is visible to frontend.
    const channelId = resolveChannelFromTarget(resolvedTarget, db) ?? (resolvedTarget.startsWith('dm:') ? `dm:${agentId}` : null);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel from target: ${resolvedTarget}` };
    }

    const now = Date.now();
    const messageId = randomUUID();
    const seq = nextSeq(db, channelId);
    const runId = conversationId ? findActiveConversationRunId(db, conversationId) : null;
    const threadRootId = resolveThreadRootId(resolvedTarget);
    const priorFinals = runId ? listRunFinalMessages(db, runId) : [];
    const hasPriorFinal = priorFinals.length > 0;

    if (hasPriorFinal) {
      const allowAdditionalFinal =
        kind === 'final' &&
        priorFinals.every((row) => row.target === resolvedTarget);
      if (!allowAdditionalFinal) {
        reply.code(400);
        return {
          error: 'run already sent a final reply; no further messages are allowed for this run',
        };
      }
    }

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id, message_kind, message_source)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      messageId,
      channelId,
      agentId,
      agent.name,
      resolvedTarget,
      normalizedContent,
      seq,
      now,
      runId,
      threadRootId,
      kind ?? null,
      'agent_send',
    );

    const channelMessageEvent: ServerEvent = {
      type: 'channel.message',
      message: {
        id: messageId,
        senderName: agent.name,
        senderType: 'agent',
        content: normalizedContent,
        createdAt: new Date(now).toISOString(),
        seq,
        ...(threadRootId ? { threadRootId } : {}),
      },
    };

    broadcastToAgent(agentId, channelMessageEvent, conversationId);

    // Public channels (not DMs) also broadcast to channel-level WS subscribers
    if (!channelId.startsWith('dm:')) {
      broadcastToChannel(channelId, channelMessageEvent);
    }

    return { messageId, seq, runId, target: resolvedTarget, kind: kind ?? null };
  });

  /**
   * GET /api/internal/agent/:agentId/receive
   * Poll for new messages since the agent's last-read checkpoint.
   * Returns immediately with pending messages (or empty array).
   */
  app.get<{ Params: { agentId: string }; Querystring: { channel?: string } }>(
    '/api/internal/agent/:agentId/receive',
    async (req, reply) => {
      const { agentId } = req.params;
      if (!conversationManager.getAgent(agentId)) {
        reply.code(404);
        return { error: 'Agent not found' };
      }

      // Query all channels the agent has joined, plus the user DM channel
      const agent = conversationManager.getAgent(agentId)!;
      const dmChannelId = `dm:${agentId}`;

      let channelsToQuery: string[];
      const channelFilter = req.query.channel?.trim();
      if (channelFilter) {
        const filteredId = resolveChannelFromTarget(channelFilter, db)
          ?? (channelFilter.startsWith('dm:') ? dmChannelId : null);
        if (!filteredId) {
          reply.code(400);
          return { error: `Cannot resolve channel: ${channelFilter}` };
        }
        const memberOf = new Set([...(agent.channelIds ?? []), dmChannelId]);
        channelsToQuery = memberOf.has(filteredId) ? [filteredId] : [];
      } else {
        channelsToQuery = Array.from(new Set([...(agent.channelIds ?? []), dmChannelId]));
      }

      let allRows: MessageRow[] = [];
      for (const channelId of channelsToQuery) {
        const threadKeys = (
          db.prepare(
            `SELECT DISTINCT COALESCE(thread_root_id, '') as threadKey
             FROM channel_messages
             WHERE channel_id = ? AND sender_id != ?
             ORDER BY threadKey ASC`,
          ).all(channelId, agentId) as Array<{ threadKey: string }>
        ).map((row) => row.threadKey);

        for (const threadKey of threadKeys) {
          const checkpoint = getAgentMessageCheckpoint(db, agentId, channelId, threadKey || null);
          const rows = db
          .prepare(
            `SELECT message_id as messageId, channel_id as channelId, sender_id as senderId,
                    sender_name as senderName, sender_type as senderType,
                    target, content, seq, created_at as createdAt, thread_root_id as threadRootId
             FROM channel_messages
             WHERE channel_id = ? AND seq > ? AND sender_id != ? AND COALESCE(thread_root_id, '') = ?
             ORDER BY seq ASC
             LIMIT 50`,
          )
          .all(channelId, checkpoint, agentId, threadKey) as MessageRow[];

          allRows = allRows.concat(rows);
        }
      }

      // Merge and sort by createdAt
      const rows = allRows
        .sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq))
        .slice(0, 50);

      if (rows.length > 0) {
        const maxSeqByThread = new Map<string, { channelId: string; threadKey: string; maxSeq: number }>();
        for (const row of rows) {
          const threadKey = checkpointThreadKey(row.threadRootId);
          const aggregateKey = `${row.channelId}::${threadKey}`;
          const current = maxSeqByThread.get(aggregateKey);
          if (!current || row.seq > current.maxSeq) {
            maxSeqByThread.set(aggregateKey, { channelId: row.channelId, threadKey, maxSeq: row.seq });
          }
        }
        for (const { channelId, threadKey, maxSeq } of maxSeqByThread.values()) {
          setAgentMessageCheckpoint(db, agentId, channelId, maxSeq, threadKey || null);
        }
      }

      const messages = rows.map((r) => ({
        message_id: r.messageId,
        channel_id: r.channelId,
        sender_id: r.senderId,
        sender_name: r.senderName,
        sender_type: r.senderType,
        target: r.target,
        content: r.content,
        seq: r.seq,
        timestamp: new Date(r.createdAt).toISOString(),
      }));

      return { messages };
    },
  );

  /**
   * GET /api/internal/agent/:agentId/server
   * Returns channels (with joined status), other agents, and humans.
   */
  app.get<{ Params: { agentId: string } }>(
    '/api/internal/agent/:agentId/server',
    async (req, reply) => {
      const { agentId } = req.params;
      const agent = conversationManager.getAgent(agentId);
      if (!agent) {
        reply.code(404);
        return { error: 'Agent not found' };
      }

      const joinedSet = new Set(agent.channelIds ?? []);
      const channels = conversationManager.listChannels().map((ch) => ({
        name: ch.name,
        joined: joinedSet.has(ch.channelId),
        description: ch.description,
      }));

      const allAgents = conversationManager.listAgents().filter((a) => a.agentId !== agentId);
      const agents = allAgents.map((a) => ({
        name: a.name,
        status: 'online',
      }));

      const humanRows = db.prepare(
        `SELECT DISTINCT sender_name as name FROM channel_messages
         WHERE sender_type = 'user' ORDER BY created_at DESC LIMIT 20`,
      ).all() as Array<{ name: string }>;
      const humans = humanRows;

      return { channels, agents, humans };
    },
  );

  /**
   * GET /api/internal/agent/:agentId/history
   * Read message history for a target.
   * Query: channel (target string), limit?, before?, after?
   */
  app.get<{
    Params: { agentId: string };
    Querystring: { channel: string; limit?: string; before?: string; after?: string };
  }>('/api/internal/agent/:agentId/history', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, limit: limitStr, before: beforeStr, after: afterStr } = req.query;
    if (!channel) {
      reply.code(400);
      return { error: 'channel query parameter is required' };
    }

    const channelId = resolveChannelFromTarget(channel, db) ?? (channel.startsWith('dm:') ? `dm:${agentId}` : null);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }
    if (channel.startsWith('#') && !(agent.channelIds ?? []).includes(channelId)) {
      reply.code(403);
      return { error: 'Agent is not a member of this channel' };
    }

    const limit = Math.min(Number(limitStr ?? 50), 100);
    const before = beforeStr ? Number(beforeStr) : undefined;
    const after = afterStr ? Number(afterStr) : undefined;
    // Thread filter: "#channel:shortId" reads thread; "#channel" reads main channel only
    const targetThreadRootId = resolveThreadRootId(channel);
    const threadFilter = targetThreadRootId !== null
      ? `AND thread_root_id = '${targetThreadRootId.replace(/'/g, "''")}'`
      : `AND thread_root_id IS NULL`;

    let rows: MessageRow[];
    if (after !== undefined) {
      rows = db
        .prepare(
          `SELECT message_id as messageId, channel_id as channelId, sender_id as senderId,
                  sender_name as senderName, sender_type as senderType,
                  target, content, seq, created_at as createdAt
           FROM channel_messages
           WHERE channel_id = ? AND seq > ? ${threadFilter}
           ORDER BY seq ASC LIMIT ?`,
        )
        .all(channelId, after, limit) as MessageRow[];
    } else if (before !== undefined) {
      rows = db
        .prepare(
          `SELECT message_id as messageId, channel_id as channelId, sender_id as senderId,
                  sender_name as senderName, sender_type as senderType,
                  target, content, seq, created_at as createdAt
           FROM channel_messages
           WHERE channel_id = ? AND seq < ? ${threadFilter}
           ORDER BY seq DESC LIMIT ?`,
        )
        .all(channelId, before, limit).reverse() as MessageRow[];
    } else {
      rows = db
        .prepare(
          `SELECT message_id as messageId, channel_id as channelId, sender_id as senderId,
                  sender_name as senderName, sender_type as senderType,
                  target, content, seq, created_at as createdAt
           FROM channel_messages
           WHERE channel_id = ? ${threadFilter}
           ORDER BY seq DESC LIMIT ?`,
        )
        .all(channelId, limit).reverse() as MessageRow[];
    }

    const hasMore = rows.length === limit;
    const messages = rows.map((r) => ({
      id: r.messageId,
      senderName: r.senderName,
      senderType: r.senderType,
      content: r.content,
      seq: r.seq,
      createdAt: new Date(r.createdAt).toISOString(),
    }));

    return { messages, has_more: hasMore };
  });

  // ─── Task board ──────────────────────────────────────────────────────────

  /**
   * GET /api/internal/agent/:agentId/tasks
   * List tasks for a channel.
   * Query: channel (target string), status?
   */
  app.get<{
    Params: { agentId: string };
    Querystring: { channel: string; status?: string };
  }>('/api/internal/agent/:agentId/tasks', async (req, reply) => {
    const { agentId } = req.params;
    if (!conversationManager.getAgent(agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, status } = req.query;
    if (!channel) {
      reply.code(400);
      return { error: 'channel query parameter is required' };
    }

    const channelId = resolveChannelFromTarget(channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }

    const rows: TaskRow[] = status && status !== 'all'
      ? db
        .prepare(
          `SELECT task_id as taskId, channel_id as channelId, task_number as taskNumber,
                  title, status, claimed_by_agent_id as claimedByAgentId,
                  claimed_by_name as claimedByName, created_by_agent_id as createdByAgentId,
                  created_by_name as createdByName, created_at as createdAt, updated_at as updatedAt
           FROM tasks WHERE channel_id = ? AND status = ? ORDER BY task_number ASC`,
        )
        .all(channelId, status) as TaskRow[]
      : db
        .prepare(
          `SELECT task_id as taskId, channel_id as channelId, task_number as taskNumber,
                  title, status, claimed_by_agent_id as claimedByAgentId,
                  claimed_by_name as claimedByName, created_by_agent_id as createdByAgentId,
                  created_by_name as createdByName, created_at as createdAt, updated_at as updatedAt
           FROM tasks WHERE channel_id = ? ORDER BY task_number ASC`,
        )
        .all(channelId) as TaskRow[];

    const tasks = rows.map((r) => ({
      taskId: r.taskId,
      taskNumber: r.taskNumber,
      title: r.title,
      status: r.status,
      claimedByName: r.claimedByName,
      createdByName: r.createdByName,
    }));

    return { tasks };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks
   * Create one or more tasks on a channel's task board.
   * Body: { channel: string; tasks: Array<{ title: string }> }
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; tasks: Array<{ title: string }> };
  }>('/api/internal/agent/:agentId/tasks', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, tasks } = req.body ?? {};
    if (!channel || !Array.isArray(tasks) || tasks.length === 0) {
      reply.code(400);
      return { error: 'channel and non-empty tasks array are required' };
    }

    const channelId = resolveChannelFromTarget(channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }

    const now = Date.now();
    const created: Array<{ taskId: string; taskNumber: number; title: string }> = [];

    const insertTask = db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status,
                         created_by_agent_id, created_by_name, created_at, updated_at)
       VALUES(?, ?, ?, ?, 'todo', ?, ?, ?, ?)`,
    );

    for (const taskDef of tasks) {
      const taskId = randomUUID();
      const taskNumber = nextTaskNumber(db, channelId);
      insertTask.run(taskId, channelId, taskNumber, taskDef.title, agentId, agent.name, now, now);
      created.push({ taskId, taskNumber, title: taskDef.title });
    }

    reply.code(201);
    return { tasks: created };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks/claim
   * Claim one or more tasks atomically (prevents race conditions).
   * Body: { channel: string; task_numbers: number[] }
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; task_numbers: number[] };
  }>('/api/internal/agent/:agentId/tasks/claim', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, task_numbers } = req.body ?? {};
    if (!channel || !Array.isArray(task_numbers)) {
      reply.code(400);
      return { error: 'channel and task_numbers array are required' };
    }

    const channelId = resolveChannelFromTarget(channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }

    const now = Date.now();
    const results: Array<{ taskNumber: number; success: boolean; reason?: string }> = [];

    for (const taskNumber of task_numbers) {
      const row = db
        .prepare(
          `SELECT task_id as taskId, status, claimed_by_agent_id as claimedByAgentId
           FROM tasks WHERE channel_id = ? AND task_number = ?`,
        )
        .get(channelId, taskNumber) as {
          taskId: string;
          status: string;
          claimedByAgentId: string | null;
        } | undefined;

      if (!row) {
        results.push({ taskNumber, success: false, reason: 'Task not found' });
        continue;
      }
      if (row.claimedByAgentId && row.claimedByAgentId !== agentId) {
        results.push({ taskNumber, success: false, reason: 'Already claimed by another agent' });
        continue;
      }
      if (row.status === 'done') {
        results.push({ taskNumber, success: false, reason: 'Task is already done' });
        continue;
      }

      const newStatus = row.status === 'todo' ? 'in_progress' : row.status;
      db.prepare(
        `UPDATE tasks SET claimed_by_agent_id = ?, claimed_by_name = ?, status = ?, updated_at = ?
         WHERE task_id = ?`,
      ).run(agentId, agent.name, newStatus, now, row.taskId);

      results.push({ taskNumber, success: true });
    }

    return { results };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks/unclaim
   * Release the agent's claim on a task.
   * Body: { channel: string; task_number: number }
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; task_number: number };
  }>('/api/internal/agent/:agentId/tasks/unclaim', async (req, reply) => {
    const { agentId } = req.params;
    if (!conversationManager.getAgent(agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, task_number } = req.body ?? {};
    if (!channel || task_number == null) {
      reply.code(400);
      return { error: 'channel and task_number are required' };
    }

    const channelId = resolveChannelFromTarget(channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }

    const row = db
      .prepare(
        `SELECT task_id as taskId, claimed_by_agent_id as claimedByAgentId
         FROM tasks WHERE channel_id = ? AND task_number = ?`,
      )
      .get(channelId, task_number) as { taskId: string; claimedByAgentId: string | null } | undefined;

    if (!row) {
      reply.code(404);
      return { error: 'Task not found' };
    }
    if (row.claimedByAgentId !== agentId) {
      reply.code(403);
      return { error: 'You do not own this task' };
    }

    db.prepare(
      `UPDATE tasks SET claimed_by_agent_id = NULL, claimed_by_name = NULL, updated_at = ?
       WHERE task_id = ?`,
    ).run(Date.now(), row.taskId);

    return { ok: true };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks/update-status
   * Update a task's progress status.
   * Body: { channel: string; task_number: number; status: string }
   * Valid transitions: todo→in_progress, in_progress→in_review, in_progress→done,
   *                    in_review→done, in_review→in_progress
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; task_number: number; status: string };
  }>('/api/internal/agent/:agentId/tasks/update-status', async (req, reply) => {
    const { agentId } = req.params;
    if (!conversationManager.getAgent(agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, task_number, status } = req.body ?? {};
    if (!channel || task_number == null || !status) {
      reply.code(400);
      return { error: 'channel, task_number, and status are required' };
    }

    const validStatuses = ['todo', 'in_progress', 'in_review', 'done'];
    if (!validStatuses.includes(status)) {
      reply.code(400);
      return { error: `Invalid status: ${status}` };
    }

    const channelId = resolveChannelFromTarget(channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }

    const row = db
      .prepare(
        `SELECT task_id as taskId, status as currentStatus, claimed_by_agent_id as claimedByAgentId
         FROM tasks WHERE channel_id = ? AND task_number = ?`,
      )
      .get(channelId, task_number) as {
        taskId: string;
        currentStatus: string;
        claimedByAgentId: string | null;
      } | undefined;

    if (!row) {
      reply.code(404);
      return { error: 'Task not found' };
    }

    // in_review→done is allowed by anyone; other transitions require the assignee
    const isReviewToDone = row.currentStatus === 'in_review' && status === 'done';
    if (!isReviewToDone && row.claimedByAgentId !== agentId) {
      reply.code(403);
      return { error: 'You must be the task assignee to update its status' };
    }

    db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?`).run(
      status,
      Date.now(),
      row.taskId,
    );

    return { ok: true, taskNumber: task_number, status };
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolves a target string (e.g. "#general", "dm:@alice", "#general:msgid") to a channelId.
 * For now, targets are resolved by channel name. DM and thread targets use the base channel.
 */
function resolveChannelFromTarget(target: string, db: Db): string | null {
  // "#channel:threadid" or "#channel"
  const channelMatch = target.match(/^#([^:]+)/);
  if (channelMatch) {
    const name = channelMatch[1];
    const row = db
      .prepare('SELECT channel_id as channelId FROM channels WHERE name = ?')
      .get(name) as { channelId: string } | undefined;
    return row?.channelId ?? null;
  }

  // "dm:@agentname" or "dm:@agentname:threadid" — resolve to dm:{agentId} virtual channel
  if (target.startsWith('dm:')) {
    const match = target.match(/^dm:@([^:]+)/);
    if (match) {
      const agentName = match[1];
      const agentRow = db
        .prepare('SELECT agent_id as agentId FROM agents WHERE name = ?')
        .get(agentName) as { agentId: string } | undefined;
      if (agentRow) return `dm:${agentRow.agentId}`;
    }
    // Non-agent DM target (e.g. dm:@User) — return null so the caller can fall back to dm:{agentId}
    return null;
  }

  return null;
}

function resolveDefaultReplyTarget(db: Db, conversationId: string, humanUserName: string): string | null {
  const row = db.prepare(
    `SELECT c.id as conversationId, c.channel_id as channelId, c.thread_kind as threadKind,
            c.is_primary_thread as isPrimaryThread, c.thread_root_id as threadRootId,
            ch.name as channelName
     FROM conversations c
     LEFT JOIN channels ch ON ch.channel_id = c.channel_id
     WHERE c.id = ?`,
  ).get(conversationId) as {
    conversationId: string;
    channelId: string;
    threadKind: 'direct' | 'branch';
    isPrimaryThread: number;
    threadRootId: string | null;
    channelName: string | null;
  } | undefined;

  if (!row) return null;

  if (row.threadKind === 'direct') {
    return row.isPrimaryThread
      ? `dm:@${humanUserName}`
      : `dm:@${humanUserName}:${row.conversationId.slice(0, 8)}`;
  }

  const channelName = row.channelName ?? row.channelId;
  const baseTarget = `#${channelName}`;
  return row.threadRootId ? `${baseTarget}:${row.threadRootId}` : baseTarget;
}

function normalizeTargetForConversation(db: Db, conversationId: string, target: string): string {
  const row = db.prepare(
    `SELECT c.channel_id as channelId, c.thread_kind as threadKind, c.thread_root_id as threadRootId,
            ch.name as channelName
     FROM conversations c
     LEFT JOIN channels ch ON ch.channel_id = c.channel_id
     WHERE c.id = ?`,
  ).get(conversationId) as {
    channelId: string;
    threadKind: 'direct' | 'branch';
    threadRootId: string | null;
    channelName: string | null;
  } | undefined;

  if (!row || row.threadKind !== 'branch' || row.threadRootId) return target;

  const channelName = row.channelName ?? row.channelId;
  const canonicalBaseTarget = `#${channelName}`;
  const sameChannelThread = target.match(/^#([^:]+):([a-zA-Z0-9]+)$/);
  if (sameChannelThread) {
    const [, targetChannel] = sameChannelThread;
    if (targetChannel === channelName || targetChannel === row.channelId) {
      return canonicalBaseTarget;
    }
  }

  return target;
}

/** Extracts the thread shortId from targets like "#general:a1b2c3d4". Returns null for non-thread targets. */
function resolveThreadRootId(target: string): string | null {
  const match = target.match(/^(?:#[^:]+|dm:@[^:]+):([a-zA-Z0-9]+)$/);
  return match ? match[1] : null;
}

function nextSeq(db: Db, channelId: string): number {
  const row = db
    .prepare('SELECT MAX(seq) as maxSeq FROM channel_messages WHERE channel_id = ?')
    .get(channelId) as { maxSeq: number | null };
  return (row.maxSeq ?? 0) + 1;
}

function findActiveConversationRunId(db: Db, conversationId: string): string | null {
  const row = db
    .prepare(
      `SELECT r.run_id as runId
       FROM conversations c
       JOIN runs r ON r.session_key = c.session_key
       WHERE c.id = ? AND r.ended_at IS NULL
       ORDER BY r.started_at DESC
       LIMIT 1`,
    )
    .get(conversationId) as { runId: string } | undefined;
  return row?.runId ?? null;
}

function listRunFinalMessages(db: Db, runId: string): Array<{ target: string }> {
  return db.prepare(
    `SELECT target
     FROM channel_messages
     WHERE run_id = ?
       AND sender_type = 'agent'
       AND message_kind = 'final'
     ORDER BY created_at ASC, seq ASC`,
  ).all(runId) as Array<{ target: string }>;
}

function nextTaskNumber(db: Db, channelId: string): number {
  const row = db
    .prepare('SELECT MAX(task_number) as maxNum FROM tasks WHERE channel_id = ?')
    .get(channelId) as { maxNum: number | null };
  return (row.maxNum ?? 0) + 1;
}
