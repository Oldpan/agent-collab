import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';

import type { Db } from '@agent-collab/runtime-acp';
import { log, finishRun } from '@agent-collab/runtime-acp';
import type { CreateConversationRequest, CreateChannelRequest, UpdateChannelRequest, CreateAgentRequest, UpdateAgentRequest, CreateMachineRequest } from '@agent-collab/protocol';
import type { ConversationManager } from './conversationManager.js';
import { handleWebSocket, broadcast } from './wsHandler.js';
import { handleNodeWebSocket } from './nodeWsHandler.js';
import { registerInternalAgentRoutes } from './internalAgentRouter.js';
import { NodeRegistry } from '../services/nodeRegistry.js';
import { AgentWorkspaceBroker } from '../services/agentWorkspaceBroker.js';
import { AgentWorkspaceService, AgentWorkspaceServiceError } from '../services/agentWorkspaceService.js';
import { findMentionedAgents } from './channelMentions.js';
import { buildChannelActivationPrompt } from './channelActivationPrompt.js';
import { bumpAgentMessageCheckpoint } from './messageCheckpoints.js';

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

    return runs.map((run) => {
      const nodeEvents = db
        .prepare(
          `SELECT payload_json as payloadJson
           FROM events
           WHERE run_id = ? AND method = 'node/event'
           ORDER BY seq ASC`,
        )
        .all(run.runId) as Array<{ payloadJson: string }>;

      let assistantText = '';
      let thinkingText = '';
      for (const evt of nodeEvents) {
        try {
          const parsed = JSON.parse(evt.payloadJson) as { type?: string; text?: string };
          if (parsed?.type === 'content.delta' && typeof parsed.text === 'string') {
            assistantText += parsed.text;
          }
          if (parsed?.type === 'thinking.delta' && typeof parsed.text === 'string') {
            thinkingText += parsed.text;
          }
        } catch {
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
        description: body.description,
      });
      for (const agentId of body.agentIds ?? []) {
        if (conversationManager.getAgent(agentId)) {
          conversationManager.joinChannel(agentId, channel.channelId);
        }
      }
      reply.code(201);
      return channel;
    } catch {
      reply.code(409);
      return { error: 'Channel name already exists' };
    }
  });

  // Update channel (e.g. description)
  app.patch<{ Params: { id: string }; Body: UpdateChannelRequest }>(
    '/api/channels/:id',
    async (req, reply) => {
      const updated = conversationManager.updateChannel(req.params.id, req.body ?? {});
      if (!updated) { reply.code(404); return { error: 'Not found' }; }
      return updated;
    },
  );

  // Join agent to a channel
  app.post<{ Params: { id: string; channelId: string } }>(
    '/api/agents/:id/channels/:channelId',
    async (req, reply) => {
      const agent = conversationManager.getAgent(req.params.id);
      if (!agent) { reply.code(404); return { error: 'Agent not found' }; }
      const channel = conversationManager.getChannel(req.params.channelId);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      conversationManager.joinChannel(req.params.id, req.params.channelId);
      reply.code(204);
    },
  );

  // Leave agent from a channel
  app.delete<{ Params: { id: string; channelId: string } }>(
    '/api/agents/:id/channels/:channelId',
    async (req, reply) => {
      conversationManager.leaveChannel(req.params.id, req.params.channelId);
      reply.code(204);
    },
  );

  // List conversations in a channel
  app.get<{ Params: { id: string } }>('/api/channels/:id/conversations', async (req, reply) => {
    const channel = conversationManager.getChannel(req.params.id);
    if (!channel) {
      reply.code(404);
      return { error: 'Channel not found' };
    }
    return conversationManager.listConversations({ channelId: req.params.id });
  });

  // Get channel message history (top-level only; thread replies excluded)
  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/channels/:id/messages',
    async (req, reply) => {
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const before = req.query.before != null ? Number(req.query.before) : null;
      const rows = (before != null
        ? db.prepare(
            `SELECT cm.message_id as id, cm.sender_name as senderName, cm.sender_type as senderType,
                    cm.content, cm.created_at as createdAt, cm.seq,
                    COUNT(replies.message_id) as replyCount
             FROM channel_messages cm
             LEFT JOIN channel_messages replies
               ON replies.channel_id = cm.channel_id
               AND replies.thread_root_id = SUBSTR(cm.message_id, 1, 8)
             WHERE cm.channel_id = ? AND cm.thread_root_id IS NULL AND cm.seq < ?
             GROUP BY cm.message_id
             ORDER BY cm.seq DESC LIMIT ?`,
          ).all(req.params.id, before, limit)
        : db.prepare(
            `SELECT cm.message_id as id, cm.sender_name as senderName, cm.sender_type as senderType,
                    cm.content, cm.created_at as createdAt, cm.seq,
                    COUNT(replies.message_id) as replyCount
             FROM channel_messages cm
             LEFT JOIN channel_messages replies
               ON replies.channel_id = cm.channel_id
               AND replies.thread_root_id = SUBSTR(cm.message_id, 1, 8)
             WHERE cm.channel_id = ? AND cm.thread_root_id IS NULL
             GROUP BY cm.message_id
             ORDER BY cm.seq DESC LIMIT ?`,
          ).all(req.params.id, limit)
      ) as Array<{ id: string; senderName: string; senderType: string; content: string; createdAt: number; seq: number; replyCount: number }>;
      return {
        messages: rows.reverse().map((r) => ({
          id: r.id,
          senderName: r.senderName,
          senderType: r.senderType as 'user' | 'agent',
          content: r.content,
          createdAt: new Date(r.createdAt).toISOString(),
          seq: r.seq,
          replyCount: r.replyCount,
        })),
      };
    },
  );

  // Get thread messages for a specific root message
  app.get<{ Params: { id: string; shortId: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/channels/:id/threads/:shortId/messages',
    async (req, reply) => {
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const limit = Math.min(Number(req.query.limit ?? 100), 200);
      const before = req.query.before != null ? Number(req.query.before) : null;
      const rows = (before != null
        ? db.prepare(
            `SELECT message_id as id, sender_name as senderName, sender_type as senderType,
                    content, created_at as createdAt, seq
             FROM channel_messages
             WHERE channel_id = ? AND thread_root_id = ? AND seq < ?
             ORDER BY seq DESC LIMIT ?`,
          ).all(req.params.id, req.params.shortId, before, limit)
        : db.prepare(
            `SELECT message_id as id, sender_name as senderName, sender_type as senderType,
                    content, created_at as createdAt, seq
             FROM channel_messages
             WHERE channel_id = ? AND thread_root_id = ?
             ORDER BY seq ASC LIMIT ?`,
          ).all(req.params.id, req.params.shortId, limit)
      ) as Array<{ id: string; senderName: string; senderType: string; content: string; createdAt: number; seq: number }>;
      const ordered = before != null ? rows.reverse() : rows;
      return {
        messages: ordered.map((r) => ({
          id: r.id,
          senderName: r.senderName,
          senderType: r.senderType as 'user' | 'agent',
          content: r.content,
          createdAt: new Date(r.createdAt).toISOString(),
          seq: r.seq,
          threadRootId: req.params.shortId,
        })),
      };
    },
  );

  // Post a user message to a channel (or thread when replyTo is set)
  app.post<{ Params: { id: string }; Body: { content: string; senderName?: string; replyTo?: string } }>(
    '/api/channels/:id/messages',
    async (req, reply) => {
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const { content, senderName = config.humanUserName, replyTo } = req.body ?? {};
      if (!content) { reply.code(400); return { error: 'content is required' }; }
      const threadRootId = replyTo ?? null;
      const now = Date.now();
      const messageId = randomUUID();
      const seqRow = db.prepare('SELECT MAX(seq) as maxSeq FROM channel_messages WHERE channel_id = ?').get(req.params.id) as { maxSeq: number | null };
      const seq = (seqRow.maxSeq ?? 0) + 1;
      const target = threadRootId ? `#${channel.name}:${threadRootId}` : `#${channel.name}`;
      db.prepare(
        `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
         VALUES(?, ?, 'user', ?, 'user', ?, ?, ?, ?, NULL, ?)`,
      ).run(messageId, req.params.id, senderName, target, content, seq, now, threadRootId);
      const event: import('@agent-collab/protocol').ServerEvent = {
        type: 'channel.message',
        message: {
          id: messageId, senderName, senderType: 'user', content,
          createdAt: new Date(now).toISOString(),
          ...(threadRootId ? { threadRootId } : {}),
        },
      };
      broadcastToChannel(req.params.id, event);

      // Thread reply: notify the agent whose message was replied to
      if (threadRootId) {
        const rootMsg = db.prepare(
          `SELECT sender_id, sender_type FROM channel_messages
           WHERE channel_id = ? AND substr(message_id, 1, 8) = ?
           LIMIT 1`,
        ).get(req.params.id, threadRootId) as { sender_id: string; sender_type: string } | undefined;
        if (rootMsg?.sender_type === 'agent') {
          const conv = conversationManager.openAgentChannelThread(rootMsg.sender_id, req.params.id, threadRootId);
          if (conv) {
            bumpAgentMessageCheckpoint(db, rootMsg.sender_id, req.params.id, seq, threadRootId);
            conversationManager.submitPrompt(
              conv.id,
              buildChannelActivationPrompt({
                channelName: channel.name,
                target: `#${channel.name}:${threadRootId}`,
                senderName,
                content,
                reason: 'thread_reply',
              }),
              { recordAsUserMessage: false },
            ).catch(() => {});
          }
        }
      }

      // Notify only @mentioned agents in the channel.
      void (async () => {
        const channelAgents = conversationManager.listAgents(req.params.id);
        const mentionedAgents = findMentionedAgents(content, channelAgents);
        for (const agent of mentionedAgents) {
          const conv = conversationManager.openAgentChannelThread(agent.agentId, req.params.id, threadRootId ?? null);
          if (conv) {
            const historyTarget = threadRootId ? `#${channel.name}:${threadRootId}` : `#${channel.name}`;
            bumpAgentMessageCheckpoint(db, agent.agentId, req.params.id, seq, threadRootId ?? null);
            broadcastToChannel(req.params.id, {
              type: 'channel.notice',
              notice: {
                message: `@${agent.name} was mentioned and notified.`,
                createdAt: new Date(now).toISOString(),
              },
            });
            conversationManager.submitPrompt(
              conv.id,
              buildChannelActivationPrompt({
                channelName: channel.name,
                target: historyTarget,
                senderName,
                content,
                reason: 'mention',
              }),
              { recordAsUserMessage: false },
            ).catch(() => {});
          }
        }
      })();

      reply.code(201);
      return { messageId, seq };
    },
  );

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

  // Channel-level WebSocket subscriber registry
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connectionsByChannel = new Map<string, Set<any>>();

  function broadcastToChannel(
    channelId: string,
    event: import('@agent-collab/protocol').ServerEvent,
  ): void {
    const sockets = connectionsByChannel.get(channelId);
    if (!sockets) return;
    const data = JSON.stringify(event);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

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

  registerInternalAgentRoutes(app, db, conversationManager, broadcastToAgent, broadcastToChannel, config.humanUserName);

  // ─── User-facing Task routes ───

  // GET /api/channels/:id/tasks
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/api/channels/:id/tasks',
    async (req, reply) => {
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const rows = req.query.status && req.query.status !== 'all'
        ? db.prepare(
            `SELECT task_id as taskId, channel_id as channelId, task_number as taskNumber,
                    title, description, status,
                    claimed_by_agent_id as assigneeId, claimed_by_name as assigneeName,
                    created_at as createdAt, updated_at as updatedAt
             FROM tasks WHERE channel_id = ? AND status = ? ORDER BY task_number ASC`,
          ).all(req.params.id, req.query.status)
        : db.prepare(
            `SELECT task_id as taskId, channel_id as channelId, task_number as taskNumber,
                    title, description, status,
                    claimed_by_agent_id as assigneeId, claimed_by_name as assigneeName,
                    created_at as createdAt, updated_at as updatedAt
             FROM tasks WHERE channel_id = ? ORDER BY task_number ASC`,
          ).all(req.params.id);
      return { tasks: rows };
    },
  );

  // POST /api/channels/:id/tasks
  app.post<{ Params: { id: string }; Body: { title: string; description?: string } }>(
    '/api/channels/:id/tasks',
    async (req, reply) => {
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const { title, description } = req.body ?? {};
      if (!title) { reply.code(400); return { error: 'title is required' }; }
      const now = Date.now();
      const taskId = randomUUID();
      const seqRow = db.prepare('SELECT MAX(task_number) as maxNum FROM tasks WHERE channel_id = ?').get(req.params.id) as { maxNum: number | null };
      const taskNumber = (seqRow.maxNum ?? 0) + 1;
      db.prepare(
        `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, 'todo', ?, ?)`,
      ).run(taskId, req.params.id, taskNumber, title, description ?? null, now, now);
      reply.code(201);
      return { taskId, channelId: req.params.id, taskNumber, title, description, status: 'todo', assigneeId: null, assigneeName: null, createdAt: now, updatedAt: now };
    },
  );

  // PATCH /api/channels/:id/tasks/:num/status
  app.patch<{ Params: { id: string; num: string }; Body: { status: string } }>(
    '/api/channels/:id/tasks/:num/status',
    async (req, reply) => {
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const taskNumber = Number(req.params.num);
      const { status } = req.body ?? {};
      const validStatuses = ['todo', 'in_progress', 'in_review', 'done'];
      if (!validStatuses.includes(status)) { reply.code(400); return { error: `Invalid status: ${status}` }; }
      const now = Date.now();
      const result = db.prepare(
        `UPDATE tasks SET status = ?, updated_at = ? WHERE channel_id = ? AND task_number = ?`,
      ).run(status, now, req.params.id, taskNumber);
      if (result.changes === 0) { reply.code(404); return { error: 'Task not found' }; }
      const row = db.prepare(
        `SELECT task_id as taskId, channel_id as channelId, task_number as taskNumber,
                title, description, status, claimed_by_agent_id as assigneeId,
                claimed_by_name as assigneeName, created_at as createdAt, updated_at as updatedAt
         FROM tasks WHERE channel_id = ? AND task_number = ?`,
      ).get(req.params.id, taskNumber);
      return row;
    },
  );

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

  // Channel WebSocket stream (real-time channel messages)
  app.get<{ Params: { id: string } }>(
    '/api/channels/:id/stream',
    { websocket: true },
    (socket, req) => {
      const channelId = req.params.id;
      if (!conversationManager.getChannel(channelId)) {
        socket.send(JSON.stringify({ type: 'error', message: 'Channel not found' }));
        socket.close();
        return;
      }
      if (!connectionsByChannel.has(channelId)) connectionsByChannel.set(channelId, new Set());
      connectionsByChannel.get(channelId)!.add(socket);
      socket.on('close', () => {
        const s = connectionsByChannel.get(channelId);
        if (s) { s.delete(socket); if (s.size === 0) connectionsByChannel.delete(channelId); }
      });
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
