import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  beforeEach(() => {
    db = createTestDb();
    manager = new ConversationManager({ db, config: createTestConfig() });
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

  it('私聊 run 未通过 send_message 回复时应按失败收口', () => {
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

    socket.emit('message', JSON.stringify({
      type: 'run.end',
      runId: 'run-1',
      conversationId: conv.id,
      stopReason: 'end_turn',
    }));

    const runRow = db.prepare('SELECT error FROM runs WHERE run_id = ?')
      .get('run-1') as { error: string | null };
    expect(runRow.error).toBe('Agent did not reply via send_message');
    expect(events).toContainEqual({
      type: 'error',
      message: 'Agent did not reply via send_message',
    });
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

  it('仅发送 progress 消息且后续仍有大量输出时应要求 final reply', () => {
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

    const runRow = db.prepare('SELECT error FROM runs WHERE run_id = ?')
      .get('run-3') as { error: string | null };
    expect(runRow.error).toBe('Agent did not send a final reply via send_message');
    expect(events).toContainEqual({
      type: 'error',
      message: 'Agent did not send a final reply via send_message',
    });
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
});
