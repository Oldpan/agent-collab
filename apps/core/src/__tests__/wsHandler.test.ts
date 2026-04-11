import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '@agent-collab/runtime-acp';
import { createTestConfig, createTestDb } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { handleWebSocket } from '../web/wsHandler.js';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close');
  }
}

const waitForAsyncHandlers = async () => new Promise((resolve) => setTimeout(resolve, 0));

describe('wsHandler', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it('queued prompt 应通过状态广播回调同步 conversation status', async () => {
    const db: Db = createTestDb();
    const manager = new ConversationManager({ db, config: createTestConfig() });
    manager.start();
    cleanups.push(() => {
      manager.close();
      db.close();
    });

    const conversation = manager.createConversation({ title: 'Queued Branch', nodeId: 'node-1' });
    const socket = new FakeSocket();
    const statuses: string[] = [];
    const stubManager = {
      getConversation: (conversationId: string) => manager.getConversation(conversationId),
      getDb: () => db,
      submitPrompt: async () => ({ queued: true }),
      handleApproval: async () => ({ ok: true, message: '' }),
    } as unknown as ConversationManager;

    handleWebSocket(socket as any, conversation.id, stubManager, 'oldpan', (_conversationId, status) => {
      statuses.push(status);
    });
    cleanups.push(() => socket.close());

    socket.emit('message', JSON.stringify({ type: 'prompt', text: 'hello' }));
    await waitForAsyncHandlers();

    expect(statuses).toContain('queued');
  });

  it('approval.response 成功后应通过状态广播回调切回 active', async () => {
    const db: Db = createTestDb();
    const manager = new ConversationManager({ db, config: createTestConfig() });
    manager.start();
    cleanups.push(() => {
      manager.close();
      db.close();
    });

    const conversation = manager.createConversation({ title: 'Approval Branch', nodeId: 'node-1' });
    const socket = new FakeSocket();
    const statuses: string[] = [];
    const stubManager = {
      getConversation: (conversationId: string) => manager.getConversation(conversationId),
      getDb: () => db,
      submitPrompt: async () => ({ queued: false }),
      handleApproval: async () => ({ ok: true, message: '' }),
    } as unknown as ConversationManager;

    handleWebSocket(socket as any, conversation.id, stubManager, 'oldpan', (_conversationId, status) => {
      statuses.push(status);
    });
    cleanups.push(() => socket.close());

    socket.emit('message', JSON.stringify({
      type: 'approval.response',
      requestId: 'req-1',
      decision: 'allow',
    }));
    await waitForAsyncHandlers();

    expect(statuses).toContain('active');
  });
});
