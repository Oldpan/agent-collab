import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';

import type { Db } from '../db/db.js';
import type { ConversationManager } from './conversationManager.js';
import type { CreateConversationRequest } from '@agent-collab/wire-types';
import { log } from '../logging.js';
import { handleWebSocket } from './wsHandler.js';

export async function startServer(params: {
  port: number;
  host: string;
  conversationManager: ConversationManager;
  db: Db;
}): Promise<void> {
  const { port, host, conversationManager, db } = params;

  const app = Fastify({ logger: false });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebSocket);

  // ─── REST routes ───

  // List conversations
  app.get('/api/conversations', async () => {
    return conversationManager.listConversations();
  });

  // Create conversation
  app.post<{ Body: CreateConversationRequest }>('/api/conversations', async (req, reply) => {
    const body = req.body ?? {};
    const conv = conversationManager.createConversation({
      agentType: body.agentType,
      workspacePath: body.workspacePath,
      title: body.title,
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

  // ─── WebSocket route ───

  app.get<{ Params: { id: string } }>(
    '/api/conversations/:id/stream',
    { websocket: true },
    (socket, req) => {
      const conversationId = req.params.id;
      handleWebSocket(socket, conversationId, conversationManager);
    },
  );

  await app.listen({ port, host });
  log.info(`Web server listening on ${host}:${port}`);
}
