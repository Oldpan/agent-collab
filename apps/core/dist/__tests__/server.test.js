import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, createTestConfig } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { createRun } from '@agent-collab/runtime-acp';
import WebSocket from 'ws';
let db;
let manager;
let baseUrl;
let serverClose;
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
    app.post('/api/conversations', async (req, reply) => {
        const body = (req.body ?? {});
        const conv = manager.createConversation({
            agentType: body.agentType,
            workspacePath: body.workspacePath,
            title: body.title,
            envVars: body.envVars,
        });
        reply.code(201);
        return conv;
    });
    app.delete('/api/conversations/:id', async (req, reply) => {
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
        fastify.get('/api/conversations/:id/stream', { websocket: true }, (socket, req) => {
            handleWebSocket(socket, req.params.id, manager);
        });
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    serverClose = () => app.close();
});
afterAll(async () => {
    manager.close();
    await serverClose();
    db.close();
});
// ─── Helpers ───
async function fetchJson(path, init) {
    const res = await fetch(`${baseUrl}${path}`, init);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
}
/**
 * 创建 WS 连接，同时立即开始收集消息（避免 open 和 message 之间的竞态）。
 * 返回 { ws, events } — events 是一个持续增长的数组。
 */
function createWsConnection(convId) {
    const wsUrl = baseUrl.replace('http', 'ws');
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsUrl}/api/conversations/${convId}/stream`);
        const events = [];
        // 注册 message handler 在 open 之前，确保不漏消息
        ws.on('message', (data) => {
            events.push(JSON.parse(data.toString()));
        });
        ws.on('open', () => resolve({ ws, events }));
        ws.on('error', reject);
    });
}
/** 等待事件数量达到 count */
function waitForEvents(events, count, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        if (events.length >= count)
            return resolve(events.slice(0, count));
        const timer = setTimeout(() => reject(new Error(`Timeout: got ${events.length}/${count} events: ${JSON.stringify(events)}`)), timeoutMs);
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
            .get(body.id);
        expect(JSON.parse(row.env_vars)).toEqual(envVars);
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
        await new Promise((resolve) => {
            if (ws.readyState === WebSocket.CLOSED)
                resolve();
            else
                ws.on('close', () => resolve());
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
            .get(conv.id);
        createRun(db, {
            runId: 'run-recovering-1',
            sessionKey: sessionRow.sessionKey,
            promptText: 'continue previous run',
        });
        db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('recovering', conv.id);
        db.prepare(`INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'node/event', ?, ?)`).run('run-recovering-1', 1, JSON.stringify({ type: 'content.delta', text: 'partial output' }), Date.now());
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
