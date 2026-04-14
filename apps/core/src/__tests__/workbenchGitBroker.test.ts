import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NodeEntry } from '../services/nodeRegistry.js';
import { NodeRegistry } from '../services/nodeRegistry.js';
import { WorkbenchGitBroker } from '../services/workbenchGitBroker.js';

describe('WorkbenchGitBroker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('应向 node 发送 git status 请求并在响应后 resolve', async () => {
    const registry = new NodeRegistry();
    const sent: string[] = [];

    registry.register({
      nodeId: 'node-1',
      hostname: 'host',
      agentTypes: ['codex_acp'],
      version: '0.1.0',
      ws: {
        readyState: 1,
        send(payload: string) {
          sent.push(payload);
        },
      } as unknown as NodeEntry['ws'],
      lastSeen: Date.now(),
    });

    const broker = new WorkbenchGitBroker({ nodeRegistry: registry, timeoutMs: 500 });
    const promise = broker.getGitStatus('node-1', '/tmp/repo');

    const message = JSON.parse(sent[0] ?? '{}') as { requestId: string; type: string };
    expect(message.type).toBe('workspace.git_status.request');

    broker.handleGitStatusResponse({
      type: 'workspace.git_status.response',
      requestId: message.requestId,
      status: {
        workspaceRoot: '/tmp/repo',
        isGit: true,
        repoRoot: '/tmp/repo',
        workspaceKind: 'local_checkout',
        branchName: 'main',
        remoteUrl: 'git@example.com:repo.git',
        baseRef: 'origin/main',
        hasRemote: true,
        isDirty: true,
        changedFiles: 1,
        stagedFiles: 0,
        unstagedFiles: 1,
        untrackedFiles: 0,
        aheadOfOrigin: 0,
        behindOfOrigin: 0,
        aheadBehind: { ahead: 1, behind: 0 },
      },
    });

    await expect(promise).resolves.toMatchObject({
      workspaceRoot: '/tmp/repo',
      branchName: 'main',
      changedFiles: 1,
    });
  });

  it('node 断开时应 reject 挂起的 git diff 请求', async () => {
    const registry = new NodeRegistry();
    registry.register({
      nodeId: 'node-1',
      hostname: 'host',
      agentTypes: ['codex_acp'],
      version: '0.1.0',
      ws: {
        readyState: 1,
        send() {},
      } as unknown as NodeEntry['ws'],
      lastSeen: Date.now(),
    });

    const broker = new WorkbenchGitBroker({ nodeRegistry: registry, timeoutMs: 500 });
    const promise = broker.getGitDiff('node-1', '/tmp/repo', 'uncommitted');

    broker.rejectPendingForNode('node-1');

    await expect(promise).rejects.toThrow('Agent node disconnected: node-1');
  });

  it('应为 status / diff / action 使用不同超时', async () => {
    vi.useFakeTimers();

    const registry = new NodeRegistry();
    registry.register({
      nodeId: 'node-1',
      hostname: 'host',
      agentTypes: ['codex_acp'],
      version: '0.1.0',
      ws: {
        readyState: 1,
        send() {},
      } as unknown as NodeEntry['ws'],
      lastSeen: Date.now(),
    });

    const broker = new WorkbenchGitBroker({
      nodeRegistry: registry,
      statusTimeoutMs: 10,
      diffTimeoutMs: 20,
      actionTimeoutMs: 30,
    });

    const statusPromise = broker.getGitStatus('node-1', '/tmp/repo');
    await vi.advanceTimersByTimeAsync(11);
    await expect(statusPromise).rejects.toThrow('Workspace git status request timed out.');

    const diffPromise = broker.getGitDiff('node-1', '/tmp/repo', 'uncommitted');
    await vi.advanceTimersByTimeAsync(21);
    await expect(diffPromise).rejects.toThrow('Workspace git diff request timed out.');

    const actionPromise = broker.runGitAction('node-1', '/tmp/repo', 'fetch');
    await vi.advanceTimersByTimeAsync(31);
    await expect(actionPromise).rejects.toThrow('Workspace git action request timed out.');
  });
});
