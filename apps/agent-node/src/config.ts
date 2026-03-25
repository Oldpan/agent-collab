import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { listRuntimeDrivers } from '@agent-collab/protocol';
import type { RuntimeConfig } from '@agent-collab/runtime-acp';

export type AgentNodeConfig = RuntimeConfig & {
  nodeId: string;
  hostname: string;
  coreUrl: string;
  agentTypes: string[];
  version: string;
  workspaceRoot: string;
  dbPath: string;
  heartbeatIntervalMs: number;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
};

export function loadConfig(): AgentNodeConfig {
  const coreUrl = process.env.CORE_URL ?? 'ws://localhost:3100';
  const hostname = process.env.NODE_HOSTNAME ?? os.hostname();
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? path.join(os.homedir(), '.agent-node', 'workspace');
  const dbPath =
    process.env.DB_PATH ?? path.join(os.homedir(), '.agent-node', 'db.sqlite');
  const nodeId = process.env.NODE_ID ?? resolveStableNodeId(dbPath);

  return {
    nodeId,
    hostname,
    coreUrl,
    agentTypes: listRuntimeDrivers().map((driver) => driver.agentType),
    version: '0.1.0',
    workspaceRoot,
    dbPath,
    // RuntimeConfig fields
    acpAgentCommand: process.env.ACP_AGENT_COMMAND ?? 'npx',
    acpAgentArgs: process.env.ACP_AGENT_ARGS
      ? JSON.parse(process.env.ACP_AGENT_ARGS)
      : ['-y', '@zed-industries/claude-code-acp@latest'],
    uiJsonMaxChars: Number(process.env.UI_JSON_MAX_CHARS ?? 3000),
    heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS ?? 15_000),
    reconnectInitialDelayMs: Number(process.env.RECONNECT_INITIAL_DELAY_MS ?? 1_000),
    reconnectMaxDelayMs: Number(process.env.RECONNECT_MAX_DELAY_MS ?? 30_000),
  };
}

function resolveStableNodeId(dbPath: string): string {
  const dir = path.dirname(dbPath);
  const filePath = path.join(dir, 'node-id');
  fs.mkdirSync(dir, { recursive: true });

  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // fall through
  }

  const nodeId = `node-${randomUUID()}`;
  fs.writeFileSync(filePath, `${nodeId}\n`, 'utf8');
  return nodeId;
}
