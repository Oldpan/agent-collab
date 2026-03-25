import { afterEach, describe, expect, it } from 'vitest';

import type { RunDispatchMsg, NodeToCore } from '@agent-collab/protocol';
import { Executor } from '../executor.js';
import { enqueueDispatch } from '../dispatchQueueStore.js';
import { createTestConfig, createTestDb } from './helpers.js';

describe('Executor recovery', () => {
  const openDbs: Array<ReturnType<typeof createTestDb>> = [];

  afterEach(() => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
  });

  it('node 重启后应发送 recovering 并恢复 running dispatch', async () => {
    const db = createTestDb();
    openDbs.push(db);

    const sent: NodeToCore[] = [];
    const dispatched: RunDispatchMsg[] = [];

    const msg: RunDispatchMsg = {
      type: 'run.dispatch',
      runId: 'run-restore-1',
      conversationId: 'conv-1',
      agentType: 'claude_acp',
      workspacePath: '/tmp',
      prompt: 'resume me',
      sessionKey: 'session-1',
      hostKey: 'conversation:conv-1:claude_acp',
      dispatchMode: 'cold_start',
      contextText: 'ctx',
    };

    enqueueDispatch(db, msg, 'running');

    const executor = new Executor({
      db,
      config: createTestConfig(),
      send: (event) => {
        sent.push(event);
      },
      createHost: ({ hooks }) => ({
        getState: () => 'idle',
        dispatch: async (restoredMsg) => {
          hooks?.onRunStart?.(restoredMsg);
          dispatched.push(restoredMsg);
          hooks?.onRunFinish?.(restoredMsg);
        },
        cancelRun: async () => false,
        handlePermissionResponse: async () => false,
        close: () => {},
      }),
    });

    executor.resumePendingDispatches();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent).toContainEqual({
      type: 'run.event',
      runId: 'run-restore-1',
      conversationId: 'conv-1',
      event: {
        type: 'conversation.status',
        conversationId: 'conv-1',
        status: 'recovering',
      },
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.dispatchMode).toBe('resume');

    const remaining = db
      .prepare(`SELECT COUNT(*) as count FROM node_dispatch_queue`)
      .get() as { count: number };
    expect(remaining.count).toBe(0);

    executor.close();
  });

  it('claude dispatch 应注入隔离的 CLAUDE_CONFIG_DIR', async () => {
    const db = createTestDb();
    openDbs.push(db);

    const captured: Array<{ env?: Record<string, string>; workspaceRoot: string }> = [];
    const workspaceRoot = '/tmp/claude-isolated-test';

    const executor = new Executor({
      db,
      config: createTestConfig(),
      send: () => {},
      createHost: ({ env, workspaceRoot: hostWorkspaceRoot }) => {
        captured.push({ env, workspaceRoot: hostWorkspaceRoot });
        return {
          getState: () => 'idle',
          dispatch: async () => {},
          cancelRun: async () => false,
          handlePermissionResponse: async () => false,
          close: () => {},
          getCurrentRunId: () => null,
          getLastError: () => null,
          getWorkspaceRoot: () => hostWorkspaceRoot,
        };
      },
    });

    await executor.dispatch({
      type: 'run.dispatch',
      runId: 'run-claude-env-1',
      conversationId: 'conv-claude-env-1',
      agentType: 'claude_acp',
      workspacePath: workspaceRoot,
      prompt: 'hello',
      sessionKey: 'session-claude-env-1',
      hostKey: 'conversation:conv-claude-env-1:claude_acp',
      dispatchMode: 'cold_start',
      envVars: {
        ANTHROPIC_MODEL: 'GLM-4.7',
      },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.env).toMatchObject({
      ANTHROPIC_MODEL: 'GLM-4.7',
      CLAUDE_CONFIG_DIR: `${workspaceRoot}/.claude-runtime`,
    });

    executor.close();
  });
});
