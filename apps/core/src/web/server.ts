import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';

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
import { AgentSkillsBroker } from '../services/agentSkillsBroker.js';
import { AgentSkillsService, AgentSkillsServiceError } from '../services/agentSkillsService.js';
import { CodexTranscriptBroker } from '../services/codexTranscriptBroker.js';
import { CodexTranscriptService } from '../services/codexTranscriptService.js';
import { findMentionedAgents } from './channelMentions.js';
import { buildChannelActivationPrompt, buildChannelActivationContextText } from './channelActivationPrompt.js';
import { appendChannelResetMarkers } from './channelMemoryNotes.js';
import { buildTargetActivationContext } from './activationContext.js';
import { bumpAgentMessageCheckpoint } from './messageCheckpoints.js';
import { deleteChannelSubscription, listChannelSubscriptions, upsertChannelSubscription } from './channelSubscriptions.js';
import { listTargetParticipants, setTargetOwner, upsertTargetParticipant } from './targetParticipants.js';
import { bindTaskToThread, getBoundTaskForThread, getThreadCollaborationSummary, unbindTaskFromThread } from './threadTaskBindings.js';
import { allocateNextChannelMessageSeq } from './channelMessageSequences.js';
import { isValidTransition } from './taskStatusTransitions.js';
import type { User } from '../services/auth.js';
import {
  hasAdminUser,
  setupWithInvite,
  loginUser,
  logoutUser,
  validateSession,
  validateInviteToken,
  createInviteToken,
  getUserById,
  listUsers,
  deleteUser,
  cleanupExpiredTokens,
  getUserAgentAccess,
  getUserChannelAccess,
  setUserAccess,
} from '../services/auth.js';

export async function startServer(params: {
  port: number;
  host: string;
  conversationManager: ConversationManager;
  db: Db;
  nodeRegistry?: NodeRegistry;
  workspaceBroker?: AgentWorkspaceBroker;
  skillsBroker?: AgentSkillsBroker;
}): Promise<void> {
  const { port, host, conversationManager, db } = params;
  const config = conversationManager.getConfig();
  // Attachment storage: sibling directory next to the DB file
  const attachmentsDir = path.join(path.dirname(config.dbPath), 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const nodeRegistry = params.nodeRegistry ?? new NodeRegistry();
  const workspaceBroker = params.workspaceBroker ?? new AgentWorkspaceBroker({ nodeRegistry });
  const skillsBroker = params.skillsBroker ?? new AgentSkillsBroker({ nodeRegistry });
  const codexTranscriptBroker = new CodexTranscriptBroker({ nodeRegistry });
  const workspaceService = new AgentWorkspaceService({
    getAgentById: (agentId) => conversationManager.getAgent(agentId),
    broker: workspaceBroker,
  });
  const skillsService = new AgentSkillsService({
    getAgentById: (agentId) => conversationManager.getAgent(agentId),
    broker: skillsBroker,
  });
  const codexTranscriptService = new CodexTranscriptService({
    db,
    broker: codexTranscriptBroker,
    getConversationById: (conversationId) => conversationManager.getConversation(conversationId),
    getAgentById: (agentId) => conversationManager.getAgent(agentId),
    getAcpSessionIdByConversationId: (conversationId) => {
      const row = db.prepare(
        `SELECT s.acp_session_id as acpSessionId
           FROM conversations c
           JOIN sessions s ON s.session_key = c.session_key
          WHERE c.id = ?`,
      ).get(conversationId) as { acpSessionId: string | null } | undefined;
      return row?.acpSessionId ?? null;
    },
  });

  const app = Fastify({ logger: false });

  const broadcastChannelTasksChanged = (channelId: string) => {
    broadcastToChannel(channelId, {
      type: 'channel.tasks.changed',
      channelId,
      changedAt: Date.now(),
    });
  };

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebSocket);
  await app.register(fastifyMultipart, { limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

  const getRequestUser = (req: { headers: Record<string, unknown> }): User | null => {
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const token = authHeader.replace('Bearer ', '');
    return token ? validateSession(db, token) : null;
  };

  const requireUser = (req: { headers: Record<string, unknown> }, reply: { code: (statusCode: number) => unknown }): User | null => {
    const user = getRequestUser(req);
    if (!user) {
      reply.code(401);
      return null;
    }
    return user;
  };

  const requireAdmin = (req: { headers: Record<string, unknown> }, reply: { code: (statusCode: number) => unknown }): User | null => {
    const user = requireUser(req, reply);
    if (!user) return null;
    if (!user.isAdmin) {
      reply.code(403);
      return null;
    }
    return user;
  };

  const hasAgentAccess = (user: User, agentId: string): boolean => {
    if (user.isAdmin) return true;
    return getUserAgentAccess(db, user.id).includes(agentId);
  };

  const hasChannelAccess = (user: User, channelId: string): boolean => {
    if (user.isAdmin) return true;
    return getUserChannelAccess(db, user.id).includes(channelId);
  };

  const requireAgentAccess = (
    req: { headers: Record<string, unknown> },
    reply: { code: (statusCode: number) => unknown },
    agentId: string,
  ): User | null => {
    const user = requireUser(req, reply);
    if (!user) return null;
    if (!hasAgentAccess(user, agentId)) {
      reply.code(403);
      return null;
    }
    return user;
  };

  const requireChannelAccess = (
    req: { headers: Record<string, unknown> },
    reply: { code: (statusCode: number) => unknown },
    channelId: string,
  ): User | null => {
    const user = requireUser(req, reply);
    if (!user) return null;
    if (!hasChannelAccess(user, channelId)) {
      reply.code(403);
      return null;
    }
    return user;
  };

  const canAccessConversation = (user: User, conversationId: string): boolean => {
    if (user.isAdmin) return true;
    const conv = conversationManager.getConversation(conversationId);
    if (!conv) return false;
    if (conv.threadKind === 'direct') return conv.userId === user.id;
    return hasChannelAccess(user, conv.channelId);
  };

  const requireConversationAccess = (
    req: { headers: Record<string, unknown> },
    reply: { code: (statusCode: number) => unknown },
    conversationId: string,
  ): User | null => {
    const user = requireUser(req, reply);
    if (!user) return null;
    if (!canAccessConversation(user, conversationId)) {
      reply.code(403);
      return null;
    }
    return user;
  };

  // ─── REST routes ───

  // List conversations — filtered by the requesting user
  app.get('/api/conversations', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return { error: 'Unauthorized' };
    return conversationManager.listConversations({ userId: user.id, isAdmin: user.isAdmin });
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/restart', async (req, reply) => {
    const user = requireConversationAccess(req, reply, req.params.id);
    if (!user) return { error: 'Access denied' };
    const conversation = conversationManager.getConversation(req.params.id);
    if (!conversation) {
      reply.code(404);
      return { error: 'Not found' };
    }
    if (!conversation.nodeId) {
      reply.code(409);
      return { error: 'Conversation is not assigned to a remote node.' };
    }

    broadcast(conversation.id, { type: 'system.notice', message: 'Agent restarting…' });

    const hostBinding = conversationManager.getConversationHostKey(conversation.id);
    if (hostBinding) {
      nodeRegistry.send(hostBinding.nodeId, { type: 'host.close', hostKey: hostBinding.hostKey });
    }

    const now = Date.now();
    const activeRuns = db.prepare(
      `SELECT run_id as runId
         FROM runs
        WHERE session_key = (SELECT session_key FROM conversations WHERE id = ?)
          AND ended_at IS NULL`,
    ).all(conversation.id) as Array<{ runId: string }>;
    for (const run of activeRuns) {
      finishRun(db, { runId: run.runId, error: 'Restarted by user' });
    }
    db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
      .run('idle', now, conversation.id);
    broadcast(conversation.id, { type: 'conversation.status', conversationId: conversation.id, status: 'idle' });
    broadcast(conversation.id, { type: 'system.notice', message: 'Agent restarted — ready for new messages.' });
    void conversationManager.onConversationSettled(conversation.id);

    return {
      ok: true,
      conversation: conversationManager.getConversation(conversation.id) ?? conversation,
    };
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/clear-chat', async (req, reply) => {
    const user = requireConversationAccess(req, reply, req.params.id);
    if (!user) return { error: 'Access denied' };
    const conversation = conversationManager.getConversation(req.params.id);
    if (!conversation) {
      reply.code(404);
      return { error: 'Not found' };
    }

    const hostBinding = conversationManager.getConversationHostKey(conversation.id);
    if (hostBinding) {
      nodeRegistry.send(hostBinding.nodeId, { type: 'host.close', hostKey: hostBinding.hostKey });
    }

    const clearedConversation = conversationManager.clearConversationChat(conversation.id);
    if (!clearedConversation) {
      reply.code(404);
      return { error: 'Not found' };
    }
    broadcast(clearedConversation.id, { type: 'history.reset' });
    broadcast(clearedConversation.id, {
      type: 'conversation.status',
      conversationId: clearedConversation.id,
      status: 'idle',
    });

    return { ok: true, conversation: clearedConversation };
  });

  // ─── Agent routes ───

  app.get('/api/agents', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return { error: 'Unauthorized' };
    if (user.isAdmin) return conversationManager.listAgents();
    const allowed = getUserAgentAccess(db, user.id);
    return conversationManager.listAgents().filter((a) => allowed.includes(a.agentId));
  });

  app.post<{ Body: CreateAgentRequest }>('/api/agents', async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
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
    if (!requireAgentAccess(req, reply, req.params.id)) return { error: 'Access denied' };
    const agent = conversationManager.getAgent(req.params.id);
    if (!agent) { reply.code(404); return { error: 'Not found' }; }
    return agent;
  });

  app.patch<{ Params: { id: string }; Body: UpdateAgentRequest }>('/api/agents/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
    const updated = conversationManager.updateAgent(req.params.id, req.body ?? {});
    if (!updated) { reply.code(404); return { error: 'Not found' }; }
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/agents/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
    const agent = conversationManager.getAgent(req.params.id);
    if (!agent) { reply.code(404); return { error: 'Not found' }; }
    const result = conversationManager.deleteAgent(req.params.id);
    return { ok: true, deletedConversations: result.deletedConversations };
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id/conversations', async (req, reply) => {
    const user = requireAgentAccess(req, reply, req.params.id);
    if (!user) return { error: 'Access denied' };
    const agent = conversationManager.getAgent(req.params.id);
    if (!agent) { reply.code(404); return { error: 'Not found' }; }
    return conversationManager.listConversations({
      agentId: req.params.id,
      ...(user.isAdmin ? { isAdmin: true } : { userId: user.id }),
    });
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/open-thread', async (req, reply) => {
    const user = requireAgentAccess(req, reply, req.params.id);
    if (!user) return { error: 'Access denied' };
    const thread = conversationManager.openAgentThread(req.params.id, user?.id ?? null);
    if (!thread) {
      reply.code(404);
      return { error: 'Not found' };
    }
    return thread;
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/reset', async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
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
    if (!requireAgentAccess(req, reply, req.params.id)) return { error: 'Access denied' };
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
    if (!requireAgentAccess(req, reply, req.params.id)) return { error: 'Access denied' };
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

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/agents/:id/skills', async (req, reply) => {
    if (!requireAgentAccess(req, reply, req.params.id)) return { error: 'Access denied' };
    try {
      return await skillsService.listSkills(req.params.id, normalizeSkillQueryPath(req.query.path));
    } catch (error) {
      if (error instanceof AgentSkillsServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      reply.code(500);
      return { error: String((error as Error)?.message ?? error) };
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/agents/:id/skills/file', async (req, reply) => {
    if (!requireAgentAccess(req, reply, req.params.id)) return { error: 'Access denied' };
    try {
      return await skillsService.readSkillFile(req.params.id, normalizeRequiredSkillQueryPath(req.query.path));
    } catch (error) {
      if (error instanceof AgentSkillsServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      reply.code(500);
      return { error: String((error as Error)?.message ?? error) };
    }
  });

  // Create conversation
  app.post<{ Body: CreateConversationRequest }>('/api/conversations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
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
    if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
    const conv = conversationManager.getConversation(req.params.id);
    if (!conv) {
      reply.code(404);
      return { error: 'Not found' };
    }
    conversationManager.deleteConversation(req.params.id);
    reply.code(204);
    return;
  });

  app.post<{ Params: { id: string }; Body: { text?: string; clientMessageId?: string } }>(
    '/api/conversations/:id/prompt',
    async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return { error: 'Unauthorized' };

      const conv = conversationManager.getConversation(req.params.id);
      if (!conv) {
        reply.code(404);
        return { error: 'Not found' };
      }
      if (!canAccessConversation(user, req.params.id)) {
        reply.code(403);
        return { error: 'Access denied' };
      }

      const text = req.body?.text?.trim();
      if (!text) {
        reply.code(400);
        return { error: 'Prompt text is required' };
      }

      if (!conv.nodeId) {
        reply.code(409);
        return { error: 'No agent node assigned. Connect an agent-node first.' };
      }

      try {
        const result = await conversationManager.submitPrompt(req.params.id, text, {
          senderName: user.username,
          clientMessageId: typeof req.body?.clientMessageId === 'string' && req.body.clientMessageId.trim()
            ? req.body.clientMessageId.trim()
            : undefined,
        });
        return result;
      } catch (error: any) {
        reply.code(500);
        return { error: String(error?.message ?? error) };
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/conversations/:id/cancel',
    async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return { error: 'Unauthorized' };

      const conv = conversationManager.getConversation(req.params.id);
      if (!conv) {
        reply.code(404);
        return { error: 'Not found' };
      }
      if (!canAccessConversation(user, req.params.id)) {
        reply.code(403);
        return { error: 'Access denied' };
      }

      const result = conversationManager.cancelConversationRun(req.params.id);
      if (!result.ok) {
        reply.code(409);
        return { error: result.message };
      }
      return { ok: true, ...(result.runId ? { runId: result.runId } : {}) };
    },
  );

  // Get conversation history (stored events from DB)
  app.get<{ Params: { id: string } }>('/api/conversations/:id/history', async (req, reply) => {
    const conv = conversationManager.getConversation(req.params.id);
    if (!conv) {
      reply.code(404);
      return { error: 'Not found' };
    }
    if (!requireConversationAccess(req, reply, req.params.id)) return { error: 'Access denied' };

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

  app.get<{ Params: { id: string } }>('/api/conversations/:id/codex-debug', async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
    const conv = conversationManager.getConversation(req.params.id);
    if (!conv) {
      reply.code(404);
      return { error: 'Not found' };
    }

    try {
      return await codexTranscriptService.getConversationDebug(req.params.id);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (message === 'Conversation not found.') {
        reply.code(404);
      } else if (
        message === 'Codex debug is only supported for codex_acp conversations.'
        || message === 'Conversation is not assigned to a remote node.'
        || message === 'Conversation has no workspace path.'
        || message === 'Conversation has no reply target.'
      ) {
        reply.code(409);
      } else {
        reply.code(500);
      }
      return { error: message };
    }
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
      const user = requireConversationAccess(req, reply, req.params.id);
      if (!user) return { error: 'Access denied' };
      if (!conv.agentId) {
        return { messages: [] };
      }

      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const dmChannelId = `dm:${conv.agentId}`;
      const directTarget = (conv.replyTarget ?? '').trim();
      const directTargetPrefix = `${directTarget}:%`;

      const rows = db
        .prepare(
          `SELECT message_id as id, sender_name as senderName, sender_type as senderType,
                  content, created_at as createdAt, seq, message_source as messageSource,
                  attachment_ids as attachmentIds
           FROM channel_messages
           WHERE channel_id = ? AND (target = ? OR target LIKE ?)
           ORDER BY seq DESC LIMIT ?`,
        )
        .all(dmChannelId, directTarget, directTargetPrefix, limit) as Array<{
        id: string;
        senderName: string;
        senderType: string;
        content: string;
        createdAt: number;
        seq: number;
        messageSource: string | null;
        attachmentIds: string | null;
      }>;

      const messages = rows.reverse().map((r) => ({
        id: r.id,
        senderName: r.senderName,
        senderType: r.senderType as 'user' | 'agent',
        content: r.content,
        createdAt: new Date(r.createdAt).toISOString(),
        seq: r.seq,
        ...(r.messageSource ? { messageSource: r.messageSource } : {}),
        ...(r.attachmentIds ? { attachmentIds: JSON.parse(r.attachmentIds) as string[] } : {}),
      }));

      return { messages };
    },
  );

  app.post<{
    Body: {
      agentIds?: string[];
      channelIds?: string[];
      agentDmReadSeqs?: Record<string, number>;
      channelReadSeqs?: Record<string, number>;
    };
  }>('/api/unread-summary', async (req) => {
    const user = getRequestUser(req);
    if (!user) return { agentDms: {}, channels: {} };
    const body = req.body ?? {};
    const requestedAgentIds = Array.isArray(body.agentIds)
      ? body.agentIds.filter((value): value is string => typeof value === 'string')
      : [];
    const requestedChannelIds = Array.isArray(body.channelIds)
      ? body.channelIds.filter((value): value is string => typeof value === 'string')
      : [];
    const allowedAgentIds = user.isAdmin ? requestedAgentIds : requestedAgentIds.filter((id) => hasAgentAccess(user, id));
    const allowedChannelIds = user.isAdmin ? requestedChannelIds : requestedChannelIds.filter((id) => hasChannelAccess(user, id));
    const agentDmReadSeqs = body.agentDmReadSeqs && typeof body.agentDmReadSeqs === 'object'
      ? body.agentDmReadSeqs
      : {};
    const channelReadSeqs = body.channelReadSeqs && typeof body.channelReadSeqs === 'object'
      ? body.channelReadSeqs
      : {};

    const summarizeChannel = (channelId: string, lastReadSeq: number) => {
      const row = db
        .prepare(
          `SELECT
             COALESCE(MAX(seq), 0) as latestSeq,
             COALESCE(SUM(CASE WHEN seq > ? AND sender_type != 'user' THEN 1 ELSE 0 END), 0) as unreadCount
           FROM channel_messages
           WHERE channel_id = ?`,
        )
        .get(lastReadSeq, channelId) as { latestSeq: number | null; unreadCount: number | null };
      return {
        unreadCount: Number(row?.unreadCount ?? 0),
        latestSeq: Number(row?.latestSeq ?? 0),
      };
    };

    return {
      agentDms: Object.fromEntries(
        allowedAgentIds.map((agentId) => [
          agentId,
          summarizeChannel(`dm:${agentId}`, Math.max(0, Number(agentDmReadSeqs[agentId] ?? 0))),
        ]),
      ),
      channels: Object.fromEntries(
        allowedChannelIds.map((channelId) => [
          channelId,
          summarizeChannel(channelId, Math.max(0, Number(channelReadSeqs[channelId] ?? 0))),
        ]),
      ),
    };
  });

  // ─── Channel routes ───

  // List all channels (filtered by user access for non-admins)
  app.get('/api/channels', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return { error: 'Unauthorized' };
    if (user.isAdmin) return conversationManager.listChannels();
    const allowed = getUserChannelAccess(db, user.id);
    return conversationManager.listChannels().filter((c) => allowed.includes(c.channelId));
  });

  // Create channel
  app.post<{ Body: CreateChannelRequest }>('/api/channels', async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
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
        collaborationMode: body.collaborationMode,
      });
      for (const agentId of body.agentIds ?? []) {
        if (conversationManager.getAgent(agentId)) {
          conversationManager.joinChannel(agentId, channel.channelId);
        }
      }
      reply.code(201);
      return conversationManager.getChannel(channel.channelId) ?? channel;
    } catch {
      reply.code(409);
      return { error: 'Channel name already exists' };
    }
  });

  // Update channel (e.g. description)
  app.patch<{ Params: { id: string }; Body: UpdateChannelRequest }>(
    '/api/channels/:id',
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
      const updated = conversationManager.updateChannel(req.params.id, req.body ?? {});
      if (!updated) { reply.code(404); return { error: 'Not found' }; }
      return updated;
    },
  );

  app.post<{ Params: { id: string; agentId: string } }>(
    '/api/channels/:id/agents/:agentId',
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const agent = conversationManager.getAgent(req.params.agentId);
      if (!agent) { reply.code(404); return { error: 'Agent not found' }; }
      conversationManager.joinChannel(req.params.agentId, req.params.id);
      return conversationManager.getChannel(req.params.id);
    },
  );

  app.delete<{ Params: { id: string; agentId: string } }>(
    '/api/channels/:id/agents/:agentId',
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      conversationManager.leaveChannel(req.params.agentId, req.params.id);
      return conversationManager.getChannel(req.params.id);
    },
  );

  app.post<{ Params: { id: string; agentId: string } }>(
    '/api/channels/:id/subscriptions/:agentId',
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const agent = conversationManager.getAgent(req.params.agentId);
      if (!agent) { reply.code(404); return { error: 'Agent not found' }; }
      upsertChannelSubscription(db, {
        channelId: req.params.id,
        agentId: req.params.agentId,
      });
      return conversationManager.getChannel(req.params.id);
    },
  );

  app.delete<{ Params: { id: string; agentId: string } }>(
    '/api/channels/:id/subscriptions/:agentId',
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      deleteChannelSubscription(db, req.params.id, req.params.agentId);
      return conversationManager.getChannel(req.params.id);
    },
  );

  app.post<{
    Params: { id: string; agentId: string };
    Body: { threadRootId?: string | null };
  }>(
    '/api/channels/:id/agents/:agentId/open-session',
    async (req, reply) => {
      const user = requireChannelAccess(req, reply, req.params.id);
      if (!user) return { error: 'Access denied' };
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
      const channelAgentIds = new Set(conversationManager.listAgents(req.params.id).map((item) => item.agentId));
      if (!channelAgentIds.has(req.params.agentId)) {
        reply.code(409);
        return { error: 'Agent is not a member of this channel.' };
      }

      const threadRootId = typeof req.body?.threadRootId === 'string' && req.body.threadRootId.trim().length > 0
        ? req.body.threadRootId.trim()
        : null;
      const conversation = conversationManager.openAgentChannelThread(req.params.agentId, req.params.id, threadRootId);
      if (!conversation) {
        reply.code(404);
        return { error: 'Conversation not found' };
      }
      return conversation;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/channels/:id/clear-chat',
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
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
      } catch (error) {
        reply.code(409);
        return { error: `Failed to mark channel memory: ${String((error as Error)?.message ?? error)}` };
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
    },
  );

  // Join agent to a channel
  app.post<{ Params: { id: string; channelId: string } }>(
    '/api/agents/:id/channels/:channelId',
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
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
      if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
      conversationManager.leaveChannel(req.params.id, req.params.channelId);
      reply.code(204);
    },
  );

  // List conversations in a channel
  app.get<{ Params: { id: string } }>('/api/channels/:id/conversations', async (req, reply) => {
    if (!requireChannelAccess(req, reply, req.params.id)) return { error: 'Access denied' };
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
      if (!requireChannelAccess(req, reply, req.params.id)) return { error: 'Access denied' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const before = req.query.before != null ? Number(req.query.before) : null;
      const rows = (before != null
        ? db.prepare(
            `SELECT cm.message_id as id, cm.sender_name as senderName, cm.sender_type as senderType,
                    cm.content, cm.created_at as createdAt, cm.seq, cm.message_source as messageSource,
                    cm.attachment_ids as attachmentIds,
                    COUNT(replies.message_id) as replyCount,
                    t.task_number as taskNumber, t.status as taskStatus,
                    t.claimed_by_name as taskAssigneeName
             FROM channel_messages cm
             LEFT JOIN channel_messages replies
               ON replies.channel_id = cm.channel_id
               AND replies.thread_root_id = SUBSTR(cm.message_id, 1, 8)
             LEFT JOIN tasks t ON t.message_id = cm.message_id
             WHERE cm.channel_id = ? AND cm.thread_root_id IS NULL AND cm.seq < ?
             GROUP BY cm.message_id
             ORDER BY cm.seq DESC LIMIT ?`,
          ).all(req.params.id, before, limit)
        : db.prepare(
            `SELECT cm.message_id as id, cm.sender_name as senderName, cm.sender_type as senderType,
                    cm.content, cm.created_at as createdAt, cm.seq, cm.message_source as messageSource,
                    cm.attachment_ids as attachmentIds,
                    COUNT(replies.message_id) as replyCount,
                    t.task_number as taskNumber, t.status as taskStatus,
                    t.claimed_by_name as taskAssigneeName
             FROM channel_messages cm
             LEFT JOIN channel_messages replies
               ON replies.channel_id = cm.channel_id
               AND replies.thread_root_id = SUBSTR(cm.message_id, 1, 8)
             LEFT JOIN tasks t ON t.message_id = cm.message_id
             WHERE cm.channel_id = ? AND cm.thread_root_id IS NULL
             GROUP BY cm.message_id
             ORDER BY cm.seq DESC LIMIT ?`,
          ).all(req.params.id, limit)
      ) as Array<{ id: string; senderName: string; senderType: string; content: string; createdAt: number; seq: number; replyCount: number; messageSource: string | null; attachmentIds: string | null; taskNumber: number | null; taskStatus: string | null; taskAssigneeName: string | null }>;
      return {
        messages: rows.reverse().map((r) => ({
          id: r.id,
          senderName: r.senderName,
          senderType: r.senderType as 'user' | 'agent',
          content: r.content,
          createdAt: new Date(r.createdAt).toISOString(),
          seq: r.seq,
          replyCount: r.replyCount,
          ...(r.messageSource ? { messageSource: r.messageSource } : {}),
          ...(r.attachmentIds ? { attachmentIds: JSON.parse(r.attachmentIds) as string[] } : {}),
          ...(r.taskNumber != null ? { taskNumber: r.taskNumber, taskStatus: r.taskStatus, taskAssigneeName: r.taskAssigneeName } : {}),
        })),
      };
    },
  );

  // Get thread messages for a specific root message
  app.get<{ Params: { id: string; shortId: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/channels/:id/threads/:shortId/messages',
    async (req, reply) => {
      if (!requireChannelAccess(req, reply, req.params.id)) return { error: 'Access denied' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const limit = Math.min(Number(req.query.limit ?? 100), 200);
      const before = req.query.before != null ? Number(req.query.before) : null;
      const rows = (before != null
        ? db.prepare(
            `SELECT message_id as id, sender_name as senderName, sender_type as senderType,
                    content, created_at as createdAt, seq, message_source as messageSource,
                    attachment_ids as attachmentIds
             FROM channel_messages
             WHERE channel_id = ? AND thread_root_id = ? AND seq < ?
             ORDER BY seq DESC LIMIT ?`,
          ).all(req.params.id, req.params.shortId, before, limit)
        : db.prepare(
            `SELECT message_id as id, sender_name as senderName, sender_type as senderType,
                    content, created_at as createdAt, seq, message_source as messageSource,
                    attachment_ids as attachmentIds
             FROM channel_messages
             WHERE channel_id = ? AND thread_root_id = ?
             ORDER BY seq ASC LIMIT ?`,
          ).all(req.params.id, req.params.shortId, limit)
      ) as Array<{ id: string; senderName: string; senderType: string; content: string; createdAt: number; seq: number; messageSource: string | null; attachmentIds: string | null }>;
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
          ...(r.messageSource ? { messageSource: r.messageSource } : {}),
          ...(r.attachmentIds ? { attachmentIds: JSON.parse(r.attachmentIds) as string[] } : {}),
        })),
      };
    },
  );

  app.get<{ Params: { id: string; shortId: string } }>(
    '/api/channels/:id/threads/:shortId/summary',
    async (req, reply) => {
      if (!requireChannelAccess(req, reply, req.params.id)) return { error: 'Access denied' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      return getThreadCollaborationSummary(db, {
        channelId: req.params.id,
        threadRootId: req.params.shortId,
      });
    },
  );

  app.post<{ Params: { id: string; shortId: string }; Body: { taskNumber?: number } }>(
    '/api/channels/:id/threads/:shortId/task',
    async (req, reply) => {
      if (!requireChannelAccess(req, reply, req.params.id)) return { error: 'Access denied' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const taskNumber = req.body?.taskNumber;
      if (taskNumber == null) { reply.code(400); return { error: 'taskNumber is required' }; }

      const task = db.prepare(
        `SELECT task_id as taskId, claimed_by_agent_id as assigneeId
         FROM tasks
         WHERE channel_id = ? AND task_number = ?`,
      ).get(req.params.id, taskNumber) as { taskId: string; assigneeId: string | null } | undefined;
      if (!task) { reply.code(404); return { error: 'Task not found' }; }

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
      } else {
        setTargetOwner(db, {
          channelId: req.params.id,
          threadRootId: req.params.shortId,
          agentId: null,
        });
      }

      broadcastChannelTasksChanged(req.params.id);

      return getThreadCollaborationSummary(db, {
        channelId: req.params.id,
        threadRootId: req.params.shortId,
      });
    },
  );

  app.delete<{ Params: { id: string; shortId: string } }>(
    '/api/channels/:id/threads/:shortId/task',
    async (req, reply) => {
      if (!requireChannelAccess(req, reply, req.params.id)) return { error: 'Access denied' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const boundTask = getBoundTaskForThread(db, {
        channelId: req.params.id,
        threadRootId: req.params.shortId,
      });
      if (!boundTask) { reply.code(404); return { error: 'Thread is not bound to a task' }; }

      unbindTaskFromThread(db, {
        channelId: req.params.id,
        threadRootId: req.params.shortId,
      });
      setTargetOwner(db, {
        channelId: req.params.id,
        threadRootId: req.params.shortId,
        agentId: null,
      });
      broadcastChannelTasksChanged(req.params.id);

      return getThreadCollaborationSummary(db, {
        channelId: req.params.id,
        threadRootId: req.params.shortId,
      });
    },
  );

  // ─── User-facing attachment upload ──────────────────────────────────────────

  /** POST /api/attachments/upload — upload a file as the current user */
  app.post('/api/attachments/upload', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const data = await req.file();
    if (!data) { reply.code(400); return { error: 'No file uploaded' }; }

    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMimes.includes(data.mimetype)) {
      reply.code(400);
      return { error: `Unsupported file type. Allowed: JPEG, PNG, GIF, WebP` };
    }
    const buffer = await data.toBuffer();
    if (buffer.length > 5 * 1024 * 1024) { reply.code(400); return { error: 'File too large (max 5MB)' }; }

    const id = randomUUID();
    const ext = path.extname(data.filename) || '.bin';
    const storagePath = path.join(attachmentsDir, `${id}${ext}`);
    fs.writeFileSync(storagePath, buffer);

    db.prepare(
      `INSERT INTO attachments(id, filename, mime_type, size_bytes, storage_path, channel_id, agent_id, created_at)
       VALUES(?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).run(id, data.filename, data.mimetype, buffer.length, storagePath, Date.now());

    return { id, filename: data.filename, sizeBytes: buffer.length };
  });

  // Post a user message to a channel (or thread when replyTo is set)
  app.post<{ Params: { id: string }; Body: { content: string; senderName?: string; replyTo?: string; attachmentIds?: string[] } }>(
    '/api/channels/:id/messages',
    async (req, reply) => {
      const chanUser = requireChannelAccess(req, reply, req.params.id);
      if (!chanUser) return { error: 'Access denied' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const { content, replyTo, attachmentIds } = req.body ?? {};
      const senderName = chanUser.username;
      if (!content) { reply.code(400); return { error: 'content is required' }; }
      const threadRootId = replyTo ?? null;
      const now = Date.now();
      const messageId = randomUUID();
      const seq = allocateNextChannelMessageSeq(db, req.params.id);
      const target = threadRootId ? `#${channel.name}:${threadRootId}` : `#${channel.name}`;
      const attachmentIdsJson = Array.isArray(attachmentIds) && attachmentIds.length > 0
        ? JSON.stringify(attachmentIds) : null;
      db.prepare(
        `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id, attachment_ids)
         VALUES(?, ?, 'user', ?, 'user', ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(messageId, req.params.id, senderName, target, content, seq, now, threadRootId, attachmentIdsJson);
      const event: import('@agent-collab/protocol').ServerEvent = {
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
      const notifiedAgentIds = new Set<string>();
      const historyTarget = threadRootId ? `#${channel.name}:${threadRootId}` : `#${channel.name}`;

      const notifyAgent = (
        agentId: string,
        reason: 'mention' | 'thread_reply' | 'channel_activity',
        role: 'owner' | 'participant',
      ): void => {
        if (notifiedAgentIds.has(agentId)) return;
        const agent = conversationManager.getAgent(agentId);
        if (!agent) return;
        const conv = conversationManager.openAgentChannelThread(agentId, req.params.id, threadRootId ?? null);
        if (!conv) return;

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
        conversationManager.submitPrompt(
          conv.id,
          buildChannelActivationPrompt({
            channelName: channel.name,
            target: historyTarget,
            replyTarget: activationContext.replyTarget,
            senderName,
            content,
            reason,
          }),
          {
            recordAsUserMessage: false,
            activationContextText: buildChannelActivationContextText({
              target: historyTarget,
              recentMessages: activationContext.recentMessages,
              rootMessage: activationContext.rootMessage,
              unreadCount: activationContext.unreadCount,
              oldestVisibleSeq: activationContext.oldestVisibleSeq,
              participants: activationContext.participants,
              boundTask: activationContext.boundTask,
              openTasks: activationContext.openTasks,
            }) || undefined,
          },
        ).then(() => {
          bumpAgentMessageCheckpoint(db, agentId, req.params.id, seq, threadRootId ?? null);
        }).catch(() => {});
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

        const rootMsg = db.prepare(
          `SELECT sender_id as senderId, sender_type as senderType
           FROM channel_messages
           WHERE channel_id = ? AND substr(message_id, 1, 8) = ?
           LIMIT 1`,
        ).get(req.params.id, threadRootId) as { senderId: string; senderType: string } | undefined;

        if (summary.ownerAgentId) {
          notifyAgent(summary.ownerAgentId, 'thread_reply', 'owner');
        }

        if (participants.length === 0 && !summary.ownerAgentId && rootMsg?.senderType === 'agent') {
          notifyAgent(rootMsg.senderId, 'thread_reply', 'owner');
        } else {
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
              role: 'participant' as const,
            }));

        for (const agent of agentsToWake) {
          notifyAgent(agent.agentId, 'channel_activity', agent.role);
        }
      }

      reply.code(201);
      return { messageId, seq };
    },
  );

  // ─── Machine routes ───

  app.get('/api/machines', async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
    return conversationManager.listMachines();
  });

  app.post<{ Body: CreateMachineRequest }>('/api/machines', async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
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
    if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
    const machine = conversationManager.getMachine(req.params.id);
    if (!machine) { reply.code(404); return { error: 'Not found' }; }
    return machine;
  });

  app.delete<{ Params: { id: string } }>('/api/machines/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
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

  registerInternalAgentRoutes(
    app,
    db,
    conversationManager,
    broadcastToAgent,
    broadcastToChannel,
    config.humanUserName,
    skillsService,
    config.internalAgentAuthToken,
    attachmentsDir,
  );

  // ─── Attachment download ─────────────────────────────────────────────────────

  type AttachmentRow = { id: string; filename: string; mime_type: string; size_bytes: number; storage_path: string };

  /** GET /api/attachments/:id — download an uploaded attachment (user auth or internal agent token) */
  app.get<{ Params: { id: string } }>('/api/attachments/:id', async (req, reply) => {
    const user = getRequestUser(req);
    if (!user) {
      // Also accept internal agent token so agents can use view_file
      const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      if (!config.internalAgentAuthToken || token !== config.internalAgentAuthToken) {
        reply.code(401);
        return { error: 'Unauthorized' };
      }
    }
    const { id } = req.params;
    const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
    if (!row) { reply.code(404); return { error: 'Not found' }; }
    if (!fs.existsSync(row.storage_path)) { reply.code(404); return { error: 'File not found on disk' }; }
    reply.type(row.mime_type);
    return reply.send(fs.readFileSync(row.storage_path));
  });

  // ─── User-facing Task routes ───

  // GET /api/channels/:id/tasks
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/api/channels/:id/tasks',
    async (req, reply) => {
      if (!requireChannelAccess(req, reply, req.params.id)) return { error: 'Access denied' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const rows = req.query.status && req.query.status !== 'all'
        ? db.prepare(
            `SELECT t.task_id as taskId, t.channel_id as channelId, t.task_number as taskNumber,
                    t.title, t.description, t.status,
                    t.claimed_by_agent_id as assigneeId, t.claimed_by_name as assigneeName,
                    t.created_at as createdAt, t.updated_at as updatedAt,
                    t.message_id as messageId,
                    COALESCE(SUBSTR(t.message_id, 1, 8), b.thread_root_id) as linkedThreadId,
                    COALESCE(SUBSTR(t.message_id, 1, 8), b.thread_root_id) as linkedThreadShortId
             FROM tasks t
             LEFT JOIN thread_task_bindings b ON b.task_id = t.task_id
             WHERE t.channel_id = ? AND t.status = ? ORDER BY t.task_number ASC`,
          ).all(req.params.id, req.query.status)
        : db.prepare(
            `SELECT t.task_id as taskId, t.channel_id as channelId, t.task_number as taskNumber,
                    t.title, t.description, t.status,
                    t.claimed_by_agent_id as assigneeId, t.claimed_by_name as assigneeName,
                    t.created_at as createdAt, t.updated_at as updatedAt,
                    t.message_id as messageId,
                    COALESCE(SUBSTR(t.message_id, 1, 8), b.thread_root_id) as linkedThreadId,
                    COALESCE(SUBSTR(t.message_id, 1, 8), b.thread_root_id) as linkedThreadShortId
             FROM tasks t
             LEFT JOIN thread_task_bindings b ON b.task_id = t.task_id
             WHERE t.channel_id = ? ORDER BY t.task_number ASC`,
          ).all(req.params.id);
      return { tasks: rows };
    },
  );

  // POST /api/channels/:id/tasks
  app.post<{ Params: { id: string }; Body: { title: string; description?: string } }>(
    '/api/channels/:id/tasks',
    async (req, reply) => {
      if (!requireChannelAccess(req, reply, req.params.id)) return { error: 'Access denied' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const { title, description } = req.body ?? {};
      if (!title) { reply.code(400); return { error: 'title is required' }; }
      const now = Date.now();
      const taskId = randomUUID();
      const messageId = randomUUID();
      const seqRow = db.prepare('SELECT MAX(task_number) as maxNum FROM tasks WHERE channel_id = ?').get(req.params.id) as { maxNum: number | null };
      const taskNumber = (seqRow.maxNum ?? 0) + 1;
      const seq = allocateNextChannelMessageSeq(db, req.params.id);
      const target = `#${channel.name}`;

      // Insert the task message (becomes the thread root)
      db.prepare(
        `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id, message_kind)
         VALUES(?, ?, 'system', 'system', 'system', ?, ?, ?, ?, NULL, NULL, 'task')`,
      ).run(messageId, req.params.id, target, title, seq, now);

      // Insert the task, linking it to the message
      db.prepare(
        `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, message_id, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
      ).run(taskId, req.params.id, taskNumber, title, description ?? null, messageId, now, now);

      const shortId = messageId.slice(0, 8);
      // Broadcast the task message to channel subscribers
      broadcastToChannel(req.params.id, {
        type: 'channel.message',
        message: {
          id: messageId, senderName: 'system', senderType: 'agent', content: title,
          createdAt: new Date(now).toISOString(), seq,
          taskNumber, taskStatus: 'todo', taskAssigneeName: null,
        },
      });

      reply.code(201);
      broadcastChannelTasksChanged(req.params.id);
      return { taskId, channelId: req.params.id, taskNumber, title, description, status: 'todo', assigneeId: null, assigneeName: null, messageId, linkedThreadId: shortId, linkedThreadShortId: shortId, createdAt: now, updatedAt: now };
    },
  );

  // POST /api/channels/:id/tasks/claim-message — promote a message to a task
  app.post<{ Params: { id: string }; Body: { messageId: string; title?: string } }>(
    '/api/channels/:id/tasks/claim-message',
    async (req, reply) => {
      if (!requireChannelAccess(req, reply, req.params.id)) return { error: 'Access denied' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const { messageId, title } = req.body ?? {};
      if (!messageId) { reply.code(400); return { error: 'messageId is required' }; }
      // Check message exists and belongs to this channel
      const msg = db.prepare(
        `SELECT message_id, content, thread_root_id FROM channel_messages WHERE message_id LIKE ? AND channel_id = ?`,
      ).get(`${messageId}%`, req.params.id) as { message_id: string; content: string; thread_root_id: string | null } | undefined;
      if (!msg) { reply.code(404); return { error: 'Message not found' }; }
      if (msg.thread_root_id) { reply.code(400); return { error: 'Cannot promote a thread reply to task' }; }
      // Check not already a task
      const existing = db.prepare(`SELECT task_id FROM tasks WHERE message_id = ?`).get(msg.message_id) as { task_id: string } | undefined;
      if (existing) { reply.code(409); return { error: 'Message is already a task' }; }
      const now = Date.now();
      const taskId = randomUUID();
      const seqRow = db.prepare('SELECT MAX(task_number) as maxNum FROM tasks WHERE channel_id = ?').get(req.params.id) as { maxNum: number | null };
      const taskNumber = (seqRow.maxNum ?? 0) + 1;
      const taskTitle = title?.trim() || msg.content.slice(0, 120);
      db.prepare(
        `INSERT INTO tasks(task_id, channel_id, task_number, title, status, message_id, created_at, updated_at)
         VALUES(?, ?, ?, ?, 'todo', ?, ?, ?)`,
      ).run(taskId, req.params.id, taskNumber, taskTitle, msg.message_id, now, now);
      // Update the message kind to 'task'
      db.prepare(`UPDATE channel_messages SET message_kind = 'task' WHERE message_id = ?`).run(msg.message_id);
      const shortId = msg.message_id.slice(0, 8);
      broadcastChannelTasksChanged(req.params.id);
      reply.code(201);
      return { taskId, channelId: req.params.id, taskNumber, title: taskTitle, status: 'todo', messageId: msg.message_id, linkedThreadId: shortId, linkedThreadShortId: shortId, assigneeId: null, assigneeName: null, createdAt: now, updatedAt: now };
    },
  );

  // PATCH /api/channels/:id/tasks/:num/status
  app.patch<{ Params: { id: string; num: string }; Body: { status: string } }>(
    '/api/channels/:id/tasks/:num/status',
    async (req, reply) => {
      if (!requireChannelAccess(req, reply, req.params.id)) return { error: 'Access denied' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const taskNumber = Number(req.params.num);
      const { status } = req.body ?? {};
      const validStatuses = ['todo', 'in_progress', 'in_review', 'done'];
      if (!validStatuses.includes(status)) { reply.code(400); return { error: `Invalid status: ${status}` }; }
      const nextStatus = status as 'todo' | 'in_progress' | 'in_review' | 'done';
      const current = db.prepare(
        `SELECT task_id as taskId, status as currentStatus
         FROM tasks WHERE channel_id = ? AND task_number = ?`,
      ).get(req.params.id, taskNumber) as { taskId: string; currentStatus: 'todo' | 'in_progress' | 'in_review' | 'done' } | undefined;
      if (!current) { reply.code(404); return { error: 'Task not found' }; }
      if (!isValidTransition(current.currentStatus, nextStatus)) {
        reply.code(400);
        return { error: `Invalid transition: ${current.currentStatus} → ${nextStatus}` };
      }
      const now = Date.now();
      db.prepare(
        `UPDATE tasks SET status = ?, updated_at = ? WHERE channel_id = ? AND task_number = ?`,
      ).run(nextStatus, now, req.params.id, taskNumber);
      const row = db.prepare(
        `SELECT task_id as taskId, channel_id as channelId, task_number as taskNumber,
                title, description, status, claimed_by_agent_id as assigneeId,
                claimed_by_name as assigneeName, message_id as messageId,
                SUBSTR(message_id, 1, 8) as linkedThreadShortId,
                SUBSTR(message_id, 1, 8) as linkedThreadId,
                created_at as createdAt, updated_at as updatedAt
         FROM tasks WHERE channel_id = ? AND task_number = ?`,
      ).get(req.params.id, taskNumber);
      broadcastChannelTasksChanged(req.params.id);
      return row;
    },
  );

  // DELETE /api/channels/:id/tasks/:num
  app.delete<{ Params: { id: string; num: string } }>(
    '/api/channels/:id/tasks/:num',
    async (req, reply) => {
      if (!requireChannelAccess(req, reply, req.params.id)) return { error: 'Access denied' };
      const channel = conversationManager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const taskNumber = Number(req.params.num);
      if (!Number.isFinite(taskNumber)) {
        reply.code(400);
        return { error: 'Invalid task number' };
      }

      const task = db.prepare(
        `SELECT task_id as taskId, message_id as messageId
         FROM tasks
         WHERE channel_id = ? AND task_number = ?`,
      ).get(req.params.id, taskNumber) as { taskId: string; messageId: string | null } | undefined;
      if (!task) {
        reply.code(404);
        return { error: 'Task not found' };
      }

      const threadRootId = task.messageId ? task.messageId.slice(0, 8) : null;

      db.transaction(() => {
        db.prepare(`DELETE FROM thread_task_bindings WHERE task_id = ?`).run(task.taskId);
        db.prepare(`DELETE FROM tasks WHERE task_id = ?`).run(task.taskId);
        if (task.messageId) {
          db.prepare(`UPDATE channel_messages SET message_kind = NULL WHERE message_id = ?`).run(task.messageId);
        }
        if (threadRootId) {
          db.prepare(
            `DELETE FROM target_participants
             WHERE channel_id = ? AND thread_root_id = ?`,
          ).run(req.params.id, threadRootId);
          db.prepare(
            `DELETE FROM agent_message_checkpoints
             WHERE channel_id = ? AND thread_root_id = ?`,
          ).run(req.params.id, threadRootId);
        }
      })();

      broadcastChannelTasksChanged(req.params.id);
      broadcastToChannel(req.params.id, { type: 'channel.history.reset' });
      return { ok: true, taskNumber };
    },
  );

  // ─── Node REST routes ───

  // List connected agent nodes (in-memory only, for backward compat)
  app.get('/api/nodes', async (req, reply) => {
    if (!requireAdmin(req, reply)) return { error: 'Admin access required' };
    return nodeRegistry.listNodes();
  });

  // ─── WebSocket routes ───

  // Frontend WebSocket stream for a conversation
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/api/conversations/:id/stream',
    { websocket: true },
    (socket, req) => {
      const conversationId = req.params.id;
      // Resolve sender name from auth token (falls back to config default)
      const wsToken = (req.query as Record<string, string>)['token'] ?? '';
      const wsUser = wsToken ? validateSession(db, wsToken) : null;
      if (!wsUser) {
        socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        socket.close();
        return;
      }
      // Check user owns this conversation (or it's shared channel thread, or user is admin)
      const conv = conversationManager.getConversation(conversationId);
      if (!conv) {
        socket.send(JSON.stringify({ type: 'error', message: 'Conversation not found' }));
        socket.close();
        return;
      }
      if (!canAccessConversation(wsUser, conversationId)) {
        socket.send(JSON.stringify({ type: 'error', message: 'Access denied' }));
        socket.close();
        return;
      }
      const senderName = wsUser?.username ?? config.humanUserName;
      handleWebSocket(socket, conversationId, conversationManager, senderName);
    },
  );

  // Channel WebSocket stream (real-time channel messages)
  app.get<{ Params: { id: string } }>(
    '/api/channels/:id/stream',
    { websocket: true },
    (socket, req) => {
      const channelId = req.params.id;
      const wsToken = (req.query as Record<string, string>)['token'] ?? '';
      const wsUser = wsToken ? validateSession(db, wsToken) : null;
      if (!wsUser) {
        socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        socket.close();
        return;
      }
      if (!conversationManager.getChannel(channelId)) {
        socket.send(JSON.stringify({ type: 'error', message: 'Channel not found' }));
        socket.close();
        return;
      }
      if (!hasChannelAccess(wsUser, channelId)) {
        socket.send(JSON.stringify({ type: 'error', message: 'Access denied' }));
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
      handleNodeWebSocket(
        socket,
        nodeRegistry,
        broadcast,
        db,
        conversationManager,
        workspaceBroker,
        skillsBroker,
        codexTranscriptBroker,
      );
    },
  );

  // ─── Authentication routes ───

  // Check if setup is complete (has admin user)
  app.get('/api/auth/check-setup', async () => {
    return { hasAdmin: hasAdminUser(db) };
  });

  // Check invite token validity (public, no auth needed) — always 200 to avoid proxy interference
  app.get<{ Params: { token: string } }>('/api/auth/invite/:token', async (req, reply) => {
    const { token } = req.params;
    const result = validateInviteToken(db, token);
    reply.code(200);
    return result.valid ? { valid: true } : { valid: false, error: result.error };
  });

  // Initial setup with invite token
  app.post<{ Body: { token: string; username: string; password: string } }>(
    '/api/auth/setup',
    async (req, reply) => {
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
    },
  );

  // Login
  app.post<{ Body: { username: string; password: string } }>(
    '/api/auth/login',
    async (req, reply) => {
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
    },
  );

  // Logout
  app.post<{ Headers: { authorization?: string } }>(
    '/api/auth/logout',
    async (req, reply) => {
      const authHeader = req.headers.authorization ?? '';
      const token = authHeader.replace(/^Bearer\s+/i, '');

      if (token) {
        logoutUser(db, token);
      }

      return { ok: true };
    },
  );

  // Get current user
  app.get<{ Headers: { authorization?: string } }>(
    '/api/auth/me',
    async (req, reply) => {
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
    },
  );

  // Admin: Create invite token
  app.post<{ Headers: { authorization?: string } }>(
    '/api/admin/invite',
    async (req, reply) => {
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
    },
  );

  // List all users (any authenticated user)
  app.get<{ Headers: { authorization?: string } }>(
    '/api/users',
    async (req, reply) => {
      const authHeader = req.headers.authorization ?? '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      if (!token) { reply.code(401); return { error: 'Not authenticated' }; }
      const user = validateSession(db, token);
      if (!user) { reply.code(401); return { error: 'Invalid or expired session' }; }
      return { users: listUsers(db) };
    },
  );

  // Admin: List all users
  app.get<{ Headers: { authorization?: string } }>(
    '/api/admin/users',
    async (req, reply) => {
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
    },
  );

  // Admin: Delete user
  app.delete<{ Params: { id: string }; Headers: { authorization?: string } }>(
    '/api/admin/users/:id',
    async (req, reply) => {
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
    },
  );

  // Admin: Get user access (which agents/channels are granted)
  app.get<{ Params: { id: string }; Headers: { authorization?: string } }>(
    '/api/admin/users/:id/access',
    async (req, reply) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!token) { reply.code(401); return { error: 'Not authenticated' }; }
      const user = validateSession(db, token);
      if (!user) { reply.code(401); return { error: 'Invalid or expired session' }; }
      if (!user.isAdmin) { reply.code(403); return { error: 'Admin access required' }; }
      return {
        agentIds: getUserAgentAccess(db, req.params.id),
        channelIds: getUserChannelAccess(db, req.params.id),
      };
    },
  );

  // Admin: Set user access (replace all grants atomically)
  app.put<{
    Params: { id: string };
    Body: { agentIds: string[]; channelIds: string[] };
    Headers: { authorization?: string };
  }>(
    '/api/admin/users/:id/access',
    async (req, reply) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!token) { reply.code(401); return { error: 'Not authenticated' }; }
      const user = validateSession(db, token);
      if (!user) { reply.code(401); return { error: 'Invalid or expired session' }; }
      if (!user.isAdmin) { reply.code(403); return { error: 'Admin access required' }; }
      const { agentIds = [], channelIds = [] } = req.body ?? {};
      setUserAccess(db, req.params.id, agentIds, channelIds);
      return { ok: true };
    },
  );

  // Change password (authenticated user)
  app.post<{ Body: { currentPassword: string; newPassword: string }; Headers: { authorization?: string } }>(
    '/api/auth/change-password',
    async (req, reply) => {
      const authHeader = req.headers.authorization ?? '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      if (!token) { reply.code(401); return { error: 'Not authenticated' }; }

      const user = validateSession(db, token);
      if (!user) { reply.code(401); return { error: 'Invalid or expired session' }; }

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
      const userRow = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string } | undefined;
      if (!userRow) { reply.code(404); return { error: 'User not found' }; }

      const { verifyPassword, hashPassword } = await import('../services/auth.js');
      const valid = await verifyPassword(currentPassword, userRow.password_hash);
      if (!valid) { reply.code(400); return { error: 'Current password is incorrect' }; }

      const newHash = await hashPassword(newPassword);
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, Date.now(), user.id);

      return { ok: true };
    },
  );

  // Cleanup expired tokens periodically
  setInterval(() => {
    cleanupExpiredTokens(db);
  }, 60 * 60 * 1000); // Every hour

  // Serve built web UI static files if dist exists
  const __serverDir = path.dirname(fileURLToPath(import.meta.url));
  const webDistPath = path.resolve(__serverDir, '../../../..', 'apps/web/dist');
  if (fs.existsSync(webDistPath)) {
    await app.register(fastifyStatic, { root: webDistPath, prefix: '/' });
    // SPA fallback: serve index.html for GET requests to non-API routes
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && req.url !== '/ws' && !req.url.startsWith('/node-ws')) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'Not found' });
    });
  }

  await app.listen({ port, host });
  log.info(`Web server listening on ${host}:${port}`);
}

function normalizeWorkspaceQueryPath(rawPath?: string): string {
  if (!rawPath) return '';
  return rawPath.replace(/^\/+/, '');
}

function normalizeSkillQueryPath(rawPath?: string): string | null {
  const trimmed = (rawPath ?? '').trim();
  return trimmed || null;
}

function normalizeRequiredSkillQueryPath(rawPath?: string): string {
  const trimmed = (rawPath ?? '').trim();
  if (!trimmed) throw new AgentSkillsServiceError(400, 'path query parameter is required.');
  return trimmed;
}
