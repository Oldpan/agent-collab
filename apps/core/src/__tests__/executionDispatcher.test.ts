import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finishRun } from '@agent-collab/runtime-acp';
import type { CoreToNode } from '@agent-collab/protocol';
import type { Db } from '@agent-collab/runtime-acp';
import { createTestConfig, createTestDb } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';

describe('ExecutionDispatcher', () => {
  let db: Db;
  const sent: Array<{ nodeId: string; msg: CoreToNode }> = [];
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
      return true;
    },
  };

  let manager: ConversationManager;

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
    expect(dispatch.systemPromptText).toContain('prefer `mcp__chat__send_message(content="...")` with no target');
    expect(dispatch.systemPromptText).toContain('Sending `kind="final"` marks your current answer as complete');
    expect(dispatch.systemPromptText).toContain('Do **not** convert a main-channel message');
    expect(dispatch.systemPromptText).toContain('Do **not** quote or repeat that metadata block back to the user');
    expect(dispatch.systemPromptText).toContain('Maintain memory carefully');
    expect(dispatch.contextText).toContain('[Local Memory Guide]');
    expect(dispatch.contextText).toContain('Local memory is stored as ordinary workspace files');
    expect(dispatch.contextText).toContain('Do not use MCP resource-reading tools');
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
    expect(dispatch.prompt).toContain('target: dm:@oldpan');
    expect(dispatch.prompt).toContain('recipient: @Direct Bob');
    expect(dispatch.prompt).toContain('[Triggered message body]');
    expect(dispatch.prompt).toContain('你好，帮我总结一下刚才的结论');
    expect(dispatch.prompt).toContain('Reply only via mcp__chat__send_message(...)');
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

  it('同一 agent 的第二个 thread 提交时应进入 queued', async () => {
    const agent = manager.createAgent({
      name: 'Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/bob-test',
    });
    const primary = manager.openAgentThread(agent.agentId);
    if (!primary) throw new Error('missing primary thread');
    const branch = manager.createConversation({
      agentId: agent.agentId,
      agentType: agent.agentType,
      nodeId: agent.nodeId ?? undefined,
      workspacePath: agent.workspacePath ?? undefined,
      channelId: agent.channelId,
      threadKind: 'branch',
      isPrimaryThread: false,
      title: 'Branch',
    });

    await manager.submitPrompt(primary.id, 'first');
    const queued = await manager.submitPrompt(branch.id, 'second');

    expect(queued.queued).toBe(true);
    const queuedRow = db.prepare(
      'SELECT status FROM conversations WHERE id = ?'
    ).get(branch.id) as { status: string };
    expect(queuedRow.status).toBe('queued');

    const queueEntry = db.prepare(
      `SELECT conversation_id as conversationId, prompt_text as promptText,
              activation_context_text as activationContextText
       FROM conversation_prompt_queue
       WHERE agent_id = ?`
    ).get(agent.agentId) as {
      conversationId: string;
      promptText: string;
      activationContextText: string | null;
    } | undefined;
    expect(queueEntry).toEqual({
      conversationId: branch.id,
      promptText: 'second',
      activationContextText: null,
    });
  });

  it('排队的 prompt 在重新派发时应保留 activationContextText', async () => {
    const agent = manager.createAgent({
      name: 'Queued Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/queued-bob',
    });
    const primary = manager.openAgentThread(agent.agentId);
    if (!primary) throw new Error('missing primary thread');
    const branch = manager.createConversation({
      agentId: agent.agentId,
      agentType: agent.agentType,
      nodeId: agent.nodeId ?? undefined,
      workspacePath: agent.workspacePath ?? undefined,
      channelId: agent.channelId,
      threadKind: 'branch',
      isPrimaryThread: false,
      title: 'Queued Branch',
    });

    await manager.submitPrompt(primary.id, 'first');
    const queued = await manager.submitPrompt(branch.id, 'second', {
      recordAsUserMessage: false,
      activationContextText: '[Thread root message]\nhello root',
    });

    expect(queued.queued).toBe(true);

    const queueEntry = db.prepare(
      `SELECT activation_context_text as activationContextText
       FROM conversation_prompt_queue
       WHERE conversation_id = ?`
    ).get(branch.id) as { activationContextText: string | null } | undefined;
    expect(queueEntry?.activationContextText).toBe('[Thread root message]\nhello root');

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
