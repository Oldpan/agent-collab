import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';

import type { Db } from '@agent-collab/runtime-acp';
import { log, finishRun } from '@agent-collab/runtime-acp';
import type { CreateConversationRequest, CreateChannelRequest, CreateAgentRequest, UpdateAgentRequest, CreateMachineRequest } from '@agent-collab/protocol';
import type { ConversationManager } from './conversationManager.js';
import { handleWebSocket, broadcast } from './wsHandler.js';
import { handleNodeWebSocket } from './nodeWsHandler.js';
import { registerInternalAgentRoutes } from './internalAgentRouter.js';
import { NodeRegistry } from '../services/nodeRegistry.js';
import { AgentWorkspaceBroker } from '../services/agentWorkspaceBroker.js';
import { AgentWorkspaceService, AgentWorkspaceServiceError } from '../services/agentWorkspaceService.js';

export async function startServer(params: {
  port: number;
  host: string;
  conversationManager: ConversationManager;
  db: Db;
  nodeRegistry?: NodeRegistry;
  workspaceBroker?: AgentWorkspaceBroker;
}): Promise<void> {
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

  app.post<{ Body: CreateAgentRequest }>('/api/agents', async (req, reply) => {
    const body = (req.body ?? {}) as CreateAgentRequest;
    if (!body.name) {
      reply.code(400);
      return { error: 'name is required' };
    }
    const agent = conversationManager.createAgent(body);
    reply.code(201);
    return agent;
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id', async (req, reply) => {
    const agent = conversationManager.getAgent(req.params.id);
    if (!agent) { reply.code(404); return { error: 'Not found' }; }
    return agent;
  });

  app.patch<{ Params: { id: string }; Body: UpdateAgentRequest }>('/api/agents/:id', async (req, reply) => {
    const updated = conversationManager.updateAgent(req.params.id, req.body ?? {});
    if (!updated) { reply.code(404); return { error: 'Not found' }; }
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/agents/:id', async (req, reply) => {
    const agent = conversationManager.getAgent(req.params.id);
    if (!agent) { reply.code(404); return { error: 'Not found' }; }
    const result = conversationManager.deleteAgent(req.params.id);
    return { ok: true, deletedConversations: result.deletedConversations };
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id/conversations', async (req, reply) => {
    const agent = conversationManager.getAgent(req.params.id);
    if (!agent) { reply.code(404); return { error: 'Not found' }; }
    return conversationManager.listConversations({ agentId: req.params.id });
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/open-thread', async (req, reply) => {
    const thread = conversationManager.openAgentThread(req.params.id);
    if (!thread) {
      reply.code(404);
      return { error: 'Not found' };
    }
    return thread;
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/restart', async (req, reply) => {
    const agent = conversationManager.getAgent(req.params.id);
    if (!agent) { reply.code(404); return { error: 'Not found' }; }
    if (!agent.nodeId) { reply.code(409); return { error: 'Agent is not assigned to a remote node.' }; }

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
      const activeRuns = db.prepare(
        `SELECT run_id as runId FROM runs WHERE session_key = (
           SELECT session_key FROM conversations WHERE id = ?
         ) AND ended_at IS NULL`,
      ).all(conversation.id) as Array<{ runId: string }>;
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

  app.post<{ Params: { id: string } }>('/api/agents/:id/clear-chat', async (req, reply) => {
    const agent = conversationManager.getAgent(req.params.id);
    if (!agent) { reply.code(404); return { error: 'Not found' }; }

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

  app.post<{ Params: { id: string } }>('/api/agents/:id/reset', async (req, reply) => {
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
    } catch (error) {
      reply.code(409);
      return { error: String((error as Error)?.message ?? error) };
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

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/agents/:id/workspace', async (req, reply) => {
    try {
      return await workspaceService.listWorkspace(req.params.id, normalizeWorkspaceQueryPath(req.query.path));
    } catch (error) {
      if (error instanceof AgentWorkspaceServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      reply.code(500);
      return { error: String((error as Error)?.message ?? error) };
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/agents/:id/workspace/file', async (req, reply) => {
    try {
      return await workspaceService.readWorkspaceFile(req.params.id, normalizeWorkspaceQueryPath(req.query.path));
    } catch (error) {
      if (error instanceof AgentWorkspaceServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      reply.code(500);
      return { error: String((error as Error)?.message ?? error) };
    }
  });

  // Create conversation
  app.post<{ Body: CreateConversationRequest }>('/api/conversations', async (req, reply) => {
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
  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
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
  app.get<{ Params: { id: string } }>('/api/conversations/:id/history', async (req, reply) => {
    const conv = conversationManager.getConversation(req.params.id);
    if (!conv) {
      reply.code(404);
      return { error: 'Not found' };
    }

    // Fetch runs and events for this conversation's session
    const sessionRow = db
      .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(req.params.id) as { sessionKey: string } | undefined;

    if (!sessionRow) return [];

    const runs = db
      .prepare(
        `SELECT run_id as runId, prompt_text as promptText, started_at as startedAt,
                ended_at as endedAt, stop_reason as stopReason, error
         FROM runs WHERE session_key = ? ORDER BY started_at ASC`,
      )
      .all(sessionRow.sessionKey) as Array<{
      runId: string;
      promptText: string;
      startedAt: number;
      endedAt: number | null;
      stopReason: string | null;
      error: string | null;
    }>;

    return runs;
  });

  // Channel message history for a conversation (used by frontend to load DM history)
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/conversations/:id/channel-messages',
    async (req, reply) => {
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
        .prepare(
          `SELECT message_id as id, sender_name as senderName, sender_type as senderType,
                  content, created_at as createdAt
           FROM channel_messages
           WHERE channel_id = ?
           ORDER BY seq DESC LIMIT ?`,
        )
        .all(dmChannelId, limit) as Array<{
        id: string;
        senderName: string;
        senderType: string;
        content: string;
        createdAt: number;
      }>;

      const messages = rows.reverse().map((r) => ({
        id: r.id,
        senderName: r.senderName,
        senderType: r.senderType as 'user' | 'agent',
        content: r.content,
        createdAt: new Date(r.createdAt).toISOString(),
      }));

      return { messages };
    },
  );

  // ─── Channel routes ───

  // List all channels
  app.get('/api/channels', async () => {
    return conversationManager.listChannels();
  });

  // Create channel
  app.post<{ Body: CreateChannelRequest }>('/api/channels', async (req, reply) => {
    const body = (req.body ?? {}) as CreateChannelRequest;
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
    } catch {
      reply.code(409);
      return { error: 'Channel name already exists' };
    }
  });

  // List conversations in a channel
  app.get<{ Params: { id: string } }>('/api/channels/:id/conversations', async (req, reply) => {
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

  app.post<{ Body: CreateMachineRequest }>('/api/machines', async (req, reply) => {
    const body = (req.body ?? {}) as CreateMachineRequest;
    if (!body.name) {
      reply.code(400);
      return { error: 'name is required' };
    }
    const machine = conversationManager.createMachine(body);
    reply.code(201);
    return machine;
  });

  app.get<{ Params: { id: string } }>('/api/machines/:id', async (req, reply) => {
    const machine = conversationManager.getMachine(req.params.id);
    if (!machine) { reply.code(404); return { error: 'Not found' }; }
    return machine;
  });

  app.delete<{ Params: { id: string } }>('/api/machines/:id', async (req, reply) => {
    const machine = conversationManager.getMachine(req.params.id);
    if (!machine) { reply.code(404); return { error: 'Not found' }; }
    conversationManager.deleteMachine(req.params.id);
    reply.code(204);
    return;
  });

  // ─── Internal agent routes (used by channel-bridge MCP server) ───

  function broadcastToAgent(
    agentId: string,
    event: import('@agent-collab/protocol').ServerEvent,
    conversationId?: string,
  ): void {
    if (conversationId) {
      broadcast(conversationId, event);
      return;
    }
    const rows = db
      .prepare('SELECT id FROM conversations WHERE agent_id = ?')
      .all(agentId) as Array<{ id: string }>;
    for (const row of rows) {
      broadcast(row.id, event);
    }
  }

  registerInternalAgentRoutes(app, db, conversationManager, broadcastToAgent);

  // ─── Node REST routes ───

  // List connected agent nodes (in-memory only, for backward compat)
  app.get('/api/nodes', async () => {
    return nodeRegistry.listNodes();
  });

  // ─── WebSocket routes ───

  // Frontend WebSocket stream for a conversation
  app.get<{ Params: { id: string } }>(
    '/api/conversations/:id/stream',
    { websocket: true },
    (socket, req) => {
      const conversationId = req.params.id;
      handleWebSocket(socket, conversationId, conversationManager);
    },
  );

  // Agent-node WebSocket connection
  app.get(
    '/api/nodes/connect',
    { websocket: true },
    (socket) => {
      handleNodeWebSocket(socket, nodeRegistry, broadcast, db, conversationManager, workspaceBroker);
    },
  );

  await app.listen({ port, host });
  log.info(`Web server listening on ${host}:${port}`);
}

function normalizeWorkspaceQueryPath(rawPath?: string): string {
  if (!rawPath) return '';
  return rawPath.replace(/^\/+/, '');
}
