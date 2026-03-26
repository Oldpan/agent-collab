import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createRun } from '@agent-collab/runtime-acp';
import { createTestConfig, createTestDb } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { registerInternalAgentRoutes } from '../web/internalAgentRouter.js';
let db;
let manager;
let baseUrl;
let serverClose;
beforeAll(async () => {
    db = createTestDb();
    manager = new ConversationManager({ db, config: createTestConfig() });
    manager.start();
    const app = Fastify({ logger: false });
    registerInternalAgentRoutes(app, db, manager, () => { });
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
describe('internalAgentRouter', () => {
    it('send_message 应把消息绑定到当前会话的 active run', async () => {
        const agent = manager.createAgent({
            name: 'Bob',
            agentType: 'claude_acp',
            nodeId: 'node-1',
            workspacePath: '/tmp/bob-router',
        });
        const conv = manager.openAgentThread(agent.agentId);
        if (!conv)
            throw new Error('missing conversation');
        const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
            .get(conv.id);
        createRun(db, {
            runId: 'run-router-1',
            sessionKey: sessionRow.sessionKey,
            promptText: 'hello',
        });
        const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                target: `dm:@${agent.name}`,
                content: 'hi',
                conversationId: conv.id,
            }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.runId).toBe('run-router-1');
        const row = db.prepare('SELECT run_id as runId, channel_id as channelId FROM channel_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1').get(agent.agentId);
        expect(row.runId).toBe('run-router-1');
        expect(row.channelId).toBe(`dm:${agent.agentId}`);
    });
});
