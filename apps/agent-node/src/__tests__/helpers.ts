import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { migrate, openDb, type Db } from '@agent-collab/runtime-acp';
import type { AgentNodeConfig } from '../config.js';

export function createTestDb(): Db {
  const dbPath = join(tmpdir(), `agent-node-test-${randomUUID()}.db`);
  const db = openDb(dbPath);
  migrate(db);
  return db;
}

export function createTestConfig(): AgentNodeConfig {
  return {
    nodeId: 'node-test',
    hostname: 'test-host',
    coreUrl: 'ws://127.0.0.1:3100',
    agentTypes: ['claude_acp', 'codex_acp'],
    version: '0.1.0-test',
    workspaceRoot: '/tmp',
    dbPath: join(tmpdir(), `agent-node-config-${randomUUID()}.db`),
    heartbeatIntervalMs: 1_000,
    reconnectInitialDelayMs: 10,
    reconnectMaxDelayMs: 100,
    hostIdleTimeoutMs: 1_000,
    hostSweepIntervalMs: 50,
    acpAgentCommand: 'npx',
    acpAgentArgs: ['-y', '@zed-industries/claude-code-acp@latest'],
    acpPromptTimeoutMs: 120_000,
    uiJsonMaxChars: 3_000,
  };
}
