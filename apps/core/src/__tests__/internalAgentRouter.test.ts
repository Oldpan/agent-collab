import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { buildThreadShortId, type CoreToNode } from '@agent-collab/protocol';
import type { Db } from '@agent-collab/runtime-acp';
import { createRun, finishRun } from '@agent-collab/runtime-acp';
import { createTestConfig, createTestDb } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { registerInternalAgentRoutes } from '../web/internalAgentRouter.js';
import { AgentSkillsService } from '../services/agentSkillsService.js';
import { allocateNextChannelMessageSeq } from '../web/channelMessageSequences.js';
import { upsertTargetParticipant } from '../web/targetParticipants.js';

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
  const skillsService = new AgentSkillsService({
    getAgentById: (agentId) => manager.getAgent(agentId),
    broker: {
      async listSkills(
        _nodeId: string,
        skillRoots: string[],
        _params?: { agentType?: string; workspaceRoot?: string | null },
        skillPath?: string | null,
      ) {
        if (skillPath) {
          return {
            path: skillPath,
            roots: skillRoots,
            skills: [],
            entries: [
              {
                name: 'SKILL.md',
                path: `${skillPath}/SKILL.md`,
                kind: 'file',
                size: 64,
                modifiedAt: 123,
              },
            ],
          };
        }
        return {
          path: null,
          roots: skillRoots,
          skills: [
            {
              name: 'deploy',
              path: `${skillRoots[0]}/deploy/SKILL.md`,
              sourceRoot: skillRoots[0],
              description: 'Deploy workflow',
            },
          ],
          entries: [],
        };
      },
      async readSkillFile(
        _nodeId: string,
        _skillRoots: string[],
        _params: { agentType?: string; workspaceRoot?: string | null },
        skillPath: string,
      ) {
        if (!skillPath.endsWith('SKILL.md')) {
          throw new Error('not_found:Skill file not found.');
        }
        return {
          path: skillPath,
          content: '# Deploy\nUse rollout checklist.',
          mimeType: 'text/markdown' as const,
          size: 31,
          modifiedAt: 123,
        };
      },
    } as any,
  });
  registerInternalAgentRoutes(app, db, manager, () => {}, () => {}, createTestConfig().humanUserName, skillsService);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  serverClose = () => app.close();
});

beforeEach(async () => {
  await settleDispatches();
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

  it('未提供 target 时应按当前 direct conversation 的 userId 回复，而不是全局 humanUserName', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO users(id, username, password_hash, is_admin, created_at, updated_at)
       VALUES(?, ?, ?, 0, ?, ?)`,
    ).run('yanzong', 'yanzong', 'hash', now, now);
    const agent = manager.createAgent({
      name: 'Alice',
      agentType: 'codex_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/alice-router',
    });
    const conv = manager.openAgentThread(agent.agentId, 'yanzong');
    if (!conv) throw new Error('missing conversation');

    db.prepare(
      `UPDATE conversations
       SET reply_target = ?
       WHERE id = ?`,
    ).run('dm:@oldpan', conv.id);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-yanzong',
      sessionKey: sessionRow.sessionKey,
      promptText: 'reply to yanzong',
    });

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'ack yanzong',
        conversationId: conv.id,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { target?: string };
    expect(body.target).toBe('dm:@yanzong');

    const row = db.prepare(
      'SELECT target FROM channel_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(agent.agentId) as { target: string };
    expect(row.target).toBe('dm:@yanzong');
  });

  it('显式无法解析的 DM target 应返回 400 且不落库', async () => {
    const agent = manager.createAgent({
      name: 'GhostTargetBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/ghost-target-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-ghost-target',
      sessionKey: sessionRow.sessionKey,
      promptText: 'reply ghost',
    });

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'dm:@ghost',
        content: 'hello ghost',
        conversationId: conv.id,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('Cannot resolve DM target: dm:@ghost');

    const row = db.prepare(
      'SELECT COUNT(*) as count FROM channel_messages WHERE sender_id = ?',
    ).get(agent.agentId) as { count: number };
    expect(row.count).toBe(0);
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

  it('DM claim current 后应自动启动 task-thread run、写入 lifecycle event 并阻止主 DM follow-up', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO users(id, username, password_hash, is_admin, created_at, updated_at)
       VALUES('user-oldpan', 'oldpan', 'hash', 0, ?, ?)`,
    ).run(now, now);
    const agent = manager.createAgent({
      name: 'DmThreadSendBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/dm-thread-send-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const dmChannelId = `dm:${agent.agentId}`;
    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-dm-thread-send',
      sessionKey: sessionRow.sessionKey,
      promptText: 'claim current then work in thread',
    });

    const helloSeq = allocateNextChannelMessageSeq(db, dmChannelId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('dm-hello-0000-0000-0000-000000000000', ?, 'user', 'oldpan', 'user', 'dm:@oldpan', '你好', ?, ?)`,
    ).run(dmChannelId, helloSeq, now - 2);
    const helloReplySeq = allocateNextChannelMessageSeq(db, dmChannelId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('dm-hello-reply-0000-0000-0000-0000', ?, ?, ?, 'agent', 'dm:@oldpan', '你好！我是 Kimi。', ?, ?)`,
    ).run(dmChannelId, agent.agentId, agent.name, helloReplySeq, now - 1);
    const seq = allocateNextChannelMessageSeq(db, dmChannelId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('currtask-0000-0000-0000-000000000000', ?, 'user', 'oldpan', 'user', 'dm:@oldpan', 'Check memory usage and treat it as a task', ?, ?)`,
    ).run(dmChannelId, seq, now);

    const claimRes = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'dm:@oldpan',
        message_ids: ['current'],
        description: 'Inspect current memory usage and summarize the result in the task thread.',
        conversationId: conv.id,
      }),
    });
    expect(claimRes.status).toBe(200);
    const claimBody = await claimRes.json() as {
      results: Array<{
        taskNumber?: number;
        success: boolean;
        messageId?: string;
        handoffStarted?: boolean;
        threadConversationId?: string | null;
        threadTarget?: string | null;
      }>;
    };
    expect(claimBody.results[0]).toMatchObject({
      success: true,
      messageId: 'currtask-0000-0000-0000-000000000000',
      handoffStarted: true,
      threadTarget: `dm:@oldpan:${buildThreadShortId('currtask-0000-0000-0000-000000000000')}`,
    });
    expect(claimBody.results[0].threadConversationId).toBeTruthy();
    await settleDispatches();
    expect(dispatches.some((msg) => msg.type === 'run.cancel' && msg.runId === 'run-router-dm-thread-send')).toBe(true);

    const threadRun = db.prepare(
      `SELECT r.prompt_text as promptText
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ?
       ORDER BY r.started_at DESC
       LIMIT 1`,
    ).get(claimBody.results[0].threadConversationId) as { promptText: string } | undefined;
    expect(threadRun?.promptText).toContain('[DM Task Thread Handoff]');
    expect(threadRun?.promptText).toContain('[Current conversation target]');
    expect(threadRun?.promptText).toContain(`reply_target: dm:@oldpan:${buildThreadShortId('currtask-0000-0000-0000-000000000000')}`);
    expect(threadRun?.promptText).toContain('Inspect current memory usage and summarize the result in the task thread.');
    const threadDebug = db.prepare(
      `SELECT context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(claimBody.results[0].threadConversationId) as { contextText: string | null } | undefined;
    expect(threadDebug?.contextText).toContain('[Context from DM]');
    expect(threadDebug?.contextText).toContain('@oldpan: 你好');
    expect(threadDebug?.contextText).toContain(`@${agent.name}: 你好！我是 Kimi。`);
    expect(threadDebug?.contextText).toContain('@oldpan [Trigger]: Check memory usage and treat it as a task');

    const blockedRes = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Memory usage looks healthy.\n- Total: 64 GB\n- Used: 31 GB\n- Free: 33 GB',
        conversationId: conv.id,
      }),
    });

    expect(blockedRes.status).toBe(409);
    expect(await blockedRes.json()).toEqual({
      error: `This run already handed off DM task work to dm:@oldpan:${buildThreadShortId('currtask-0000-0000-0000-000000000000')}. Do not continue work in dm:@oldpan; the platform mirrors task status there and detailed execution belongs in the task thread conversation.`,
    });

    const lifecycleRow = db.prepare(
      `SELECT sender_type as senderType, content, message_source as messageSource
       FROM channel_messages
       WHERE channel_id = ?
         AND target = 'dm:@oldpan'
         AND message_source = 'task_lifecycle'
       ORDER BY created_at DESC, seq DESC
       LIMIT 1`,
    ).get(dmChannelId) as { senderType: string; content: string; messageSource: string } | undefined;
    expect(lifecycleRow).toEqual({
      senderType: 'system',
      content: 'Started #1 "Check memory usage and treat it as a task". Detailed work continues in the task thread.',
      messageSource: 'task_lifecycle',
    });
  });

  it('DM handoff 后任何显式 send 都会被 gate 拦住，不会再落回主 DM', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO users(id, username, password_hash, is_admin, created_at, updated_at)
       VALUES('user-oldpan', 'oldpan', 'hash', 0, ?, ?)`,
    ).run(now, now);
    const agent = manager.createAgent({
      name: 'DmThreadOverrideBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/dm-thread-override-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const dmChannelId = `dm:${agent.agentId}`;
    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-dm-thread-override',
      sessionKey: sessionRow.sessionKey,
      promptText: 'keep valid override after invalid thread send',
    });

    const seq = allocateNextChannelMessageSeq(db, dmChannelId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('keepovrd-0000-0000-0000-000000000000', ?, 'user', 'oldpan', 'user', 'dm:@oldpan', 'Turn this into a task and keep the thread target', ?, ?)`,
    ).run(dmChannelId, seq, now);

    const claimRes = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'dm:@oldpan',
        message_ids: ['current'],
        description: 'Do the requested work and keep subsequent updates in the task thread.',
        conversationId: conv.id,
      }),
    });
    expect(claimRes.status).toBe(200);

    const invalidSendRes = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'dm:@oldpan:missing00',
        content: 'this should fail',
        conversationId: conv.id,
      }),
    });
    expect(invalidSendRes.status).toBe(409);
    expect(await invalidSendRes.json()).toEqual({
      error: `This run already handed off DM task work to dm:@oldpan:${buildThreadShortId('keepovrd-0000-0000-0000-000000000000')}. Do not continue work in dm:@oldpan; the platform mirrors task status there and detailed execution belongs in the task thread conversation.`,
    });

    const rows = db.prepare(
      `SELECT target
       FROM channel_messages
       WHERE sender_id = ?
       ORDER BY created_at ASC, seq ASC`,
    ).all(agent.agentId) as Array<{ target: string }>;
    expect(rows).toEqual([]);
  });

  it('DM create_tasks 在 primary DM 中应自动启动 task-thread run', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO users(id, username, password_hash, is_admin, created_at, updated_at)
       VALUES('user-oldpan', 'oldpan', 'hash', 0, ?, ?)`,
    ).run(now, now);
    const agent = manager.createAgent({
      name: 'DmThreadClearBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/dm-thread-clear-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const dmChannelId = `dm:${agent.agentId}`;
    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-dm-task-create',
      sessionKey: sessionRow.sessionKey,
      promptText: 'create a DM task and hand it off',
    });

    const seq = allocateNextChannelMessageSeq(db, dmChannelId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('createtg-0000-0000-0000-000000000000', ?, 'user', 'oldpan', 'user', 'dm:@oldpan', 'Please create a task for this work', ?, ?)`,
    ).run(dmChannelId, seq, now);

    const createRes = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'dm:@oldpan',
        tasks: [{
          title: 'Check memory usage',
          description: 'Inspect memory usage and keep all substantive work in the task thread.',
        }],
        conversationId: conv.id,
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json() as {
      tasks: Array<{
        taskNumber: number;
        messageId: string;
        handoffStarted?: boolean;
        threadConversationId?: string | null;
        threadTarget?: string | null;
      }>;
    };
    expect(createBody.tasks).toHaveLength(1);
    expect(createBody.tasks[0].taskNumber).toBe(1);
    expect(createBody.tasks[0].handoffStarted).toBe(true);
    expect(createBody.tasks[0].threadConversationId).toBeTruthy();
    expect(createBody.tasks[0].threadTarget).toBe(`dm:@oldpan:${buildThreadShortId(createBody.tasks[0].messageId)}`);
    const createdTaskRow = db.prepare(
      `SELECT status, claimed_by_agent_id as claimedByAgentId
       FROM tasks
       WHERE message_id = ?`,
    ).get(createBody.tasks[0].messageId) as { status: string; claimedByAgentId: string | null };
    expect(createdTaskRow).toEqual({
      status: 'in_progress',
      claimedByAgentId: agent.agentId,
    });

    const threadRun = db.prepare(
      `SELECT r.prompt_text as promptText
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ?
       ORDER BY r.started_at DESC
       LIMIT 1`,
    ).get(createBody.tasks[0].threadConversationId) as { promptText: string } | undefined;
    expect(threadRun?.promptText).toContain('[DM Task Thread Handoff]');
    expect(threadRun?.promptText).toContain('[Current conversation target]');
    expect(threadRun?.promptText).toContain(`reply_target: ${createBody.tasks[0].threadTarget}`);
    expect(threadRun?.promptText).toContain('Inspect memory usage and keep all substantive work in the task thread.');

    const blockedRes = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Memory usage inspected.\n- Used: 31 GB\n- Free: 33 GB',
        conversationId: conv.id,
      }),
    });
    expect(blockedRes.status).toBe(409);
    expect(await blockedRes.json()).toEqual({
      error: `This run already handed off DM task work to ${createBody.tasks[0].threadTarget}. Do not continue work in dm:@oldpan; the platform mirrors task status there and detailed execution belongs in the task thread conversation.`,
    });
  });

  it('send_message 在仅有持久化 handoff 事件时仍应返回 409', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO users(id, username, password_hash, is_admin, created_at, updated_at)
       VALUES('user-oldpan', 'oldpan', 'hash', 0, ?, ?)`,
    ).run(now, now);
    const agent = manager.createAgent({
      name: 'PersistedGateBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/persisted-gate-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-persisted-handoff',
      sessionKey: sessionRow.sessionKey,
      promptText: 'already handed off',
    });
    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, 1, 'platform/handoff', ?, ?)`,
    ).run(
      'run-router-persisted-handoff',
      JSON.stringify({
        status: 'started',
        primaryTarget: 'dm:@oldpan',
        threadTarget: 'dm:@oldpan:persist01',
        taskNumber: 1,
      }),
      now,
    );

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'this should still be blocked',
        conversationId: conv.id,
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This run already handed off DM task work to dm:@oldpan:persist01. Do not continue work in dm:@oldpan; the platform mirrors task status there and detailed execution belongs in the task thread conversation.',
    });
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
    await expectDispatchCount(1);

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

  it('同批被 @mention 唤醒的多个 agent 应看到一致的 active participants', async () => {
    // 使用独立 channel 避免 default channel 的参与者记录污染
    const batchChannel = manager.createChannel({ name: 'batch-mention-channel' });
    const tab = manager.createAgent({
      name: 'BatchTab',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/batch-tab-router',
      channelId: batchChannel.channelId,
    });
    const bob = manager.createAgent({
      name: 'BatchBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/batch-bob-router',
      channelId: batchChannel.channelId,
    });
    const carol = manager.createAgent({
      name: 'BatchCarol',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/batch-carol-router',
      channelId: batchChannel.channelId,
    });
    manager.joinChannel(tab.agentId, batchChannel.channelId);
    manager.joinChannel(bob.agentId, batchChannel.channelId);
    manager.joinChannel(carol.agentId, batchChannel.channelId);

    const conv = manager.openAgentChannelThread(tab.agentId, batchChannel.channelId, null);
    if (!conv) throw new Error('missing batch root conversation');

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-agent-mention-batch',
      sessionKey: sessionRow.sessionKey,
      promptText: 'wake both helpers',
    });

    dispatches.length = 0;
    const res = await fetch(`${baseUrl}/api/internal/agent/${tab.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: `#${batchChannel.name}`,
        content: 'Need both of you here, @BatchBob and @BatchCarol.',
        kind: 'progress',
        conversationId: conv.id,
      }),
    });

    expect(res.status).toBe(200);
    await expectDispatchCount(2);

    const bobConv = manager.openAgentChannelThread(bob.agentId, batchChannel.channelId, null);
    const carolConv = manager.openAgentChannelThread(carol.agentId, batchChannel.channelId, null);
    if (!bobConv || !carolConv) throw new Error('missing batch target conversations');

    const runDispatches = dispatches.filter((msg): msg is Extract<CoreToNode, { type: 'run.dispatch' }> => msg.type === 'run.dispatch');
    const bobDispatch = runDispatches.find((msg) => msg.conversationId === bobConv.id);
    const carolDispatch = runDispatches.find((msg) => msg.conversationId === carolConv.id);
    const extractParticipants = (text?: string) => (
      /\[Active participants on this target\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(text ?? '')?.[1]?.trim() ?? ''
    );

    expect(extractParticipants(bobDispatch?.contextText)).toBe(
      '@BatchBob (participant)\n@BatchCarol (participant)\n@BatchTab (participant)',
    );
    expect(extractParticipants(carolDispatch?.contextText)).toBe(
      '@BatchBob (participant)\n@BatchCarol (participant)\n@BatchTab (participant)',
    );
  });

  it('带有 multi-mention suppress metadata 的根频道 run 在 progress 后再次 @ 已在场 peer 时不应二次唤醒', async () => {
    const alpha = manager.createAgent({
      name: 'SuppressAlpha',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/suppress-alpha-router',
      channelId: 'default',
    });
    const bob = manager.createAgent({
      name: 'SuppressBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/suppress-bob-router',
      channelId: 'default',
    });
    manager.joinChannel(alpha.agentId, 'default');
    manager.joinChannel(bob.agentId, 'default');

    const conv = manager.openAgentChannelThread(alpha.agentId, 'default', null);
    if (!conv) throw new Error('missing suppress root conversation');
    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-suppress-progress-window',
      sessionKey: sessionRow.sessionKey,
      promptText: 'first-wave root multi-mention reply',
    });
    const now = Date.now();
    db.prepare(
      `INSERT INTO run_debug_inputs(
         run_id, conversation_id, session_key, dispatch_mode, reply_target,
         prompt_text, dispatched_prompt_text, activation_metadata_json, created_at, updated_at
       )
       VALUES(?, ?, ?, 'resume', ?, ?, ?, ?, ?, ?)`,
    ).run(
      'run-router-suppress-progress-window',
      conv.id,
      sessionRow.sessionKey,
      '#default',
      'first-wave root multi-mention reply',
      'first-wave root multi-mention reply',
      JSON.stringify({
        mentionSuppression: {
          mode: 'root_user_multi_mention',
          triggerSeq: 401,
          peerMentionedAgentIds: [bob.agentId],
        },
      }),
      now,
      now,
    );

    const progressRes = await fetch(`${baseUrl}/api/internal/agent/${alpha.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: '#default',
        content: '先说明一下背景，我先看下上下文。',
        kind: 'progress',
        conversationId: conv.id,
      }),
    });
    expect(progressRes.status).toBe(200);
    await settleDispatches();
    dispatches.length = 0;

    const mentionRes = await fetch(`${baseUrl}/api/internal/agent/${alpha.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: '#default',
        content: '收到，@SuppressBob 我这边先同步一下当前情况。',
        kind: 'final',
        conversationId: conv.id,
      }),
    });
    expect(mentionRes.status).toBe(200);
    await settleDispatches();
    expect(dispatches.filter((msg) => msg.type === 'run.dispatch')).toHaveLength(0);

    const cooldownRows = db.prepare(
      `SELECT COUNT(*) as count
       FROM agent_mention_cooldowns
       WHERE channel_id = ? AND thread_root_id = '' AND from_agent_id = ? AND to_agent_id = ?`,
    ).get('default', alpha.agentId, bob.agentId) as { count: number };
    expect(cooldownRows.count).toBe(0);
  });

  it('multi-mention suppress metadata 不应误伤 thread 中的真实 agent mention', async () => {
    const alpha = manager.createAgent({
      name: 'SuppressThreadAlpha',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/suppress-thread-alpha-router',
      channelId: 'default',
    });
    const bob = manager.createAgent({
      name: 'SuppressThreadBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/suppress-thread-bob-router',
      channelId: 'default',
    });
    manager.joinChannel(alpha.agentId, 'default');
    manager.joinChannel(bob.agentId, 'default');

    const threadRootId = 'suppress-thread-1';
    const conv = manager.openAgentChannelThread(alpha.agentId, 'default', threadRootId);
    const bobConv = manager.openAgentChannelThread(bob.agentId, 'default', threadRootId);
    if (!conv || !bobConv) throw new Error('missing suppress thread conversations');

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-suppress-thread-safe',
      sessionKey: sessionRow.sessionKey,
      promptText: 'thread collaboration reply',
    });
    const now = Date.now();
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES('suppress-thread-root-msg', 'default', 'user', 'User', 'user', ?, 'thread root', 501, ?, ?)`,
    ).run(`#default:${threadRootId}`, now, threadRootId);
    db.prepare(
      `INSERT INTO run_debug_inputs(
         run_id, conversation_id, session_key, dispatch_mode, reply_target,
         prompt_text, dispatched_prompt_text, activation_metadata_json, created_at, updated_at
       )
       VALUES(?, ?, ?, 'resume', ?, ?, ?, ?, ?, ?)`,
    ).run(
      'run-router-suppress-thread-safe',
      conv.id,
      sessionRow.sessionKey,
      `#default:${threadRootId}`,
      'thread collaboration reply',
      'thread collaboration reply',
      JSON.stringify({
        mentionSuppression: {
          mode: 'root_user_multi_mention',
          triggerSeq: 502,
          peerMentionedAgentIds: [bob.agentId],
        },
      }),
      now,
      now,
    );

    dispatches.length = 0;
    const res = await fetch(`${baseUrl}/api/internal/agent/${alpha.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: `#default:${threadRootId}`,
        content: '需要你一起看这个线程，@SuppressThreadBob。',
        kind: 'progress',
        conversationId: conv.id,
      }),
    });
    expect(res.status).toBe(200);
    await expectDispatchCount(1);

    const taskDispatch = dispatches
      .filter((msg): msg is Extract<CoreToNode, { type: 'run.dispatch' }> => msg.type === 'run.dispatch')
      .find((msg) => msg.conversationId === bobConv.id);
    expect(taskDispatch?.prompt).toContain('Another agent (@SuppressThreadAlpha) explicitly asked for your help in #default.');
  });

  it('agent 在主频道 @ 多个 agent 且其中一个已 active 时，应让 active 目标先排队、其余目标正常派发，并保持 participants 一致', async () => {
    const tab = manager.createAgent({
      name: 'RootQueueTab',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/root-queue-tab-router',
      channelId: 'default',
    });
    const bob = manager.createAgent({
      name: 'RootQueueBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/root-queue-bob-router',
      channelId: 'default',
    });
    const carol = manager.createAgent({
      name: 'RootQueueCarol',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/root-queue-carol-router',
      channelId: 'default',
    });
    manager.joinChannel(tab.agentId, 'default');
    manager.joinChannel(bob.agentId, 'default');
    manager.joinChannel(carol.agentId, 'default');

    const tabConv = manager.openAgentChannelThread(tab.agentId, 'default', null);
    const bobConv = manager.openAgentChannelThread(bob.agentId, 'default', null);
    const carolConv = manager.openAgentChannelThread(carol.agentId, 'default', null);
    if (!tabConv || !bobConv || !carolConv) throw new Error('missing root queue conversations');

    const tabSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(tabConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-root-queue-tab',
      sessionKey: tabSession.sessionKey,
      promptText: 'root queue sender',
    });

    const bobSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(bobConv.id) as { sessionKey: string };
    const busyRunId = 'run-router-root-queue-bob-busy';
    createRun(db, {
      runId: busyRunId,
      sessionKey: bobSession.sessionKey,
      promptText: 'already active on root channel',
    });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('active', bobConv.id);

    dispatches.length = 0;
    const res = await fetch(`${baseUrl}/api/internal/agent/${tab.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: '#default',
        content: 'Need both of you here, @RootQueueBob and @RootQueueCarol.',
        kind: 'progress',
        conversationId: tabConv.id,
      }),
    });

    expect(res.status).toBe(200);
    await expectDispatchCount(1);

    const getRunDispatches = () => dispatches.filter((msg): msg is Extract<CoreToNode, { type: 'run.dispatch' }> => msg.type === 'run.dispatch');
    const carolDispatch = getRunDispatches().find((msg) => msg.conversationId === carolConv.id);
    expect(carolDispatch).toBeTruthy();

    const bobQueuedRow = db.prepare(
      `SELECT prompt_text as promptText, activation_context_text as activationContextText
       FROM conversation_prompt_queue
       WHERE conversation_id = ?
       ORDER BY queue_id DESC
       LIMIT 1`,
    ).get(bobConv.id) as { promptText: string; activationContextText: string | null } | undefined;
    expect(bobQueuedRow?.promptText).toContain('Another agent (@RootQueueTab) explicitly asked for your help in #default.');
    expect(carolDispatch?.prompt).toContain('Another agent (@RootQueueTab) explicitly asked for your help in #default.');

    const extractParticipants = (text?: string | null) => (
      /\[Active participants on this target\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(text ?? '')?.[1]?.trim() ?? ''
    );
    const queuedParticipants = extractParticipants(bobQueuedRow?.activationContextText);
    const dispatchedParticipants = extractParticipants(carolDispatch?.contextText);
    expect(queuedParticipants).toBe(dispatchedParticipants);
    expect(queuedParticipants).toContain('@RootQueueBob');
    expect(queuedParticipants).toContain('@RootQueueCarol');
    expect(queuedParticipants).toContain('@RootQueueTab');

    finishRun(db, { runId: busyRunId, stopReason: 'end_turn' });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', bobConv.id);
    await manager.onConversationSettled(bobConv.id);

    const bobRunDispatch = getRunDispatches().find((msg) => msg.conversationId === bobConv.id);
    expect(bobRunDispatch).toBeTruthy();
    expect(bobRunDispatch?.dispatchMode).toBe('resume');
    expect(bobRunDispatch?.prompt).toContain('Need both of you here, @RootQueueBob and @RootQueueCarol.');
    expect(extractParticipants(bobRunDispatch?.contextText)).toBe(dispatchedParticipants);
  });

  it('agent 在主频道普通消息中，不应无故唤醒其他 root agents', async () => {
    const tab = manager.createAgent({
      name: 'PlainRootTab',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/plain-root-tab-router',
      channelId: 'default',
    });
    const bob = manager.createAgent({
      name: 'PlainRootBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/plain-root-bob-router',
      channelId: 'default',
    });
    const carol = manager.createAgent({
      name: 'PlainRootCarol',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/plain-root-carol-router',
      channelId: 'default',
    });
    manager.joinChannel(tab.agentId, 'default');
    manager.joinChannel(bob.agentId, 'default');
    manager.joinChannel(carol.agentId, 'default');

    const tabConv = manager.openAgentChannelThread(tab.agentId, 'default', null);
    const bobConv = manager.openAgentChannelThread(bob.agentId, 'default', null);
    const carolConv = manager.openAgentChannelThread(carol.agentId, 'default', null);
    if (!tabConv || !bobConv || !carolConv) throw new Error('missing plain root conversations');

    const tabSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(tabConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-plain-root-tab',
      sessionKey: tabSession.sessionKey,
      promptText: 'plain root update',
    });

    dispatches.length = 0;
    const res = await fetch(`${baseUrl}/api/internal/agent/${tab.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: '#default',
        content: 'This is a normal root-channel update without any explicit mentions.',
        kind: 'progress',
        conversationId: tabConv.id,
      }),
    });

    expect(res.status).toBe(200);
    expect(dispatches.filter((msg) => msg.type === 'run.dispatch')).toHaveLength(0);

    for (const conv of [bobConv, carolConv]) {
      const runCount = db.prepare(
        `SELECT COUNT(*) as count
         FROM runs
         WHERE session_key = (SELECT session_key FROM conversations WHERE id = ?)`,
      ).get(conv.id) as { count: number };
      expect(runCount.count).toBe(0);
    }

    const participantCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM target_participants
       WHERE channel_id = 'default' AND thread_root_id = '' AND agent_id IN (?, ?)`,
    ).get(bob.agentId, carol.agentId) as { count: number };
    expect(participantCount.count).toBe(0);
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
    await expectDispatchCount(1);

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

  it('agent 在线程发普通回复时应唤醒最近活跃的其他 thread participants', async () => {
    const alice = manager.createAgent({
      name: 'RecentAlice',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/recent-alice-router',
      channelId: 'default',
    });
    const bob = manager.createAgent({
      name: 'RecentBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/recent-bob-router',
      channelId: 'default',
    });
    manager.joinChannel(alice.agentId, 'default');
    manager.joinChannel(bob.agentId, 'default');

    const threadRootId = 'recent123';
    const aliceConv = manager.openAgentChannelThread(alice.agentId, 'default', threadRootId);
    const bobConv = manager.openAgentChannelThread(bob.agentId, 'default', threadRootId);
    if (!aliceConv || !bobConv) throw new Error('missing recent thread conversations');

    upsertTargetParticipant(db, {
      agentId: bob.agentId,
      channelId: 'default',
      threadRootId,
      role: 'participant',
      lastActiveAt: Date.now(),
    });

    const aliceSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(aliceConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-thread-recent',
      sessionKey: aliceSession.sessionKey,
      promptText: 'continue the thread',
    });

    dispatches.length = 0;
    const res = await fetch(`${baseUrl}/api/internal/agent/${alice.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: `#default:${threadRootId}`,
        content: 'Here is a normal follow-up in the thread.',
        kind: 'progress',
        conversationId: aliceConv.id,
      }),
    });

    expect(res.status).toBe(200);
    await expectDispatchCount(1);

    const bobSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(bobConv.id) as { sessionKey: string };
    const runRow = db.prepare(
      'SELECT prompt_text as promptText FROM runs WHERE session_key = ? ORDER BY started_at DESC LIMIT 1',
    ).get(bobSession.sessionKey) as { promptText: string } | undefined;
    expect(runRow?.promptText).toContain('Your collaborative thread in #default received a reply from RecentAlice.');
    expect(runRow?.promptText).toContain(`#default:${threadRootId.slice(0, 8)}`);
  });

  it('agent 在线程 @ 多个 agent 且其中一个已 active 时，应让 active 目标先排队、其余目标正常派发，并保持 participants 一致', async () => {
    const tab = manager.createAgent({
      name: 'ThreadQueueTab',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/thread-queue-tab-router',
      channelId: 'default',
    });
    const bob = manager.createAgent({
      name: 'ThreadQueueBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/thread-queue-bob-router',
      channelId: 'default',
    });
    const carol = manager.createAgent({
      name: 'ThreadQueueCarol',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/thread-queue-carol-router',
      channelId: 'default',
    });
    manager.joinChannel(tab.agentId, 'default');
    manager.joinChannel(bob.agentId, 'default');
    manager.joinChannel(carol.agentId, 'default');

    const threadRootId = 'thrq1234';
    const tabConv = manager.openAgentChannelThread(tab.agentId, 'default', threadRootId);
    const bobConv = manager.openAgentChannelThread(bob.agentId, 'default', threadRootId);
    const carolConv = manager.openAgentChannelThread(carol.agentId, 'default', threadRootId);
    if (!tabConv || !bobConv || !carolConv) throw new Error('missing thread queue conversations');

    const now = Date.now();
    const rootSeq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES(?, 'default', ?, ?, 'agent', '#default', ?, ?, ?, ?)`,
    ).run(
      `${threadRootId}-0000-0000-0000-000000000000`,
      tab.agentId,
      tab.name,
      'Thread queue root',
      rootSeq,
      now,
      threadRootId,
    );
    upsertTargetParticipant(db, {
      agentId: tab.agentId,
      channelId: 'default',
      threadRootId,
      role: 'owner',
      lastActiveAt: now,
    });
    upsertTargetParticipant(db, {
      agentId: bob.agentId,
      channelId: 'default',
      threadRootId,
      role: 'participant',
      lastActiveAt: now,
    });
    upsertTargetParticipant(db, {
      agentId: carol.agentId,
      channelId: 'default',
      threadRootId,
      role: 'participant',
      lastActiveAt: now,
    });

    const tabSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(tabConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-thread-queue-tab',
      sessionKey: tabSession.sessionKey,
      promptText: 'thread queue sender',
    });

    const bobSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(bobConv.id) as { sessionKey: string };
    const busyRunId = 'run-router-thread-queue-bob-busy';
    createRun(db, {
      runId: busyRunId,
      sessionKey: bobSession.sessionKey,
      promptText: 'already active on thread',
    });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('active', bobConv.id);

    dispatches.length = 0;
    const res = await fetch(`${baseUrl}/api/internal/agent/${tab.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: `#default:${threadRootId}`,
        content: 'Need both of you on this thread, @ThreadQueueBob and @ThreadQueueCarol.',
        kind: 'progress',
        conversationId: tabConv.id,
      }),
    });

    expect(res.status).toBe(200);
    await expectDispatchCount(1);

    const getRunDispatches = () => dispatches.filter((msg): msg is Extract<CoreToNode, { type: 'run.dispatch' }> => msg.type === 'run.dispatch');
    const carolDispatch = getRunDispatches().find((msg) => msg.conversationId === carolConv.id);
    expect(carolDispatch).toBeTruthy();

    const bobQueuedRow = db.prepare(
      `SELECT prompt_text as promptText, activation_context_text as activationContextText
       FROM conversation_prompt_queue
       WHERE conversation_id = ?
       ORDER BY queue_id DESC
       LIMIT 1`,
    ).get(bobConv.id) as { promptText: string; activationContextText: string | null } | undefined;
    expect(bobQueuedRow?.promptText).toContain('Another agent (@ThreadQueueTab) explicitly asked for your help in #default.');
    expect(carolDispatch?.prompt).toContain('Another agent (@ThreadQueueTab) explicitly asked for your help in #default.');

    const extractParticipants = (text?: string | null) => (
      /\[Active participants on this target\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(text ?? '')?.[1]?.trim() ?? ''
    );
    const queuedParticipants = extractParticipants(bobQueuedRow?.activationContextText);
    const dispatchedParticipants = extractParticipants(carolDispatch?.contextText);
    expect(queuedParticipants).toBe(dispatchedParticipants);
    expect(queuedParticipants).toContain('@ThreadQueueTab');
    expect(queuedParticipants).toContain('@ThreadQueueBob');
    expect(queuedParticipants).toContain('@ThreadQueueCarol');

    finishRun(db, { runId: busyRunId, stopReason: 'end_turn' });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', bobConv.id);
    await manager.onConversationSettled(bobConv.id);

    const bobRunDispatch = getRunDispatches().find((msg) => msg.conversationId === bobConv.id);
    expect(bobRunDispatch).toBeTruthy();
    expect(bobRunDispatch?.dispatchMode).toBe('resume');
    expect(bobRunDispatch?.prompt).toContain('Need both of you on this thread, @ThreadQueueBob and @ThreadQueueCarol.');
    expect(extractParticipants(bobRunDispatch?.contextText)).toBe(dispatchedParticipants);
  });

  it('3A+0U 多轮 thread 协作中，active agent 应先进入 queue，再在后续 round 以相同上下文重新派发', async () => {
    const alice = manager.createAgent({
      name: 'RoundAlice',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/round-alice-router',
      channelId: 'default',
    });
    const bob = manager.createAgent({
      name: 'RoundBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/round-bob-router',
      channelId: 'default',
    });
    const carol = manager.createAgent({
      name: 'RoundCarol',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/round-carol-router',
      channelId: 'default',
    });
    manager.joinChannel(alice.agentId, 'default');
    manager.joinChannel(bob.agentId, 'default');
    manager.joinChannel(carol.agentId, 'default');

    const threadRootId = 'round1234';
    const aliceConv = manager.openAgentChannelThread(alice.agentId, 'default', threadRootId);
    const bobConv = manager.openAgentChannelThread(bob.agentId, 'default', threadRootId);
    const carolConv = manager.openAgentChannelThread(carol.agentId, 'default', threadRootId);
    if (!aliceConv || !bobConv || !carolConv) throw new Error('missing round thread conversations');

    const now = Date.now();
    upsertTargetParticipant(db, {
      agentId: alice.agentId,
      channelId: 'default',
      threadRootId,
      role: 'participant',
      lastActiveAt: now,
    });
    upsertTargetParticipant(db, {
      agentId: bob.agentId,
      channelId: 'default',
      threadRootId,
      role: 'owner',
      lastActiveAt: now,
    });
    upsertTargetParticipant(db, {
      agentId: carol.agentId,
      channelId: 'default',
      threadRootId,
      role: 'participant',
      lastActiveAt: now,
    });

    const bobSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(bobConv.id) as { sessionKey: string };
    const busyRunId = 'run-router-round-bob-busy';
    createRun(db, {
      runId: busyRunId,
      sessionKey: bobSession.sessionKey,
      promptText: 'already active on this thread',
    });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('active', bobConv.id);

    const aliceSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(aliceConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-round-alice',
      sessionKey: aliceSession.sessionKey,
      promptText: 'round one',
    });

    dispatches.length = 0;
    const res = await fetch(`${baseUrl}/api/internal/agent/${alice.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: `#default:${threadRootId}`,
        content: 'First round update from Alice.',
        kind: 'progress',
        conversationId: aliceConv.id,
      }),
    });

    expect(res.status).toBe(200);
    await expectDispatchCount(1);

    const initialRunDispatches = dispatches.filter((msg): msg is Extract<CoreToNode, { type: 'run.dispatch' }> => msg.type === 'run.dispatch');
    const carolDispatch = initialRunDispatches.find((msg) => msg.conversationId === carolConv.id);
    expect(carolDispatch).toBeTruthy();
    expect(carolDispatch?.prompt).toContain('Your collaborative thread in #default received a reply from RoundAlice.');

    const queuedRow = db.prepare(
      `SELECT prompt_text as promptText,
              activation_context_text as activationContextText
       FROM conversation_prompt_queue
       WHERE conversation_id = ?
       ORDER BY queue_id ASC
       LIMIT 1`,
    ).get(bobConv.id) as { promptText: string; activationContextText: string | null } | undefined;
    expect(queuedRow?.promptText).toContain('Your collaborative thread in #default received a reply from RoundAlice.');
    expect(queuedRow?.activationContextText).toContain('[Active participants on this target]');
    expect(queuedRow?.activationContextText).toContain('@RoundBob (owner)');
    expect(queuedRow?.activationContextText).toContain('@RoundAlice (participant)');
    expect(queuedRow?.activationContextText).toContain('@RoundCarol (participant)');

    finishRun(db, { runId: busyRunId, stopReason: 'end_turn' });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', bobConv.id);

    await manager.onConversationSettled(bobConv.id);

    const bobRunDispatch = dispatches
      .filter((msg): msg is Extract<CoreToNode, { type: 'run.dispatch' }> => msg.type === 'run.dispatch')
      .find((msg) => msg.conversationId === bobConv.id);
    expect(bobRunDispatch).toBeTruthy();
    expect(bobRunDispatch?.dispatchMode).toBe('resume');
    expect(dispatches.filter((msg) => msg.type === 'run.dispatch')).toHaveLength(2);
    expect(bobRunDispatch?.prompt).toContain('First round update from Alice.');

    const participantSection = (text?: string) => (
      /\[Active participants on this target\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(text ?? '')?.[1]?.trim() ?? ''
    );

    expect(participantSection(bobRunDispatch?.contextText)).toBe(participantSection(carolDispatch?.contextText));
    expect(participantSection(bobRunDispatch?.contextText)).toBe(
      '@RoundBob (owner)\n@RoundAlice (participant)\n@RoundCarol (participant)',
    );
  });

  it('task thread 普通回复应优先唤醒 assignee，并在 prompt 中注入 bound task 上下文', async () => {
    const alice = manager.createAgent({
      name: 'TaskRootAlice',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/task-root-alice-router',
      channelId: 'default',
    });
    const bob = manager.createAgent({
      name: 'TaskOwnerBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/task-owner-bob-router',
      channelId: 'default',
    });
    manager.joinChannel(alice.agentId, 'default');
    manager.joinChannel(bob.agentId, 'default');

    const threadRootId = 'taskc123';
    const aliceConv = manager.openAgentChannelThread(alice.agentId, 'default', threadRootId);
    const bobConv = manager.openAgentChannelThread(bob.agentId, 'default', threadRootId);
    if (!aliceConv || !bobConv) throw new Error('missing task thread conversations');

    const now = Date.now();
    const rootSeq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES(?, 'default', ?, ?, 'agent', '#default', ?, ?, ?)`,
    ).run('taskc123-0000-0000-0000-000000000000', alice.agentId, alice.name, 'Task root', rootSeq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
       VALUES(?, 'default', 12, 'Investigate rollout', 'Goal: reproduce the issue. Done when root cause and fix are posted in this thread.', 'in_progress', ?, ?, ?, ?, ?)`,
    ).run(
      'task-thread-owner',
      bob.agentId,
      bob.name,
      'taskc123-0000-0000-0000-000000000000',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, created_at, updated_at)
       VALUES('task-other-open', 'default', 13, 'Other open task', 'todo', ?, ?)`,
    ).run(now, now);

    const aliceSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(aliceConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-task-thread-owner',
      sessionKey: aliceSession.sessionKey,
      promptText: 'continue task thread',
    });

    dispatches.length = 0;
    const res = await fetch(`${baseUrl}/api/internal/agent/${alice.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: `#default:${threadRootId}`,
        content: 'Posting a normal progress update inside the task thread.',
        kind: 'progress',
        conversationId: aliceConv.id,
      }),
    });

    expect(res.status).toBe(200);
    await expectDispatchCount(1);

    const taskDispatch = dispatches
      .filter((msg): msg is Extract<CoreToNode, { type: 'run.dispatch' }> => msg.type === 'run.dispatch')
      .find((msg) => msg.conversationId === bobConv.id);
    expect(taskDispatch?.prompt).toContain('Your collaborative thread in #default received a reply from TaskRootAlice.');
    expect(taskDispatch?.contextText).toContain('[Bound task-message for this thread]');
    expect(taskDispatch?.contextText).toContain('#12 [in_progress] @TaskOwnerBob — Investigate rollout');
    expect(taskDispatch?.contextText).toContain('Goal: reproduce the issue. Done when root cause and fix are posted in this thread.');
    expect(taskDispatch?.contextText).toContain('@TaskOwnerBob (owner)');
    expect(taskDispatch?.contextText).toContain('@TaskRootAlice (participant)');
    expect(taskDispatch?.contextText).not.toContain('[Task-message board summary]');
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
    await settleDispatches();
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

    await expectDispatchCount(1);

    const cooldownRows = db.prepare(
      `SELECT COUNT(*) as count
       FROM agent_mention_cooldowns
       WHERE channel_id = ? AND thread_root_id = '' AND from_agent_id = ? AND to_agent_id = ?`,
    ).get('default', tab.agentId, bob.agentId) as { count: number };
    expect(cooldownRows.count).toBe(1);
  });

  it('agent mention 命中当前 target 的活跃 conversation 时应进入 queue，而不是并行 dispatch', async () => {
    const alice = manager.createAgent({
      name: 'QueueAlice',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/queue-alice-router',
      channelId: 'default',
    });
    const bob = manager.createAgent({
      name: 'QueueBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/queue-bob-router',
      channelId: 'default',
    });
    manager.joinChannel(alice.agentId, 'default');
    manager.joinChannel(bob.agentId, 'default');

    const threadRootId = 'thrdq123';
    const aliceConv = manager.openAgentChannelThread(alice.agentId, 'default', threadRootId);
    const bobConv = manager.openAgentChannelThread(bob.agentId, 'default', threadRootId);
    if (!aliceConv || !bobConv) throw new Error('missing thread conversations');

    const bobSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(bobConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-agent-mention-queue',
      sessionKey: bobSession.sessionKey,
      promptText: 'already active on this thread',
    });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('active', bobConv.id);

    dispatches.length = 0;
    const res = await fetch(`${baseUrl}/api/internal/agent/${alice.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: `#default:${threadRootId}`,
        content: 'Queue this follow-up for @QueueBob please.',
        kind: 'progress',
        conversationId: aliceConv.id,
      }),
    });

    expect(res.status).toBe(200);
    await settleDispatches();
    expect(dispatches.filter((msg) => msg.type === 'run.dispatch')).toHaveLength(0);

    const queueRows = db.prepare(
      `SELECT conversation_id as conversationId, prompt_text as promptText
       FROM conversation_prompt_queue
       WHERE conversation_id = ?
       ORDER BY queue_id ASC`,
    ).all(bobConv.id) as Array<{ conversationId: string; promptText: string }>;
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0]?.conversationId).toBe(bobConv.id);
    expect(queueRows[0]?.promptText).toContain('@QueueBob');
  });

  it('thread 中显式 agent mention 应覆盖普通 thread_reply reason', async () => {
    const alice = manager.createAgent({
      name: 'PriorityAlice',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/priority-alice-router',
      channelId: 'default',
    });
    const bob = manager.createAgent({
      name: 'PriorityBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/priority-bob-router',
      channelId: 'default',
    });
    manager.joinChannel(alice.agentId, 'default');
    manager.joinChannel(bob.agentId, 'default');

    const threadRootId = 'prio1234';
    const aliceConv = manager.openAgentChannelThread(alice.agentId, 'default', threadRootId);
    const bobConv = manager.openAgentChannelThread(bob.agentId, 'default', threadRootId);
    if (!aliceConv || !bobConv) throw new Error('missing priority thread conversations');

    upsertTargetParticipant(db, {
      agentId: bob.agentId,
      channelId: 'default',
      threadRootId,
      role: 'participant',
      lastActiveAt: Date.now(),
    });

    const aliceSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(aliceConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-priority-alice',
      sessionKey: aliceSession.sessionKey,
      promptText: 'priority thread sender',
    });

    const bobSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(bobConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-router-priority-bob',
      sessionKey: bobSession.sessionKey,
      promptText: 'bob is already active',
    });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('active', bobConv.id);

    dispatches.length = 0;
    const res = await fetch(`${baseUrl}/api/internal/agent/${alice.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: `#default:${threadRootId}`,
        content: 'Need your input here, @PriorityBob.',
        kind: 'progress',
        conversationId: aliceConv.id,
      }),
    });

    expect(res.status).toBe(200);
    await settleDispatches();
    expect(dispatches.filter((msg) => msg.type === 'run.dispatch')).toHaveLength(0);

    const queueRows = db.prepare(
      `SELECT prompt_text as promptText
       FROM conversation_prompt_queue
       WHERE conversation_id = ?
       ORDER BY queue_id ASC`,
    ).all(bobConv.id) as Array<{ promptText: string }>;
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0]?.promptText).toContain('Another agent (@PriorityAlice) explicitly asked for your help in #default.');
    expect(queueRows[0]?.promptText).not.toContain('received a reply');
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

  it('check_messages 应把 legacy DM task-thread 用户消息归到对应 thread bucket', async () => {
    const agent = manager.createAgent({
      name: 'LegacyDmReceiver',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/legacy-dm-receiver',
    });
    const dmChannelId = `dm:${agent.agentId}`;
    const threadTarget = 'dm:@oldpan:deadbead';

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES
       ('dm-root-1', ?, 'user', 'oldpan', 'user', 'dm:@oldpan', 'root-1', 1, 1000, NULL),
       ('dm-thread-1', ?, 'user', 'oldpan', 'user', ?, 'thread-1', 2, 2000, NULL)`,
    ).run(dmChannelId, dmChannelId, threadTarget);

    let res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/receive`);
    expect(res.status).toBe(200);
    let body = await res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((message) => message.content)).toEqual(['root-1', 'thread-1']);

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES('dm-root-2', ?, 'user', 'oldpan', 'user', 'dm:@oldpan', 'root-2', 3, 3000, NULL)`,
    ).run(dmChannelId);

    res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/receive`);
    expect(res.status).toBe(200);
    body = await res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((message) => message.content)).toEqual(['root-2']);

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES('dm-thread-2', ?, 'user', 'oldpan', 'user', ?, 'thread-2', 4, 4000, NULL)`,
    ).run(dmChannelId, threadTarget);

    res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/receive`);
    expect(res.status).toBe(200);
    body = await res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((message) => message.content)).toEqual(['thread-2']);
  });

  it('read_history 在 DM task-thread 中应兼容 legacy thread target 用户消息', async () => {
    const agent = manager.createAgent({
      name: 'DmThreadReader',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/dm-thread-reader',
    });
    const dmChannelId = `dm:${agent.agentId}`;
    const threadRootId = 'deadbead';
    const threadTarget = `dm:@oldpan:${threadRootId}`;

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id, message_kind)
       VALUES
       (?, ?, 'user', 'oldpan', 'user', 'dm:@oldpan', '请处理这个任务线程', 1, 1000, NULL, 'task'),
       ('legacy-thread-user', ?, 'user', 'oldpan', 'user', ?, '你不需要在本机启动fastapi，使用远程已经搭建好的就行', 2, 2000, NULL, NULL),
       ('thread-agent-reply', ?, ?, ?, 'agent', ?, '收到，我改走远端服务。', 3, 3000, ?, 'progress')`,
    ).run(
      `${threadRootId}-0000-0000-0000-000000000000`, dmChannelId,
      dmChannelId, threadTarget,
      dmChannelId, agent.agentId, agent.name, threadTarget, threadRootId,
    );

    const res = await fetch(
      `${baseUrl}/api/internal/agent/${agent.agentId}/history?channel=${encodeURIComponent(threadTarget)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((message) => message.content)).toEqual([
      '你不需要在本机启动fastapi，使用远程已经搭建好的就行',
      '收到，我改走远端服务。',
    ]);
  });

  it('read_history 对已加入的 channel 应返回历史', async () => {
    const agent = manager.createAgent({
      name: 'Reader',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/reader-router',
    });
    manager.joinChannel(agent.agentId, 'default');

    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('msg-1', 'default', 'user', 'User', 'user', '#default', 'hello channel', seq, Date.now());

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/history?channel=${encodeURIComponent('#default')}`);
    expect(res.status).toBe(200);

    const body = await res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((msg) => msg.content)).toContain('hello channel');
  });

  it('read_history 支持 around messageId 居中读取上下文', async () => {
    const agent = manager.createAgent({
      name: 'AroundReader',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/around-reader-router',
    });
    manager.joinChannel(agent.agentId, 'default');

    for (const content of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) {
      db.prepare(
        `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `around-${content}`,
        'default',
        'user',
        'User',
        'user',
        '#default',
        content,
        allocateNextChannelMessageSeq(db, 'default'),
        Date.now(),
      );
    }

    const res = await fetch(
      `${baseUrl}/api/internal/agent/${agent.agentId}/history?channel=${encodeURIComponent('#default')}&around=${encodeURIComponent('around-charlie')}&limit=3`,
    );
    expect(res.status).toBe(200);

    const body = await res.json() as {
      messages: Array<{ content: string }>;
      has_older: boolean;
      has_newer: boolean;
      has_more: boolean;
    };
    expect(body.messages.map((msg) => msg.content)).toEqual(['bravo', 'charlie', 'delta']);
    expect(body.has_older).toBe(true);
    expect(body.has_newer).toBe(true);
    expect(body.has_more).toBe(true);
  });

  it('read_history 支持 around seq 居中读取上下文', async () => {
    const agent = manager.createAgent({
      name: 'AroundSeqReader',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/around-seq-reader-router',
    });
    manager.joinChannel(agent.agentId, 'default');

    for (const content of ['one', 'two', 'three', 'four']) {
      db.prepare(
        `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `around-seq-${content}`,
        'default',
        'user',
        'User',
        'user',
        '#default',
        content,
        allocateNextChannelMessageSeq(db, 'default'),
        Date.now(),
      );
    }

    const anchorRow = db.prepare(
      `SELECT seq FROM channel_messages WHERE message_id = 'around-seq-three'`,
    ).get() as { seq: number };
    const res = await fetch(
      `${baseUrl}/api/internal/agent/${agent.agentId}/history?channel=${encodeURIComponent('#default')}&around=${anchorRow.seq}&limit=3`,
    );
    expect(res.status).toBe(200);

    const body = await res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((msg) => msg.content)).toEqual(['two', 'three', 'four']);
  });

  it('thread target 的 read_history around 不应泄漏主频道消息', async () => {
    const agent = manager.createAgent({
      name: 'ThreadAroundReader',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/thread-around-reader-router',
    });
    manager.joinChannel(agent.agentId, 'default');

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES
       ('thread-around-root', 'default', 'user', 'User', 'user', '#default', 'main thread root', ?, ?, NULL),
       ('thread-around-1', 'default', 'user', 'User', 'user', '#default:thr12345', 'thread only one', ?, ?, 'thr12345'),
       ('thread-around-2', 'default', 'user', 'User', 'user', '#default:thr12345', 'thread only two', ?, ?, 'thr12345'),
       ('thread-around-3', 'default', 'user', 'User', 'user', '#default:thr12345', 'thread only three', ?, ?, 'thr12345')`,
    ).run(
      allocateNextChannelMessageSeq(db, 'default'),
      Date.now(),
      allocateNextChannelMessageSeq(db, 'default'),
      Date.now() + 1,
      allocateNextChannelMessageSeq(db, 'default'),
      Date.now() + 2,
      allocateNextChannelMessageSeq(db, 'default'),
      Date.now() + 3,
    );

    const res = await fetch(
      `${baseUrl}/api/internal/agent/${agent.agentId}/history?channel=${encodeURIComponent('#default:thr12345')}&around=${encodeURIComponent('thread-around-2')}&limit=3`,
    );
    expect(res.status).toBe(200);

    const body = await res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((msg) => msg.content)).toEqual(['thread only one', 'thread only two', 'thread only three']);
  });

  it('read_history 的 around 不可与 before 同时使用', async () => {
    const agent = manager.createAgent({
      name: 'AroundConflict',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/around-conflict-router',
    });
    manager.joinChannel(agent.agentId, 'default');

    const res = await fetch(
      `${baseUrl}/api/internal/agent/${agent.agentId}/history?channel=${encodeURIComponent('#default')}&around=msg-1&before=2`,
    );
    expect(res.status).toBe(400);

    const body = await res.json() as { error: string };
    expect(body.error).toContain('around');
  });

  it('read_history 的 around 找不到 anchor 时应返回 404', async () => {
    const agent = manager.createAgent({
      name: 'AroundMissing',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/around-missing-router',
    });
    manager.joinChannel(agent.agentId, 'default');

    const res = await fetch(
      `${baseUrl}/api/internal/agent/${agent.agentId}/history?channel=${encodeURIComponent('#default')}&around=${encodeURIComponent('missing-anchor')}`,
    );
    expect(res.status).toBe(404);

    const body = await res.json() as { error: string };
    expect(body.error).toContain('Cannot resolve message');
  });

  it('search 应只返回 agent 可见范围内的命中消息', async () => {
    const agent = manager.createAgent({
      name: 'Searcher',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/searcher-router',
    });
    manager.joinChannel(agent.agentId, 'default');
    const privateChannel = manager.createChannel({ name: 'private-search' });

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES
       ('search-root', 'default', 'user', 'User', 'user', '#default', 'needle root hit', ?, ?, NULL),
       ('search-thread', 'default', 'user', 'User', 'user', '#default:thread123', 'needle thread hit', ?, ?, 'thread123'),
       ('search-private', ?, 'user', 'User', 'user', ?, 'needle hidden hit', ?, ?, NULL)`,
    ).run(
      allocateNextChannelMessageSeq(db, 'default'),
      Date.now(),
      allocateNextChannelMessageSeq(db, 'default'),
      Date.now() + 1,
      privateChannel.channelId,
      '#private-search',
      allocateNextChannelMessageSeq(db, privateChannel.channelId),
      Date.now() + 2,
    );

    const res = await fetch(
      `${baseUrl}/api/internal/agent/${agent.agentId}/search?q=${encodeURIComponent('needle')}`,
    );
    expect(res.status).toBe(200);

    const body = await res.json() as {
      results: Array<{ content: string; target: string; snippet: string }>;
    };
    expect(body.results.map((msg) => msg.content)).toContain('needle root hit');
    expect(body.results.map((msg) => msg.content)).toContain('needle thread hit');
    expect(body.results.map((msg) => msg.content)).not.toContain('needle hidden hit');
    expect(body.results.map((msg) => msg.target)).toContain('#default');
    expect(body.results.map((msg) => msg.target)).toContain('#default:thread123');
    expect(body.results.some((msg) => msg.snippet.toLowerCase().includes('needle'))).toBe(true);
  });

  it('search 的基础 channel 过滤应包含该 channel 的主线与 thread 命中', async () => {
    const agent = manager.createAgent({
      name: 'ScopedSearcher',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/scoped-searcher-router',
    });
    manager.joinChannel(agent.agentId, 'default');

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES
       ('scope-root', 'default', 'user', 'User', 'user', '#default', 'scoped term main', ?, ?, NULL),
       ('scope-thread', 'default', 'user', 'User', 'user', '#default:scope123', 'scoped term thread', ?, ?, 'scope123')`,
    ).run(
      allocateNextChannelMessageSeq(db, 'default'),
      Date.now(),
      allocateNextChannelMessageSeq(db, 'default'),
      Date.now() + 1,
    );

    const res = await fetch(
      `${baseUrl}/api/internal/agent/${agent.agentId}/search?q=${encodeURIComponent('scoped')}&channel=${encodeURIComponent('#default')}`,
    );
    expect(res.status).toBe(200);

    const body = await res.json() as { results: Array<{ content: string; target: string }> };
    expect(body.results.map((msg) => msg.content)).toContain('scoped term main');
    expect(body.results.map((msg) => msg.content)).toContain('scoped term thread');
    expect(body.results.map((msg) => msg.target)).toContain('#default');
    expect(body.results.map((msg) => msg.target)).toContain('#default:scope123');
  });

  it('search 的 channel 过滤支持 exact thread target', async () => {
    const agent = manager.createAgent({
      name: 'ThreadSearcher',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/thread-searcher-router',
    });
    manager.joinChannel(agent.agentId, 'default');

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES
       ('thread-filter-root', 'default', 'user', 'User', 'user', '#default', 'focus term root', ?, ?, NULL),
       ('thread-filter-thread', 'default', 'user', 'User', 'user', '#default:focus123', 'focus term thread', ?, ?, 'focus123')`,
    ).run(
      allocateNextChannelMessageSeq(db, 'default'),
      Date.now(),
      allocateNextChannelMessageSeq(db, 'default'),
      Date.now() + 1,
    );

    const res = await fetch(
      `${baseUrl}/api/internal/agent/${agent.agentId}/search?q=${encodeURIComponent('focus')}&channel=${encodeURIComponent('#default:focus123')}`,
    );
    expect(res.status).toBe(200);

    const body = await res.json() as {
      results: Array<{ content: string; target: string }>;
    };
    expect(body.results.map((msg) => msg.content)).toEqual(['focus term thread']);
    expect(body.results.map((msg) => msg.target)).toEqual(['#default:focus123']);
  });

  it('search 对未加入的 channel 过滤应返回 403', async () => {
    const agent = manager.createAgent({
      name: 'ForbiddenSearcher',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/forbidden-searcher-router',
    });
    manager.createChannel({ name: 'private-search-filter' });

    const res = await fetch(
      `${baseUrl}/api/internal/agent/${agent.agentId}/search?q=${encodeURIComponent('needle')}&channel=${encodeURIComponent('#private-search-filter')}`,
    );
    expect(res.status).toBe(403);

    const body = await res.json() as { error: string };
    expect(body.error).toContain('not a member');
  });

  it('search 的空查询应返回 400', async () => {
    const agent = manager.createAgent({
      name: 'EmptySearcher',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/empty-searcher-router',
    });
    manager.joinChannel(agent.agentId, 'default');

    const res = await fetch(
      `${baseUrl}/api/internal/agent/${agent.agentId}/search?q=${encodeURIComponent('   ')}`,
    );
    expect(res.status).toBe(400);

    const body = await res.json() as { error: string };
    expect(body.error).toContain('q');
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
       VALUES(?, 'default', 'user', 'User', 'user', ?, ?, ?, ?)`,
    ).run(
      'main-msg-1',
      '#default',
      'main channel context',
      allocateNextChannelMessageSeq(db, 'default'),
      Date.now(),
    );
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES(?, 'default', 'user', 'User', 'user', ?, ?, ?, ?)`,
    ).run(
      'thread-msg-1',
      '#default:mainread1',
      'thread-only context',
      allocateNextChannelMessageSeq(db, 'default'),
      Date.now() + 1,
    );

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

  it('已配置 skillRoots 的 agent 应可列出 skills', async () => {
    const agent = manager.createAgent({
      name: 'SkillListBob',
      agentType: 'codex_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/skill-list-bob',
      skillRoots: ['/skills'],
    });

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/skills`);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      path: string | null;
      roots: string[];
      skills: Array<{ name: string; path: string; sourceRoot: string; description?: string }>;
    };
    expect(body.path).toBeNull();
    expect(body.roots).toEqual(['/skills']);
    expect(body.skills).toEqual([
      {
        name: 'deploy',
        path: '/skills/deploy/SKILL.md',
        sourceRoot: '/skills',
        description: 'Deploy workflow',
      },
    ]);
  });

  it('已配置 skillRoots 的 agent 应可读取 skill 文件', async () => {
    const agent = manager.createAgent({
      name: 'SkillReadBob',
      agentType: 'codex_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/skill-read-bob',
      skillRoots: ['/skills'],
    });

    const res = await fetch(
      `${baseUrl}/api/internal/agent/${agent.agentId}/skills/file?path=${encodeURIComponent('/skills/deploy/SKILL.md')}`,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { path: string; content: string; mimeType: string };
    expect(body.path).toBe('/skills/deploy/SKILL.md');
    expect(body.mimeType).toBe('text/markdown');
    expect(body.content).toContain('rollout checklist');
  });

  it('未配置 skillRoots 时 skills 接口应返回 409', async () => {
    const agent = manager.createAgent({
      name: 'NoSkillsBob',
      agentType: 'codex_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/no-skills-bob',
    });

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/skills`);

    expect(res.status).toBe(409);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('Agent has no skill roots configured.');
  });

  it('thread 中 claim task 时应忽略 conversationId，并把 owner 同步到 task root thread', async () => {
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

    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('feedbeef-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Bind me', ?, ?)`,
    ).run(seq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, message_id, created_at, updated_at)
       VALUES(?, 'default', 7, 'Bind me', 'todo', 'feedbeef-0000-0000-0000-000000000000', ?, ?)`,
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
    const body = await res.json() as {
      results: Array<{
        taskNumber: number;
        success: boolean;
        messageId?: string | null;
        context?: Array<unknown>;
      }>;
    };
    expect(body.results[0]).toMatchObject({
      taskNumber: 7,
      success: true,
      messageId: 'feedbeef-0000-0000-0000-000000000000',
    });
    expect(Array.isArray(body.results[0].context)).toBe(true);

    const binding = db.prepare(
      `SELECT channel_id as channelId, thread_root_id as threadRootId, task_id as taskId
       FROM thread_task_bindings
       WHERE channel_id = 'default' AND thread_root_id = 'bind1234'`,
    ).get() as { channelId: string; threadRootId: string; taskId: string } | undefined;
    expect(binding).toBeUndefined();

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
       WHERE agent_id = ? AND channel_id = 'default' AND thread_root_id = 'feedbeef'`,
    ).get(agent.agentId) as { role: string } | undefined;
    expect(participant?.role).toBe('owner');
    const branchParticipant = db.prepare(
      `SELECT role FROM target_participants
       WHERE agent_id = ? AND channel_id = 'default' AND thread_root_id = 'bind1234'`,
    ).get(agent.agentId) as { role: string } | undefined;
    expect(branchParticipant).toBeUndefined();
  });

  it('legacy task claim 成功时 context 应为空，且 conversationId 不应创建 branch owner', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'LegacyTaskBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/legacy-task-bob',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const conv = manager.openAgentChannelThread(agent.agentId, 'default', 'legacy123');
    if (!conv) throw new Error('missing thread conversation');

    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, created_at, updated_at)
       VALUES('task-legacy-1', 'default', 21, 'Legacy task', 'todo', ?, ?)`,
    ).run(now, now);

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        task_numbers: [21],
        conversationId: conv.id,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      results: Array<{ taskNumber: number; success: boolean; messageId?: string | null; context?: Array<unknown> }>;
    };
    expect(body.results).toEqual([{ taskNumber: 21, success: true, messageId: null, context: [] }]);

    const binding = db.prepare(
      `SELECT task_id as taskId FROM thread_task_bindings
       WHERE channel_id = 'default' AND thread_root_id = 'legacy123'`,
    ).get() as { taskId: string } | undefined;
    expect(binding).toBeUndefined();

    const branchParticipant = db.prepare(
      `SELECT role FROM target_participants
       WHERE agent_id = ? AND channel_id = 'default' AND thread_root_id = 'legacy123'`,
    ).get(agent.agentId) as { role: string } | undefined;
    expect(branchParticipant).toBeUndefined();
  });

  it('claim_message 提升为 task 后应同步 task root owner', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'ClaimMsgBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/claim-msg-bob',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('c0ffee00-0000-0000-0000-000000000000', 'default', 'user', 'User', 'user', '#default', 'Promote me', ?, ?)`,
    ).run(seq, now);

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/claim-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        message_ids: ['c0ffee00'],
        description: 'Goal: promote this message into a real task. Done when the task is owned and the thread becomes the work surface.',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { results: Array<{ messageId: string; taskNumber?: number; success: boolean; context?: Array<unknown> }> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      messageId: 'c0ffee00-0000-0000-0000-000000000000',
      success: true,
    });
    expect(Array.isArray(body.results[0].context)).toBe(true);

    const participant = db.prepare(
      `SELECT role FROM target_participants
       WHERE agent_id = ? AND channel_id = 'default' AND thread_root_id = 'c0ffee00'`,
    ).get(agent.agentId) as { role: string } | undefined;
    expect(participant?.role).toBe('owner');
  });

  it('claim_message 在 primary DM 中应复用 claim_tasks 的 handoff 逻辑', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO users(id, username, password_hash, is_admin, created_at, updated_at)
       VALUES('user-oldpan', 'oldpan', 'hash', 0, ?, ?)`,
    ).run(now, now);
    const agent = manager.createAgent({
      name: 'ClaimMsgDmBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/claim-msg-dm-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const dmChannelId = `dm:${agent.agentId}`;
    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-claim-message-dm',
      sessionKey: sessionRow.sessionKey,
      promptText: 'claim message via alias',
    });

    const seq = allocateNextChannelMessageSeq(db, dmChannelId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('claimmsgdm-0000-0000-0000-000000000000', ?, 'user', 'oldpan', 'user', 'dm:@oldpan', 'Treat this DM request as a task', ?, ?)`,
    ).run(dmChannelId, seq, now);

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/claim-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'dm:@oldpan',
        message_ids: ['claimmsg'],
        description: 'Do the work in the DM task thread, not in the main DM.',
        conversationId: conv.id,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as {
      results: Array<{
        taskNumber?: number;
        success: boolean;
        messageId?: string;
        handoffStarted?: boolean;
        threadTarget?: string | null;
      }>;
    };
    expect(body.results[0]).toMatchObject({
      success: true,
      messageId: 'claimmsgdm-0000-0000-0000-000000000000',
      handoffStarted: true,
      threadTarget: `dm:@oldpan:${buildThreadShortId('claimmsgdm-0000-0000-0000-000000000000')}`,
    });

    const blockedRes = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'this should be blocked in the main DM',
        conversationId: conv.id,
      }),
    });
    expect(blockedRes.status).toBe(409);
  });

  it('claim_message 缺少 description 时应拒绝', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'ClaimMsgNoBrief',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/claim-msg-nobrief',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('briefless-0000-0000-0000-000000000000', 'default', 'user', 'User', 'user', '#default', 'Promote me without a brief', ?, ?)`,
    ).run(seq, now);

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/claim-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        message_ids: ['briefles'],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('description is required');
  });

  it('claim_tasks 支持用 message_ids 提升普通顶层消息并自动进入 in_progress', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'ClaimByMessageBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/claim-by-message-bob',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('feedc0de-0000-0000-0000-000000000000', 'default', 'user', 'User', 'user', '#default', 'Please investigate this regression', ?, ?)`,
    ).run(seq, now);

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        message_ids: ['feedc0de'],
        description: 'Investigate the regression and report a concrete root cause or fix.',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      results: Array<{ taskNumber?: number; success: boolean; messageId?: string; context?: Array<unknown> }>;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      success: true,
      messageId: 'feedc0de-0000-0000-0000-000000000000',
    });
    expect(Array.isArray(body.results[0].context)).toBe(true);

    const taskRow = db.prepare(
      `SELECT status, claimed_by_agent_id as claimedByAgentId, message_id as messageId
       FROM tasks
       WHERE channel_id = 'default' AND message_id = 'feedc0de-0000-0000-0000-000000000000'`,
    ).get() as { status: string; claimedByAgentId: string | null; messageId: string } | undefined;
    expect(taskRow).toMatchObject({
      status: 'in_progress',
      claimedByAgentId: agent.agentId,
      messageId: 'feedc0de-0000-0000-0000-000000000000',
    });
  });

  it('claim_tasks 支持在 DM 中用 message_ids 认领顶层消息', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'DmClaimBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/dm-claim-bob',
      channelId: 'default',
    });
    const dmChannelId = `dm:${agent.agentId}`;
    const seq = allocateNextChannelMessageSeq(db, dmChannelId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('dmclaim0-0000-0000-0000-000000000000', ?, 'user', 'User', 'user', 'dm:@User', 'Please take care of this DM task', ?, ?)`,
    ).run(dmChannelId, seq, now);

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'dm:@User',
        message_ids: ['dmclaim0'],
        description: 'Handle the requested DM work and report completion.',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      results: Array<{ taskNumber?: number; success: boolean; messageId?: string; context?: Array<unknown>; agentTaskRef?: string }>;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      taskNumber: 1,
      success: true,
      messageId: 'dmclaim0-0000-0000-0000-000000000000',
      context: [],
    });
    expect(body.results[0]?.agentTaskRef).toBeTruthy();

    const taskRow = db.prepare(
      `SELECT channel_id as channelId, status, claimed_by_agent_id as claimedByAgentId
       FROM tasks
       WHERE message_id = 'dmclaim0-0000-0000-0000-000000000000'`,
    ).get() as { channelId: string; status: string; claimedByAgentId: string | null } | undefined;
    expect(taskRow).toMatchObject({
      channelId: dmChannelId,
      status: 'in_progress',
      claimedByAgentId: agent.agentId,
    });
  });

  it('claim_tasks 用 message_ids 认领 thread 消息时应拒绝', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'ThreadClaimBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/thread-claim-bob',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES('threadmsg-0000-0000-0000-000000000000', 'default', 'user', 'User', 'user', '#default:root0001', 'Can you do this from a thread?', ?, ?, 'root0001')`,
    ).run(seq, now);

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        message_ids: ['threadms'],
        description: 'This should be rejected because it is a thread message.',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      results: Array<{ success: boolean; messageId?: string; reason?: string }>;
    };
    expect(body.results).toEqual([
      {
        success: false,
        messageId: 'threadmsg-0000-0000-0000-000000000000',
        reason: 'Thread messages cannot become tasks',
      },
    ]);
  });

  it('update-details 应更新 task 标题和 brief，并同步 dedicated task root message', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'TaskEditBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/task-edit-bob',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, message_kind)
       VALUES('taskedit0-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Original title', ?, ?, 'task')`,
    ).run(seq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, message_id, created_at, updated_at)
       VALUES('task-edit-agent', 'default', 41, 'Original title', 'Old brief', 'todo', 'taskedit0-0000-0000-0000-000000000000', ?, ?)`,
    ).run(now, now);

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/update-details`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        task_number: 41,
        title: 'Updated title',
        description: 'Goal: update task details through the internal API. Done when prompt context can see the new brief.',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; title: string; description: string };
    expect(body.ok).toBe(true);
    expect(body.title).toBe('Updated title');
    expect(body.description).toContain('internal API');

    const taskRow = db.prepare(
      `SELECT title, description FROM tasks WHERE task_id = 'task-edit-agent'`,
    ).get() as { title: string; description: string };
    expect(taskRow.title).toBe('Updated title');
    expect(taskRow.description).toContain('prompt context can see the new brief');

    const messageRow = db.prepare(
      `SELECT content FROM channel_messages WHERE message_id = 'taskedit0-0000-0000-0000-000000000000'`,
    ).get() as { content: string };
    expect(messageRow.content).toBe('Updated title');
  });

  it('agent 不应允许非法状态流转 todo → done', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'TaskTransitionBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/task-transition-bob',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');

    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, claimed_by_agent_id, claimed_by_name, created_at, updated_at)
       VALUES('task-transition-1', 'default', 31, 'Do not skip', 'todo', ?, ?, ?, ?)`,
    ).run(agent.agentId, agent.name, now, now);

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/update-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        task_number: 31,
        status: 'done',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('Invalid transition: todo → done');
  });

  it('unclaim in_progress task 时应回退到 todo', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'TaskUnclaimBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/task-unclaim-bob',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');

    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, claimed_by_agent_id, claimed_by_name, created_at, updated_at)
       VALUES('task-unclaim-1', 'default', 32, 'Rollback me', 'in_progress', ?, ?, ?, ?)`,
    ).run(agent.agentId, agent.name, now, now);

    const res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/unclaim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        task_number: 32,
      }),
    });

    expect(res.status).toBe(200);
    const task = db.prepare(
      `SELECT status, claimed_by_agent_id as claimedByAgentId, claimed_by_name as claimedByName
       FROM tasks WHERE task_id = 'task-unclaim-1'`,
    ).get() as { status: string; claimedByAgentId: string | null; claimedByName: string | null };
    expect(task).toEqual({
      status: 'todo',
      claimedByAgentId: null,
      claimedByName: null,
    });
  });

  it('隐式 task-root thread 的 claim / in_review 应同步 owner，agent 不应直接 done', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'ImplicitOwnerBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/implicit-owner-bob',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');

    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('f00d0000-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Implicit owner', ?, ?)`,
    ).run(seq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, message_id, created_at, updated_at)
       VALUES('task-implicit-owner', 'default', 33, 'Implicit owner', 'todo', 'f00d0000-0000-0000-0000-000000000000', ?, ?)`,
    ).run(now, now);

    let res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        task_numbers: [33],
      }),
    });
    expect(res.status).toBe(200);

    let participant = db.prepare(
      `SELECT role FROM target_participants
       WHERE agent_id = ? AND channel_id = 'default' AND thread_root_id = 'f00d0000'`,
    ).get(agent.agentId) as { role: string } | undefined;
    expect(participant?.role).toBe('owner');

    res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/update-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        task_number: 33,
        status: 'in_review',
      }),
    });
    expect(res.status).toBe(200);

    res = await fetch(`${baseUrl}/api/internal/agent/${agent.agentId}/tasks/update-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#default',
        task_number: 33,
        status: 'done',
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Only a human user can mark a task done. If your work is complete, move it to in_review first unless the user explicitly approved done.',
    });

    participant = db.prepare(
      `SELECT role FROM target_participants
       WHERE agent_id = ? AND channel_id = 'default' AND thread_root_id = 'f00d0000'`,
    ).get(agent.agentId) as { role: string } | undefined;
    expect(participant?.role).toBe('owner');
  });
});

async function expectDispatchCount(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await settleDispatches();
    if (dispatches.filter((msg) => msg.type === 'run.dispatch').length === expected) {
      return;
    }
  }
  expect(dispatches.filter((msg) => msg.type === 'run.dispatch')).toHaveLength(expected);
}

async function settleDispatches(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
