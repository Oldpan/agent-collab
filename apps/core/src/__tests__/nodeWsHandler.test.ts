import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreToNode } from '@agent-collab/protocol';
import type { Db } from '@agent-collab/runtime-acp';
import { createRun } from '@agent-collab/runtime-acp';
import { createTestConfig, createTestDb } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { handleNodeWebSocket } from '../web/nodeWsHandler.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }
}

describe('nodeWsHandler', () => {
  let db: Db;
  let manager: ConversationManager;
  let dispatches: CoreToNode[];
  let fakeRegistry: {
    getNode: (nodeId: string) => { nodeId: string; hostname: string; agentTypes: string[]; version: string } | undefined;
    send: (nodeId: string, msg: CoreToNode) => boolean;
  };

  beforeEach(() => {
    db = createTestDb();
    dispatches = [];
    fakeRegistry = {
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
        if (msg.type === 'run.dispatch') {
          queueMicrotask(() => {
            manager.handleRunAccepted(msg.runId, msg.conversationId);
          });
        }
        return true;
      },
    };
    manager = new ConversationManager({ db, config: createTestConfig(), nodeRegistry: fakeRegistry as any });
    manager.start();
  });

  afterEach(() => {
    manager.close();
    db.close();
  });

  it('permission.request 应把会话状态切到 awaiting_approval', () => {
    const conv = manager.createConversation({ title: 'Approval Test', nodeId: 'node-1' });
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    socket.emit('message', JSON.stringify({
      type: 'permission.request',
      runId: 'run-1',
      conversationId: conv.id,
      requestId: 'req-1',
      toolName: 'bash',
      toolArgs: { cmd: 'ls' },
      toolKind: 'exec_command',
    }));

    const row = db.prepare('SELECT status FROM conversations WHERE id = ?')
      .get(conv.id) as { status: string };
    expect(row.status).toBe('awaiting_approval');
    expect(events[0]).toEqual({
      type: 'conversation.status',
      conversationId: conv.id,
      status: 'awaiting_approval',
    });
    expect(events[1]).toEqual({
      type: 'approval.request',
      requestId: 'req-1',
      toolName: 'bash',
      toolArgs: { cmd: 'ls' },
      toolKind: 'exec_command',
    });
  });

  it('node.register 在未显式传 NODE_ID 时应按 machine name 接管 pending machine', () => {
    const machine = manager.createMachine({
      name: 'gpu-box-01',
      envVarKeys: ['ANTHROPIC_API_KEY'],
    });
    const agent = manager.createAgent({
      name: 'Alice',
      agentType: 'claude_acp',
      nodeId: machine.nodeId,
      workspacePath: '/tmp/alice-contract',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    const socket = new FakeSocket();
    const registered: Array<{ nodeId: string; hostname: string }> = [];
    const registry = {
      register(entry: { nodeId: string; hostname: string }) {
        registered.push({ nodeId: entry.nodeId, hostname: entry.hostname });
      },
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, () => {}, db, manager);

    socket.emit('message', JSON.stringify({
      type: 'node.register',
      nodeId: 'node-auto-1',
      hostname: 'gpu-box-01',
      agentTypes: ['claude_acp'],
      version: '0.1.0',
    }));

    const adopted = db.prepare(
      `SELECT node_id as nodeId, hostname, status, display_name as displayName
       FROM nodes
       WHERE node_id = ?`,
    ).get('node-auto-1') as {
      nodeId: string;
      hostname: string;
      status: string;
      displayName: string | null;
    } | undefined;
    const pending = db.prepare(
      `SELECT node_id as nodeId
       FROM nodes
       WHERE node_id = ?`,
    ).get(machine.nodeId) as { nodeId: string } | undefined;
    const adoptedAgent = db.prepare(
      `SELECT node_id as nodeId
       FROM agents
       WHERE agent_id = ?`,
    ).get(agent.agentId) as { nodeId: string | null };
    const adoptedConversation = db.prepare(
      `SELECT node_id as nodeId
       FROM conversations
       WHERE id = ?`,
    ).get(conv.id) as { nodeId: string | null };

    expect(registered).toEqual([{ nodeId: 'node-auto-1', hostname: 'gpu-box-01' }]);
    expect(adopted).toEqual({
      nodeId: 'node-auto-1',
      hostname: 'gpu-box-01',
      status: 'online',
      displayName: 'gpu-box-01',
    });
    expect(pending).toBeUndefined();
    expect(adoptedAgent.nodeId).toBe('node-auto-1');
    expect(adoptedConversation.nodeId).toBe('node-auto-1');
    expect(socket.sent).toContain(JSON.stringify({ type: 'node.ack', nodeId: 'node-auto-1' }));
  });

  it('run.end 错误应把会话状态切到 failed', () => {
    const conv = manager.createConversation({ title: 'Failure Test', nodeId: 'node-1' });
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-1',
      sessionKey: sessionRow.sessionKey,
      promptText: 'hello',
    });

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-1',
      conversationId: conv.id,
      error: 'runtime crashed',
    }));

    const row = db.prepare('SELECT status FROM conversations WHERE id = ?')
      .get(conv.id) as { status: string };
    expect(row.status).toBe('failed');
    expect(events.some((event) => event.type === 'conversation.status' && event.status === 'failed')).toBe(true);
    expect(events.some((event) => event.type === 'error' && event.message === 'runtime crashed')).toBe(true);
    expect(events).toContainEqual({
      type: 'turn.end',
      turnId: 'run-1',
      stopReason: 'error',
      endedAt: expect.any(Number),
      error: 'runtime crashed',
    });
  });

  it('run.debug.snapshot 应回填 run debug 输入与 session runtime 状态', () => {
    const agent = manager.createAgent({
      name: 'Bob',
      agentType: 'codex_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/bob-debug',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const socket = new FakeSocket();
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, () => {}, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-debug-1',
      sessionKey: sessionRow.sessionKey,
      promptText: 'hello',
    });
    db.prepare(
      `INSERT INTO run_debug_inputs(
         run_id, conversation_id, session_key, dispatch_mode, prompt_text, dispatched_prompt_text, created_at, updated_at
       )
       VALUES(?, ?, ?, 'cold_start', ?, ?, ?, ?)`,
    ).run('run-debug-1', conv.id, sessionRow.sessionKey, 'hello', '[Reply contract]\n\nhello', 1000, 1000);

    socket.emit('message', JSON.stringify({
      type: 'run.debug.snapshot',
      runId: 'run-debug-1',
      conversationId: conv.id,
      sessionKey: sessionRow.sessionKey,
      acpSessionId: 'acp-session-1',
      isFreshSession: true,
      isExact: true,
      effectiveSystemPromptText: 'SYSTEM PROMPT',
      effectiveContextText: 'CONTEXT',
    }));

    const debugRow = db.prepare(
      `SELECT acp_session_id as acpSessionId,
              is_fresh_session as isFreshSession,
              is_exact as isExact,
              system_prompt_text as systemPromptText,
              context_text as contextText
         FROM run_debug_inputs
        WHERE run_id = ?`,
    ).get('run-debug-1') as {
      acpSessionId: string | null;
      isFreshSession: number | null;
      isExact: number;
      systemPromptText: string | null;
      contextText: string | null;
    };
    expect(debugRow).toEqual({
      acpSessionId: 'acp-session-1',
      isFreshSession: 1,
      isExact: 1,
      systemPromptText: 'SYSTEM PROMPT',
      contextText: 'CONTEXT',
    });

    const updatedSession = db.prepare(
      `SELECT acp_session_id as acpSessionId, system_prompt_text as systemPromptText
         FROM sessions
        WHERE session_key = ?`,
    ).get(sessionRow.sessionKey) as { acpSessionId: string | null; systemPromptText: string | null };
    expect(updatedSession).toEqual({
      acpSessionId: 'acp-session-1',
      systemPromptText: 'SYSTEM PROMPT',
    });
  });

  it('私聊 run 未通过 send_message 回复时应落 delta_fallback 消息并正常收口', () => {
    const agent = manager.createAgent({
      name: 'Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/bob-contract',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-1',
      sessionKey: sessionRow.sessionKey,
      promptText: 'hello',
    });
    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'node/event', ?, ?)`,
    ).run(
      'run-1',
      1,
      JSON.stringify({
        type: 'content.delta',
        text: '这是上一轮已经写好的结论，请把它发送给当前会话用户。',
      }),
      1000,
    );

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-1',
      conversationId: conv.id,
      stopReason: 'end_turn',
    }));
    const originalRun = db.prepare('SELECT error, stop_reason as stopReason FROM runs WHERE run_id = ?')
      .get('run-1') as { error: string | null; stopReason: string | null };
    expect(originalRun.error).toBeNull();
    expect(originalRun.stopReason).toBe('end_turn');
    const fallbackRow = db.prepare(
      `SELECT channel_id as channelId, target, content, message_source as messageSource
       FROM channel_messages
       WHERE run_id = ?
       ORDER BY created_at DESC, seq DESC
       LIMIT 1`,
    ).get('run-1') as {
      channelId: string;
      target: string;
      content: string;
      messageSource: string | null;
    };
    expect(fallbackRow.channelId).toBe(`dm:${agent.agentId}`);
    expect(fallbackRow.target).toBe('dm:@oldpan');
    expect(fallbackRow.content).toBe('这是上一轮已经写好的结论，请把它发送给当前会话用户。');
    expect(fallbackRow.messageSource).toBe('delta_fallback');
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.some((event) => event.type === 'conversation.status' && event.status === 'idle')).toBe(true);
    expect(dispatches).toHaveLength(0);
  });

  it('仅输出较短私聊 delta 时也应落 delta_fallback 消息', () => {
    const agent = manager.createAgent({
      name: 'ShortReplyBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/short-reply-bob-contract',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-short-dm-fallback-1',
      sessionKey: sessionRow.sessionKey,
      promptText: '你好',
    });
    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'node/event', ?, ?)`,
    ).run(
      'run-short-dm-fallback-1',
      1,
      JSON.stringify({
        type: 'content.delta',
        text: '你好，有什么需要我处理的？',
      }),
      1000,
    );

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-short-dm-fallback-1',
      conversationId: conv.id,
      stopReason: 'end_turn',
    }));

    const fallbackRow = db.prepare(
      `SELECT channel_id as channelId, target, content, message_source as messageSource
       FROM channel_messages
       WHERE run_id = ? AND message_source = 'delta_fallback'
       ORDER BY created_at DESC, seq DESC
       LIMIT 1`,
    ).get('run-short-dm-fallback-1') as {
      channelId: string;
      target: string;
      content: string;
      messageSource: string | null;
    } | undefined;
    expect(fallbackRow).toMatchObject({
      channelId: `dm:${agent.agentId}`,
      target: 'dm:@oldpan',
      content: '你好，有什么需要我处理的？',
      messageSource: 'delta_fallback',
    });
    expect(events.some((event) => event.type === 'conversation.status' && event.status === 'idle')).toBe(true);
  });

  it('空响应噪音 delta 不应落 delta_fallback 聊天记录', () => {
    const agent = manager.createAgent({
      name: 'NoisyFallbackBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/noisy-fallback-bob-contract',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-empty-delta-fallback-1',
      sessionKey: sessionRow.sessionKey,
      promptText: '你好',
    });

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, message_kind)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?)`,
    ).run(
      'msg-empty-delta-fallback-1',
      `dm:${agent.agentId}`,
      agent.agentId,
      agent.name,
      'dm:@oldpan',
      '你好！我是 kimi，打杂小能手。有什么我可以帮你的吗？',
      1,
      999,
      'run-empty-delta-fallback-1',
      'final',
    );

    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'node/event', ?, ?)`,
    ).run(
      'run-empty-delta-fallback-1',
      1,
      JSON.stringify({
        type: 'content.delta',
        text: `(Empty response: {'content': [], 'stop_reason': 'end_turn'})`,
      }),
      1000,
    );

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-empty-delta-fallback-1',
      conversationId: conv.id,
      stopReason: 'end_turn',
    }));

    const fallbackCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM channel_messages
       WHERE run_id = ? AND message_source = 'delta_fallback'`,
    ).get('run-empty-delta-fallback-1') as { count: number };
    expect(fallbackCount.count).toBe(0);
    expect(events.some((event) => event.type === 'conversation.status' && event.status === 'idle')).toBe(true);
  });

  it('plan/task updated 噪音 delta 不应落 delta_fallback 聊天记录', () => {
    const agent = manager.createAgent({
      name: 'PlanNoiseBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/plan-noise-bob-contract',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-plan-delta-fallback-1',
      sessionKey: sessionRow.sessionKey,
      promptText: 'hello',
    });

    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES
       (?, 1, 'node/event', ?, ?),
       (?, 2, 'node/event', ?, ?)`,
    ).run(
      'run-plan-delta-fallback-1',
      JSON.stringify({
        type: 'content.delta',
        text: '[plan] Plan updated',
      }),
      1000,
      'run-plan-delta-fallback-1',
      JSON.stringify({
        type: 'content.delta',
        text: 'Task updated',
      }),
      1001,
    );

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-plan-delta-fallback-1',
      conversationId: conv.id,
      stopReason: 'end_turn',
    }));

    const fallbackCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM channel_messages
       WHERE run_id = ? AND message_source = 'delta_fallback'`,
    ).get('run-plan-delta-fallback-1') as { count: number };
    expect(fallbackCount.count).toBe(0);
    expect(events.some((event) => event.type === 'conversation.status' && event.status === 'idle')).toBe(true);
  });

  it('私聊 run 已绑定 send_message 时应允许正常完成', () => {
    const agent = manager.createAgent({
      name: 'Alice',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/alice-contract',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-2',
      sessionKey: sessionRow.sessionKey,
      promptText: 'hello',
    });
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?)`,
    ).run('msg-1', `dm:${agent.agentId}`, agent.agentId, agent.name, `dm:@${agent.name}`, 'hi', 1, Date.now(), 'run-2');

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-2',
      conversationId: conv.id,
      stopReason: 'end_turn',
    }));

    const runRow = db.prepare('SELECT error, stop_reason as stopReason FROM runs WHERE run_id = ?')
      .get('run-2') as { error: string | null; stopReason: string | null };
    expect(runRow.error).toBeNull();
    expect(runRow.stopReason).toBe('end_turn');
    expect(events.some((event) => event.type === 'conversation.status' && event.status === 'idle')).toBe(true);
  });

  it('已发送 final 后若继续输出实质性 delta，应追加 delta_fallback 消息', () => {
    const agent = manager.createAgent({
      name: 'TrailingFinalBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/trailing-final-bob-contract',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-trailing-final-1',
      sessionKey: sessionRow.sessionKey,
      promptText: 'list envs',
    });

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, message_kind)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?)`,
    ).run(
      'msg-trailing-final-1',
      `dm:${agent.agentId}`,
      agent.agentId,
      agent.name,
      'dm:@oldpan',
      '你的 conda 环境列表：',
      1,
      1000,
      'run-trailing-final-1',
      'final',
    );

    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'node/event', ?, ?)`,
    ).run(
      'run-trailing-final-1',
      1,
      JSON.stringify({
        type: 'content.delta',
        text: '1. base - 基础环境\n2. develop - 开发环境\n3. vllm - 推理环境',
      }),
      2000,
    );

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-trailing-final-1',
      conversationId: conv.id,
      stopReason: 'end_turn',
    }));
    const originalRun = db.prepare('SELECT error, stop_reason as stopReason FROM runs WHERE run_id = ?')
      .get('run-trailing-final-1') as { error: string | null; stopReason: string | null };
    expect(originalRun.error).toBeNull();
    expect(originalRun.stopReason).toBe('end_turn');
    const fallbackRow = db.prepare(
      `SELECT content, message_source as messageSource
       FROM channel_messages
       WHERE run_id = ? AND message_source = 'delta_fallback'
       ORDER BY created_at DESC, seq DESC
       LIMIT 1`,
    ).get('run-trailing-final-1') as { content: string; messageSource: string | null } | undefined;
    expect(fallbackRow?.content).toBe('1. base - 基础环境\n2. develop - 开发环境\n3. vllm - 推理环境');
    expect(fallbackRow?.messageSource).toBe('delta_fallback');
    expect(events.some((event) => event.type === 'conversation.status' && event.status === 'idle')).toBe(true);
    expect(dispatches).toHaveLength(0);
  });

  it('已发送 final 后收到 cancel stopReason 时应按成功收口，不触发 repair', () => {
    const agent = manager.createAgent({
      name: 'CancelFinalBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/cancel-final-bob-contract',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-cancel-final-1',
      sessionKey: sessionRow.sessionKey,
      promptText: 'hello',
    });

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, message_kind)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?)`,
    ).run(
      'msg-cancel-final-1',
      `dm:${agent.agentId}`,
      agent.agentId,
      agent.name,
      'dm:@oldpan',
      'done',
      1,
      Date.now(),
      'run-cancel-final-1',
      'final',
    );

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-cancel-final-1',
      conversationId: conv.id,
      stopReason: 'cancelled',
    }));

    const runRow = db.prepare('SELECT error, stop_reason as stopReason FROM runs WHERE run_id = ?')
      .get('run-cancel-final-1') as { error: string | null; stopReason: string | null };
    expect(runRow.error).toBeNull();
    expect(runRow.stopReason).toBe('cancelled');
    expect(events.some((event) => event.type === 'conversation.status' && event.status === 'idle')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(dispatches).toHaveLength(0);
  });

  it('未发送 final 就 cancel 时应按失败收口，且不触发 repair', () => {
    const agent = manager.createAgent({
      name: 'CancelNoFinalBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/cancel-no-final-bob-contract',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-cancel-no-final-1',
      sessionKey: sessionRow.sessionKey,
      promptText: 'hello',
    });

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, message_kind)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?)`,
    ).run(
      'msg-cancel-progress-1',
      `dm:${agent.agentId}`,
      agent.agentId,
      agent.name,
      'dm:@oldpan',
      'working',
      1,
      Date.now(),
      'run-cancel-no-final-1',
      'progress',
    );

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-cancel-no-final-1',
      conversationId: conv.id,
      stopReason: 'cancelled',
    }));

    const runRow = db.prepare('SELECT error, stop_reason as stopReason FROM runs WHERE run_id = ?')
      .get('run-cancel-no-final-1') as { error: string | null; stopReason: string | null };
    expect(runRow.error).toBe('Agent run was cancelled before sending a final reply');
    expect(runRow.stopReason).toBeNull();
    expect(events).toContainEqual({
      type: 'error',
      message: 'Agent run was cancelled before sending a final reply',
    });
    expect(dispatches).toHaveLength(0);
  });

  it('被标记为 dm task handoff 的主 DM run 在 cancel 后应按 handoff 成功收口', () => {
    const agent = manager.createAgent({
      name: 'CancelHandoffBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/cancel-handoff-bob-contract',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-cancel-handoff-1',
      sessionKey: sessionRow.sessionKey,
      promptText: 'handoff then stop',
    });
    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, 1, 'platform/handoff', ?, ?)`,
    ).run(
      'run-cancel-handoff-1',
      JSON.stringify({
        status: 'started',
        primaryTarget: 'dm:@oldpan',
        threadTarget: 'dm:@oldpan:abc12345',
        taskNumber: 7,
      }),
      Date.now(),
    );

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-cancel-handoff-1',
      conversationId: conv.id,
      stopReason: 'cancelled',
    }));

    const runRow = db.prepare('SELECT error, stop_reason as stopReason FROM runs WHERE run_id = ?')
      .get('run-cancel-handoff-1') as { error: string | null; stopReason: string | null };
    expect(runRow).toEqual({
      error: null,
      stopReason: 'handoff',
    });
    expect(events).toContainEqual({
      type: 'turn.end',
      turnId: 'run-cancel-handoff-1',
      stopReason: 'handoff',
      endedAt: expect.any(Number),
      error: undefined,
    });
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('仅发送 progress 消息且后续仍有大量输出时应追加 delta_fallback 消息并正常收口', () => {
    const agent = manager.createAgent({
      name: 'Charlie',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/charlie-contract',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-3',
      sessionKey: sessionRow.sessionKey,
      promptText: 'check torch',
    });

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, message_kind)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?)`,
    ).run('msg-progress', `dm:${agent.agentId}`, agent.agentId, agent.name, `dm:@${agent.name}`, 'I am checking now.', 1, 1000, 'run-3', 'progress');

    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'node/event', ?, ?)`,
    ).run(
      'run-3',
      1,
      JSON.stringify({
        type: 'content.delta',
        text: 'The environment does not have torch installed. You can install it with pip install torch in the develop environment.',
      }),
      2000,
    );

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-3',
      conversationId: conv.id,
      stopReason: 'end_turn',
    }));
    const originalRun = db.prepare('SELECT error, stop_reason as stopReason FROM runs WHERE run_id = ?')
      .get('run-3') as { error: string | null; stopReason: string | null };
    expect(originalRun.error).toBeNull();
    expect(originalRun.stopReason).toBe('end_turn');
    const rows = db.prepare(
      `SELECT content, message_kind as messageKind, message_source as messageSource
       FROM channel_messages
       WHERE run_id = ?
       ORDER BY created_at ASC, seq ASC`,
    ).all('run-3') as Array<{ content: string; messageKind: string | null; messageSource: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ content: 'I am checking now.', messageKind: 'progress', messageSource: null });
    expect(rows[1]).toMatchObject({
      content: 'The environment does not have torch installed. You can install it with pip install torch in the develop environment.',
      messageKind: null,
      messageSource: 'delta_fallback',
    });
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(dispatches).toHaveLength(0);
  });

  it('旧式未标注 kind 的单条回复若与后续输出只是重复，不应误判缺少 final reply', () => {
    const agent = manager.createAgent({
      name: 'LegacyBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/legacy-bob-contract',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-legacy-1',
      sessionKey: sessionRow.sessionKey,
      promptText: 'hello',
    });

    const replyText = '你好！我是 Bob，你的 AI 协作助手。有什么我可以帮你的吗？';
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?)`,
    ).run('msg-legacy-1', `dm:${agent.agentId}`, agent.agentId, agent.name, 'dm:@oldpan', replyText, 1, 1000, 'run-legacy-1');

    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'node/event', ?, ?)`,
    ).run(
      'run-legacy-1',
      1,
      JSON.stringify({
        type: 'content.delta',
        text: replyText,
      }),
      2000,
    );

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-legacy-1',
      conversationId: conv.id,
      stopReason: 'end_turn',
    }));

    const runRow = db.prepare('SELECT error, stop_reason as stopReason FROM runs WHERE run_id = ?')
      .get('run-legacy-1') as { error: string | null; stopReason: string | null };
    const rows = db.prepare(
      `SELECT COUNT(*) as count FROM channel_messages WHERE run_id = ?`,
    ).get('run-legacy-1') as { count: number };
    expect(runRow.error).toBeNull();
    expect(runRow.stopReason).toBe('end_turn');
    expect(rows.count).toBe(1);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('channel branch run 未通过 send_message 回复时应追加频道 delta_fallback 消息', () => {
    const agent = manager.createAgent({
      name: 'ChannelBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/channel-bob-contract',
    });
    const conv = manager.openAgentChannelThread(agent.agentId, 'default', null);
    if (!conv) throw new Error('missing conversation');
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-channel-repair-1',
      sessionKey: sessionRow.sessionKey,
      promptText: '@Bob 我们刚才聊了什么',
    });
    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'node/event', ?, ?)`,
    ).run(
      'run-channel-repair-1',
      1,
      JSON.stringify({
        type: 'content.delta',
        text: '这是频道中的最终回答，请把它发回 #default。',
      }),
      1000,
    );

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-channel-repair-1',
      conversationId: conv.id,
      stopReason: 'end_turn',
    }));

    const fallbackRow = db.prepare(
      `SELECT channel_id as channelId, target, content, message_source as messageSource
       FROM channel_messages
       WHERE run_id = ? AND message_source = 'delta_fallback'
       ORDER BY created_at DESC, seq DESC
       LIMIT 1`,
    ).get('run-channel-repair-1') as {
      channelId: string;
      target: string;
      content: string;
      messageSource: string | null;
    } | undefined;
    expect(fallbackRow).toMatchObject({
      channelId: 'default',
      target: '#default',
      content: '这是频道中的最终回答，请把它发回 #default。',
      messageSource: 'delta_fallback',
    });
    expect(events.some((event) => event.type === 'conversation.status' && event.status === 'idle')).toBe(true);
    expect(dispatches).toHaveLength(0);
  });

  it('channel delta_fallback 即使包含 @agent 也不应触发新的协作唤醒', () => {
    const sender = manager.createAgent({
      name: 'FallbackSender',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/channel-fallback-sender',
      channelId: 'default',
    });
    const helper = manager.createAgent({
      name: 'FallbackHelper',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/channel-fallback-helper',
      channelId: 'default',
    });
    const conv = manager.openAgentChannelThread(sender.agentId, 'default', null);
    const helperConv = manager.openAgentChannelThread(helper.agentId, 'default', null);
    if (!conv || !helperConv) throw new Error('missing channel conversations');

    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-channel-fallback-mention',
      sessionKey: sessionRow.sessionKey,
      promptText: 'give the channel a direct answer',
    });
    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'node/event', ?, ?)`,
    ).run(
      'run-channel-fallback-mention',
      1,
      JSON.stringify({
        type: 'content.delta',
        text: '@FallbackHelper 请顺手看一下这条频道回复。',
      }),
      1000,
    );

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-channel-fallback-mention',
      conversationId: conv.id,
      stopReason: 'end_turn',
    }));

    const fallbackRow = db.prepare(
      `SELECT content, message_source as messageSource
       FROM channel_messages
       WHERE run_id = ? AND message_source = 'delta_fallback'
       ORDER BY created_at DESC, seq DESC
       LIMIT 1`,
    ).get('run-channel-fallback-mention') as {
      content: string;
      messageSource: string | null;
    } | undefined;
    expect(fallbackRow).toMatchObject({
      content: '@FallbackHelper 请顺手看一下这条频道回复。',
      messageSource: 'delta_fallback',
    });

    const helperRunCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ?`,
    ).get(helperConv.id) as { count: number };
    const helperQueueCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM conversation_prompt_queue
       WHERE conversation_id = ?`,
    ).get(helperConv.id) as { count: number };
    expect(helperRunCount.count).toBe(0);
    expect(helperQueueCount.count).toBe(0);
    expect(events.some((event) => event.type === 'conversation.status' && event.status === 'idle')).toBe(true);
    expect(dispatches).toHaveLength(0);
  });

  it('run.event 中的 recovering 状态应更新会话状态', () => {
    const conv = manager.createConversation({ title: 'Recovering Test', nodeId: 'node-1' });
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    socket.emit('message', JSON.stringify({
      type: 'run.event',
      runId: 'run-1',
      conversationId: conv.id,
      event: {
        type: 'conversation.status',
        conversationId: conv.id,
        status: 'recovering',
      },
    }));

    const row = db.prepare('SELECT status FROM conversations WHERE id = ?')
      .get(conv.id) as { status: string };
    expect(row.status).toBe('recovering');
    expect(events).toContainEqual({
      type: 'conversation.status',
      conversationId: conv.id,
      status: 'recovering',
    });
  });

  it('run.accepted 应把会话切到 active', () => {
    const conv = manager.createConversation({ title: 'Accepted Test', nodeId: 'node-1' });
    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    const dispatchPromise = manager.dispatchToNode(conv.id, 'hello');
    socket.emit('message', JSON.stringify({
      type: 'run.accepted',
      runId: (dispatches[0] as Extract<CoreToNode, { type: 'run.dispatch' }>).runId,
      conversationId: conv.id,
    }));

    return dispatchPromise.then(() => {
      const row = db.prepare('SELECT status FROM conversations WHERE id = ?')
      .get(conv.id) as { status: string };
      expect(row.status).toBe('active');
      expect(events).toContainEqual({
        type: 'conversation.status',
        conversationId: conv.id,
        status: 'active',
      });
    });
  });

  it('node 断连时不应清空 core 侧 queued prompt，并应收口未结束 run', async () => {
    const agent = manager.createAgent({
      name: 'Queue Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/queue-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    const socket = new FakeSocket();
    const events: any[] = [];
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, (_conversationId, event) => {
      events.push(event);
    }, db, manager);

    socket.emit('message', JSON.stringify({
      type: 'node.register',
      nodeId: 'node-1',
      hostname: 'queue-host',
      agentTypes: ['claude_acp'],
      version: '0.1.0',
    }));

    await manager.submitPrompt(conv.id, 'first');
    const queued = await manager.submitPrompt(conv.id, 'second');
    expect(queued.queued).toBe(true);

    socket.emit('close');

    const queueCount = db.prepare(
      'SELECT COUNT(*) as count FROM conversation_prompt_queue WHERE conversation_id = ?',
    ).get(conv.id) as { count: number };
    expect(queueCount.count).toBe(1);

    const openRuns = db.prepare(
      `SELECT COUNT(*) as count
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ? AND r.ended_at IS NULL`,
    ).get(conv.id) as { count: number };
    expect(openRuns.count).toBe(0);
    expect(events.some((event) => event.type === 'error' && event.message === 'Agent node disconnected: node-1')).toBe(true);
  });

  it('node 重连后应继续派发保留的 queued prompt', async () => {
    const agent = manager.createAgent({
      name: 'Reconnect Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/reconnect-bob',
    });
    const conv = manager.openAgentThread(agent.agentId);
    if (!conv) throw new Error('missing conversation');

    const socket = new FakeSocket();
    const registry = {
      register() {},
      unregister() {},
      heartbeat() {},
    };

    handleNodeWebSocket(socket as any, registry as any, () => {}, db, manager);

    socket.emit('message', JSON.stringify({
      type: 'node.register',
      nodeId: 'node-1',
      hostname: 'reconnect-host',
      agentTypes: ['claude_acp'],
      version: '0.1.0',
    }));

    await manager.submitPrompt(conv.id, 'first');
    await manager.submitPrompt(conv.id, 'second');
    socket.emit('close');

    const reconnectSocket = new FakeSocket();
    handleNodeWebSocket(reconnectSocket as any, registry as any, () => {}, db, manager);
    reconnectSocket.emit('message', JSON.stringify({
      type: 'node.register',
      nodeId: 'node-1',
      hostname: 'reconnect-host',
      agentTypes: ['claude_acp'],
      version: '0.1.0',
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dispatches.filter((msg) => msg.type === 'run.dispatch')).toHaveLength(2);
    const queuedCount = db.prepare(
      'SELECT COUNT(*) as count FROM conversation_prompt_queue WHERE conversation_id = ?',
    ).get(conv.id) as { count: number };
    expect(queuedCount.count).toBe(0);
  });
});
