import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finishRun } from '@agent-collab/runtime-acp';
import type { CoreToNode } from '@agent-collab/protocol';
import type { Db } from '@agent-collab/runtime-acp';
import { createTestConfig, createTestDb } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { allocateNextChannelMessageSeq } from '../web/channelMessageSequences.js';
import { buildChannelActivationContextText, buildChannelActivationPrompt } from '../web/channelActivationPrompt.js';

describe('ExecutionDispatcher', () => {
  let db: Db;
  const sent: Array<{ nodeId: string; msg: CoreToNode }> = [];
  let manager: ConversationManager;
  const fakeRegistry = {
    getNode(nodeId: string) {
      return {
        nodeId,
        hostname: 'test-host',
        agentTypes: ['claude_acp', 'codex_acp'],
        version: 'test',
      };
    },
    send(nodeId: string, msg: CoreToNode) {
      sent.push({ nodeId, msg });
      if (msg.type === 'run.dispatch') {
        queueMicrotask(() => {
          manager.handleRunAccepted(msg.runId, msg.conversationId);
        });
      }
      return true;
    },
  };

  beforeEach(() => {
    db = createTestDb();
    sent.length = 0;
    manager = new ConversationManager({
      db,
      config: createTestConfig(),
      nodeRegistry: fakeRegistry as any,
    });
    manager.start();
  });

  afterEach(() => {
    manager.close();
    db.close();
  });

  it('dispatchToNode 第一次应发送 cold_start + hostKey', async () => {
    const conv = manager.createConversation({
      title: 'Dispatch Test',
      agentType: 'codex_acp',
      nodeId: 'node-1',
    });

    await manager.dispatchToNode(conv.id, 'hello');

    expect(sent).toHaveLength(1);
    expect(sent[0].nodeId).toBe('node-1');
    expect(sent[0].msg.type).toBe('run.dispatch');
    if (sent[0].msg.type !== 'run.dispatch') throw new Error('unexpected message');
    expect(sent[0].msg.dispatchMode).toBe('cold_start');
    expect(sent[0].msg.hostKey).toBe(`conversation:${conv.id}:codex_acp`);
    expect(sent[0].msg.agentType).toBe('codex_acp');
    expect(sent[0].msg.channelBridgeConfig).toBeUndefined();
  });

  it('dispatchToNode 后续应发送 resume', async () => {
    const conv = manager.createConversation({
      title: 'Resume Test',
      agentType: 'claude_acp',
      nodeId: 'node-1',
    });

    await manager.dispatchToNode(conv.id, 'first');
    const first = sent[0]?.msg;
    if (!first || first.type !== 'run.dispatch') throw new Error('missing first dispatch');
    finishRun(db, { runId: first.runId, stopReason: 'end_turn' });

    await manager.dispatchToNode(conv.id, 'second');

    const second = sent[1]?.msg;
    if (!second || second.type !== 'run.dispatch') throw new Error('missing second dispatch');
    expect(second.dispatchMode).toBe('resume');
    expect(second.prompt).toContain('[Reply contract]');
    expect(second.envVars?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  it('dispatchToNode 应合并 agent envVars、conversation envVars 和 driver 默认 env', async () => {
    const agent = manager.createAgent({
      name: 'Merged Env Agent',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/merged-env-agent',
      envVars: {
        https_proxy: 'http://127.0.0.1:7893',
        ANTHROPIC_MODEL: 'GLM-4.7',
      },
    });
    const conv = manager.createConversation({
      agentId: agent.agentId,
      title: 'Merged Env Test',
      envVars: {
        ANTHROPIC_MODEL: 'GLM-4.7-override',
        CUSTOM_ONLY: '1',
      },
    });

    await manager.dispatchToNode(conv.id, 'hello');

    expect(sent).toHaveLength(1);
    const dispatch = sent[0]?.msg;
    if (!dispatch || dispatch.type !== 'run.dispatch') throw new Error('missing dispatch');
    expect(dispatch.envVars).toMatchObject({
      https_proxy: 'http://127.0.0.1:7893',
      ANTHROPIC_MODEL: 'GLM-4.7-override',
      CUSTOM_ONLY: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    });
  });

  it('dispatchToNode 应携带 agent 级 disabledToolKinds', async () => {
    const agent = manager.createAgent({
      name: 'Restricted Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/restricted-bob',
      disabledToolKinds: ['execute', 'delete'],
    });
    const conv = manager.createConversation({
      agentId: agent.agentId,
      title: 'Restricted Test',
    });

    await manager.dispatchToNode(conv.id, 'hello');

    const dispatch = sent[0]?.msg;
    if (!dispatch || dispatch.type !== 'run.dispatch') throw new Error('missing dispatch');
    expect(dispatch.disabledToolKinds).toEqual(['execute', 'delete']);
  });

  it('dispatchToNode 应分开发送 true system prompt 和本地 memory context', async () => {
    const agent = manager.createAgent({
      name: 'Memory Agent',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/memory-agent',
      systemPrompt: 'Maintain memory carefully.',
    });
    const conv = manager.createConversation({
      agentId: agent.agentId,
      title: 'Memory Dispatch Test',
    });

    await manager.dispatchToNode(conv.id, 'remember this');

    const dispatch = sent[0]?.msg;
    if (!dispatch || dispatch.type !== 'run.dispatch') throw new Error('missing dispatch');
    expect(dispatch.systemPromptText).toContain('"Memory Agent"');
    expect(dispatch.systemPromptText).toContain('mcp__chat__send_message');
    expect(dispatch.systemPromptText).toContain('mcp__chat__check_messages');
    expect(dispatch.systemPromptText).toContain('Compaction safety');
    expect(dispatch.systemPromptText).toContain('This is your only user-visible output channel');
    expect(dispatch.systemPromptText).toContain('If the run needs a user-visible reply, send it with `mcp__chat__send_message`');
    expect(dispatch.systemPromptText).toContain('Follow-up messages in the same conversation will be delivered in later runs');
    expect(dispatch.systemPromptText).toContain('prefer `mcp__chat__send_message(content="...")` with no target');
    expect(dispatch.systemPromptText).toContain('Do **not** convert a main-channel message');
    expect(dispatch.systemPromptText).toContain('Do **not** quote or repeat that metadata block back to the user');
    expect(dispatch.systemPromptText).toContain('Maintain memory carefully');
    expect(dispatch.systemPromptText).not.toContain('put to sleep when idle');
    expect(dispatch.systemPromptText).not.toContain('stdin prompt');
    expect(dispatch.contextText).toContain('[Local Memory Guide]');
    expect(dispatch.contextText).toContain('Local memory is stored as ordinary workspace files');
    expect(dispatch.contextText).toContain('Use normal file read/edit tools');
    expect(dispatch.contextText).toContain('MEMORY.md');
    expect(dispatch.contextText).toContain('notes/*.md');
    expect(dispatch.contextText).not.toContain('[System Prompt]');
    expect(dispatch.prompt).toContain('[Reply contract]');
    expect(dispatch.prompt).toContain('Use mcp__chat__send_message(..., kind="progress") only while work is still ongoing.');
    expect(dispatch.prompt).toContain('Use kind="final" only when your current answer is complete. The runtime decides when the run ends.');
    expect(dispatch.channelBridgeConfig).toMatchObject({
      agentId: agent.agentId,
      conversationId: conv.id,
    });

    const debugRow = db.prepare(
      `SELECT dispatch_mode as dispatchMode,
              system_prompt_text as systemPromptText,
              context_text as contextText,
              prompt_text as promptText,
              dispatched_prompt_text as dispatchedPromptText,
              is_exact as isExact
         FROM run_debug_inputs
        WHERE run_id = ?`,
    ).get(dispatch.runId) as {
      dispatchMode: string;
      systemPromptText: string | null;
      contextText: string | null;
      promptText: string;
      dispatchedPromptText: string;
      isExact: number;
    } | undefined;
    expect(debugRow).toBeDefined();
    expect(debugRow?.dispatchMode).toBe('cold_start');
    expect(debugRow?.systemPromptText).toContain('"Memory Agent"');
    expect(debugRow?.contextText).toContain('[Local Memory Guide]');
    expect(debugRow?.promptText).toContain('remember this');
    expect(debugRow?.dispatchedPromptText).toContain('[Reply contract]');
    expect(debugRow?.isExact).toBe(0);
  });

  it('内部静默 prompt 不应写入私聊 channel_messages', async () => {
    const agent = manager.createAgent({
      name: 'Silent Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/silent-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    await manager.submitPrompt(
      conv.id,
      '[System: You were @mentioned in #default by User. Call check_messages to read the message.]',
      { recordAsUserMessage: false },
    );

    const countRow = db.prepare(
      'SELECT COUNT(*) as count FROM channel_messages WHERE channel_id = ?'
    ).get(`dm:${agent.agentId}`) as { count: number };
    expect(countRow.count).toBe(0);
  });

  it('私聊用户消息应直接作为激活 prompt 下发，并推进 DM root checkpoint', async () => {
    const agent = manager.createAgent({
      name: 'Direct Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/direct-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    await manager.submitPrompt(conv.id, '你好，帮我总结一下刚才的结论');

    const dispatch = sent[0]?.msg;
    if (!dispatch || dispatch.type !== 'run.dispatch') throw new Error('missing dispatch');
    expect(dispatch.prompt).toContain('[Reply contract]');
    expect(dispatch.prompt).toContain('[Triggered message metadata]');
    expect(dispatch.prompt).toContain('[Current conversation target]');
    expect(dispatch.prompt).toContain('reply_target: dm:@oldpan');
    expect(dispatch.prompt).toContain('recipient: @Direct Bob');
    expect(dispatch.prompt).toContain('[Triggered message body]');
    expect(dispatch.prompt).toContain('你好，帮我总结一下刚才的结论');
    expect(dispatch.prompt).toContain('Reply only via mcp__chat__send_message(...)');
    expect(dispatch.prompt).not.toContain('This execution is bound to reply_target=');
    expect(dispatch.prompt).not.toContain('[Triggered message metadata]\ntarget: dm:@oldpan');
    expect(dispatch.prompt).not.toContain('[Recent messages on this exact target]');
    expect(dispatch.prompt).not.toContain('[Unread summary]');
    expect(dispatch.prompt).not.toContain('Call check_messages to read them when you\'re ready');

    const dmChannelId = `dm:${agent.agentId}`;
    const msgRow = db.prepare(
      'SELECT content, seq FROM channel_messages WHERE channel_id = ? ORDER BY seq DESC LIMIT 1'
    ).get(dmChannelId) as { content: string; seq: number } | undefined;
    expect(msgRow?.content).toBe('你好，帮我总结一下刚才的结论');

    const checkpointRow = db.prepare(
      'SELECT last_seq as lastSeq FROM agent_message_checkpoints WHERE agent_id = ? AND channel_id = ? AND thread_root_id = ?'
    ).get(agent.agentId, dmChannelId, '') as { lastSeq: number } | undefined;
    expect(checkpointRow?.lastSeq).toBe(msgRow?.seq);
  });

  it('私聊用户消息应保留前端传入的 clientMessageId，避免当前页重复气泡', async () => {
    const agent = manager.createAgent({
      name: 'Stable Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/stable-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    await manager.submitPrompt(conv.id, '你好', {
      senderName: 'oldpan',
      clientMessageId: 'client-msg-1',
    });

    const row = db.prepare(
      'SELECT message_id as messageId, content FROM channel_messages WHERE channel_id = ? ORDER BY seq DESC LIMIT 1'
    ).get(`dm:${agent.agentId}`) as { messageId: string; content: string } | undefined;

    expect(row?.messageId).toBe('client-msg-1');
    expect(row?.content).toBe('你好');
  });

  it('私聊 resume 应附带局部 recent messages、history cursor 和去重后的 unread summary', async () => {
    const agent = manager.createAgent({
      name: 'Recover Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/recover-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    await manager.submitPrompt(conv.id, 'seed');
    const firstDispatch = sent[0]?.msg;
    if (!firstDispatch || firstDispatch.type !== 'run.dispatch') throw new Error('missing first dispatch');
    finishRun(db, { runId: firstDispatch.runId, stopReason: 'end_turn' });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', conv.id);

    const dmChannelId = `dm:${agent.agentId}`;
    for (let i = 2; i <= 11; i += 1) {
      db.prepare(
        `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
         VALUES(?, ?, 'user', 'oldpan', 'user', 'dm:@oldpan', ?, ?, ?)`,
      ).run(`dm-old-${i}`, dmChannelId, `old-${i}`, allocateNextChannelMessageSeq(db, dmChannelId), Date.now() + i);
    }

    await manager.submitPrompt(conv.id, 'current');

    const secondDispatch = sent[1]?.msg;
    if (!secondDispatch || secondDispatch.type !== 'run.dispatch') throw new Error('missing second dispatch');
    expect(secondDispatch.dispatchMode).toBe('resume');
    expect(secondDispatch.contextText).toContain('[Recent messages on this exact target]');
    expect(secondDispatch.contextText).toContain('old-4');
    expect(secondDispatch.contextText).toContain('old-11');
    expect(secondDispatch.contextText).not.toContain('old-2');
    expect(secondDispatch.contextText).toContain('[History cursor]\noldest_visible_seq: 4');
    expect(secondDispatch.contextText).toContain('[Unread summary]\n2 older unread messages on this exact target were not included above. Use read_history(channel="dm:@oldpan", before=4) if you need them.');
    expect(secondDispatch.contextText).not.toContain('[Inbox]');
  });

  it('history_reset_at 之后 resume 不应 replay reset 之前的旧 runs', async () => {
    const agent = manager.createAgent({
      name: 'Reset Boundary Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/reset-boundary-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    await manager.submitPrompt(conv.id, 'before reset');
    const firstDispatch = sent[0]?.msg;
    if (!firstDispatch || firstDispatch.type !== 'run.dispatch') throw new Error('missing first dispatch');
    finishRun(db, { runId: firstDispatch.runId, stopReason: 'end_turn' });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', conv.id);

    const resetAt = Date.now() + 1_000;
    db.prepare('UPDATE conversations SET history_reset_at = ? WHERE id = ?').run(resetAt, conv.id);

    await manager.submitPrompt(conv.id, 'after reset');

    const secondDispatch = sent[1]?.msg;
    if (!secondDispatch || secondDispatch.type !== 'run.dispatch') throw new Error('missing second dispatch');
    expect(secondDispatch.dispatchMode).toBe('resume');
    expect(secondDispatch.contextText ?? '').not.toContain('Context (previous messages, for continuity after restart):');
    expect(secondDispatch.contextText ?? '').not.toContain('User: before reset');
  });

  it('resume replay 应优先使用真实 agent 回复，不应回放空响应 delta 噪音', async () => {
    manager.close();
    db.close();
    db = createTestDb();
    sent.length = 0;
    manager = new ConversationManager({
      db,
      config: createTestConfig({ contextReplayEnabled: true, contextReplayRuns: 16 }),
      nodeRegistry: fakeRegistry as any,
    });
    manager.start();

    const agent = manager.createAgent({
      name: 'Replay Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/replay-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    await manager.submitPrompt(conv.id, 'first prompt', { senderName: 'oldpan' });
    const firstDispatch = sent[0]?.msg;
    if (!firstDispatch || firstDispatch.type !== 'run.dispatch') throw new Error('missing first dispatch');

    const dmChannelId = `dm:${agent.agentId}`;
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, message_kind)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      dmChannelId,
      agent.agentId,
      agent.name,
      'dm:@oldpan',
      '真实可见回复',
      allocateNextChannelMessageSeq(db, dmChannelId),
      Date.now(),
      firstDispatch.runId,
      'final',
    );
    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'node/event', ?, ?)`,
    ).run(
      firstDispatch.runId,
      1,
      JSON.stringify({
        type: 'content.delta',
        text: `(Empty response: {'content': [{'type': 'thinking', 'thinking': 'noise'}]})`,
      }),
      Date.now(),
    );
    finishRun(db, { runId: firstDispatch.runId, stopReason: 'end_turn' });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', conv.id);

    await manager.submitPrompt(conv.id, 'second prompt', { senderName: 'oldpan' });

    const secondDispatch = sent[1]?.msg;
    if (!secondDispatch || secondDispatch.type !== 'run.dispatch') throw new Error('missing second dispatch');
    expect(secondDispatch.dispatchMode).toBe('resume');
    expect(secondDispatch.contextText ?? '').toContain('真实可见回复');
    expect(secondDispatch.contextText ?? '').not.toContain('Assistant: 真实可见回复');
    expect(secondDispatch.contextText ?? '').not.toContain('Empty response:');
  });

  it('私聊 restore 时不应把 replay 和 exact-target recent messages 重复注入两遍', async () => {
    manager.close();
    db.close();
    db = createTestDb();
    sent.length = 0;
    manager = new ConversationManager({
      db,
      config: createTestConfig({ contextReplayEnabled: true, contextReplayRuns: 16 }),
      nodeRegistry: fakeRegistry as any,
    });
    manager.start();

    const agent = manager.createAgent({
      name: 'kimi',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/kimi-dm-restore',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    const dmChannelId = `dm:${agent.agentId}`;
    const insertFinalReply = (runId: string, content: string) => {
      db.prepare(
        `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, message_kind)
         VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        dmChannelId,
        agent.agentId,
        agent.name,
        'dm:@oldpan',
        content,
        allocateNextChannelMessageSeq(db, dmChannelId),
        Date.now(),
        runId,
        'final',
      );
      finishRun(db, { runId, stopReason: 'end_turn' });
      db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', conv.id);
    };

    await manager.submitPrompt(conv.id, '你好', { senderName: 'oldpan' });
    const firstDispatch = sent[0]?.msg;
    if (!firstDispatch || firstDispatch.type !== 'run.dispatch') throw new Error('missing first dispatch');
    insertFinalReply(firstDispatch.runId, '你好！我是 kimi，打杂小能手。有什么我可以帮你的吗？');

    await manager.submitPrompt(conv.id, '我们刚才聊了什么', { senderName: 'oldpan' });
    const secondSeedDispatch = sent[1]?.msg;
    if (!secondSeedDispatch || secondSeedDispatch.type !== 'run.dispatch') throw new Error('missing second seed dispatch');
    insertFinalReply(
      secondSeedDispatch.runId,
      '我们刚才聊了两句：你先打了招呼，然后让我回顾刚才的对话。',
    );

    sent.length = 0;
    await manager.submitPrompt(conv.id, '你真棒', { senderName: 'oldpan' });

    const replayDispatch = sent[0]?.msg;
    if (!replayDispatch || replayDispatch.type !== 'run.dispatch') throw new Error('missing replay dispatch');
    expect(replayDispatch.dispatchMode).toBe('resume');
    expect(replayDispatch.contextText ?? '').toContain('[Recent messages on this exact target]');
    expect(replayDispatch.contextText ?? '').toContain('你好！我是 kimi，打杂小能手。有什么我可以帮你的吗？');
    expect(replayDispatch.contextText ?? '').toContain('我们刚才聊了什么');
    expect(replayDispatch.contextText ?? '').not.toContain('Context (previous messages, for continuity after restart):');
  });

  it('resume replay 应去掉旧 activation envelope，仅回放触发正文', async () => {
    manager.close();
    db.close();
    db = createTestDb();
    sent.length = 0;
    manager = new ConversationManager({
      db,
      config: createTestConfig({ contextReplayEnabled: true, contextReplayRuns: 16 }),
      nodeRegistry: fakeRegistry as any,
    });
    manager.start();

    const agent = manager.createAgent({
      name: 'Envelope Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/envelope-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    const sessionRow = db.prepare(
      'SELECT session_key as sessionKey FROM conversations WHERE id = ?',
    ).get(conv.id) as { sessionKey: string };

    const replayRunId = randomUUID();
    const replayPrompt = [
      '[System: Your collaborative thread in #default received a reply from oldpan.]',
      '',
      '[Current conversation target]',
      'reply_target: #default:abcd1234',
      '',
      '[Triggered message metadata]',
      'target: #default:abcd1234',
      'sender: @oldpan',
      '',
      '[Triggered message body]',
      '再看下机器的内存状态',
    ].join('\n');
    db.prepare(
      `INSERT INTO runs(run_id, session_key, prompt_text, started_at, ended_at, stop_reason)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(replayRunId, sessionRow.sessionKey, replayPrompt, 1000, 1100, 'end_turn');

    const dmChannelId = `dm:${agent.agentId}`;
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, message_kind)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      dmChannelId,
      agent.agentId,
      agent.name,
      'dm:@oldpan',
      '收到，继续检查中',
      allocateNextChannelMessageSeq(db, dmChannelId),
      Date.now(),
      replayRunId,
      'final',
    );

    await manager.dispatchToNode(conv.id, '继续');

    const dispatch = sent[0]?.msg;
    if (!dispatch || dispatch.type !== 'run.dispatch') throw new Error('missing dispatch');
    expect(dispatch.dispatchMode).toBe('resume');
    expect(dispatch.contextText ?? '').toContain('User: 再看下机器的内存状态');
    expect(dispatch.contextText ?? '').toContain('收到，继续检查中');
    expect(dispatch.contextText ?? '').not.toContain('[Current conversation target]');
    expect(dispatch.contextText ?? '').not.toContain('[Triggered message metadata]');
    expect(dispatch.contextText ?? '').not.toContain('[Triggered message body]');
  });

  it('thread restore 时不应把 replay 和 exact-target recent messages 重复注入两遍', async () => {
    manager.close();
    db.close();
    db = createTestDb();
    sent.length = 0;
    manager = new ConversationManager({
      db,
      config: createTestConfig({ contextReplayEnabled: true, contextReplayRuns: 16 }),
      nodeRegistry: fakeRegistry as any,
    });
    manager.start();

    const channel = manager.createChannel({ name: 'pure-cal-related' });
    const agent = manager.createAgent({
      name: 'kimi',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/kimi-thread-restore',
      channelId: channel.channelId,
    });
    manager.joinChannel(agent.agentId, channel.channelId);
    const conv = manager.openAgentChannelThread(agent.agentId, channel.channelId, 'f550d695');
    if (!conv) throw new Error('missing thread conversation');

    const channelId = channel.channelId;
    const threadRootId = 'f550d695';
    const target = '#pure-cal-related:f550d695';
    const baseTime = Date.now();

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?)`,
    ).run('f550d695-root', channelId, agent.agentId, agent.name, '#pure-cal-related', '你好！我是kimi，有什么可以帮你的吗？', 6, baseTime, threadRootId);

    const sessionRow = db.prepare(
      'SELECT session_key as sessionKey FROM conversations WHERE id = ?',
    ).get(conv.id) as { sessionKey: string };

    const firstRunId = randomUUID();
    db.prepare(
      `INSERT INTO runs(run_id, session_key, prompt_text, started_at, ended_at, stop_reason)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(
      firstRunId,
      sessionRow.sessionKey,
      buildChannelActivationPrompt({
        channelName: 'pure-cal-related',
        target,
        replyTarget: target,
        senderName: 'yanzong',
        content: '帮我看下当前机器的显存状态',
        reason: 'thread_reply',
      }),
      1000,
      1100,
      'end_turn',
    );
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id, message_kind)
       VALUES(?, ?, ?, ?, 'user', ?, ?, ?, ?, NULL, ?, NULL)`,
    ).run('6aa79cc1-user', channelId, 'user', 'yanzong', target, '帮我看下当前机器的显存状态', 7, baseTime + 1, threadRootId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id, message_kind)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?)`,
    ).run('2e50a80d-agent', channelId, agent.agentId, agent.name, target, '当前机器显存状态如下：显存几乎完全可用。', 8, baseTime + 2, firstRunId, threadRootId, 'final');

    const secondRunId = randomUUID();
    db.prepare(
      `INSERT INTO runs(run_id, session_key, prompt_text, started_at, ended_at, stop_reason)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(
      secondRunId,
      sessionRow.sessionKey,
      buildChannelActivationPrompt({
        channelName: 'pure-cal-related',
        target,
        replyTarget: target,
        senderName: 'yanzong',
        content: '再看下机器的内存状态',
        reason: 'thread_reply',
      }),
      1200,
      1300,
      'end_turn',
    );
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id, message_kind)
       VALUES(?, ?, ?, ?, 'user', ?, ?, ?, ?, NULL, ?, NULL)`,
    ).run('9a33f438-user', channelId, 'user', 'yanzong', target, '再看下机器的内存状态', 9, baseTime + 3, threadRootId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id, message_kind)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?)`,
    ).run('7058b948-agent', channelId, agent.agentId, agent.name, target, '当前机器内存状态如下：可用内存很充裕。', 10, baseTime + 4, secondRunId, threadRootId, 'final');

    const recentMessages = [
      {
        messageId: '6aa79cc1',
        seq: 7,
        target,
        senderName: 'yanzong',
        senderType: 'user' as const,
        content: '帮我看下当前机器的显存状态',
        createdAt: baseTime + 1,
      },
      {
        messageId: '2e50a80d',
        seq: 8,
        target,
        senderName: 'kimi',
        senderType: 'agent' as const,
        content: '当前机器显存状态如下：显存几乎完全可用。',
        createdAt: baseTime + 2,
      },
      {
        messageId: '9a33f438',
        seq: 9,
        target,
        senderName: 'yanzong',
        senderType: 'user' as const,
        content: '再看下机器的内存状态',
        createdAt: baseTime + 3,
      },
      {
        messageId: '7058b948',
        seq: 10,
        target,
        senderName: 'kimi',
        senderType: 'agent' as const,
        content: '当前机器内存状态如下：可用内存很充裕。',
        createdAt: baseTime + 4,
      },
    ];

    await manager.submitPrompt(
      conv.id,
      buildChannelActivationPrompt({
        channelName: 'pure-cal-related',
        target,
        replyTarget: target,
        senderName: 'yanzong',
        content: '你刚才干了什么',
        reason: 'thread_reply',
      }),
      {
        recordAsUserMessage: false,
        activationContextText: buildChannelActivationContextText({
          target,
          rootMessage: {
            messageId: 'f550d695-root',
            seq: 6,
            target: '#pure-cal-related',
            senderName: 'kimi',
            senderType: 'agent',
            content: '你好！我是kimi，有什么可以帮你的吗？',
            createdAt: baseTime,
          },
          recentMessages,
          oldestVisibleSeq: 7,
        }),
        replayOverlapRecentMessages: recentMessages,
      },
    );

    const dispatch = sent[0]?.msg;
    if (!dispatch || dispatch.type !== 'run.dispatch') throw new Error('missing dispatch');
    expect(dispatch.dispatchMode).toBe('resume');
    expect(dispatch.contextText ?? '').toContain('[Recent messages on this exact target]');
    expect(dispatch.contextText ?? '').toContain('当前机器显存状态如下：显存几乎完全可用。');
    expect(dispatch.contextText ?? '').toContain('当前机器内存状态如下：可用内存很充裕。');
    expect(dispatch.contextText ?? '').not.toContain('Context (previous messages, for continuity after restart):');
  });

  it('cancelConversationRun 应发送 run.cancel 到节点', () => {
    const conv = manager.createConversation({
      title: 'Cancel Test',
      nodeId: 'node-1',
    });

    const row = db.prepare(
      'SELECT session_key as sessionKey FROM conversations WHERE id = ?'
    ).get(conv.id) as { sessionKey: string };
    db.prepare(
      'INSERT INTO runs(run_id, session_key, prompt_text, started_at) VALUES(?, ?, ?, ?)'
    ).run('run-1', row.sessionKey, 'hello', Date.now());

    const result = manager.cancelConversationRun(conv.id);

    expect(result.ok).toBe(true);
    expect(result.runId).toBe('run-1');
    expect(sent).toHaveLength(1);
    expect(sent[0].msg).toEqual({ type: 'run.cancel', runId: 'run-1' });
  });

  it('同一 direct conversation 的后续 prompt 应进入 queued', async () => {
    const agent = manager.createAgent({
      name: 'Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/bob-test',
    });
    const primary = manager.openAgentThread(agent.agentId);
    if (!primary) throw new Error('missing primary thread');

    await manager.submitPrompt(primary.id, 'first');
    const queued = await manager.submitPrompt(primary.id, 'second');
    const queuedAgain = await manager.submitPrompt(primary.id, 'third');

    expect(queued.queued).toBe(true);
    expect(queuedAgain.queued).toBe(true);
    const queuedRow = db.prepare(
      'SELECT status FROM conversations WHERE id = ?'
    ).get(primary.id) as { status: string };
    expect(queuedRow.status).toBe('queued');

    const queueEntries = db.prepare(
      `SELECT conversation_id as conversationId, prompt_text as promptText,
              activation_context_text as activationContextText
       FROM conversation_prompt_queue
       ORDER BY queue_id ASC`
    ).all() as Array<{
      conversationId: string;
      promptText: string;
      activationContextText: string | null;
    }>;
    expect(queueEntries).toEqual([
      {
        conversationId: primary.id,
        promptText: 'second',
        activationContextText: null,
      },
      {
        conversationId: primary.id,
        promptText: 'third',
        activationContextText: null,
      },
    ]);
  });

  it('不同用户的 direct conversation 应并发 dispatch，不进入 queued', async () => {
    const agent = manager.createAgent({
      name: 'Alice',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/alice-direct-concurrency',
    });
    db.prepare(
      `INSERT INTO users(id, username, password_hash, is_admin, created_at, updated_at)
       VALUES(?, ?, ?, 0, ?, ?)`,
    ).run('oldpan', 'oldpan', 'hash', Date.now(), Date.now());
    db.prepare(
      `INSERT INTO users(id, username, password_hash, is_admin, created_at, updated_at)
       VALUES(?, ?, ?, 0, ?, ?)`,
    ).run('yanzong', 'yanzong', 'hash', Date.now(), Date.now());
    const oldpan = manager.openAgentThread(agent.agentId, 'oldpan');
    const yanzong = manager.openAgentThread(agent.agentId, 'yanzong');
    if (!oldpan || !yanzong) throw new Error('missing direct threads');

    const first = await manager.submitPrompt(oldpan.id, 'first');
    const second = await manager.submitPrompt(yanzong.id, 'second');

    expect(first.queued).toBe(false);
    expect(second.queued).toBe(false);
    expect(sent.filter((entry) => entry.msg.type === 'run.dispatch')).toHaveLength(2);

    const queuedCount = db.prepare(
      'SELECT COUNT(*) as count FROM conversation_prompt_queue'
    ).get() as { count: number };
    expect(queuedCount.count).toBe(0);
  });

  it('同一 agent 的 channel root 与 thread branch 应可并发 dispatch', async () => {
    const channel = manager.createChannel({ name: 'project-room' });
    const agent = manager.createAgent({
      name: 'Tab',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/tab-channel-concurrency',
      channelId: channel.channelId,
    });
    const root = manager.openAgentChannelThread(agent.agentId, channel.channelId, null);
    const thread = manager.openAgentChannelThread(agent.agentId, channel.channelId, 'thread-root-1');
    if (!root || !thread) throw new Error('missing channel conversations');

    const rootSubmit = await manager.submitPrompt(root.id, 'root prompt', {
      recordAsUserMessage: false,
    });
    const threadSubmit = await manager.submitPrompt(thread.id, 'thread prompt', {
      recordAsUserMessage: false,
    });

    expect(rootSubmit.queued).toBe(false);
    expect(threadSubmit.queued).toBe(false);
    expect(sent.filter((entry) => entry.msg.type === 'run.dispatch')).toHaveLength(2);

    const queuedCount = db.prepare(
      'SELECT COUNT(*) as count FROM conversation_prompt_queue'
    ).get() as { count: number };
    expect(queuedCount.count).toBe(0);
  });

  it('排队的 prompt 在同一 conversation 重新派发时应保留 activationContextText', async () => {
    const agent = manager.createAgent({
      name: 'Queued Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/queued-bob',
    });
    const primary = manager.openAgentThread(agent.agentId);
    if (!primary) throw new Error('missing primary thread');

    await manager.submitPrompt(primary.id, 'first');
    const queued = await manager.submitPrompt(primary.id, 'second', {
      recordAsUserMessage: false,
      activationContextText: '[Thread root message]\nhello root',
      replayOverlapRecentMessages: [
        {
          messageId: 'recent-1',
          seq: 1,
          target: '#default:abcd1234',
          senderName: 'Queued Bob',
          senderType: 'agent',
          content: 'hello root',
          createdAt: 1000,
        },
      ],
    });

    expect(queued.queued).toBe(true);

    const queueEntry = db.prepare(
      `SELECT activation_context_text as activationContextText,
              replay_overlap_recent_messages_json as replayOverlapRecentMessagesJson
       FROM conversation_prompt_queue
       WHERE conversation_id = ?`
    ).get(primary.id) as {
      activationContextText: string | null;
      replayOverlapRecentMessagesJson: string | null;
    } | undefined;
    expect(queueEntry?.activationContextText).toBe('[Thread root message]\nhello root');
    expect(queueEntry?.replayOverlapRecentMessagesJson).toContain('"messageId":"recent-1"');

    const firstDispatch = sent[0]?.msg;
    if (!firstDispatch || firstDispatch.type !== 'run.dispatch') throw new Error('missing first dispatch');
    finishRun(db, { runId: firstDispatch.runId, stopReason: 'end_turn' });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', primary.id);

    await manager.onConversationSettled(primary.id);

    const secondDispatch = sent[1]?.msg;
    if (!secondDispatch || secondDispatch.type !== 'run.dispatch') throw new Error('missing second dispatch');
    expect(secondDispatch.contextText).toContain('[Thread root message]\nhello root');
  });
});
