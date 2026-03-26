import { randomUUID } from 'node:crypto';
/**
 * Registers internal agent API routes — used by channel-bridge MCP server.
 *
 * These endpoints let agents (via the channel-bridge) send messages to channels,
 * poll for new messages, browse the server directory, and manage task boards.
 */
export function registerInternalAgentRoutes(app, db, conversationManager, broadcastToAgent, broadcastToChannel) {
    // ─── Messaging ───────────────────────────────────────────────────────────
    /**
     * POST /api/internal/agent/:agentId/send
     * Send a message to a target (channel, DM, or thread).
     * Body: { target: string; content: string; attachmentIds?: string[] }
     */
    app.post('/api/internal/agent/:agentId/send', async (req, reply) => {
        const { agentId } = req.params;
        const agent = conversationManager.getAgent(agentId);
        if (!agent) {
            reply.code(404);
            return { error: 'Agent not found' };
        }
        const { target, content, conversationId } = req.body ?? {};
        if (!content) {
            reply.code(400);
            return { error: 'content is required' };
        }
        if (conversationId) {
            const conversation = conversationManager.getConversation(conversationId);
            if (!conversation || conversation.agentId !== agentId) {
                reply.code(400);
                return { error: 'conversationId does not belong to this agent' };
            }
        }
        const resolvedTarget = target?.trim() || (conversationId ? resolveDefaultReplyTarget(db, conversationId) : null);
        if (!resolvedTarget) {
            reply.code(400);
            return { error: 'target is required unless conversationId is provided for the current conversation reply' };
        }
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
        db.prepare(`INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?)`).run(messageId, channelId, agentId, agent.name, resolvedTarget, content, seq, now, runId);
        const channelMessageEvent = {
            type: 'channel.message',
            message: {
                id: messageId,
                senderName: agent.name,
                senderType: 'agent',
                content,
                createdAt: new Date(now).toISOString(),
            },
        };
        broadcastToAgent(agentId, channelMessageEvent, conversationId);
        // Public channels (not DMs) also broadcast to channel-level WS subscribers
        if (!channelId.startsWith('dm:')) {
            broadcastToChannel(channelId, channelMessageEvent);
        }
        return { messageId, seq, runId, target: resolvedTarget };
    });
    /**
     * GET /api/internal/agent/:agentId/receive
     * Poll for new messages since the agent's last-read checkpoint.
     * Returns immediately with pending messages (or empty array).
     */
    app.get('/api/internal/agent/:agentId/receive', async (req, reply) => {
        const { agentId } = req.params;
        if (!conversationManager.getAgent(agentId)) {
            reply.code(404);
            return { error: 'Agent not found' };
        }
        // Query both the agent's public channel and the user DM channel
        const agent = conversationManager.getAgent(agentId);
        const publicChannelId = agent.channelId;
        const dmChannelId = `dm:${agentId}`;
        const channelsToQuery = [publicChannelId, dmChannelId];
        let allRows = [];
        for (const channelId of channelsToQuery) {
            const checkpoint = db
                .prepare(`SELECT last_seq as lastSeq FROM agent_message_checkpoints
             WHERE agent_id = ? AND channel_id = ?`)
                .get(agentId, channelId)?.lastSeq ?? 0;
            const rows = db
                .prepare(`SELECT message_id as messageId, channel_id as channelId, sender_id as senderId,
                    sender_name as senderName, sender_type as senderType,
                    target, content, seq, created_at as createdAt
             FROM channel_messages
             WHERE channel_id = ? AND seq > ? AND sender_id != ?
             ORDER BY seq ASC
             LIMIT 50`)
                .all(channelId, checkpoint, agentId);
            if (rows.length > 0) {
                const maxSeq = rows[rows.length - 1].seq;
                db.prepare(`INSERT INTO agent_message_checkpoints(agent_id, channel_id, last_seq)
             VALUES(?, ?, ?)
             ON CONFLICT(agent_id, channel_id) DO UPDATE SET last_seq = excluded.last_seq`).run(agentId, channelId, maxSeq);
            }
            allRows = allRows.concat(rows);
        }
        // Merge and sort by createdAt
        const rows = allRows.sort((a, b) => a.createdAt - b.createdAt);
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
    });
    /**
     * GET /api/internal/agent/:agentId/server
     * Returns channels (with joined status), other agents, and humans.
     */
    app.get('/api/internal/agent/:agentId/server', async (req, reply) => {
        const { agentId } = req.params;
        const agent = conversationManager.getAgent(agentId);
        if (!agent) {
            reply.code(404);
            return { error: 'Agent not found' };
        }
        const channels = conversationManager.listChannels().map((ch) => ({
            name: ch.name,
            joined: ch.channelId === agent.channelId,
            description: undefined,
        }));
        const allAgents = conversationManager.listAgents().filter((a) => a.agentId !== agentId);
        const agents = allAgents.map((a) => ({
            name: a.name,
            status: 'online',
        }));
        // No human user model in agent-collab yet; return empty for now
        const humans = [];
        return { channels, agents, humans };
    });
    /**
     * GET /api/internal/agent/:agentId/history
     * Read message history for a target.
     * Query: channel (target string), limit?, before?, after?
     */
    app.get('/api/internal/agent/:agentId/history', async (req, reply) => {
        const { agentId } = req.params;
        if (!conversationManager.getAgent(agentId)) {
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
        const limit = Math.min(Number(limitStr ?? 50), 100);
        const before = beforeStr ? Number(beforeStr) : undefined;
        const after = afterStr ? Number(afterStr) : undefined;
        let rows;
        if (after !== undefined) {
            rows = db
                .prepare(`SELECT message_id as messageId, channel_id as channelId, sender_id as senderId,
                  sender_name as senderName, sender_type as senderType,
                  target, content, seq, created_at as createdAt
           FROM channel_messages
           WHERE channel_id = ? AND seq > ?
           ORDER BY seq ASC LIMIT ?`)
                .all(channelId, after, limit);
        }
        else if (before !== undefined) {
            rows = db
                .prepare(`SELECT message_id as messageId, channel_id as channelId, sender_id as senderId,
                  sender_name as senderName, sender_type as senderType,
                  target, content, seq, created_at as createdAt
           FROM channel_messages
           WHERE channel_id = ? AND seq < ?
           ORDER BY seq DESC LIMIT ?`)
                .all(channelId, before, limit).reverse();
        }
        else {
            rows = db
                .prepare(`SELECT message_id as messageId, channel_id as channelId, sender_id as senderId,
                  sender_name as senderName, sender_type as senderType,
                  target, content, seq, created_at as createdAt
           FROM channel_messages
           WHERE channel_id = ?
           ORDER BY seq DESC LIMIT ?`)
                .all(channelId, limit).reverse();
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
    app.get('/api/internal/agent/:agentId/tasks', async (req, reply) => {
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
        const rows = status && status !== 'all'
            ? db
                .prepare(`SELECT task_id as taskId, channel_id as channelId, task_number as taskNumber,
                  title, status, claimed_by_agent_id as claimedByAgentId,
                  claimed_by_name as claimedByName, created_by_agent_id as createdByAgentId,
                  created_by_name as createdByName, created_at as createdAt, updated_at as updatedAt
           FROM tasks WHERE channel_id = ? AND status = ? ORDER BY task_number ASC`)
                .all(channelId, status)
            : db
                .prepare(`SELECT task_id as taskId, channel_id as channelId, task_number as taskNumber,
                  title, status, claimed_by_agent_id as claimedByAgentId,
                  claimed_by_name as claimedByName, created_by_agent_id as createdByAgentId,
                  created_by_name as createdByName, created_at as createdAt, updated_at as updatedAt
           FROM tasks WHERE channel_id = ? ORDER BY task_number ASC`)
                .all(channelId);
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
    app.post('/api/internal/agent/:agentId/tasks', async (req, reply) => {
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
        const created = [];
        const insertTask = db.prepare(`INSERT INTO tasks(task_id, channel_id, task_number, title, status,
                         created_by_agent_id, created_by_name, created_at, updated_at)
       VALUES(?, ?, ?, ?, 'todo', ?, ?, ?, ?)`);
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
    app.post('/api/internal/agent/:agentId/tasks/claim', async (req, reply) => {
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
        const results = [];
        for (const taskNumber of task_numbers) {
            const row = db
                .prepare(`SELECT task_id as taskId, status, claimed_by_agent_id as claimedByAgentId
           FROM tasks WHERE channel_id = ? AND task_number = ?`)
                .get(channelId, taskNumber);
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
            db.prepare(`UPDATE tasks SET claimed_by_agent_id = ?, claimed_by_name = ?, status = ?, updated_at = ?
         WHERE task_id = ?`).run(agentId, agent.name, newStatus, now, row.taskId);
            results.push({ taskNumber, success: true });
        }
        return { results };
    });
    /**
     * POST /api/internal/agent/:agentId/tasks/unclaim
     * Release the agent's claim on a task.
     * Body: { channel: string; task_number: number }
     */
    app.post('/api/internal/agent/:agentId/tasks/unclaim', async (req, reply) => {
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
            .prepare(`SELECT task_id as taskId, claimed_by_agent_id as claimedByAgentId
         FROM tasks WHERE channel_id = ? AND task_number = ?`)
            .get(channelId, task_number);
        if (!row) {
            reply.code(404);
            return { error: 'Task not found' };
        }
        if (row.claimedByAgentId !== agentId) {
            reply.code(403);
            return { error: 'You do not own this task' };
        }
        db.prepare(`UPDATE tasks SET claimed_by_agent_id = NULL, claimed_by_name = NULL, updated_at = ?
       WHERE task_id = ?`).run(Date.now(), row.taskId);
        return { ok: true };
    });
    /**
     * POST /api/internal/agent/:agentId/tasks/update-status
     * Update a task's progress status.
     * Body: { channel: string; task_number: number; status: string }
     * Valid transitions: todo→in_progress, in_progress→in_review, in_progress→done,
     *                    in_review→done, in_review→in_progress
     */
    app.post('/api/internal/agent/:agentId/tasks/update-status', async (req, reply) => {
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
            .prepare(`SELECT task_id as taskId, status as currentStatus, claimed_by_agent_id as claimedByAgentId
         FROM tasks WHERE channel_id = ? AND task_number = ?`)
            .get(channelId, task_number);
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
        db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?`).run(status, Date.now(), row.taskId);
        return { ok: true, taskNumber: task_number, status };
    });
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
/**
 * Resolves a target string (e.g. "#general", "dm:@alice", "#general:msgid") to a channelId.
 * For now, targets are resolved by channel name. DM and thread targets use the base channel.
 */
function resolveChannelFromTarget(target, db) {
    // "#channel:threadid" or "#channel"
    const channelMatch = target.match(/^#([^:]+)/);
    if (channelMatch) {
        const name = channelMatch[1];
        const row = db
            .prepare('SELECT channel_id as channelId FROM channels WHERE name = ?')
            .get(name);
        return row?.channelId ?? null;
    }
    // "dm:@agentname" or "dm:@agentname:threadid" — resolve to dm:{agentId} virtual channel
    if (target.startsWith('dm:')) {
        const match = target.match(/^dm:@([^:]+)/);
        if (match) {
            const agentName = match[1];
            const agentRow = db
                .prepare('SELECT agent_id as agentId FROM agents WHERE name = ?')
                .get(agentName);
            if (agentRow)
                return `dm:${agentRow.agentId}`;
        }
        // Non-agent DM target (e.g. dm:@User) — return null so the caller can fall back to dm:{agentId}
        return null;
    }
    return null;
}
function resolveDefaultReplyTarget(db, conversationId) {
    const row = db.prepare(`SELECT c.id as conversationId, c.channel_id as channelId, c.thread_kind as threadKind,
            c.is_primary_thread as isPrimaryThread, ch.name as channelName
     FROM conversations c
     LEFT JOIN channels ch ON ch.channel_id = c.channel_id
     WHERE c.id = ?`).get(conversationId);
    if (!row)
        return null;
    if (row.threadKind === 'direct') {
        return row.isPrimaryThread
            ? 'dm:@User'
            : `dm:@User:${row.conversationId.slice(0, 8)}`;
    }
    const channelName = row.channelName ?? row.channelId;
    const baseTarget = `#${channelName}`;
    return row.isPrimaryThread ? baseTarget : `${baseTarget}:${row.conversationId.slice(0, 8)}`;
}
function nextSeq(db, channelId) {
    const row = db
        .prepare('SELECT MAX(seq) as maxSeq FROM channel_messages WHERE channel_id = ?')
        .get(channelId);
    return (row.maxSeq ?? 0) + 1;
}
function findActiveConversationRunId(db, conversationId) {
    const row = db
        .prepare(`SELECT r.run_id as runId
       FROM conversations c
       JOIN runs r ON r.session_key = c.session_key
       WHERE c.id = ? AND r.ended_at IS NULL
       ORDER BY r.started_at DESC
       LIMIT 1`)
        .get(conversationId);
    return row?.runId ?? null;
}
function nextTaskNumber(db, channelId) {
    const row = db
        .prepare('SELECT MAX(task_number) as maxNum FROM tasks WHERE channel_id = ?')
        .get(channelId);
    return (row.maxNum ?? 0) + 1;
}
