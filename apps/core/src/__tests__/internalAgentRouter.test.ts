import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { CoreToNode } from '@agent-collab/protocol';
import type { Db } from '@agent-collab/runtime-acp';
import { createRun } from '@agent-collab/runtime-acp';
import { createTestConfig, createTestDb } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { registerInternalAgentRoutes } from '../web/internalAgentRouter.js';

let db: Db;
let manager: ConversationManager;
let baseUrl: string;
let serverClose: () => Promise<void>;
const dispatches: CoreToNode[] = [];

beforeAll(async () => {
  db = createTestDb();
  const fakeRegistry = {
    getNode(nodeId: string) {
      return {
        nodeId,
        hostname: 'test-node',
        agentTypes: ['claude_acp', 'codex_acp'],
        version: 'test',
      };
    },
    send(_nodeId: string, msg: CoreToNode) {
      dispatches.push(msg);
      return true;
    },
  };
  manager = new ConversationManager({ db, config: createTestConfig(), nodeRegistry: fakeRegistry as any });
  manager.start();

  const app = Fastify({ logger: false });
  registerInternalAgentRoutes(app, db, manager, () => {}, () => {}, createTestConfig().humanUserName);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  serverClose = () => app.close();
});

beforeEach(() => {
  dispatches.length = 0;
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
    if (!conv) throw new Error('missing conversation');

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
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
    const body = await res.json() as { runId?: string; kind?: string | null };
    expect(body.runId).toBe('run-router-1');
    expect(body.kind).toBe('final');

    const row = db.prepare(
      'SELECT run_id as runId, channel_id as channelId, message_kind as messageKind, message_source as messageSource FROM channel_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(agent.agentId) as { runId: string | null; channelId: string; messageKind: string | null; messageSource: string | null };
    expect(row.runId).toBe('run-router-1');
    expect(row.channelId).toBe(`dm:${agent.agentId}`);
    expect(row.messageKind).toBe('final');
    expect(row.messageSource).toBe('agent_send');
    expect(dispatches).toHaveLength(0);
  });

  it('未提供 target 时应默认回复当前私聊会话', async () => {
    const agent = manager.createAgent({
      name: 'Tab',
      agentType: 'codex_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/tab-router',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
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
    const body = await res.json() as { runId?: string; target?: string };
    expect(body.runId).toBe('run-router-2');
    expect(body.target).toBe('dm:@oldpan');

    const row = db.prepare(
      'SELECT run_id as runId, channel_id as channelId, target FROM channel_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(agent.agentId) as { runId: string | null; channelId: string; target: string };
    expect(row.runId).toBe('run-router-2');
    expect(row.channelId).toBe(`dm:${agent.agentId}`);
    expect(row.target).toBe('dm:@oldpan');
  });

  it('send_message 应拒绝纯空白内容', async () => {
    const agent = manager.createAgent({
      name: 'WhitespaceBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/whitespace-bob-router',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '   \n\t  ',
        conversationId: conv.id,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('content must not be empty');

    const row = db.prepare(
      'SELECT COUNT(*) as count FROM channel_messages WHERE sender_id = ?',
    ).get(agent.agentId) as { count: number };
    expect(row.count).toBe(0);
  });

  it('同一 run 在 final 之后仍允许继续发送；final 只保留消息语义', async () => {
    const agent = manager.createAgent({
      name: 'FinalGateBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/final-gate-bob-router',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-final-gate',
      sessionKey: sessionRow.sessionKey,
      promptText: 'gate me',
    });

    const firstFinal = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'done',
        kind: 'final',
        conversationId: conv.id,
      }),
    });
    expect(firstFinal.status).toBe(200);
    expect(dispatches).toHaveLength(0);
    const trailingFinal = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'done, tail',
        kind: 'final',
        conversationId: conv.id,
      }),
    });
    expect(trailingFinal.status).toBe(200);
    expect(dispatches).toHaveLength(0);
    const thirdAllowedFinal = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'done, final tail 2',
        kind: 'final',
        conversationId: conv.id,
      }),
    });
    expect(thirdAllowedFinal.status).toBe(200);
    expect(dispatches).toHaveLength(0);

    const progressAfterFinal = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'still working',
        kind: 'progress',
        conversationId: conv.id,
      }),
    });
    expect(progressAfterFinal.status).toBe(200);

    const untypedAfterFinal = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'plain text',
        conversationId: conv.id,
      }),
    });
    expect(untypedAfterFinal.status).toBe(200);

    const crossTargetFinal = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: '#default',
        content: 'different target final',
        kind: 'final',
        conversationId: conv.id,
      }),
    });
    expect(crossTargetFinal.status).toBe(200);

    const rows = db.prepare(
      `SELECT content, message_kind as messageKind, target
       FROM channel_messages
       WHERE run_id = ?
       ORDER BY created_at ASC, seq ASC`,
    ).all('run-router-final-gate') as Array<{ content: string; messageKind: string | null; target: string }>;
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.messageKind)).toEqual(['final', 'final', 'final', 'progress', null, 'final']);
    expect(rows.map((row) => row.target)).toEqual([
      'dm:@oldpan',
      'dm:@oldpan',
      'dm:@oldpan',
      'dm:@oldpan',
      'dm:@oldpan',
      '#default',
    ]);
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
    if (!conv) throw new Error('missing channel conversation');

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
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
    const body = await res.json() as { target?: string };
    expect(body.target).toBe('#default:abcd1234');

    const row = db.prepare(
      'SELECT channel_id as channelId, target FROM channel_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(agent.agentId) as { channelId: string; target: string };
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
    if (!conv) throw new Error('missing channel root conversation');

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
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
    const body = await res.json() as { target?: string };
    expect(body.target).toBe('#default');

    const row = db.prepare(
      'SELECT channel_id as channelId, target, thread_root_id as threadRootId FROM channel_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(agent.agentId) as { channelId: string; target: string; threadRootId: string | null };
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
    if (!conv) throw new Error('missing channel root conversation');

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
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
    const body = await res.json() as { target?: string };
    expect(body.target).toBe('#default');

    const row = db.prepare(
      'SELECT channel_id as channelId, target, thread_root_id as threadRootId FROM channel_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(agent.agentId) as { channelId: string; target: string; threadRootId: string | null };
    expect(row.channelId).toBe('default');
    expect(row.target).toBe('#default');
    expect(row.threadRootId).toBeNull();
  });

  it('agent 在主频道正式 @ 另一个 agent 时应触发该 agent 协作唤醒', async () => {
    const tab = manager.createAgent({
      name: 'MentionTab',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/mention-tab-router',
      channelId: 'default',
    });
    const bob = manager.createAgent({
      name: 'MentionBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/mention-bob-router',
      channelId: 'default',
    });
    manager.joinChannel(tab.agentId, 'default');
    manager.joinChannel(bob.agentId, 'default');

    const conv = manager.openAgentChannelThread(tab.agentId, 'default', null);
    if (!conv) throw new Error('missing channel conversation');

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-agent-mention-root',
      sessionKey: sessionRow.sessionKey,
      promptText: 'mention root helper',
    });

    dispatches.length = 0;
    const res = await fetch(`${baseUrl}/api/internal/agent/${tab.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: '#default',
        content: 'Can you take a look, @MentionBob?',
        kind: 'progress',
        conversationId: conv.id,
      }),
    });

    expect(res.status).toBe(200);
    expect(dispatches.filter((msg) => msg.type === 'run.dispatch')).toHaveLength(1);

    const bobConv = manager.openAgentChannelThread(bob.agentId, 'default', null);
    if (!bobConv) throw new Error('missing mentioned conversation');
    const bobSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(bobConv.id) as { sessionKey: string };
    const runRow = db.prepare(
      'SELECT prompt_text as promptText FROM runs WHERE session_key = ? ORDER BY started_at DESC LIMIT 1',
    ).get(bobSession.sessionKey) as { promptText: string } | undefined;
    expect(runRow?.promptText).toContain('@MentionTab');
    expect(runRow?.promptText).toContain('target: #default');

    const participant = db.prepare(
      `SELECT role
       FROM target_participants
       WHERE agent_id = ? AND channel_id = ? AND thread_root_id = ''`,
    ).get(bob.agentId, 'default') as { role: string } | undefined;
    expect(participant?.role).toBe('participant');
  });

  it('agent 在线程正式 @ 另一个 agent 时应唤醒同一 thread 的 conversation', async () => {
    const tab = manager.createAgent({
      name: 'ThreadTab',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/thread-tab-router',
      channelId: 'default',
    });
    const bob = manager.createAgent({
      name: 'ThreadBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/thread-bob-router',
      channelId: 'default',
    });
    manager.joinChannel(tab.agentId, 'default');
    manager.joinChannel(bob.agentId, 'default');

    const conv = manager.openAgentChannelThread(tab.agentId, 'default', 'thrd1234');
    if (!conv) throw new Error('missing thread conversation');

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-agent-mention-thread',
      sessionKey: sessionRow.sessionKey,
      promptText: 'mention thread helper',
    });

    dispatches.length = 0;
    const res = await fetch(`${baseUrl}/api/internal/agent/${tab.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: '#default:thrd1234',
        content: 'Need help in this thread, @ThreadBob.',
        kind: 'final',
        conversationId: conv.id,
      }),
    });

    expect(res.status).toBe(200);
    expect(dispatches.filter((msg) => msg.type === 'run.dispatch')).toHaveLength(1);

    const bobConv = manager.openAgentChannelThread(bob.agentId, 'default', 'thrd1234');
    if (!bobConv) throw new Error('missing mentioned thread conversation');
    expect(bobConv.threadRootId).toBe('thrd1234');

    const bobSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(bobConv.id) as { sessionKey: string };
    const runRow = db.prepare(
      'SELECT prompt_text as promptText FROM runs WHERE session_key = ? ORDER BY started_at DESC LIMIT 1',
    ).get(bobSession.sessionKey) as { promptText: string } | undefined;
    expect(runRow?.promptText).toContain('#default:thrd1234');
  });

  it('agent mention 只对正式 channel/thread 消息生效，并受 cooldown 限制', async () => {
    const tab = manager.createAgent({
      name: 'CooldownTab',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/cooldown-tab-router',
      channelId: 'default',
    });
    const bob = manager.createAgent({
      name: 'CooldownBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/cooldown-bob-router',
      channelId: 'default',
    });
    manager.joinChannel(tab.agentId, 'default');
    manager.joinChannel(bob.agentId, 'default');

    const dmConv = manager.openAgentThread(tab.agentId);
    if (!dmConv) throw new Error('missing dm conversation');
    const dmSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(dmConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-agent-mention-dm',
      sessionKey: dmSession.sessionKey,
      promptText: 'dm mention helper',
    });

    dispatches.length = 0;
    const dmRes = await fetch(`${baseUrl}/api/internal/agent/${tab.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Looping in @CooldownBob from DM',
        conversationId: dmConv.id,
      }),
    });
    expect(dmRes.status).toBe(200);
    expect(dispatches.filter((msg) => msg.type === 'run.dispatch')).toHaveLength(0);

    const rootConv = manager.openAgentChannelThread(tab.agentId, 'default', null);
    if (!rootConv) throw new Error('missing root conversation');
    const rootSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(rootConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-agent-mention-cooldown',
      sessionKey: rootSession.sessionKey,
      promptText: 'cooldown mention helper',
    });

    const firstRes = await fetch(`${baseUrl}/api/internal/agent/${tab.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: '#default',
        content: 'Please pair on this, @CooldownBob.',
        kind: 'progress',
        conversationId: rootConv.id,
      }),
    });
    expect(firstRes.status).toBe(200);

    const secondRes = await fetch(`${baseUrl}/api/internal/agent/${tab.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: '#default',
        content: 'Still need you, @CooldownBob.',
        kind: 'progress',
        conversationId: rootConv.id,
      }),
    });
    expect(secondRes.status).toBe(200);

    expect(dispatches.filter((msg) => msg.type === 'run.dispatch')).toHaveLength(1);

    const cooldownRows = db.prepare(
      `SELECT COUNT(*) as count
       FROM agent_mention_cooldowns
       WHERE channel_id = ? AND thread_root_id = '' AND from_agent_id = ? AND to_agent_id = ?`,
    ).get('default', tab.agentId, bob.agentId) as { count: number };
    expect(cooldownRows.count).toBe(1);
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

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES
       ('msg-root-1', ?, 'user', 'User', 'user', ?, 'root-1', 1, 1000, NULL),
       ('msg-thread-1', ?, 'user', 'User', 'user', ?, 'thread-1', 2, 2000, 'aaaa1111')`,
    ).run(channel.channelId, `#${channel.name}`, channel.channelId, `#${channel.name}:aaaa1111`);

    let res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/receive`);
    expect(res.status).toBe(200);
    let body = await res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((m) => m.content)).toEqual(['root-1', 'thread-1']);

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES(?, ?, 'user', 'User', 'user', ?, ?, ?, ?, ?)`,
    ).run('msg-root-2', channel.channelId, `#${channel.name}`, 'root-2', 3, 3000, null);

    res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/receive`);
    expect(res.status).toBe(200);
    body = await res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((m) => m.content)).toEqual(['root-2']);

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES(?, ?, 'user', 'User', 'user', ?, ?, ?, ?, ?)`,
    ).run('msg-thread-2', channel.channelId, `#${channel.name}:aaaa1111`, 'thread-2', 4, 4000, 'aaaa1111');

    res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/receive`);
    expect(res.status).toBe(200);
    body = await res.json() as { messages: Array<{ content: string }> };
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

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('msg-1', 'default', 'user', 'User', 'user', '#default', 'hello channel', 1, Date.now());

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/history?channel=${encodeURIComponent('#default')}`);
    expect(res.status).toBe(200);

    const body = await res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((msg) => msg.content)).toContain('hello channel');
  });

  it('thread conversation 中的 agent 仍可读取所属主频道历史', async () => {
    const agent = manager.createAgent({
      name: 'ThreadReader',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/thread-reader-router',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const conv = manager.openAgentChannelThread(agent.agentId, 'default', 'mainread1');
    if (!conv) throw new Error('missing thread conversation');

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES
       ('main-msg-1', 'default', 'user', 'User', 'user', '#default', 'main channel context', 1, ?),
       ('thread-msg-1', 'default', 'user', 'User', 'user', '#default:mainread1', 'thread-only context', 2, ?)`,
    ).run(Date.now(), Date.now() + 1);

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/history?channel=${encodeURIComponent('#default')}`);
    expect(res.status).toBe(200);

    const body = await res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((msg) => msg.content)).toContain('main channel context');
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

    const body = await res.json() as { error: string };
    expect(body.error).toContain('not a member');
  });

  it('thread 中 claim task 时应自动绑定 thread 并同步 owner', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'TaskOwnerBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/task-owner-bob',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const conv = manager.openAgentChannelThread(agent.agentId, 'default', 'bind1234');
    if (!conv) throw new Error('missing thread conversation');

    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, created_at, updated_at)
       VALUES(?, 'default', 7, 'Bind me', 'todo', ?, ?)`,
    ).run('task-bind-7', now, now);

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        task_numbers: [7],
        conversationId: conv.id,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ taskNumber: number; success: boolean }> };
    expect(body.results).toEqual([{ taskNumber: 7, success: true }]);

    const binding = db.prepare(
      `SELECT channel_id as channelId, thread_root_id as threadRootId, task_id as taskId
       FROM thread_task_bindings
       WHERE channel_id = 'default' AND thread_root_id = 'bind1234'`,
    ).get() as { channelId: string; threadRootId: string; taskId: string } | undefined;
    expect(binding).toEqual({ channelId: 'default', threadRootId: 'bind1234', taskId: 'task-bind-7' });

    const task = db.prepare(
      `SELECT claimed_by_agent_id as claimedByAgentId, claimed_by_name as claimedByName, status
       FROM tasks WHERE task_id = 'task-bind-7'`,
    ).get() as { claimedByAgentId: string | null; claimedByName: string | null; status: string };
    expect(task).toEqual({
      claimedByAgentId: agent.agentId,
      claimedByName: 'TaskOwnerBob',
      status: 'in_progress',
    });

    const participant = db.prepare(
      `SELECT role FROM target_participants
       WHERE agent_id = ? AND channel_id = 'default' AND thread_root_id = 'bind1234'`,
    ).get(agent.agentId) as { role: string } | undefined;
    expect(participant?.role).toBe('owner');
  });

  it('同一 thread 绑定第二个 task 时应拒绝，不隐式覆盖', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'TaskConflictBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/task-conflict-bob',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const conv = manager.openAgentChannelThread(agent.agentId, 'default', 'conf1234');
    if (!conv) throw new Error('missing thread conversation');

    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, created_at, updated_at)
       VALUES
       ('task-conflict-1', 'default', 11, 'First', 'todo', ?, ?),
       ('task-conflict-2', 'default', 12, 'Second', 'todo', ?, ?)`,
    ).run(now, now, now, now);

    let res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        task_numbers: [11],
        conversationId: conv.id,
      }),
    });
    expect(res.status).toBe(200);

    res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        task_numbers: [12],
        conversationId: conv.id,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ taskNumber: number; success: boolean; reason?: string }> };
    expect(body.results).toEqual([{ taskNumber: 12, success: false, reason: 'Thread is already bound to #t11' }]);
  });

  it('已绑定 thread 的 task 标记 done 后应清空 thread owner 但保留绑定', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'TaskDoneBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/task-done-bob',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const conv = manager.openAgentChannelThread(agent.agentId, 'default', 'done1234');
    if (!conv) throw new Error('missing thread conversation');

    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, claimed_by_agent_id, claimed_by_name, created_at, updated_at)
       VALUES('task-done-1', 'default', 21, 'Done me', 'in_review', ?, ?, ?, ?)`,
    ).run(agent.agentId, agent.name, now, now);
    db.prepare(
      `INSERT INTO thread_task_bindings(channel_id, thread_root_id, task_id, bound_at)
       VALUES('default', 'done1234', 'task-done-1', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO target_participants(agent_id, channel_id, thread_root_id, role, joined_at, last_active_at)
       VALUES(?, 'default', 'done1234', 'owner', ?, ?)`,
    ).run(agent.agentId, now, now);

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/update-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        task_number: 21,
        status: 'done',
      }),
    });

    expect(res.status).toBe(200);
    const participant = db.prepare(
      `SELECT role FROM target_participants
       WHERE agent_id = ? AND channel_id = 'default' AND thread_root_id = 'done1234'`,
    ).get(agent.agentId) as { role: string } | undefined;
    expect(participant?.role).toBe('participant');

    const binding = db.prepare(
      `SELECT task_id as taskId FROM thread_task_bindings
       WHERE channel_id = 'default' AND thread_root_id = 'done1234'`,
    ).get() as { taskId: string } | undefined;
    expect(binding?.taskId).toBe('task-done-1');
  });
});
