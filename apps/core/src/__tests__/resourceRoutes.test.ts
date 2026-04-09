import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '@agent-collab/runtime-acp';

import { createTestConfig, createTestDb } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { buildServerApp } from '../web/server.js';
import { NodeRegistry } from '../services/nodeRegistry.js';
import type { NodeEntry } from '../services/nodeRegistry.js';
import { AgentWorkspaceBroker } from '../services/agentWorkspaceBroker.js';
import { createAdminUser, createSession, createUser, setUserAccess } from '../services/auth.js';

type TestUsers = {
  adminToken: string;
  userId: string;
  userToken: string;
};

let db: Db;
let app: FastifyInstance;
let manager: ConversationManager;
let nodeRegistry: NodeRegistry;
let workspaceBroker: AgentWorkspaceBroker;
let sentByNode: Map<string, string[]>;
let intervalHandles: Array<ReturnType<typeof setInterval>>;

const originalSetInterval = global.setInterval;

beforeEach(async () => {
  db = createTestDb();
  nodeRegistry = new NodeRegistry();
  workspaceBroker = new AgentWorkspaceBroker({ nodeRegistry, timeoutMs: 500 });
  sentByNode = new Map();
  intervalHandles = [];

  global.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = originalSetInterval(...args);
    intervalHandles.push(handle);
    return handle;
  }) as typeof setInterval;

  manager = new ConversationManager({
    db,
    config: createTestConfig({
      dbPath: join(tmpdir(), `resource-routes-${randomUUID()}.db`),
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
    workspaceBroker,
  });
});

afterEach(async () => {
  if (app) {
    await app.close();
  }
  for (const handle of intervalHandles) {
    clearInterval(handle);
  }
  global.setInterval = originalSetInterval;
});

async function createTestUsers(): Promise<TestUsers> {
  const adminResult = await createAdminUser(db, 'admin', 'secret123');
  if (!adminResult.success || !adminResult.session) {
    throw new Error(adminResult.error ?? 'Failed to create admin user');
  }

  const userResult = await createUser(db, 'alice', 'secret123');
  if (!userResult.success || !userResult.user) {
    throw new Error(userResult.error ?? 'Failed to create regular user');
  }

  const userSession = createSession(db, userResult.user.id);
  return {
    adminToken: adminResult.session.token,
    userId: userResult.user.id,
    userToken: userSession.token,
  };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function registerNode(nodeId: string, lastSeen = Date.now()): void {
  sentByNode.set(nodeId, []);
  nodeRegistry.register({
    nodeId,
    hostname: nodeId,
    agentTypes: ['claude_acp', 'codex_acp'],
    version: '0.1.0',
    ws: {
      readyState: 1,
      send(payload: string) {
        sentByNode.get(nodeId)?.push(payload);
      },
    } as unknown as NodeEntry['ws'],
    lastSeen,
  });
}

async function waitForSentRequest<T extends { requestId: string }>(
  nodeId: string,
  index = 0,
): Promise<T> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const payload = sentByNode.get(nodeId)?.[index];
    if (payload) {
      return JSON.parse(payload) as T;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for request ${index} on ${nodeId}`);
}

describe('resource space routes', () => {
  it('admin can create spaces while non-admin users only see channel-bound spaces they can access', async () => {
    const { adminToken, userId, userToken } = await createTestUsers();
    const channel = manager.createChannel({ name: 'docs-room' });
    setUserAccess(db, userId, [], [channel.channelId]);

    manager.createResourceSpace({
      name: 'shared-docs',
      resourceType: 'docs',
      backendType: 'shared_mount',
      rootPath: '/mnt/shared/docs',
      channelId: channel.channelId,
    });
    manager.createResourceSpace({
      name: 'private-exp',
      resourceType: 'experiments',
      backendType: 'shared_mount',
      rootPath: '/mnt/private/experiments',
    });

    const visibleResponse = await app.inject({
      method: 'GET',
      url: '/api/resource-spaces',
      headers: authHeaders(userToken),
    });

    expect(visibleResponse.statusCode).toBe(200);
    expect(visibleResponse.json()).toMatchObject([
      { name: 'shared-docs', channelId: channel.channelId },
    ]);

    const forbiddenCreate = await app.inject({
      method: 'POST',
      url: '/api/resource-spaces',
      headers: {
        ...authHeaders(userToken),
        'content-type': 'application/json',
      },
      payload: {
        name: 'user-create-denied',
        resourceType: 'docs',
        backendType: 'shared_mount',
        rootPath: '/mnt/shared/denied',
      },
    });

    expect(forbiddenCreate.statusCode).toBe(403);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/resource-spaces',
      headers: {
        ...authHeaders(adminToken),
        'content-type': 'application/json',
      },
      payload: {
        name: 'node-docs',
        resourceType: 'docs',
        backendType: 'node_path',
        nodeId: 'node-1',
        rootPath: '/srv/docs',
        channelId: channel.channelId,
      },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json()).toMatchObject({
      name: 'node-docs',
      backendType: 'node_path',
      nodeId: 'node-1',
      rootPath: '/srv/docs',
      channelId: channel.channelId,
    });
  });

  it('tree and file routes proxy workspace reads with scaffold disabled', async () => {
    const { userId, userToken } = await createTestUsers();
    const channel = manager.createChannel({ name: 'docs-tree' });
    setUserAccess(db, userId, [], [channel.channelId]);
    registerNode('node-1');

    const resourceSpace = manager.createResourceSpace({
      name: 'docs-tree-space',
      resourceType: 'docs',
      backendType: 'node_path',
      nodeId: 'node-1',
      rootPath: '/shared/docs',
      channelId: channel.channelId,
    });

    const treePromise = app.inject({
      method: 'GET',
      url: `/api/resource-spaces/${resourceSpace.resourceSpaceId}/tree`,
      headers: authHeaders(userToken),
    });
    const treeRequest = await waitForSentRequest<{
      requestId: string;
      type: string;
      workspaceRoot: string;
      relativePath: string;
      scaffold?: boolean;
    }>('node-1', 0);

    expect(treeRequest.type).toBe('workspace.list.request');
    expect(treeRequest.workspaceRoot).toBe('/shared/docs');
    expect(treeRequest.relativePath).toBe('');
    expect(treeRequest.scaffold).toBe(false);

    workspaceBroker.handleWorkspaceListResponse({
      type: 'workspace.list.response',
      requestId: treeRequest.requestId,
      relativePath: '',
      entries: [
        {
          name: 'README.md',
          path: 'README.md',
          kind: 'file',
          size: 128,
          modifiedAt: 123,
        },
      ],
    });

    const treeResponse = await treePromise;
    expect(treeResponse.statusCode).toBe(200);
    expect(treeResponse.json()).toEqual({
      path: '',
      entries: [
        {
          name: 'README.md',
          path: 'README.md',
          kind: 'file',
          size: 128,
          modifiedAt: 123,
        },
      ],
    });

    const filePromise = app.inject({
      method: 'GET',
      url: `/api/resource-spaces/${resourceSpace.resourceSpaceId}/file?path=README.md`,
      headers: authHeaders(userToken),
    });
    const fileRequest = await waitForSentRequest<{
      requestId: string;
      type: string;
      workspaceRoot: string;
      relativePath: string;
      scaffold?: boolean;
    }>('node-1', 1);

    expect(fileRequest.type).toBe('workspace.read.request');
    expect(fileRequest.workspaceRoot).toBe('/shared/docs');
    expect(fileRequest.relativePath).toBe('README.md');
    expect(fileRequest.scaffold).toBe(false);

    workspaceBroker.handleWorkspaceReadResponse({
      type: 'workspace.read.response',
      requestId: fileRequest.requestId,
      relativePath: 'README.md',
      content: '# Docs\n',
      mimeType: 'text/markdown',
      size: 7,
      modifiedAt: 456,
    });

    const fileResponse = await filePromise;
    expect(fileResponse.statusCode).toBe(200);
    expect(fileResponse.json()).toEqual({
      path: 'README.md',
      content: '# Docs\n',
      mimeType: 'text/markdown',
      size: 7,
      modifiedAt: 456,
    });
  });

  it('analyze queues a private direct-thread prompt using the selected file content', async () => {
    const { userId, userToken } = await createTestUsers();
    const channel = manager.createChannel({ name: 'analysis-room' });
    registerNode('node-1');

    const agent = manager.createAgent({
      name: 'Analyst',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/analyst-resource-space',
    });
    manager.joinChannel(agent.agentId, channel.channelId);
    setUserAccess(db, userId, [agent.agentId], [channel.channelId]);

    const resourceSpace = manager.createResourceSpace({
      name: 'analysis-docs',
      resourceType: 'docs',
      backendType: 'node_path',
      nodeId: 'node-1',
      rootPath: '/shared/docs',
      channelId: channel.channelId,
    });

    const existingConversation = manager.openAgentThread(agent.agentId, userId);
    expect(existingConversation).not.toBeNull();
    db.prepare(`UPDATE conversations SET status = 'active' WHERE id = ?`).run(existingConversation!.id);

    const analyzePromise = app.inject({
      method: 'POST',
      url: `/api/resource-spaces/${resourceSpace.resourceSpaceId}/analyze`,
      headers: {
        ...authHeaders(userToken),
        'content-type': 'application/json',
      },
      payload: {
        agentId: agent.agentId,
        question: 'Summarize the main risks in this document.',
        path: 'README.md',
      },
    });

    const readRequest = await waitForSentRequest<{
      requestId: string;
      type: string;
      relativePath: string;
      scaffold?: boolean;
    }>('node-1', 0);
    expect(readRequest.type).toBe('workspace.read.request');
    expect(readRequest.relativePath).toBe('README.md');
    expect(readRequest.scaffold).toBe(false);

    workspaceBroker.handleWorkspaceReadResponse({
      type: 'workspace.read.response',
      requestId: readRequest.requestId,
      relativePath: 'README.md',
      content: '# Summary\nThis experiment regressed latency.\n',
      mimeType: 'text/markdown',
      size: 43,
      modifiedAt: 789,
    });

    const analyzeResponse = await analyzePromise;
    expect(analyzeResponse.statusCode).toBe(200);
    expect(analyzeResponse.json()).toMatchObject({
      queued: true,
      conversation: { id: existingConversation!.id },
    });

    const queuedPrompt = db.prepare(
      `SELECT prompt_text as promptText
       FROM conversation_prompt_queue
       WHERE conversation_id = ?
       ORDER BY queue_id DESC
       LIMIT 1`,
    ).get(existingConversation!.id) as { promptText: string } | undefined;

    expect(queuedPrompt?.promptText).toContain('Please analyze a shared resource file from "analysis-docs".');
    expect(queuedPrompt?.promptText).toContain('File path: README.md.');
    expect(queuedPrompt?.promptText).toContain('Summarize the main risks in this document.');
    expect(queuedPrompt?.promptText).toContain('# Summary');
  });
});
