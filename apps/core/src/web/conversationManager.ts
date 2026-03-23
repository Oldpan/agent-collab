import { randomUUID } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import type { ConversationInfo, AgentType, ChannelInfo, AgentInfo, CreateAgentRequest, UpdateAgentRequest, MachineInfo, CreateMachineRequest } from '@agent-collab/protocol';
import {
  log,
  createSession,
  upsertBinding,
} from '@agent-collab/runtime-acp';
import type { Db } from '@agent-collab/runtime-acp';
import { getRuntimeDriver } from '@agent-collab/protocol';
import type { AppConfig } from '../config.js';
import { ExecutionDispatcher } from '../execution/executionDispatcher.js';
import type { NodeRegistry } from '../services/nodeRegistry.js';

function slugifyAgentName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export class ConversationManager {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly nodeRegistry?: NodeRegistry;
  private readonly executionDispatcher: ExecutionDispatcher;

  constructor(params: { db: Db; config: AppConfig; nodeRegistry?: NodeRegistry }) {
    this.db = params.db;
    this.config = params.config;
    this.nodeRegistry = params.nodeRegistry;
    this.executionDispatcher = new ExecutionDispatcher({
      db: params.db,
      config: params.config,
      nodeRegistry: params.nodeRegistry,
      getAgentById: (agentId) => this.getAgent(agentId),
    });
  }

  getDb(): Db {
    return this.db;
  }

  start(): void {
    log.info('ConversationManager ready');
  }

  close(): void {
    // no-op: all execution happens on agent-nodes
  }

  // ─── Agent CRUD ───

  createAgent(params: CreateAgentRequest): AgentInfo {
    const agentId = randomUUID();
    const agentType: AgentType = params.agentType ?? 'claude_acp';
    const channelId = params.channelId ?? 'default';
    const envVarsJson = params.envVars && Object.keys(params.envVars).length > 0
      ? JSON.stringify(params.envVars)
      : null;
    const now = Date.now();

    const workspacePath = params.workspacePath
      ?? path.join(os.homedir(), '.agent-collab', 'agents', `${agentId}-${slugifyAgentName(params.name)}`);
    fs.mkdirSync(workspacePath, { recursive: true });

    this.db.prepare(
      `INSERT INTO agents(agent_id, name, agent_type, channel_id, system_prompt, memory, env_vars, node_id, workspace_path, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      agentId, params.name, agentType, channelId,
      params.systemPrompt ?? '', '',
      envVarsJson, params.nodeId ?? null, workspacePath,
      now, now,
    );

    return {
      agentId, name: params.name, agentType, channelId,
      systemPrompt: params.systemPrompt ?? '',
      envVars: params.envVars, nodeId: params.nodeId ?? null,
      workspacePath, createdAt: now, updatedAt: now,
    };
  }

  listAgents(channelId?: string): AgentInfo[] {
    const sql = channelId
      ? `SELECT agent_id as agentId, name, agent_type as agentType, channel_id as channelId,
                system_prompt as systemPrompt, env_vars as envVarsJson,
                node_id as nodeId, workspace_path as workspacePath,
                created_at as createdAt, updated_at as updatedAt
         FROM agents WHERE channel_id = ? ORDER BY updated_at DESC`
      : `SELECT agent_id as agentId, name, agent_type as agentType, channel_id as channelId,
                system_prompt as systemPrompt, env_vars as envVarsJson,
                node_id as nodeId, workspace_path as workspacePath,
                created_at as createdAt, updated_at as updatedAt
         FROM agents ORDER BY updated_at DESC`;
    const rows = channelId
      ? this.db.prepare(sql).all(channelId) as Array<AgentRow>
      : this.db.prepare(sql).all() as Array<AgentRow>;
    return rows.map(rowToAgentInfo);
  }

  getAgent(agentId: string): AgentInfo | null {
    const row = this.db.prepare(
      `SELECT agent_id as agentId, name, agent_type as agentType, channel_id as channelId,
              system_prompt as systemPrompt, env_vars as envVarsJson,
              node_id as nodeId, workspace_path as workspacePath,
              created_at as createdAt, updated_at as updatedAt
       FROM agents WHERE agent_id = ?`
    ).get(agentId) as AgentRow | undefined;
    return row ? rowToAgentInfo(row) : null;
  }

  updateAgent(agentId: string, req: UpdateAgentRequest): AgentInfo | null {
    const existing = this.getAgent(agentId);
    if (!existing) return null;

    const now = Date.now();
    const name = req.name ?? existing.name;
    const systemPrompt = req.systemPrompt ?? existing.systemPrompt;

    this.db.prepare(
      `UPDATE agents SET name = ?, system_prompt = ?, updated_at = ? WHERE agent_id = ?`
    ).run(name, systemPrompt, now, agentId);

    return { ...existing, name, systemPrompt, updatedAt: now } satisfies AgentInfo;
  }

  deleteAgent(agentId: string): void {
    // Nullify agent_id on conversations before deleting the agent
    this.db.prepare(`UPDATE conversations SET agent_id = NULL WHERE agent_id = ?`).run(agentId);
    this.db.prepare(`DELETE FROM agents WHERE agent_id = ?`).run(agentId);
  }

  // ─── CRUD ───

  createConversation(params: {
    agentType?: AgentType;
    workspacePath?: string;
    title?: string;
    channelId?: string;
    envVars?: Record<string, string>;
    nodeId?: string;
    agentId?: string;
  }): ConversationInfo {
    const id = randomUUID();

    // If agentId provided, inherit agent's settings as defaults
    const agent = params.agentId ? this.getAgent(params.agentId) : null;
    const agentType: AgentType = params.agentType ?? (agent?.agentType ?? 'claude_acp');
    const workspacePath = params.workspacePath ?? agent?.workspacePath ?? this.config.workspaceRoot;
    const title = params.title ?? '';
    const channelId = params.channelId ?? 'default';
    const nodeId = params.nodeId ?? agent?.nodeId ?? null;
    const envVarsJson = (() => {
      const ev = params.envVars ?? agent?.envVars;
      return ev && Object.keys(ev).length > 0 ? JSON.stringify(ev) : null;
    })();
    const now = Date.now();

    const sessionKey = randomUUID();
    const preset = getRuntimeDriver(agentType);

    // Create session row
    createSession(this.db, {
      sessionKey,
      agentCommand: preset.command,
      agentArgs: preset.args,
      cwd: workspacePath,
      loadSupported: false,
    });

    // bindingKey = web:{channelId}:{conversationId}:{agentType}
    // → each agent type in each thread gets its own isolated session
    upsertBinding(
      this.db,
      { platform: 'web', chatId: channelId, threadId: id, userId: agentType },
      sessionKey,
    );

    // Create conversations row
    this.db
      .prepare(
        `INSERT INTO conversations(id, channel_id, title, agent_type, workspace_path, session_key, status, env_vars, node_id, agent_id, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?)`,
      )
      .run(id, channelId, title, agentType, workspacePath, sessionKey, envVarsJson, nodeId, params.agentId ?? null, now, now);

    return { id, channelId, title, agentType, workspacePath, status: 'idle', createdAt: now, updatedAt: now, nodeId, agentId: params.agentId ?? null };
  }

  listConversations(filter?: { channelId?: string; agentId?: string }): ConversationInfo[] {
    const convSelect = `SELECT id, channel_id as channelId, title, agent_type as agentType,
                workspace_path as workspacePath, status, node_id as nodeId,
                agent_id as agentId, created_at as createdAt, updated_at as updatedAt
         FROM conversations`;

    if (filter?.channelId && filter?.agentId) {
      return this.db.prepare(`${convSelect} WHERE channel_id = ? AND agent_id = ? ORDER BY updated_at DESC`)
        .all(filter.channelId, filter.agentId) as ConversationInfo[];
    }
    if (filter?.channelId) {
      return this.db.prepare(`${convSelect} WHERE channel_id = ? ORDER BY updated_at DESC`)
        .all(filter.channelId) as ConversationInfo[];
    }
    if (filter?.agentId) {
      return this.db.prepare(`${convSelect} WHERE agent_id = ? ORDER BY updated_at DESC`)
        .all(filter.agentId) as ConversationInfo[];
    }
    return this.db.prepare(`${convSelect} ORDER BY updated_at DESC`).all() as ConversationInfo[];
  }

  getConversation(id: string): ConversationInfo | null {
    const row = this.db
      .prepare(
        `SELECT id, channel_id as channelId, title, agent_type as agentType,
                workspace_path as workspacePath, status, node_id as nodeId,
                agent_id as agentId, created_at as createdAt, updated_at as updatedAt
         FROM conversations WHERE id = ?`,
      )
      .get(id) as ConversationInfo | undefined;
    return row ?? null;
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  async dispatchToNode(conversationId: string, promptText: string): Promise<void> {
    await this.executionDispatcher.dispatchPrompt(conversationId, promptText);
  }

  // ─── Channel CRUD ───

  createChannel(params: { name: string; workspacePath?: string | null }): ChannelInfo {
    const channelId = params.name === 'default' ? 'default' : randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO channels(channel_id, name, workspace_path, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?)`,
      )
      .run(channelId, params.name, params.workspacePath ?? null, now, now);
    return {
      channelId,
      name: params.name,
      workspacePath: params.workspacePath ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  listChannels(): ChannelInfo[] {
    return this.db
      .prepare(
        `SELECT channel_id as channelId, name, workspace_path as workspacePath,
                created_at as createdAt, updated_at as updatedAt
         FROM channels ORDER BY created_at ASC`,
      )
      .all() as ChannelInfo[];
  }

  getChannel(channelId: string): ChannelInfo | null {
    const row = this.db
      .prepare(
        `SELECT channel_id as channelId, name, workspace_path as workspacePath,
                created_at as createdAt, updated_at as updatedAt
         FROM channels WHERE channel_id = ?`,
      )
      .get(channelId) as ChannelInfo | undefined;
    return row ?? null;
  }

  async handleApproval(
    conversationId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ): Promise<{ ok: boolean; message: string }> {
    return this.executionDispatcher.handleApproval(conversationId, requestId, decision);
  }

  cancelConversationRun(
    conversationId: string,
  ): { ok: boolean; message: string; runId?: string } {
    return this.executionDispatcher.cancelConversationRun(conversationId);
  }

  private updateStatus(conversationId: string, status: string): void {
    this.db
      .prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), conversationId);
  }

  // ─── Machine CRUD ───

  createMachine(params: CreateMachineRequest): MachineInfo {
    const nodeId = randomUUID();
    const now = Date.now();
    const envVarKeysJson = JSON.stringify(params.envVarKeys ?? []);

    this.db.prepare(
      `INSERT INTO nodes(node_id, hostname, agent_types_json, version, status, last_seen, created_at, display_name, env_var_keys, provisioned_at)
       VALUES(?, '', '[]', '', 'pending', 0, 0, ?, ?, ?)`
    ).run(nodeId, params.name, envVarKeysJson, now);

    return {
      nodeId,
      name: params.name,
      hostname: null,
      agentTypes: [],
      version: null,
      status: 'pending',
      envVarKeys: params.envVarKeys ?? [],
      lastSeen: null,
      provisionedAt: now,
      createdAt: 0,
    };
  }

  listMachines(): MachineInfo[] {
    const rows = this.db.prepare(
      `SELECT node_id as nodeId, hostname, agent_types_json as agentTypesJson, version,
              status, last_seen as lastSeen, created_at as createdAt,
              display_name as displayName, env_var_keys as envVarKeysJson, provisioned_at as provisionedAt
       FROM nodes ORDER BY provisioned_at DESC, created_at ASC`
    ).all() as Array<MachineRow>;

    return rows.map((row) => {
      const isOnline = !!this.nodeRegistry?.getNode(row.nodeId);
      return rowToMachineInfo(row, isOnline);
    });
  }

  getMachine(nodeId: string): MachineInfo | null {
    const row = this.db.prepare(
      `SELECT node_id as nodeId, hostname, agent_types_json as agentTypesJson, version,
              status, last_seen as lastSeen, created_at as createdAt,
              display_name as displayName, env_var_keys as envVarKeysJson, provisioned_at as provisionedAt
       FROM nodes WHERE node_id = ?`
    ).get(nodeId) as MachineRow | undefined;

    if (!row) return null;
    const isOnline = !!this.nodeRegistry?.getNode(nodeId);
    return rowToMachineInfo(row, isOnline);
  }

  deleteMachine(nodeId: string): void {
    this.db.prepare(`UPDATE agents SET node_id = NULL WHERE node_id = ?`).run(nodeId);
    this.db.prepare(`DELETE FROM nodes WHERE node_id = ?`).run(nodeId);
  }
}

type AgentRow = {
  agentId: string;
  name: string;
  agentType: AgentType;
  channelId: string;
  systemPrompt: string;
  envVarsJson: string | null;
  nodeId: string | null;
  workspacePath: string | null;
  createdAt: number;
  updatedAt: number;
};

function rowToAgentInfo(row: AgentRow): AgentInfo {
  return {
    agentId: row.agentId,
    name: row.name,
    agentType: row.agentType,
    channelId: row.channelId,
    systemPrompt: row.systemPrompt,
    envVars: parseEnvVars(row.envVarsJson),
    nodeId: row.nodeId,
    workspacePath: row.workspacePath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type MachineRow = {
  nodeId: string;
  hostname: string;
  agentTypesJson: string;
  version: string;
  status: string;
  lastSeen: number;
  createdAt: number;
  displayName: string | null;
  envVarKeysJson: string | null;
  provisionedAt: number;
};

function rowToMachineInfo(row: MachineRow, isOnline: boolean): MachineInfo {
  let agentTypes: string[] = [];
  try { agentTypes = JSON.parse(row.agentTypesJson); } catch { /* ignore */ }

  let envVarKeys: string[] = [];
  try {
    const parsed = JSON.parse(row.envVarKeysJson ?? '[]');
    if (Array.isArray(parsed)) envVarKeys = parsed;
  } catch { /* ignore */ }

  const status: MachineInfo['status'] = isOnline ? 'online'
    : (row.status === 'pending' ? 'pending' : 'offline');

  return {
    nodeId: row.nodeId,
    name: row.displayName || row.hostname || row.nodeId,
    hostname: row.hostname || null,
    agentTypes,
    version: row.version || null,
    status,
    envVarKeys,
    lastSeen: row.lastSeen || null,
    provisionedAt: row.provisionedAt,
    createdAt: row.createdAt,
  };
}

function parseEnvVars(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore
  }
  return undefined;
}
