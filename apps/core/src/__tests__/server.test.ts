import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, createTestConfig } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { startServer } from '../web/server.js';
import type { Db } from '@agent-collab/runtime-acp';
import { createRun } from '@agent-collab/runtime-acp';
import WebSocket from 'ws';
import { findMentionedAgents } from '../web/channelMentions.js';
import { buildChannelActivationPrompt } from '../web/channelActivationPrompt.js';
import { bumpAgentMessageCheckpoint } from '../web/messageCheckpoints.js';

let db: Db;
let manager: ConversationManager;
let baseUrl: string;
let serverClose: () => Promise<void>;

beforeAll(async () => {
  db = createTestDb();
  const config = createTestConfig();
  manager = new ConversationManager({ db, config });
  manager.start();

  // startServer 返回 void，但我们需要拿到 app 实例来获取端口和关闭
  // 直接构造 server
  const { default: Fastify } = await import('fastify');
  const { default: fastifyCors } = await import('@fastify/cors');
  const { default: fastifyWebSocket } = await import('@fastify/websocket');
  const { handleWebSocket } = await import('../web/wsHandler.js');

  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebSocket);

  // REST routes
  app.get('/api/conversations', async () => manager.listConversations());
  app.get('/api/channels', async () => manager.listChannels());
  app.get<{ Params: { id: string } }>('/api/conversations/:id/history', async (req, reply) => {
    const conv = manager.getConversation(req.params.id);
    if (!conv) {
      reply.code(404);
      return { error: 'Not found' };
    }

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
          if (parsed?.type === 'content.delta' && typeof parsed.text === 'string') assistantText += parsed.text;
          if (parsed?.type === 'thinking.delta' && typeof parsed.text === 'string') thinkingText += parsed.text;
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

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/conversations/:id/channel-messages',
    async (req, reply) => {
      const conv = manager.getConversation(req.params.id);
      if (!conv) {
        reply.code(404);
        return { error: 'Not found' };
      }
      if (!conv.agentId) return { messages: [] };

      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const rows = db.prepare(
        `SELECT message_id as id, sender_name as senderName, sender_type as senderType,
                content, created_at as createdAt, seq
         FROM channel_messages
         WHERE channel_id = ?
         ORDER BY seq DESC LIMIT ?`,
      ).all(`dm:${conv.agentId}`, limit) as Array<{
        id: string;
        senderName: string;
        senderType: string;
        content: string;
        createdAt: number;
        seq: number;
      }>;

      return {
        messages: rows.reverse().map((row) => ({
          id: row.id,
          senderName: row.senderName,
          senderType: row.senderType as 'user' | 'agent',
          content: row.content,
          createdAt: new Date(row.createdAt).toISOString(),
          seq: row.seq,
        })),
      };
    },
  );

  app.post<{ Body: any }>('/api/unread-summary', async (req) => {
    const body = (req.body ?? {}) as {
      agentIds?: unknown;
      channelIds?: unknown;
      agentDmReadSeqs?: unknown;
      channelReadSeqs?: unknown;
    };
    const agentIds = Array.isArray(body.agentIds) ? body.agentIds.filter((value: unknown): value is string => typeof value === 'string') : [];
    const channelIds = Array.isArray(body.channelIds) ? body.channelIds.filter((value: unknown): value is string => typeof value === 'string') : [];
    const agentDmReadSeqs: Record<string, unknown> =
      body.agentDmReadSeqs && typeof body.agentDmReadSeqs === 'object'
        ? (body.agentDmReadSeqs as Record<string, unknown>)
        : {};
    const channelReadSeqs: Record<string, unknown> =
      body.channelReadSeqs && typeof body.channelReadSeqs === 'object'
        ? (body.channelReadSeqs as Record<string, unknown>)
        : {};

    const summarizeChannel = (channelId: string, lastReadSeq: number) => {
      const row = db.prepare(
        `SELECT
           COALESCE(MAX(seq), 0) as latestSeq,
           COALESCE(SUM(CASE WHEN seq > ? AND sender_type != 'user' THEN 1 ELSE 0 END), 0) as unreadCount
         FROM channel_messages
         WHERE channel_id = ?`,
      ).get(lastReadSeq, channelId) as { latestSeq: number | null; unreadCount: number | null };
      return {
        unreadCount: Number(row?.unreadCount ?? 0),
        latestSeq: Number(row?.latestSeq ?? 0),
      };
    };

    return {
      agentDms: Object.fromEntries(
        agentIds.map((agentId: string) => [
          agentId,
          summarizeChannel(`dm:${agentId}`, Math.max(0, Number(agentDmReadSeqs[agentId] ?? 0))),
        ]),
      ),
      channels: Object.fromEntries(
        channelIds.map((channelId: string) => [
          channelId,
          summarizeChannel(channelId, Math.max(0, Number(channelReadSeqs[channelId] ?? 0))),
        ]),
      ),
    };
  });

  app.post<{ Body: any }>('/api/channels', async (req, reply) => {
    const body = (req.body ?? {}) as any;
    if (!body.name) {
      reply.code(400);
      return { error: 'name is required' };
    }
    try {
      const channel = manager.createChannel({
        name: body.name,
        workspacePath: body.workspacePath,
        description: body.description,
      });
      for (const agentId of body.agentIds ?? []) {
        if (manager.getAgent(agentId)) manager.joinChannel(agentId, channel.channelId);
      }
      reply.code(201);
      return channel;
    } catch {
      reply.code(409);
      return { error: 'Channel name already exists' };
    }
  });

  app.post<{ Params: { id: string } }>('/api/channels/:id/clear-chat', async (req, reply) => {
    const channel = manager.getChannel(req.params.id);
    if (!channel) {
      reply.code(404);
      return { error: 'Channel not found' };
    }
    const cleared = manager.clearChannelChat(req.params.id);
    return {
      ok: true,
      clearedConversationIds: cleared.map((item) => item.id),
    };
  });

  app.post<{ Params: { id: string }; Body: { content: string; senderName?: string; replyTo?: string } }>(
    '/api/channels/:id/messages',
    async (req, reply) => {
      const channel = manager.getChannel(req.params.id);
      if (!channel) {
        reply.code(404);
        return { error: 'Channel not found' };
      }
      const { content, senderName = 'User', replyTo } = req.body ?? {};
      if (!content) {
        reply.code(400);
        return { error: 'content is required' };
      }

      const now = Date.now();
      const messageId = `msg-${randomUUID()}`;
      const seqRow = db.prepare('SELECT MAX(seq) as maxSeq FROM channel_messages WHERE channel_id = ?').get(req.params.id) as { maxSeq: number | null };
      const seq = (seqRow.maxSeq ?? 0) + 1;
      const threadRootId = replyTo ?? null;
      const target = threadRootId ? `#${channel.name}:${threadRootId}` : `#${channel.name}`;
      db.prepare(
        `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
         VALUES(?, ?, 'user', ?, 'user', ?, ?, ?, ?, NULL, ?)`,
      ).run(messageId, req.params.id, senderName, target, content, seq, now, threadRootId);

      if (threadRootId) {
        const rootMsg = db.prepare(
          `SELECT sender_id, sender_type FROM channel_messages
           WHERE channel_id = ? AND substr(message_id, 1, 8) = ?
           LIMIT 1`,
        ).get(req.params.id, threadRootId) as { sender_id: string; sender_type: string } | undefined;
        if (rootMsg?.sender_type === 'agent') {
          const conv = manager.openAgentChannelThread(rootMsg.sender_id, req.params.id, threadRootId);
          if (conv) {
            bumpAgentMessageCheckpoint(db, rootMsg.sender_id, req.params.id, seq, threadRootId);
            void manager.submitPrompt(
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

      const mentionedAgents = findMentionedAgents(content, manager.listAgents(req.params.id));
      for (const agent of mentionedAgents) {
        const conv = manager.openAgentChannelThread(agent.agentId, req.params.id, threadRootId ?? null);
        if (conv) {
          const historyTarget = threadRootId ? `#${channel.name}:${threadRootId}` : `#${channel.name}`;
          bumpAgentMessageCheckpoint(db, agent.agentId, req.params.id, seq, threadRootId ?? null);
          void manager.submitPrompt(
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

      reply.code(201);
      return { messageId, seq };
    },
  );

  app.post<{ Body: any }>('/api/conversations', async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const conv = manager.createConversation({
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

  app.post<{ Params: { id: string } }>('/api/agents/:id/open-thread', async (req, reply) => {
    const thread = manager.openAgentThread(req.params.id);
    if (!thread) {
      reply.code(404);
      return { error: 'Not found' };
    }
    return thread;
  });

  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    const conv = manager.getConversation(req.params.id);
    if (!conv) {
      reply.code(404);
      return { error: 'Not found' };
    }
    manager.deleteConversation(req.params.id);
    reply.code(204);
    return;
  });

  // WebSocket route — 使用 @fastify/websocket 的正确写法
  app.register(async function (fastify) {
    fastify.get<{ Params: { id: string } }>(
      '/api/conversations/:id/stream',
      { websocket: true },
      (socket, req) => {
        handleWebSocket(socket, req.params.id, manager);
      },
    );
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  serverClose = () => app.close();
});

afterAll(async () => {
  manager.close();
  await serverClose();
  db.close();
});

// ─── Helpers ───

async function fetchJson(path: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, init);
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

/**
 * 创建 WS 连接，同时立即开始收集消息（避免 open 和 message 之间的竞态）。
 * 返回 { ws, events } — events 是一个持续增长的数组。
 */
function createWsConnection(convId: string): Promise<{ ws: WebSocket; events: any[] }> {
  const wsUrl = baseUrl.replace('http', 'ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}/api/conversations/${convId}/stream`);
    const events: any[] = [];

    // 注册 message handler 在 open 之前，确保不漏消息
    ws.on('message', (data) => {
      events.push(JSON.parse(data.toString()));
    });

    ws.on('open', () => resolve({ ws, events }));
    ws.on('error', reject);
  });
}

/** 等待事件数量达到 count */
function waitForEvents(events: any[], count: number, timeoutMs = 5000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    if (events.length >= count) return resolve(events.slice(0, count));

    const timer = setTimeout(
      () => reject(new Error(`Timeout: got ${events.length}/${count} events: ${JSON.stringify(events)}`)),
      timeoutMs,
    );

    // 轮询（简单可靠）
    const interval = setInterval(() => {
      if (events.length >= count) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve(events.slice(0, count));
      }
    }, 50);
  });
}

// ─── Tests ───

describe('REST API', () => {
  it('GET /api/conversations 初始为空', async () => {
    const { status, body } = await fetchJson('/api/conversations');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('POST /api/conversations 创建会话', async () => {
    const { status, body } = await fetchJson('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude_acp', title: 'API Test' }),
    });

    expect(status).toBe(201);
    expect(body.id).toBeTruthy();
    expect(body.title).toBe('API Test');
    expect(body.agentType).toBe('claude_acp');
    expect(body.status).toBe('idle');
  });

  it('POST /api/conversations 支持 envVars', async () => {
    const envVars = { ANTHROPIC_API_KEY: 'sk-xxx', CUSTOM: 'val' };
    const { status, body } = await fetchJson('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude_acp', title: 'Env Test', envVars }),
    });

    expect(status).toBe(201);

    // 验证 DB 中存储了 envVars
    const row = db
      .prepare('SELECT env_vars FROM conversations WHERE id = ?')
      .get(body.id) as { env_vars: string | null };
    expect(JSON.parse(row.env_vars!)).toEqual(envVars);
  });

  it('GET /api/conversations/:id/channel-messages 应返回稳定 seq，用于私聊 unread 锚点', async () => {
    const agent = manager.createAgent({
      name: 'SeqBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/seq-bob',
    });
    const conversation = manager.openAgentThread(agent.agentId);
    expect(conversation).not.toBeNull();
    if (!conversation) throw new Error('missing conversation');

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, ?, 'user', 'User', 'user', 'dm:@SeqBob', 'hello', 1, ?, NULL, NULL)`,
    ).run(randomUUID(), `dm:${agent.agentId}`, Date.now());
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, ?, ?, ?, 'agent', 'dm:@User', 'hi', 2, ?, NULL, NULL)`,
    ).run(randomUUID(), `dm:${agent.agentId}`, agent.agentId, agent.name, Date.now());

    const { status, body } = await fetchJson(`/api/conversations/${conversation.id}/channel-messages?limit=10`);
    expect(status).toBe(200);
    expect(body.messages.map((message: { seq: number }) => message.seq)).toEqual([1, 2]);
  });

  it('POST /api/unread-summary 应分别统计 agent DM 和 channel 的未读数字', async () => {
    const agent = manager.createAgent({
      name: 'UnreadBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/unread-bob',
    });
    manager.joinChannel(agent.agentId, 'default');

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, ?, 'user', 'User', 'user', 'dm:@UnreadBob', 'hello', 1, ?, NULL, NULL)`,
    ).run(randomUUID(), `dm:${agent.agentId}`, Date.now());
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, ?, ?, ?, 'agent', 'dm:@User', 'reply', 2, ?, NULL, NULL)`,
    ).run(randomUUID(), `dm:${agent.agentId}`, agent.agentId, agent.name, Date.now());
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, 'default', 'user', 'User', 'user', '#default', 'channel hello', 1, ?, NULL, NULL)`,
    ).run(randomUUID(), Date.now());
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, 'default', ?, ?, 'agent', '#default', 'channel reply', 2, ?, NULL, NULL)`,
    ).run(randomUUID(), agent.agentId, agent.name, Date.now());
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, 'default', ?, ?, 'agent', '#default:abcd1234', 'thread reply', 3, ?, NULL, 'abcd1234')`,
    ).run(randomUUID(), agent.agentId, agent.name, Date.now());

    const { status, body } = await fetchJson('/api/unread-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentIds: [agent.agentId],
        channelIds: ['default'],
        agentDmReadSeqs: { [agent.agentId]: 0 },
        channelReadSeqs: { default: 1 },
      }),
    });

    expect(status).toBe(200);
    expect(body.agentDms[agent.agentId]).toEqual({ unreadCount: 1, latestSeq: 2 });
    expect(body.channels.default).toEqual({ unreadCount: 2, latestSeq: 3 });
  });

  it('POST /api/conversations 应保留 agentId 并出现在 agent 会话列表里', async () => {
    const agent = manager.createAgent({
      name: 'Bob',
      agentType: 'codex_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/bob',
    });

    const { status, body } = await fetchJson('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.agentId,
        agentType: agent.agentType,
        nodeId: agent.nodeId,
        workspacePath: agent.workspacePath,
      }),
    });

    expect(status).toBe(201);
    expect(body.agentId).toBe(agent.agentId);

    const row = db
      .prepare('SELECT agent_id as agentId FROM conversations WHERE id = ?')
      .get(body.id) as { agentId: string | null };
    expect(row.agentId).toBe(agent.agentId);

    const agentConversations = manager.listConversations({ agentId: agent.agentId });
    expect(agentConversations.map((conv) => conv.id)).toContain(body.id);
  });

  it('POST /api/agents/:id/open-thread 应复用同一个主 thread', async () => {
    const agent = manager.createAgent({
      name: 'Alice',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/alice',
    });

    const first = await fetchJson(`/api/agents/${agent.agentId}/open-thread`, { method: 'POST' });
    const second = await fetchJson(`/api/agents/${agent.agentId}/open-thread`, { method: 'POST' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.id).toBe(second.body.id);
    expect(first.body.threadKind).toBe('direct');
    expect(first.body.isPrimaryThread).toBe(true);

    const rows = manager.listConversations({ agentId: agent.agentId });
    expect(rows).toHaveLength(1);
  });

  it('POST /api/channels/:id/messages 在主频道 @agent 时应创建/复用 channel root branch，而不是 thread reply 或私聊主 thread', async () => {
    const agent = manager.createAgent({
      name: 'BobMention',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/bob-mention-thread',
    });
    manager.joinChannel(agent.agentId, 'default');

    const dmThread = manager.openAgentThread(agent.agentId);
    expect(dmThread).not.toBeNull();
    if (!dmThread) throw new Error('missing dm thread');

    const response = await fetchJson('/api/channels/default/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '@BobMention 请看下这个问题', senderName: 'User' }),
    });

    expect(response.status).toBe(201);

    const conversations = manager.listConversations({ agentId: agent.agentId });
    const branch = conversations.find((item) => item.threadKind === 'branch');
    expect(branch).toBeTruthy();
    expect(branch?.channelId).toBe('default');
    expect(branch?.threadRootId).toBeNull();
    expect(branch?.id).not.toBe(dmThread.id);
  });

  it('POST /api/channels/:id/messages 在主频道 @agent 时应直接把触发消息写进激活 prompt', async () => {
    const agent = manager.createAgent({
      name: 'PromptBob',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/prompt-bob',
    });
    manager.joinChannel(agent.agentId, 'default');

    const response = await fetchJson('/api/channels/default/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '@PromptBob 帮我看看这个问题', senderName: 'User' }),
    });

    expect(response.status).toBe(201);

    const conv = manager.openAgentChannelThread(agent.agentId, 'default', null);
    expect(conv).not.toBeNull();
    if (!conv) throw new Error('missing mention conversation');

    const sessionRow = db
      .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    const runRow = db.prepare(
      `SELECT prompt_text as promptText
       FROM runs
       WHERE session_key = ?
       ORDER BY started_at DESC
       LIMIT 1`,
    ).get(sessionRow.sessionKey) as { promptText: string } | undefined;

    expect(runRow?.promptText).toContain('[Triggered message metadata]');
    expect(runRow?.promptText).toContain('target: #default');
    expect(runRow?.promptText).toContain('[Triggered message body]');
    expect(runRow?.promptText).toContain('@PromptBob 帮我看看这个问题');
    expect(runRow?.promptText).not.toContain('Call check_messages to read unread messages');
  });

  it('POST /api/channels/:id/messages 在 thread reply 时应直接把 reply 内容写进激活 prompt', async () => {
    const agent = manager.createAgent({
      name: 'ReplyBob',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/reply-bob',
    });
    manager.joinChannel(agent.agentId, 'default');

    const rootMessageId = randomUUID();
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, 'default', ?, ?, 'agent', '#default', ?, 1, ?, NULL, NULL)`,
    ).run(rootMessageId, agent.agentId, agent.name, 'root message', Date.now());

    const response = await fetchJson('/api/channels/default/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '我在 thread 里回复你',
        senderName: 'User',
        replyTo: rootMessageId.slice(0, 8),
      }),
    });

    expect(response.status).toBe(201);

    const conv = manager.openAgentChannelThread(agent.agentId, 'default', rootMessageId.slice(0, 8));
    expect(conv).not.toBeNull();
    if (!conv) throw new Error('missing thread reply conversation');

    const sessionRow = db
      .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    const runRow = db.prepare(
      `SELECT prompt_text as promptText
       FROM runs
       WHERE session_key = ?
       ORDER BY started_at DESC
       LIMIT 1`,
    ).get(sessionRow.sessionKey) as { promptText: string } | undefined;

    expect(runRow?.promptText).toContain(`[System: Your message in #default received a reply from User.]`);
    expect(runRow?.promptText).toContain(`target: #default:${rootMessageId.slice(0, 8)}`);
    expect(runRow?.promptText).toContain('我在 thread 里回复你');
    expect(runRow?.promptText).not.toContain('Call check_messages to read unread messages');
  });

  it('GET /api/conversations 应列出已创建的会话', async () => {
    const { body } = await fetchJson('/api/conversations');
    expect(body.length).toBeGreaterThanOrEqual(2);
  });

  it('DELETE /api/conversations/:id 删除会话', async () => {
    const { body: conv } = await fetchJson('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'To Delete' }),
    });

    const { status } = await fetchJson(`/api/conversations/${conv.id}`, { method: 'DELETE' });
    expect(status).toBe(204);

    const found = manager.getConversation(conv.id);
    expect(found).toBeNull();
  });

  it('DELETE 不存在的 id 返回 404', async () => {
    const { status } = await fetchJson('/api/conversations/non-existent', { method: 'DELETE' });
    expect(status).toBe(404);
  });

  it('POST /api/channels 应支持 description 和初始 agentIds', async () => {
    const a1 = manager.createAgent({
      name: 'Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/bob',
    });
    const a2 = manager.createAgent({
      name: 'Tab',
      agentType: 'codex_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/tab',
    });

    const { status, body } = await fetchJson('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'eng-room',
        description: 'Engineering channel',
        agentIds: [a1.agentId, a2.agentId],
      }),
    });

    expect(status).toBe(201);
    expect(body.description).toBe('Engineering channel');

    const bob = manager.getAgent(a1.agentId);
    const tab = manager.getAgent(a2.agentId);
    expect(bob?.channelIds).toContain(body.channelId);
    expect(tab?.channelIds).toContain(body.channelId);
  });

  it('POST /api/channels/:id/clear-chat 应清空 channel 消息并重置 branch 历史，但保留 tasks', async () => {
    const agent = manager.createAgent({
      name: 'ClearRoomBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/clear-room-bob',
    });
    manager.joinChannel(agent.agentId, 'default');
    const branch = manager.openAgentChannelThread(agent.agentId, 'default', null);
    expect(branch).not.toBeNull();
    if (!branch) throw new Error('missing branch conversation');

    const sessionRow = db.prepare(
      'SELECT session_key as sessionKey FROM conversations WHERE id = ?',
    ).get(branch.id) as { sessionKey: string };

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, 'default', 'user', 'User', 'user', '#default', 'hello', 1, ?, NULL, NULL)`,
    ).run(randomUUID(), Date.now());
    db.prepare(
      'INSERT INTO agent_message_checkpoints(agent_id, channel_id, thread_root_id, last_seq) VALUES(?, ?, ?, ?)',
    ).run(agent.agentId, 'default', '', 1);
    db.prepare(
      'INSERT INTO runs(run_id, session_key, prompt_text, started_at) VALUES(?, ?, ?, ?)',
    ).run('run-clear-channel', sessionRow.sessionKey, 'hello', Date.now());
    db.prepare(
      'INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)',
    ).run('run-clear-channel', 1, 'node/event', JSON.stringify({ type: 'content.delta', text: 'hi' }), Date.now());
    db.prepare(
      'INSERT INTO conversation_prompt_queue(agent_id, conversation_id, prompt_text, created_at, updated_at) VALUES(?, ?, ?, ?, ?)',
    ).run(agent.agentId, branch.id, 'queued', Date.now(), Date.now());
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, created_at, updated_at)
       VALUES(?, 'default', 1, 'Keep task', 'todo', ?, ?)`,
    ).run(randomUUID(), Date.now(), Date.now());

    const { status, body } = await fetchJson('/api/channels/default/clear-chat', {
      method: 'POST',
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.clearedConversationIds).toContain(branch.id);

    const messageCount = db.prepare(
      `SELECT count(*) as count FROM channel_messages WHERE channel_id = 'default'`,
    ).get() as { count: number };
    const checkpointCount = db.prepare(
      `SELECT count(*) as count FROM agent_message_checkpoints WHERE channel_id = 'default'`,
    ).get() as { count: number };
    const oldRunCount = db.prepare(
      'SELECT count(*) as count FROM runs WHERE session_key = ?',
    ).get(sessionRow.sessionKey) as { count: number };
    const eventCount = db.prepare(
      `SELECT count(*) as count FROM events WHERE run_id = 'run-clear-channel'`,
    ).get() as { count: number };
    const queueCount = db.prepare(
      'SELECT count(*) as count FROM conversation_prompt_queue WHERE conversation_id = ?',
    ).get(branch.id) as { count: number };
    const taskCount = db.prepare(
      `SELECT count(*) as count FROM tasks WHERE channel_id = 'default'`,
    ).get() as { count: number };

    expect(messageCount.count).toBe(0);
    expect(checkpointCount.count).toBe(0);
    expect(oldRunCount.count).toBe(0);
    expect(eventCount.count).toBe(0);
    expect(queueCount.count).toBe(0);
    expect(taskCount.count).toBe(1);
  });
});

describe('WebSocket', () => {
  it('连接后应收到 conversation.status 和 history.complete', async () => {
    const { body: conv } = await fetchJson('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'WS Test' }),
    });

    const { ws, events } = await createWsConnection(conv.id);
    const received = await waitForEvents(events, 2);
    ws.close();

    expect(received[0].type).toBe('conversation.status');
    expect(received[0].conversationId).toBe(conv.id);
    expect(received[0].status).toBe('idle');
    expect(received[1].type).toBe('history.complete');

    manager.deleteConversation(conv.id);
  });

  it('连接不存在的会话应收到 error 并关闭', async () => {
    const { ws, events } = await createWsConnection('non-existent');
    const received = await waitForEvents(events, 1);

    expect(received[0].type).toBe('error');
    expect(received[0].message).toContain('not found');

    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else ws.on('close', () => resolve());
    });
  });

  it('未绑定 agent-node 时发送 prompt 应收到 error', async () => {
    const { body: conv } = await fetchJson('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Prompt Test' }),
    });

    const { ws, events } = await createWsConnection(conv.id);
    await waitForEvents(events, 2); // status + history.complete

    ws.send(JSON.stringify({ type: 'prompt', text: 'hello' }));

    const allEvents = await waitForEvents(events, 3);
    ws.close();

    const errorEvent = allEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toContain('agent node');

    manager.deleteConversation(conv.id);
  });

  it('恢复中的未结束 run 回放时不应发送 turn.end', async () => {
    const conv = manager.createConversation({ title: 'Recovering Replay' });
    const sessionRow = db
      .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };

    createRun(db, {
      runId: 'run-recovering-1',
      sessionKey: sessionRow.sessionKey,
      promptText: 'continue previous run',
    });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('recovering', conv.id);
    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'node/event', ?, ?)`,
    ).run(
      'run-recovering-1',
      1,
      JSON.stringify({ type: 'content.delta', text: 'partial output' }),
      Date.now(),
    );

    const { ws, events } = await createWsConnection(conv.id);
    const received = await waitForEvents(events, 5);
    await new Promise((resolve) => setTimeout(resolve, 100));
    ws.close();

    expect(received[0]).toEqual({
      type: 'conversation.status',
      conversationId: conv.id,
      status: 'recovering',
    });
    expect(received[1]).toEqual({
      type: 'history.user_message',
      text: 'continue previous run',
    });
    expect(received[2].type).toBe('turn.begin');
    expect(received[3]).toEqual({
      type: 'content.delta',
      text: 'partial output',
    });
    expect(received[4]).toEqual({ type: 'history.complete' });
    expect(events.some((event) => event.type === 'turn.end')).toBe(false);

    manager.deleteConversation(conv.id);
  });
});
