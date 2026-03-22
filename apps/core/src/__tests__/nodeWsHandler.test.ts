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
    }, db);

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
    }, db);

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
    }, db);

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
