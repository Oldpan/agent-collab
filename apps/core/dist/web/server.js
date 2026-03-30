import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';
import { log, finishRun } from '@agent-collab/runtime-acp';
import { handleWebSocket, broadcast } from './wsHandler.js';
import { handleNodeWebSocket } from './nodeWsHandler.js';
import { registerInternalAgentRoutes } from './internalAgentRouter.js';
import { NodeRegistry } from '../services/nodeRegistry.js';
import { AgentWorkspaceBroker } from '../services/agentWorkspaceBroker.js';
import { AgentWorkspaceService, AgentWorkspaceServiceError } from '../services/agentWorkspaceService.js';
import { findMentionedAgents } from './channelMentions.js';
import { buildChannelActivationPrompt, buildChannelActivationContextText } from './channelActivationPrompt.js';
import { appendChannelResetMarkers } from './channelMemoryNotes.js';
import { buildTargetActivationContext } from './activationContext.js';
import { bumpAgentMessageCheckpoint } from './messageCheckpoints.js';
import { deleteChannelSubscription, listChannelSubscriptions, upsertChannelSubscription } from './channelSubscriptions.js';
import { listTargetParticipants, setTargetOwner, upsertTargetParticipant } from './targetParticipants.js';
import { bindTaskToThread, getBoundTaskForThread, getThreadCollaborationSummary, unbindTaskFromThread } from './threadTaskBindings.js';
import { hasAdminUser, setupWithInvite, loginUser, logoutUser, validateSession, createInviteToken, listUsers, deleteUser, cleanupExpiredTokens, } from '../services/auth.js';
export async function startServer(params) {
    const { port, host, conversationManager, db } = params;
    const config = conversationManager.getConfig();
    const nodeRegistry = params.nodeRegistry ?? new NodeRegistry();
    const workspaceBroker = params.workspaceBroker ?? new AgentWorkspaceBroker({ nodeRegistry });
    const workspaceService = new AgentWorkspaceService({
        getAgentById: (agentId) => conversationManager.getAgent(agentId),
        broker: workspaceBroker,
    });
    const app = Fastify({ logger: false });
    await app.register(fastifyCors, { origin: true });
    await app.register(fastifyWebSocket);
    // ─── REST routes ───
    // List conversations
    app.get('/api/conversations', async () => {
        return conversationManager.listConversations();
    });
    // ─── Agent routes ───
    app.get('/api/agents', async () => {
        return conversationManager.listAgents();
    });
    app.post('/api/agents', async (req, reply) => {
        const body = (req.body ?? {});
        if (!body.name) {
            reply.code(400);
            return { error: 'name is required' };
        }
        const agent = conversationManager.createAgent(body);
        reply.code(201);
        return agent;
    });
    app.get('/api/agents/:id', async (req, reply) => {
        const agent = conversationManager.getAgent(req.params.id);
        if (!agent) {
            reply.code(404);
            return { error: 'Not found' };
        }
        return agent;
    });
    app.patch('/api/agents/:id', async (req, reply) => {
        const updated = conversationManager.updateAgent(req.params.id, req.body ?? {});
        if (!updated) {
            reply.code(404);
            return { error: 'Not found' };
        }
        return updated;
    });
    app.delete('/api/agents/:id', async (req, reply) => {
        const agent = conversationManager.getAgent(req.params.id);
        if (!agent) {
            reply.code(404);
            return { error: 'Not found' };
        }
        const result = conversationManager.deleteAgent(req.params.id);
        return { ok: true, deletedConversations: result.deletedConversations };
    });
    app.get('/api/agents/:id/conversations', async (req, reply) => {
        const agent = conversationManager.getAgent(req.params.id);
        if (!agent) {
            reply.code(404);
            return { error: 'Not found' };
        }
        return conversationManager.listConversations({ agentId: req.params.id });
    });
    app.post('/api/agents/:id/open-thread', async (req, reply) => {
        const thread = conversationManager.openAgentThread(req.params.id);
        if (!thread) {
            reply.code(404);
            return { error: 'Not found' };
        }
        return thread;
    });
    app.post('/api/agents/:id/restart', async (req, reply) => {
        const agent = conversationManager.getAgent(req.params.id);
        if (!agent) {
            reply.code(404);
            return { error: 'Not found' };
        }
        if (!agent.nodeId) {
            reply.code(409);
            return { error: 'Agent is not assigned to a remote node.' };
        }
        const conversations = conversationManager.listConversations({ agentId: req.params.id });
        for (const conversation of conversations) {
            broadcast(conversation.id, { type: 'system.notice', message: 'Agent restarting…' });
        }
        const hostKeys = conversationManager.getAgentHostKeys(req.params.id);
        for (const { nodeId, hostKey } of hostKeys) {
            nodeRegistry.send(nodeId, { type: 'host.close', hostKey });
        }
        const now = Date.now();
        for (const conversation of conversations) {
            // Finish any active runs so findBlockingConversation won't treat this conversation as blocking
            const activeRuns = db.prepare(`SELECT run_id as runId FROM runs WHERE session_key = (
           SELECT session_key FROM conversations WHERE id = ?
         ) AND ended_at IS NULL`).all(conversation.id);
            for (const run of activeRuns) {
                finishRun(db, { runId: run.runId, error: 'Restarted by user' });
            }
            // Update DB status to idle
            db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
                .run('idle', now, conversation.id);
            broadcast(conversation.id, { type: 'conversation.status', conversationId: conversation.id, status: 'idle' });
            broadcast(conversation.id, { type: 'system.notice', message: 'Agent restarted — ready for new messages.' });
        }
        // Drain any queued prompts that were waiting on the now-settled conversations
        for (const conversation of conversations) {
            void conversationManager.onConversationSettled(conversation.id);
        }
        return { ok: true, conversations };
    });
    app.post('/api/agents/:id/clear-chat', async (req, reply) => {
        const agent = conversationManager.getAgent(req.params.id);
        if (!agent) {
            reply.code(404);
            return { error: 'Not found' };
        }
        const hostKeys = conversationManager.getAgentHostKeys(req.params.id);
        if (agent.nodeId) {
            for (const { nodeId, hostKey } of hostKeys) {
                nodeRegistry.send(nodeId, { type: 'host.close', hostKey });
            }
        }
        const conversations = conversationManager.clearAgentChat(req.params.id);
        for (const conversation of conversations) {
            broadcast(conversation.id, { type: 'history.reset' });
            broadcast(conversation.id, { type: 'conversation.status', conversationId: conversation.id, status: 'idle' });
        }
        return { ok: true, conversations };
    });
    app.post('/api/agents/:id/reset', async (req, reply) => {
        const agent = conversationManager.getAgent(req.params.id);
        if (!agent) {
            reply.code(404);
            return { error: 'Not found' };
        }
        if (!agent.nodeId) {
            reply.code(409);
            return { error: 'Agent is not assigned to a remote node.' };
        }
        if (!agent.workspacePath) {
            reply.code(409);
            return { error: 'Agent has no workspace configured.' };
        }
        try {
            await workspaceBroker.resetWorkspace(agent.nodeId, agent.workspacePath);
        }
        catch (error) {
            reply.code(409);
            return { error: String(error?.message ?? error) };
        }
        const conversations = conversationManager.resetAgent(req.params.id);
        for (const conversation of conversations) {
            broadcast(conversation.id, { type: 'history.reset' });
            broadcast(conversation.id, {
                type: 'conversation.status',
                conversationId: conversation.id,
                status: 'idle',
            });
        }
        return {
            ok: true,
            conversations,
        };
    });
    app.get('/api/agents/:id/workspace', async (req, reply) => {
        try {
            return await workspaceService.listWorkspace(req.params.id, normalizeWorkspaceQueryPath(req.query.path));
        }
        catch (error) {
            if (error instanceof AgentWorkspaceServiceError) {
                reply.code(error.statusCode);
                return { error: error.message };
            }
            reply.code(500);
            return { error: String(error?.message ?? error) };
        }
    });
    app.get('/api/agents/:id/workspace/file', async (req, reply) => {
        try {
            return await workspaceService.readWorkspaceFile(req.params.id, normalizeWorkspaceQueryPath(req.query.path));
        }
        catch (error) {
            if (error instanceof AgentWorkspaceServiceError) {
                reply.code(error.statusCode);
                return { error: error.message };
            }
            reply.code(500);
            return { error: String(error?.message ?? error) };
        }
    });
    // Create conversation
    app.post('/api/conversations', async (req, reply) => {
        const body = req.body ?? {};
        const conv = conversationManager.createConversation({
            agentType: body.agentType,
            workspacePath: body.workspacePath,
            title: body.title,
            channelId: body.channelId,
            threadKind: body.threadKind,
            isPrimaryThread: body.isPrimaryThread,
            envVars: body.envVars,
            nodeId: body.nodeId,
            agentId: body.agentId,
        });
        reply.code(201);
        return conv;
    });
    // Delete conversation
    app.delete('/api/conversations/:id', async (req, reply) => {
        const conv = conversationManager.getConversation(req.params.id);
        if (!conv) {
            reply.code(404);
            return { error: 'Not found' };
        }
        conversationManager.deleteConversation(req.params.id);
        reply.code(204);
        return;
    });
    // Get conversation history (stored events from DB)
    app.get('/api/conversations/:id/history', async (req, reply) => {
        const conv = conversationManager.getConversation(req.params.id);
        if (!conv) {
            reply.code(404);
            return { error: 'Not found' };
        }
        // Fetch runs and events for this conversation's session
        const sessionRow = db
            .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
            .get(req.params.id);
        if (!sessionRow)
            return [];
        const runs = db
            .prepare(`SELECT run_id as runId, prompt_text as promptText, started_at as startedAt,
                ended_at as endedAt, stop_reason as stopReason, error
         FROM runs WHERE session_key = ? ORDER BY started_at ASC`)
            .all(sessionRow.sessionKey);
        return runs.map((run) => {
            const nodeEvents = db
                .prepare(`SELECT payload_json as payloadJson
           FROM events
           WHERE run_id = ? AND method = 'node/event'
           ORDER BY seq ASC`)
                .all(run.runId);
            let assistantText = '';
            let thinkingText = '';
            for (const evt of nodeEvents) {
                try {
                    const parsed = JSON.parse(evt.payloadJson);
                    if (parsed?.type === 'content.delta' && typeof parsed.text === 'string') {
                        assistantText += parsed.text;
                    }
                    if (parsed?.type === 'thinking.delta' && typeof parsed.text === 'string') {
                        thinkingText += parsed.text;
                    }
                }
                catch {
                    // ignore malformed rows
                }
            }
            return {
                ...run,
                assistantText: assistantText || undefined,
                thinkingText: thinkingText || undefined,
            };
        });
    });
    // Channel message history for a conversation (used by frontend to load DM history)
    app.get('/api/conversations/:id/channel-messages', async (req, reply) => {
        const conv = conversationManager.getConversation(req.params.id);
        if (!conv) {
            reply.code(404);
            return { error: 'Not found' };
        }
        if (!conv.agentId) {
            return { messages: [] };
        }
        const limit = Math.min(Number(req.query.limit ?? 50), 200);
        const dmChannelId = `dm:${conv.agentId}`;
        const rows = db
            .prepare(`SELECT message_id as id, sender_name as senderName, sender_type as senderType,
                  content, created_at as createdAt, seq, message_source as messageSource
           FROM channel_messages
           WHERE channel_id = ?
           ORDER BY seq DESC LIMIT ?`)
            .all(dmChannelId, limit);
        const messages = rows.reverse().map((r) => ({
            id: r.id,
            senderName: r.senderName,
            senderType: r.senderType,
            content: r.content,
            createdAt: new Date(r.createdAt).toISOString(),
            seq: r.seq,
            ...(r.messageSource ? { messageSource: r.messageSource } : {}),
        }));
        return { messages };
    });
    app.post('/api/unread-summary', async (req) => {
        const body = req.body ?? {};
        const agentIds = Array.isArray(body.agentIds)
            ? body.agentIds.filter((value) => typeof value === 'string')
            : [];
        const channelIds = Array.isArray(body.channelIds)
            ? body.channelIds.filter((value) => typeof value === 'string')
            : [];
        const agentDmReadSeqs = body.agentDmReadSeqs && typeof body.agentDmReadSeqs === 'object'
            ? body.agentDmReadSeqs
            : {};
        const channelReadSeqs = body.channelReadSeqs && typeof body.channelReadSeqs === 'object'
            ? body.channelReadSeqs
            : {};
        const summarizeChannel = (channelId, lastReadSeq) => {
            const row = db
                .prepare(`SELECT
             COALESCE(MAX(seq), 0) as latestSeq,
             COALESCE(SUM(CASE WHEN seq > ? AND sender_type != 'user' THEN 1 ELSE 0 END), 0) as unreadCount
           FROM channel_messages
           WHERE channel_id = ?`)
                .get(lastReadSeq, channelId);
            return {
                unreadCount: Number(row?.unreadCount ?? 0),
                latestSeq: Number(row?.latestSeq ?? 0),
            };
        };
        return {
            agentDms: Object.fromEntries(agentIds.map((agentId) => [
                agentId,
                summarizeChannel(`dm:${agentId}`, Math.max(0, Number(agentDmReadSeqs[agentId] ?? 0))),
            ])),
            channels: Object.fromEntries(channelIds.map((channelId) => [
                channelId,
                summarizeChannel(channelId, Math.max(0, Number(channelReadSeqs[channelId] ?? 0))),
            ])),
        };
    });
    // ─── Channel routes ───
    // List all channels
    app.get('/api/channels', async () => {
        return conversationManager.listChannels();
    });
    // Create channel
    app.post('/api/channels', async (req, reply) => {
        const body = (req.body ?? {});
        if (!body.name) {
            reply.code(400);
            return { error: 'name is required' };
        }
        try {
            const channel = conversationManager.createChannel({
                name: body.name,
                workspacePath: body.workspacePath,
                description: body.description,
                collaborationMode: body.collaborationMode,
            });
            for (const agentId of body.agentIds ?? []) {
                if (conversationManager.getAgent(agentId)) {
                    conversationManager.joinChannel(agentId, channel.channelId);
                }
            }
            reply.code(201);
            return conversationManager.getChannel(channel.channelId) ?? channel;
        }
        catch {
            reply.code(409);
            return { error: 'Channel name already exists' };
        }
    });
    // Update channel (e.g. description)
    app.patch('/api/channels/:id', async (req, reply) => {
        const updated = conversationManager.updateChannel(req.params.id, req.body ?? {});
        if (!updated) {
            reply.code(404);
            return { error: 'Not found' };
        }
        return updated;
    });
    app.post('/api/channels/:id/subscriptions/:agentId', async (req, reply) => {
        const channel = conversationManager.getChannel(req.params.id);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        const agent = conversationManager.getAgent(req.params.agentId);
        if (!agent) {
            reply.code(404);
            return { error: 'Agent not found' };
        }
        upsertChannelSubscription(db, {
            channelId: req.params.id,
            agentId: req.params.agentId,
        });
        return conversationManager.getChannel(req.params.id);
    });
    app.delete('/api/channels/:id/subscriptions/:agentId', async (req, reply) => {
        const channel = conversationManager.getChannel(req.params.id);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        deleteChannelSubscription(db, req.params.id, req.params.agentId);
        return conversationManager.getChannel(req.params.id);
    });
    app.post('/api/channels/:id/clear-chat', async (req, reply) => {
        const channel = conversationManager.getChannel(req.params.id);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        const joinedAgents = conversationManager.listAgents(req.params.id);
        const unmarkableAgents = joinedAgents.filter((agent) => !agent.nodeId || !agent.workspacePath);
        if (unmarkableAgents.length > 0) {
            reply.code(409);
            return {
                error: `Cannot mark channel memory for: ${unmarkableAgents.map((agent) => agent.name).join(', ')}`,
            };
        }
        const clearedAt = Date.now();
        try {
            await appendChannelResetMarkers({
                broker: workspaceBroker,
                agents: joinedAgents,
                channelName: channel.name,
                clearedAt,
            });
        }
        catch (error) {
            reply.code(409);
            return { error: `Failed to mark channel memory: ${String(error?.message ?? error)}` };
        }
        const branchConversations = conversationManager
            .listConversations({ channelId: req.params.id })
            .filter((item) => item.threadKind === 'branch');
        for (const conversation of branchConversations) {
            if (conversation.nodeId) {
                nodeRegistry.send(conversation.nodeId, {
                    type: 'host.close',
                    hostKey: `conversation:${conversation.id}:${conversation.agentType}`,
                });
            }
        }
        const clearedConversations = conversationManager.clearChannelChat(req.params.id);
        for (const conversation of clearedConversations) {
            broadcast(conversation.id, { type: 'history.reset' });
            broadcast(conversation.id, {
                type: 'conversation.status',
                conversationId: conversation.id,
                status: 'idle',
            });
        }
        broadcastToChannel(req.params.id, { type: 'channel.history.reset' });
        return {
            ok: true,
            clearedConversationIds: clearedConversations.map((item) => item.id),
        };
    });
    // Join agent to a channel
    app.post('/api/agents/:id/channels/:channelId', async (req, reply) => {
        const agent = conversationManager.getAgent(req.params.id);
        if (!agent) {
            reply.code(404);
            return { error: 'Agent not found' };
        }
        const channel = conversationManager.getChannel(req.params.channelId);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        conversationManager.joinChannel(req.params.id, req.params.channelId);
        reply.code(204);
    });
    // Leave agent from a channel
    app.delete('/api/agents/:id/channels/:channelId', async (req, reply) => {
        conversationManager.leaveChannel(req.params.id, req.params.channelId);
        reply.code(204);
    });
    // List conversations in a channel
    app.get('/api/channels/:id/conversations', async (req, reply) => {
        const channel = conversationManager.getChannel(req.params.id);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        return conversationManager.listConversations({ channelId: req.params.id });
    });
    // Get channel message history (top-level only; thread replies excluded)
    app.get('/api/channels/:id/messages', async (req, reply) => {
        const channel = conversationManager.getChannel(req.params.id);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        const limit = Math.min(Number(req.query.limit ?? 50), 200);
        const before = req.query.before != null ? Number(req.query.before) : null;
        const rows = (before != null
            ? db.prepare(`SELECT cm.message_id as id, cm.sender_name as senderName, cm.sender_type as senderType,
                    cm.content, cm.created_at as createdAt, cm.seq, cm.message_source as messageSource,
                    COUNT(replies.message_id) as replyCount
             FROM channel_messages cm
             LEFT JOIN channel_messages replies
               ON replies.channel_id = cm.channel_id
               AND replies.thread_root_id = SUBSTR(cm.message_id, 1, 8)
             WHERE cm.channel_id = ? AND cm.thread_root_id IS NULL AND cm.seq < ?
             GROUP BY cm.message_id
             ORDER BY cm.seq DESC LIMIT ?`).all(req.params.id, before, limit)
            : db.prepare(`SELECT cm.message_id as id, cm.sender_name as senderName, cm.sender_type as senderType,
                    cm.content, cm.created_at as createdAt, cm.seq, cm.message_source as messageSource,
                    COUNT(replies.message_id) as replyCount
             FROM channel_messages cm
             LEFT JOIN channel_messages replies
               ON replies.channel_id = cm.channel_id
               AND replies.thread_root_id = SUBSTR(cm.message_id, 1, 8)
             WHERE cm.channel_id = ? AND cm.thread_root_id IS NULL
             GROUP BY cm.message_id
             ORDER BY cm.seq DESC LIMIT ?`).all(req.params.id, limit));
        return {
            messages: rows.reverse().map((r) => ({
                id: r.id,
                senderName: r.senderName,
                senderType: r.senderType,
                content: r.content,
                createdAt: new Date(r.createdAt).toISOString(),
                seq: r.seq,
                replyCount: r.replyCount,
                ...(r.messageSource ? { messageSource: r.messageSource } : {}),
            })),
        };
    });
    // Get thread messages for a specific root message
    app.get('/api/channels/:id/threads/:shortId/messages', async (req, reply) => {
        const channel = conversationManager.getChannel(req.params.id);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        const limit = Math.min(Number(req.query.limit ?? 100), 200);
        const before = req.query.before != null ? Number(req.query.before) : null;
        const rows = (before != null
            ? db.prepare(`SELECT message_id as id, sender_name as senderName, sender_type as senderType,
                    content, created_at as createdAt, seq, message_source as messageSource
             FROM channel_messages
             WHERE channel_id = ? AND thread_root_id = ? AND seq < ?
             ORDER BY seq DESC LIMIT ?`).all(req.params.id, req.params.shortId, before, limit)
            : db.prepare(`SELECT message_id as id, sender_name as senderName, sender_type as senderType,
                    content, created_at as createdAt, seq, message_source as messageSource
             FROM channel_messages
             WHERE channel_id = ? AND thread_root_id = ?
             ORDER BY seq ASC LIMIT ?`).all(req.params.id, req.params.shortId, limit));
        const ordered = before != null ? rows.reverse() : rows;
        return {
            messages: ordered.map((r) => ({
                id: r.id,
                senderName: r.senderName,
                senderType: r.senderType,
                content: r.content,
                createdAt: new Date(r.createdAt).toISOString(),
                seq: r.seq,
                threadRootId: req.params.shortId,
                ...(r.messageSource ? { messageSource: r.messageSource } : {}),
            })),
        };
    });
    app.get('/api/channels/:id/threads/:shortId/summary', async (req, reply) => {
        const channel = conversationManager.getChannel(req.params.id);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        return getThreadCollaborationSummary(db, {
            channelId: req.params.id,
            threadRootId: req.params.shortId,
        });
    });
    app.post('/api/channels/:id/threads/:shortId/task', async (req, reply) => {
        const channel = conversationManager.getChannel(req.params.id);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        const taskNumber = req.body?.taskNumber;
        if (taskNumber == null) {
            reply.code(400);
            return { error: 'taskNumber is required' };
        }
        const task = db.prepare(`SELECT task_id as taskId, claimed_by_agent_id as assigneeId
         FROM tasks
         WHERE channel_id = ? AND task_number = ?`).get(req.params.id, taskNumber);
        if (!task) {
            reply.code(404);
            return { error: 'Task not found' };
        }
        const result = bindTaskToThread(db, {
            channelId: req.params.id,
            threadRootId: req.params.shortId,
            taskId: task.taskId,
        });
        if (!result.ok) {
            reply.code(409);
            return { error: result.reason };
        }
        if (task.assigneeId) {
            upsertTargetParticipant(db, {
                agentId: task.assigneeId,
                channelId: req.params.id,
                threadRootId: req.params.shortId,
                role: 'owner',
            });
        }
        else {
            setTargetOwner(db, {
                channelId: req.params.id,
                threadRootId: req.params.shortId,
                agentId: null,
            });
        }
        return getThreadCollaborationSummary(db, {
            channelId: req.params.id,
            threadRootId: req.params.shortId,
        });
    });
    app.delete('/api/channels/:id/threads/:shortId/task', async (req, reply) => {
        const channel = conversationManager.getChannel(req.params.id);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        const boundTask = getBoundTaskForThread(db, {
            channelId: req.params.id,
            threadRootId: req.params.shortId,
        });
        if (!boundTask) {
            reply.code(404);
            return { error: 'Thread is not bound to a task' };
        }
        unbindTaskFromThread(db, {
            channelId: req.params.id,
            threadRootId: req.params.shortId,
        });
        setTargetOwner(db, {
            channelId: req.params.id,
            threadRootId: req.params.shortId,
            agentId: null,
        });
        return getThreadCollaborationSummary(db, {
            channelId: req.params.id,
            threadRootId: req.params.shortId,
        });
    });
    // Post a user message to a channel (or thread when replyTo is set)
    app.post('/api/channels/:id/messages', async (req, reply) => {
        const channel = conversationManager.getChannel(req.params.id);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        const authHeader = req.headers.authorization ?? '';
        const chanToken = authHeader.replace(/^Bearer\s+/i, '');
        const chanUser = chanToken ? validateSession(db, chanToken) : null;
        const { content, senderName = chanUser?.username ?? config.humanUserName, replyTo } = req.body ?? {};
        if (!content) {
            reply.code(400);
            return { error: 'content is required' };
        }
        const threadRootId = replyTo ?? null;
        const now = Date.now();
        const messageId = randomUUID();
        const seqRow = db.prepare('SELECT MAX(seq) as maxSeq FROM channel_messages WHERE channel_id = ?').get(req.params.id);
        const seq = (seqRow.maxSeq ?? 0) + 1;
        const target = threadRootId ? `#${channel.name}:${threadRootId}` : `#${channel.name}`;
        db.prepare(`INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
         VALUES(?, ?, 'user', ?, 'user', ?, ?, ?, ?, NULL, ?)`).run(messageId, req.params.id, senderName, target, content, seq, now, threadRootId);
        const event = {
            type: 'channel.message',
            message: {
                id: messageId, senderName, senderType: 'user', content,
                createdAt: new Date(now).toISOString(),
                seq,
                ...(threadRootId ? { threadRootId } : {}),
            },
        };
        broadcastToChannel(req.params.id, event);
        const channelAgents = conversationManager.listAgents(req.params.id);
        const mentionedAgents = findMentionedAgents(content, channelAgents);
        const notifiedAgentIds = new Set();
        const historyTarget = threadRootId ? `#${channel.name}:${threadRootId}` : `#${channel.name}`;
        const notifyAgent = (agentId, reason, role) => {
            if (notifiedAgentIds.has(agentId))
                return;
            const agent = conversationManager.getAgent(agentId);
            if (!agent)
                return;
            const conv = conversationManager.openAgentChannelThread(agentId, req.params.id, threadRootId ?? null);
            if (!conv)
                return;
            upsertTargetParticipant(db, {
                agentId,
                channelId: req.params.id,
                threadRootId: threadRootId ?? null,
                role,
                lastActiveAt: now,
            });
            const activationContext = buildTargetActivationContext(db, {
                agentId,
                channelId: req.params.id,
                replyTarget: conv.replyTarget ?? historyTarget,
                triggerSeq: seq,
                threadRootId: threadRootId ?? null,
            });
            if (reason === 'mention') {
                broadcastToChannel(req.params.id, {
                    type: 'channel.notice',
                    notice: {
                        message: `@${agent.name} was mentioned and notified.`,
                        createdAt: new Date(now).toISOString(),
                    },
                });
            }
            notifiedAgentIds.add(agentId);
            conversationManager.submitPrompt(conv.id, buildChannelActivationPrompt({
                channelName: channel.name,
                target: historyTarget,
                replyTarget: activationContext.replyTarget,
                senderName,
                content,
                reason,
            }), {
                recordAsUserMessage: false,
                activationContextText: buildChannelActivationContextText({
                    target: historyTarget,
                    recentMessages: activationContext.recentMessages,
                    rootMessage: activationContext.rootMessage,
                    unreadCount: activationContext.unreadCount,
                    participants: activationContext.participants,
                    boundTask: activationContext.boundTask,
                    openTasks: activationContext.openTasks,
                }) || undefined,
            }).then(() => {
                bumpAgentMessageCheckpoint(db, agentId, req.params.id, seq, threadRootId ?? null);
            }).catch(() => { });
        };
        // Thread replies wake current thread participants; fall back to the root owner if needed.
        if (threadRootId) {
            const summary = getThreadCollaborationSummary(db, {
                channelId: req.params.id,
                threadRootId,
            });
            const participants = listTargetParticipants(db, {
                channelId: req.params.id,
                threadRootId,
            });
            const rootMsg = db.prepare(`SELECT sender_id as senderId, sender_type as senderType
           FROM channel_messages
           WHERE channel_id = ? AND substr(message_id, 1, 8) = ?
           LIMIT 1`).get(req.params.id, threadRootId);
            if (summary.ownerAgentId) {
                notifyAgent(summary.ownerAgentId, 'thread_reply', 'owner');
            }
            if (participants.length === 0 && !summary.ownerAgentId && rootMsg?.senderType === 'agent') {
                notifyAgent(rootMsg.senderId, 'thread_reply', 'owner');
            }
            else {
                for (const participant of participants) {
                    notifyAgent(participant.agentId, 'thread_reply', participant.role);
                }
            }
        }
        for (const agent of mentionedAgents) {
            notifyAgent(agent.agentId, 'mention', threadRootId ? 'participant' : 'owner');
        }
        if (!threadRootId && mentionedAgents.length === 0 && channel.collaborationMode === 'subscribed_agents') {
            const rootParticipants = listTargetParticipants(db, {
                channelId: req.params.id,
                threadRootId: null,
            });
            const subscribedAgents = listChannelSubscriptions(db, req.params.id);
            const agentsToWake = rootParticipants.length > 0
                ? rootParticipants.map((participant) => ({
                    agentId: participant.agentId,
                    role: participant.role,
                }))
                : subscribedAgents.map((agent) => ({
                    agentId: agent.agentId,
                    role: 'participant',
                }));
            for (const agent of agentsToWake) {
                notifyAgent(agent.agentId, 'channel_activity', agent.role);
            }
        }
        reply.code(201);
        return { messageId, seq };
    });
    // ─── Machine routes ───
    app.get('/api/machines', async () => {
        return conversationManager.listMachines();
    });
    app.post('/api/machines', async (req, reply) => {
        const body = (req.body ?? {});
        if (!body.name) {
            reply.code(400);
            return { error: 'name is required' };
        }
        const machine = conversationManager.createMachine(body);
        reply.code(201);
        return machine;
    });
    app.get('/api/machines/:id', async (req, reply) => {
        const machine = conversationManager.getMachine(req.params.id);
        if (!machine) {
            reply.code(404);
            return { error: 'Not found' };
        }
        return machine;
    });
    app.delete('/api/machines/:id', async (req, reply) => {
        const machine = conversationManager.getMachine(req.params.id);
        if (!machine) {
            reply.code(404);
            return { error: 'Not found' };
        }
        conversationManager.deleteMachine(req.params.id);
        reply.code(204);
        return;
    });
    // ─── Internal agent routes (used by channel-bridge MCP server) ───
    // Channel-level WebSocket subscriber registry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connectionsByChannel = new Map();
    function broadcastToChannel(channelId, event) {
        const sockets = connectionsByChannel.get(channelId);
        if (!sockets)
            return;
        const data = JSON.stringify(event);
        for (const ws of sockets) {
            if (ws.readyState === ws.OPEN)
                ws.send(data);
        }
    }
    function broadcastToAgent(agentId, event, conversationId) {
        if (conversationId) {
            broadcast(conversationId, event);
            return;
        }
        const rows = db
            .prepare('SELECT id FROM conversations WHERE agent_id = ?')
            .all(agentId);
        for (const row of rows) {
            broadcast(row.id, event);
        }
    }
    registerInternalAgentRoutes(app, db, conversationManager, broadcastToAgent, broadcastToChannel, config.humanUserName);
    // ─── User-facing Task routes ───
    // GET /api/channels/:id/tasks
    app.get('/api/channels/:id/tasks', async (req, reply) => {
        const channel = conversationManager.getChannel(req.params.id);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        const rows = req.query.status && req.query.status !== 'all'
            ? db.prepare(`SELECT t.task_id as taskId, t.channel_id as channelId, t.task_number as taskNumber,
                    title, description, status,
                    claimed_by_agent_id as assigneeId, claimed_by_name as assigneeName,
                    created_at as createdAt, updated_at as updatedAt,
                    b.thread_root_id as linkedThreadId,
                    b.thread_root_id as linkedThreadShortId
             FROM tasks t
             LEFT JOIN thread_task_bindings b ON b.task_id = t.task_id
             WHERE t.channel_id = ? AND t.status = ? ORDER BY t.task_number ASC`).all(req.params.id, req.query.status)
            : db.prepare(`SELECT t.task_id as taskId, t.channel_id as channelId, t.task_number as taskNumber,
                    title, description, status,
                    claimed_by_agent_id as assigneeId, claimed_by_name as assigneeName,
                    created_at as createdAt, updated_at as updatedAt,
                    b.thread_root_id as linkedThreadId,
                    b.thread_root_id as linkedThreadShortId
             FROM tasks t
             LEFT JOIN thread_task_bindings b ON b.task_id = t.task_id
             WHERE t.channel_id = ? ORDER BY t.task_number ASC`).all(req.params.id);
        return { tasks: rows };
    });
    // POST /api/channels/:id/tasks
    app.post('/api/channels/:id/tasks', async (req, reply) => {
        const channel = conversationManager.getChannel(req.params.id);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        const { title, description } = req.body ?? {};
        if (!title) {
            reply.code(400);
            return { error: 'title is required' };
        }
        const now = Date.now();
        const taskId = randomUUID();
        const seqRow = db.prepare('SELECT MAX(task_number) as maxNum FROM tasks WHERE channel_id = ?').get(req.params.id);
        const taskNumber = (seqRow.maxNum ?? 0) + 1;
        db.prepare(`INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, 'todo', ?, ?)`).run(taskId, req.params.id, taskNumber, title, description ?? null, now, now);
        reply.code(201);
        return { taskId, channelId: req.params.id, taskNumber, title, description, status: 'todo', assigneeId: null, assigneeName: null, createdAt: now, updatedAt: now };
    });
    // PATCH /api/channels/:id/tasks/:num/status
    app.patch('/api/channels/:id/tasks/:num/status', async (req, reply) => {
        const channel = conversationManager.getChannel(req.params.id);
        if (!channel) {
            reply.code(404);
            return { error: 'Channel not found' };
        }
        const taskNumber = Number(req.params.num);
        const { status } = req.body ?? {};
        const validStatuses = ['todo', 'in_progress', 'in_review', 'done'];
        if (!validStatuses.includes(status)) {
            reply.code(400);
            return { error: `Invalid status: ${status}` };
        }
        const now = Date.now();
        const result = db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE channel_id = ? AND task_number = ?`).run(status, now, req.params.id, taskNumber);
        if (result.changes === 0) {
            reply.code(404);
            return { error: 'Task not found' };
        }
        const row = db.prepare(`SELECT task_id as taskId, channel_id as channelId, task_number as taskNumber,
                title, description, status, claimed_by_agent_id as assigneeId,
                claimed_by_name as assigneeName, created_at as createdAt, updated_at as updatedAt
         FROM tasks WHERE channel_id = ? AND task_number = ?`).get(req.params.id, taskNumber);
        return row;
    });
    // ─── Node REST routes ───
    // List connected agent nodes (in-memory only, for backward compat)
    app.get('/api/nodes', async () => {
        return nodeRegistry.listNodes();
    });
    // ─── WebSocket routes ───
    // Frontend WebSocket stream for a conversation
    app.get('/api/conversations/:id/stream', { websocket: true }, (socket, req) => {
        const conversationId = req.params.id;
        // Resolve sender name from auth token (falls back to config default)
        const wsToken = req.query['token'] ?? '';
        const wsUser = wsToken ? validateSession(db, wsToken) : null;
        const senderName = wsUser?.username ?? config.humanUserName;
        handleWebSocket(socket, conversationId, conversationManager, senderName);
    });
    // Channel WebSocket stream (real-time channel messages)
    app.get('/api/channels/:id/stream', { websocket: true }, (socket, req) => {
        const channelId = req.params.id;
        if (!conversationManager.getChannel(channelId)) {
            socket.send(JSON.stringify({ type: 'error', message: 'Channel not found' }));
            socket.close();
            return;
        }
        if (!connectionsByChannel.has(channelId))
            connectionsByChannel.set(channelId, new Set());
        connectionsByChannel.get(channelId).add(socket);
        socket.on('close', () => {
            const s = connectionsByChannel.get(channelId);
            if (s) {
                s.delete(socket);
                if (s.size === 0)
                    connectionsByChannel.delete(channelId);
            }
        });
    });
    // Agent-node WebSocket connection
    app.get('/api/nodes/connect', { websocket: true }, (socket) => {
        handleNodeWebSocket(socket, nodeRegistry, broadcast, db, conversationManager, workspaceBroker);
    });
    // ─── Authentication routes ───
    // Check if setup is complete (has admin user)
    app.get('/api/auth/check-setup', async () => {
        return { hasAdmin: hasAdminUser(db) };
    });
    // Initial setup with invite token
    app.post('/api/auth/setup', async (req, reply) => {
        const { token, username, password } = req.body ?? {};
        if (!token || !username || !password) {
            reply.code(400);
            return { error: 'token, username, and password are required' };
        }
        // Username validation
        if (username.length < 3 || username.length > 32) {
            reply.code(400);
            return { error: 'Username must be between 3 and 32 characters' };
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
            reply.code(400);
            return { error: 'Username can only contain letters, numbers, underscores, and hyphens' };
        }
        // Password validation
        if (password.length < 6) {
            reply.code(400);
            return { error: 'Password must be at least 6 characters' };
        }
        const result = await setupWithInvite(db, token, username, password);
        if (!result.success) {
            reply.code(400);
            return { error: result.error };
        }
        return {
            user: result.user,
            token: result.session?.token,
        };
    });
    // Login
    app.post('/api/auth/login', async (req, reply) => {
        const { username, password } = req.body ?? {};
        if (!username || !password) {
            reply.code(400);
            return { error: 'username and password are required' };
        }
        const result = await loginUser(db, username, password);
        if (!result.success) {
            reply.code(401);
            return { error: result.error };
        }
        return {
            user: result.user,
            token: result.session?.token,
        };
    });
    // Logout
    app.post('/api/auth/logout', async (req, reply) => {
        const authHeader = req.headers.authorization ?? '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (token) {
            logoutUser(db, token);
        }
        return { ok: true };
    });
    // Get current user
    app.get('/api/auth/me', async (req, reply) => {
        const authHeader = req.headers.authorization ?? '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (!token) {
            reply.code(401);
            return { error: 'Not authenticated' };
        }
        const user = validateSession(db, token);
        if (!user) {
            reply.code(401);
            return { error: 'Invalid or expired session' };
        }
        return { user };
    });
    // Admin: Create invite token
    app.post('/api/admin/invite', async (req, reply) => {
        const authHeader = req.headers.authorization ?? '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (!token) {
            reply.code(401);
            return { error: 'Not authenticated' };
        }
        const user = validateSession(db, token);
        if (!user) {
            reply.code(401);
            return { error: 'Invalid or expired session' };
        }
        if (!user.isAdmin) {
            reply.code(403);
            return { error: 'Admin access required' };
        }
        const invite = createInviteToken(db);
        // Build invite URL
        const inviteUrl = `${req.protocol}://${req.hostname}:${port}/?invite=${invite.token}`;
        return {
            token: invite.token,
            expiresAt: invite.expiresAt,
            inviteUrl,
        };
    });
    // List all users (any authenticated user)
    app.get('/api/users', async (req, reply) => {
        const authHeader = req.headers.authorization ?? '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (!token) {
            reply.code(401);
            return { error: 'Not authenticated' };
        }
        const user = validateSession(db, token);
        if (!user) {
            reply.code(401);
            return { error: 'Invalid or expired session' };
        }
        return { users: listUsers(db) };
    });
    // Admin: List all users
    app.get('/api/admin/users', async (req, reply) => {
        const authHeader = req.headers.authorization ?? '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (!token) {
            reply.code(401);
            return { error: 'Not authenticated' };
        }
        const user = validateSession(db, token);
        if (!user) {
            reply.code(401);
            return { error: 'Invalid or expired session' };
        }
        if (!user.isAdmin) {
            reply.code(403);
            return { error: 'Admin access required' };
        }
        return { users: listUsers(db) };
    });
    // Admin: Delete user
    app.delete('/api/admin/users/:id', async (req, reply) => {
        const authHeader = req.headers.authorization ?? '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (!token) {
            reply.code(401);
            return { error: 'Not authenticated' };
        }
        const user = validateSession(db, token);
        if (!user) {
            reply.code(401);
            return { error: 'Invalid or expired session' };
        }
        if (!user.isAdmin) {
            reply.code(403);
            return { error: 'Admin access required' };
        }
        // Prevent deleting self
        if (req.params.id === user.id) {
            reply.code(400);
            return { error: 'Cannot delete your own account' };
        }
        const deleted = deleteUser(db, req.params.id);
        if (!deleted) {
            reply.code(404);
            return { error: 'User not found' };
        }
        return { ok: true };
    });
    // Change password (authenticated user)
    app.post('/api/auth/change-password', async (req, reply) => {
        const authHeader = req.headers.authorization ?? '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (!token) {
            reply.code(401);
            return { error: 'Not authenticated' };
        }
        const user = validateSession(db, token);
        if (!user) {
            reply.code(401);
            return { error: 'Invalid or expired session' };
        }
        const { currentPassword, newPassword } = req.body ?? {};
        if (!currentPassword || !newPassword) {
            reply.code(400);
            return { error: 'currentPassword and newPassword are required' };
        }
        if (newPassword.length < 6) {
            reply.code(400);
            return { error: 'Password must be at least 6 characters' };
        }
        // Verify current password
        const userRow = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
        if (!userRow) {
            reply.code(404);
            return { error: 'User not found' };
        }
        const { verifyPassword, hashPassword } = await import('../services/auth.js');
        const valid = await verifyPassword(currentPassword, userRow.password_hash);
        if (!valid) {
            reply.code(400);
            return { error: 'Current password is incorrect' };
        }
        const newHash = await hashPassword(newPassword);
        db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, Date.now(), user.id);
        return { ok: true };
    });
    // Cleanup expired tokens periodically
    setInterval(() => {
        cleanupExpiredTokens(db);
    }, 60 * 60 * 1000); // Every hour
    await app.listen({ port, host });
    log.info(`Web server listening on ${host}:${port}`);
}
function normalizeWorkspaceQueryPath(rawPath) {
    if (!rawPath)
        return '';
    return rawPath.replace(/^\/+/, '');
}
