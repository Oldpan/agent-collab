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
    registerInternalAgentRoutes(app, db, manager, () => { }, () => { }, createTestConfig().humanUserName);
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
                kind: 'final',
                conversationId: conv.id,
            }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.runId).toBe('run-router-1');
        expect(body.kind).toBe('final');
        const row = db.prepare('SELECT run_id as runId, channel_id as channelId, message_kind as messageKind FROM channel_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1').get(agent.agentId);
        expect(row.runId).toBe('run-router-1');
        expect(row.channelId).toBe(`dm:${agent.agentId}`);
        expect(row.messageKind).toBe('final');
    });
    it('未提供 target 时应默认回复当前私聊会话', async () => {
        const agent = manager.createAgent({
            name: 'Tab',
            agentType: 'codex_acp',
            nodeId: 'node-1',
            workspacePath: '/tmp/tab-router',
        });
        const conv = manager.openAgentThread(agent.agentId);
        if (!conv)
            throw new Error('missing conversation');
        const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
            .get(conv.id);
        createRun(db, {
            runId: 'run-router-2',
            sessionKey: sessionRow.sessionKey,
            promptText: 'reply',
        });
        const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: 'ack',
                conversationId: conv.id,
            }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.runId).toBe('run-router-2');
        expect(body.target).toBe('dm:@oldpan');
        const row = db.prepare('SELECT run_id as runId, channel_id as channelId, target FROM channel_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1').get(agent.agentId);
        expect(row.runId).toBe('run-router-2');
        expect(row.channelId).toBe(`dm:${agent.agentId}`);
        expect(row.target).toBe('dm:@oldpan');
    });
    it('branch thread 未提供 target 时应默认回复当前 channel thread', async () => {
        const agent = manager.createAgent({
            name: 'Viber',
            agentType: 'claude_acp',
            nodeId: 'node-1',
            workspacePath: '/tmp/viber-router',
            channelId: 'default',
        });
        const conv = manager.openAgentChannelThread(agent.agentId, 'default', 'abcd1234');
        if (!conv)
            throw new Error('missing channel conversation');
        const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
            .get(conv.id);
        createRun(db, {
            runId: 'run-router-3',
            sessionKey: sessionRow.sessionKey,
            promptText: 'reply branch',
        });
        const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: 'branch ack',
                conversationId: conv.id,
            }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.target).toBe('#default:abcd1234');
        const row = db.prepare('SELECT channel_id as channelId, target FROM channel_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1').get(agent.agentId);
        expect(row.channelId).toBe('default');
        expect(row.target).toBe('#default:abcd1234');
    });
    it('channel root branch 未提供 target 时应默认回复当前 channel，而不是 thread', async () => {
        const agent = manager.createAgent({
            name: 'ViberRoot',
            agentType: 'claude_acp',
            nodeId: 'node-1',
            workspacePath: '/tmp/viber-root-router',
            channelId: 'default',
        });
        manager.joinChannel(agent.agentId, 'default');
        const conv = manager.openAgentChannelThread(agent.agentId, 'default', null);
        if (!conv)
            throw new Error('missing channel root conversation');
        const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
            .get(conv.id);
        createRun(db, {
            runId: 'run-router-4',
            sessionKey: sessionRow.sessionKey,
            promptText: 'reply root branch',
        });
        const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: 'root ack',
                conversationId: conv.id,
            }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.target).toBe('#default');
        const row = db.prepare('SELECT channel_id as channelId, target, thread_root_id as threadRootId FROM channel_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1').get(agent.agentId);
        expect(row.channelId).toBe('default');
        expect(row.target).toBe('#default');
        expect(row.threadRootId).toBeNull();
    });
    it('channel root branch 显式传入同频道 thread target 时应归一化回主频道', async () => {
        const agent = manager.createAgent({
            name: 'ViberRootNormalize',
            agentType: 'claude_acp',
            nodeId: 'node-1',
            workspacePath: '/tmp/viber-root-normalize-router',
            channelId: 'default',
        });
        manager.joinChannel(agent.agentId, 'default');
        const conv = manager.openAgentChannelThread(agent.agentId, 'default', null);
        if (!conv)
            throw new Error('missing channel root conversation');
        const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
            .get(conv.id);
        createRun(db, {
            runId: 'run-router-5',
            sessionKey: sessionRow.sessionKey,
            promptText: 'reply root branch normalize',
        });
        const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: 'normalize ack',
                target: '#default:2b5a7801',
                conversationId: conv.id,
            }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.target).toBe('#default');
        const row = db.prepare('SELECT channel_id as channelId, target, thread_root_id as threadRootId FROM channel_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1').get(agent.agentId);
        expect(row.channelId).toBe('default');
        expect(row.target).toBe('#default');
        expect(row.threadRootId).toBeNull();
    });
    it('check_messages 应按 thread_root_id 分别推进 checkpoint，不同 thread 不应互相消费', async () => {
        const channel = manager.createChannel({ name: 'thread-checkpoint-room' });
        const agent = manager.createAgent({
            name: 'ThreadCheckpointBob',
            agentType: 'claude_acp',
            nodeId: 'node-1',
            workspacePath: '/tmp/thread-checkpoint-bob',
        });
        manager.leaveChannel(agent.agentId, 'default');
        manager.joinChannel(agent.agentId, channel.channelId);
        db.prepare(`INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES
       ('msg-root-1', ?, 'user', 'User', 'user', ?, 'root-1', 1, 1000, NULL),
       ('msg-thread-1', ?, 'user', 'User', 'user', ?, 'thread-1', 2, 2000, 'aaaa1111')`).run(channel.channelId, `#${channel.name}`, channel.channelId, `#${channel.name}:aaaa1111`);
        let res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/receive`);
        expect(res.status).toBe(200);
        let body = await res.json();
        expect(body.messages.map((m) => m.content)).toEqual(['root-1', 'thread-1']);
        db.prepare(`INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES(?, ?, 'user', 'User', 'user', ?, ?, ?, ?, ?)`).run('msg-root-2', channel.channelId, `#${channel.name}`, 'root-2', 3, 3000, null);
        res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/receive`);
        expect(res.status).toBe(200);
        body = await res.json();
        expect(body.messages.map((m) => m.content)).toEqual(['root-2']);
        db.prepare(`INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES(?, ?, 'user', 'User', 'user', ?, ?, ?, ?, ?)`).run('msg-thread-2', channel.channelId, `#${channel.name}:aaaa1111`, 'thread-2', 4, 4000, 'aaaa1111');
        res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/receive`);
        expect(res.status).toBe(200);
        body = await res.json();
        expect(body.messages.map((m) => m.content)).toEqual(['thread-2']);
    });
    it('read_history 对已加入的 channel 应返回历史', async () => {
        const agent = manager.createAgent({
            name: 'Reader',
            agentType: 'claude_acp',
            nodeId: 'node-1',
            workspacePath: '/tmp/reader-router',
        });
        manager.joinChannel(agent.agentId, 'default');
        db.prepare(`INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('msg-1', 'default', 'user', 'User', 'user', '#default', 'hello channel', 1, Date.now());
        const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/history?channel=${encodeURIComponent('#default')}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.messages.map((msg) => msg.content)).toContain('hello channel');
    });
    it('read_history 对未加入的 channel 应返回 403', async () => {
        const agent = manager.createAgent({
            name: 'NoMember',
            agentType: 'codex_acp',
            nodeId: 'node-1',
            workspacePath: '/tmp/no-member-router',
        });
        manager.createChannel({ name: 'private-test' });
        const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/history?channel=${encodeURIComponent('#private-test')}`);
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toContain('not a member');
    });
});
