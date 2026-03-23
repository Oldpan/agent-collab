import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';
import { log } from '@agent-collab/runtime-acp';
import { handleWebSocket, broadcast } from './wsHandler.js';
import { handleNodeWebSocket } from './nodeWsHandler.js';
import { NodeRegistry } from '../services/nodeRegistry.js';
import { AgentWorkspaceBroker } from '../services/agentWorkspaceBroker.js';
import { AgentWorkspaceService, AgentWorkspaceServiceError } from '../services/agentWorkspaceService.js';
export async function startServer(params) {
    const { port, host, conversationManager, db } = params;
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
        conversationManager.deleteAgent(req.params.id);
        reply.code(204);
        return;
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
        return runs;
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
            });
            reply.code(201);
            return channel;
        }
        catch {
            reply.code(409);
            return { error: 'Channel name already exists' };
        }
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
    // ─── Node REST routes ───
    // List connected agent nodes (in-memory only, for backward compat)
    app.get('/api/nodes', async () => {
        return nodeRegistry.listNodes();
    });
    // ─── WebSocket routes ───
    // Frontend WebSocket stream for a conversation
    app.get('/api/conversations/:id/stream', { websocket: true }, (socket, req) => {
        const conversationId = req.params.id;
        handleWebSocket(socket, conversationId, conversationManager);
    });
    // Agent-node WebSocket connection
    app.get('/api/nodes/connect', { websocket: true }, (socket) => {
        handleNodeWebSocket(socket, nodeRegistry, broadcast, db, conversationManager, workspaceBroker);
    });
    await app.listen({ port, host });
    log.info(`Web server listening on ${host}:${port}`);
}
function normalizeWorkspaceQueryPath(rawPath) {
    if (!rawPath)
        return '';
    return rawPath.replace(/^\/+/, '');
}
