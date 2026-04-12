import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '@agent-collab/runtime-acp';
import WebSocket from 'ws';

import { createTestConfig, createTestDb } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { buildServerApp } from '../web/server.js';
import { createAdminUser } from '../services/auth.js';
import { NodeRegistry } from '../services/nodeRegistry.js';

let db: Db;
let app: FastifyInstance;
let manager: ConversationManager;
let nodeRegistry: NodeRegistry;
let baseUrl: string;
let adminToken: string;
let intervalHandles: Array<ReturnType<typeof setInterval>>;

const originalSetInterval = global.setInterval;

beforeEach(async () => {
  db = createTestDb();
  nodeRegistry = new NodeRegistry();
  intervalHandles = [];

  global.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = originalSetInterval(...args);
    intervalHandles.push(handle);
    return handle;
  }) as typeof setInterval;

  manager = new ConversationManager({
    db,
    config: createTestConfig({
      dbPath: join(tmpdir(), `status-broadcast-${randomUUID()}.db`),
      webPort: 0,
    }),
    nodeRegistry,
  });
  manager.start();

  app = await buildServerApp({
    port: 0,
    host: '127.0.0.1',
    conversationManager: manager,
    db,
    nodeRegistry,
    workspaceBroker: {
      async resetWorkspace() {},
      async readFile() {
        throw new Error('not_found:test');
      },
      async writeFile() {},
    } as any,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;

  const adminResult = await createAdminUser(db, 'admin', 'secret123');
  if (!adminResult.success || !adminResult.session) {
    throw new Error(adminResult.error ?? 'Failed to create admin user');
  }
  adminToken = adminResult.session.token;
});

afterEach(async () => {
  if (app) {
    await app.close();
  }
  for (const handle of intervalHandles) {
    clearInterval(handle);
  }
  global.setInterval = originalSetInterval;
  manager.close();
  db.close();
});

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function openChannelSocket(channelId: string, token: string): Promise<WebSocket> {
  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/channels/${encodeURIComponent(channelId)}/stream?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening channel websocket')), 1000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return ws;
}

async function waitForChannelConversationStatus(
  ws: WebSocket,
  conversationId: string,
  status: string,
): Promise<any> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for channel.conversation.status ${status} for ${conversationId}`));
    }, 1000);

    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(String(raw));
        if (
          parsed?.type === 'channel.conversation.status'
          && parsed?.conversation?.id === conversationId
          && parsed?.conversation?.status === status
        ) {
          cleanup();
          resolve(parsed);
        }
      } catch {
        // ignore malformed events
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
    };

    ws.on('message', onMessage);
  });
}

describe('status broadcast routes', () => {
  it.each([
    {
      name: 'conversation restart',
      buildPath: ({ conversationId }: { conversationId: string; agentId: string; channelId: string }) =>
        `/api/conversations/${conversationId}/restart`,
    },
    {
      name: 'conversation clear-chat',
      buildPath: ({ conversationId }: { conversationId: string; agentId: string; channelId: string }) =>
        `/api/conversations/${conversationId}/clear-chat`,
    },
    {
      name: 'agent reset',
      buildPath: ({ agentId }: { conversationId: string; agentId: string; channelId: string }) =>
        `/api/agents/${agentId}/reset`,
    },
    {
      name: 'channel clear-chat',
      buildPath: ({ channelId }: { conversationId: string; agentId: string; channelId: string }) =>
        `/api/channels/${channelId}/clear-chat`,
    },
  ])('$name 应把 branch conversation 的 idle 状态同步到 channel websocket', async ({ buildPath }) => {
    const channel = manager.createChannel({ name: `ops-${randomUUID().slice(0, 8)}` });
    const agent = manager.createAgent({
      name: `Bob-${randomUUID().slice(0, 8)}`,
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: `/tmp/${randomUUID()}`,
    });
    manager.joinChannel(agent.agentId, channel.channelId);
    const conversation = manager.openAgentChannelThread(agent.agentId, channel.channelId, 'deadbeef00000000');
    if (!conversation) throw new Error('missing branch conversation');

    db.prepare(`UPDATE conversations SET status = 'active', updated_at = ? WHERE id = ?`)
      .run(Date.now(), conversation.id);

    const ws = await openChannelSocket(channel.channelId, adminToken);
    try {
      const eventPromise = waitForChannelConversationStatus(ws, conversation.id, 'idle');

      const response = await app.inject({
        method: 'POST',
        url: buildPath({
          conversationId: conversation.id,
          agentId: agent.agentId,
          channelId: channel.channelId,
        }),
        headers: authHeaders(adminToken),
      });

      expect(response.statusCode).toBe(200);
      const event = await eventPromise;
      expect(event).toMatchObject({
        type: 'channel.conversation.status',
        channelId: channel.channelId,
        conversation: {
          id: conversation.id,
          channelId: channel.channelId,
          threadKind: 'branch',
          status: 'idle',
          agentId: agent.agentId,
        },
      });
    } finally {
      ws.close();
      await new Promise((resolve) => ws.once('close', resolve));
    }
  });
});
