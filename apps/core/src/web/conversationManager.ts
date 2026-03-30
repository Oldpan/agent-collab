import { randomUUID } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import type {
  ConversationInfo,
  AgentType,
  ChannelInfo,
  ChannelCollaborationMode,
  AgentInfo,
  CreateAgentRequest,
  UpdateAgentRequest,
  UpdateChannelRequest,
  MachineInfo,
  CreateMachineRequest,
  ThreadKind,
  AgentPermissionKind,
} from '@agent-collab/protocol';
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
import {
  deleteChannelSubscription,
  listChannelSubscriptions,
  upsertChannelSubscription,
} from './channelSubscriptions.js';
import { deleteTargetParticipantsForAgent, deleteTargetParticipantsForChannel } from './targetParticipants.js';

function slugifyAgentName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

type AgentRow = {
  agentId: string;
  name: string;
  agentType: AgentType;
  channelId: string;
  systemPrompt: string;
  description: string | null;
  envVarsJson: string | null;
  disabledToolKindsJson: string | null;
  nodeId: string | null;
  workspacePath: string | null;
  createdAt: number;
  updatedAt: number;
};

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

  getConfig(): AppConfig {
    return this.config;
  }

  start(): void {
    this.backfillConversationReplyTargets();
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
    const disabledToolKindsJson = params.disabledToolKinds && params.disabledToolKinds.length > 0
      ? JSON.stringify(params.disabledToolKinds)
      : null;
    const now = Date.now();

    const workspacePath = params.workspacePath
      ?? path.join(os.homedir(), '.agent-collab', 'agents', `${agentId}-${slugifyAgentName(params.name)}`);
    fs.mkdirSync(workspacePath, { recursive: true });

    const description = params.description?.trim() || null;

    this.db.prepare(
      `INSERT INTO agents(agent_id, name, agent_type, channel_id, system_prompt, description, memory, env_vars, disabled_tool_kinds, node_id, workspace_path, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      agentId, params.name, agentType, channelId,
      params.systemPrompt ?? '', description, '',
      envVarsJson, disabledToolKindsJson, params.nodeId ?? null, workspacePath,
      now, now,
    );
    this.db.prepare(
      `INSERT OR IGNORE INTO agent_channel_memberships(agent_id, channel_id, is_home, joined_at)
       VALUES(?, ?, 1, ?)`
    ).run(agentId, channelId, now);

    return {
      agentId, name: params.name, agentType, channelId, channelIds: [channelId],
      systemPrompt: params.systemPrompt ?? '',
      ...(description ? { description } : {}),
      envVars: params.envVars, disabledToolKinds: params.disabledToolKinds, nodeId: params.nodeId ?? null,
      workspacePath, createdAt: now, updatedAt: now,
    };
  }

  listAgents(channelId?: string): AgentInfo[] {
    const sql = channelId
      ? `SELECT a.agent_id as agentId, a.name, a.agent_type as agentType, a.channel_id as channelId,
                a.system_prompt as systemPrompt, a.description,
                a.env_vars as envVarsJson, a.disabled_tool_kinds as disabledToolKindsJson,
                a.node_id as nodeId, a.workspace_path as workspacePath,
                a.created_at as createdAt, a.updated_at as updatedAt
         FROM agents a
         JOIN agent_channel_memberships m ON m.agent_id = a.agent_id
         WHERE m.channel_id = ? ORDER BY a.updated_at DESC`
      : `SELECT agent_id as agentId, name, agent_type as agentType, channel_id as channelId,
                system_prompt as systemPrompt, description,
                env_vars as envVarsJson, disabled_tool_kinds as disabledToolKindsJson,
                node_id as nodeId, workspace_path as workspacePath,
                created_at as createdAt, updated_at as updatedAt
         FROM agents ORDER BY updated_at DESC`;
    const rows = channelId
      ? this.db.prepare(sql).all(channelId) as Array<AgentRow>
      : this.db.prepare(sql).all() as Array<AgentRow>;
    return rows.map((row) => this.rowToAgentInfo(row));
  }

  getAgent(agentId: string): AgentInfo | null {
    const row = this.db.prepare(
      `SELECT agent_id as agentId, name, agent_type as agentType, channel_id as channelId,
              system_prompt as systemPrompt, description,
              env_vars as envVarsJson, disabled_tool_kinds as disabledToolKindsJson,
              node_id as nodeId, workspace_path as workspacePath,
              created_at as createdAt, updated_at as updatedAt
       FROM agents WHERE agent_id = ?`
    ).get(agentId) as AgentRow | undefined;
    return row ? this.rowToAgentInfo(row) : null;
  }

  updateAgent(agentId: string, req: UpdateAgentRequest): AgentInfo | null {
    const existing = this.getAgent(agentId);
    if (!existing) return null;

    const now = Date.now();
    const name = req.name ?? existing.name;
    const systemPrompt = req.systemPrompt ?? existing.systemPrompt;
    const description = 'description' in req ? (req.description?.trim() || null) : (existing.description ?? null);
    const envVars = req.envVars ?? existing.envVars;
    const disabledToolKinds = req.disabledToolKinds ?? existing.disabledToolKinds;
    const channelId = req.channelId ?? existing.channelId;
    const envVarsJson = envVars && Object.keys(envVars).length > 0
      ? JSON.stringify(envVars)
      : null;
    const disabledToolKindsJson = disabledToolKinds && disabledToolKinds.length > 0
      ? JSON.stringify(disabledToolKinds)
      : null;

    this.db.prepare(
      `UPDATE agents
       SET name = ?, system_prompt = ?, description = ?, env_vars = ?, disabled_tool_kinds = ?, channel_id = ?, updated_at = ?
       WHERE agent_id = ?`
    ).run(name, systemPrompt, description, envVarsJson, disabledToolKindsJson, channelId, now, agentId);

    // Migrate home channel membership if channelId changed
    if (req.channelId && req.channelId !== existing.channelId) {
      this.db.prepare(
        `UPDATE agent_channel_memberships SET is_home = 0 WHERE agent_id = ? AND channel_id = ?`
      ).run(agentId, existing.channelId);
      this.db.prepare(
        `INSERT INTO agent_channel_memberships(agent_id, channel_id, is_home, joined_at)
         VALUES(?, ?, 1, ?)
         ON CONFLICT(agent_id, channel_id) DO UPDATE SET is_home = 1`
      ).run(agentId, channelId, now);
    }

    return this.getAgent(agentId) ?? { ...existing, name, systemPrompt, envVars, disabledToolKinds, channelId, updatedAt: now } satisfies AgentInfo;
  }

  deleteAgent(agentId: string): { deletedConversations: number } {
    // Get all conversations for this agent to cascade delete their data
    const rows = this.db.prepare(
      `SELECT id, session_key as sessionKey
       FROM conversations WHERE agent_id = ?`,
    ).all(agentId) as Array<{ id: string; sessionKey: string }>;

    // Cascade delete all conversation data
    for (const row of rows) {
      const bindingKeys = this.db.prepare(
        `SELECT binding_key as bindingKey FROM bindings WHERE session_key = ?`,
      ).all(row.sessionKey) as Array<{ bindingKey: string }>;
      const runIds = this.db.prepare(`SELECT run_id as runId FROM runs WHERE session_key = ?`)
        .all(row.sessionKey) as Array<{ runId: string }>;

      this.db.prepare('DELETE FROM conversation_prompt_queue WHERE conversation_id = ?').run(row.id);

      for (const run of runIds) {
        this.db.prepare('DELETE FROM delivery_checkpoints WHERE run_id = ?').run(run.runId);
        this.db.prepare('DELETE FROM events WHERE run_id = ?').run(run.runId);
      }

      this.db.prepare('DELETE FROM runs WHERE session_key = ?').run(row.sessionKey);

      for (const binding of bindingKeys) {
        this.db.prepare('DELETE FROM jobs WHERE binding_key = ?').run(binding.bindingKey);
        this.db.prepare('DELETE FROM tool_policies WHERE binding_key = ?').run(binding.bindingKey);
        this.db.prepare('DELETE FROM delivery_checkpoints WHERE binding_key = ?').run(binding.bindingKey);
        this.db.prepare('DELETE FROM ui_prefs WHERE binding_key = ?').run(binding.bindingKey);
        this.db.prepare('DELETE FROM tool_allow_prefixes WHERE binding_key = ?').run(binding.bindingKey);
      }

      this.db.prepare('DELETE FROM bindings WHERE session_key = ?').run(row.sessionKey);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(row.id);
      this.db.prepare('DELETE FROM sessions WHERE session_key = ?').run(row.sessionKey);
    }

    // Delete agent-related data
    this.db.prepare(`DELETE FROM conversation_prompt_queue WHERE agent_id = ?`).run(agentId);
    this.db.prepare(`DELETE FROM channel_messages WHERE channel_id = ?`).run(`dm:${agentId}`);
    this.db.prepare(`DELETE FROM agent_message_checkpoints WHERE agent_id = ?`).run(agentId);
    this.db.prepare(`DELETE FROM agent_channel_memberships WHERE agent_id = ?`).run(agentId);
    deleteTargetParticipantsForAgent(this.db, agentId);

    // Finally delete the agent
    this.db.prepare(`DELETE FROM agents WHERE agent_id = ?`).run(agentId);

    return { deletedConversations: rows.length };
  }

  // ─── CRUD ───

  createConversation(params: {
    agentType?: AgentType;
    workspacePath?: string;
    title?: string;
    channelId?: string;
    threadKind?: ThreadKind;
    isPrimaryThread?: boolean;
    threadRootId?: string | null;
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
    const channelId = params.channelId ?? agent?.channelId ?? 'default';
    const nodeId = params.nodeId ?? agent?.nodeId ?? null;
    const threadKind: ThreadKind = params.threadKind ?? 'direct';
    const isPrimaryThread = params.isPrimaryThread ?? false;
    const threadRootId = params.threadRootId ?? null;
    const replyTarget = this.computeReplyTarget({
      conversationId: id,
      channelId,
      threadKind,
      isPrimaryThread,
      threadRootId,
    });
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
        `INSERT INTO conversations(id, channel_id, reply_target, title, agent_type, workspace_path, session_key, status, thread_kind, is_primary_thread, thread_root_id, env_vars, node_id, agent_id, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, channelId, replyTarget, title, agentType, workspacePath, sessionKey, threadKind, isPrimaryThread ? 1 : 0, threadRootId, envVarsJson, nodeId, params.agentId ?? null, now, now);

    return {
      id,
      channelId,
      replyTarget,
      title,
      agentType,
      threadKind,
      isPrimaryThread,
      threadRootId,
      workspacePath,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      nodeId,
      agentId: params.agentId ?? null,
    };
  }

  openAgentThread(agentId: string): ConversationInfo | null {
    const agent = this.getAgent(agentId);
    if (!agent) return null;

    const existing = this.db.prepare(
      `SELECT id, channel_id as channelId, title, agent_type as agentType,
              reply_target as replyTarget,
              thread_kind as threadKind, is_primary_thread as isPrimaryThread,
              thread_root_id as threadRootId,
              workspace_path as workspacePath, status, node_id as nodeId,
              agent_id as agentId, created_at as createdAt, updated_at as updatedAt
       FROM conversations
       WHERE agent_id = ? AND is_primary_thread = 1
       ORDER BY updated_at DESC
       LIMIT 1`,
    ).get(agentId) as ConversationInfo | undefined;
    if (existing) {
      return { ...existing, isPrimaryThread: !!existing.isPrimaryThread };
    }

    const fallback = this.db.prepare(
      `SELECT id, channel_id as channelId, title, agent_type as agentType,
              reply_target as replyTarget,
              thread_kind as threadKind, is_primary_thread as isPrimaryThread,
              thread_root_id as threadRootId,
              workspace_path as workspacePath, status, node_id as nodeId,
              agent_id as agentId, created_at as createdAt, updated_at as updatedAt
       FROM conversations
       WHERE agent_id = ?
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
    ).get(agentId) as ConversationInfo | undefined;
    if (fallback) {
      this.db.prepare(
        `UPDATE conversations
         SET thread_kind = 'direct', is_primary_thread = 1, updated_at = ?
         WHERE id = ?`,
      ).run(Date.now(), fallback.id);
      return { ...fallback, threadKind: 'direct', isPrimaryThread: true };
    }

    return this.createConversation({
      agentId,
      agentType: agent.agentType,
      workspacePath: agent.workspacePath ?? undefined,
      channelId: agent.channelId,
      nodeId: agent.nodeId ?? undefined,
      threadKind: 'direct',
      isPrimaryThread: true,
      title: '',
    });
  }

  openAgentChannelThread(agentId: string, channelId: string, threadRootId?: string | null): ConversationInfo | null {
    const agent = this.getAgent(agentId);
    if (!agent) return null;

    const normalizedThreadRootId = threadRootId ?? null;
    const existing = (normalizedThreadRootId
      ? this.db.prepare(
        `SELECT id, channel_id as channelId, title, agent_type as agentType,
                reply_target as replyTarget,
                thread_kind as threadKind, is_primary_thread as isPrimaryThread,
                thread_root_id as threadRootId,
                workspace_path as workspacePath, status, node_id as nodeId,
                agent_id as agentId, created_at as createdAt, updated_at as updatedAt
         FROM conversations
         WHERE agent_id = ? AND channel_id = ? AND thread_kind = 'branch' AND thread_root_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      ).get(agentId, channelId, normalizedThreadRootId)
      : this.db.prepare(
        `SELECT id, channel_id as channelId, title, agent_type as agentType,
                reply_target as replyTarget,
                thread_kind as threadKind, is_primary_thread as isPrimaryThread,
                thread_root_id as threadRootId,
                workspace_path as workspacePath, status, node_id as nodeId,
                agent_id as agentId, created_at as createdAt, updated_at as updatedAt
         FROM conversations
         WHERE agent_id = ? AND channel_id = ? AND thread_kind = 'branch' AND thread_root_id IS NULL
         ORDER BY updated_at DESC
         LIMIT 1`,
      ).get(agentId, channelId)) as ConversationInfo | undefined;
    if (existing) {
      return { ...existing, isPrimaryThread: !!existing.isPrimaryThread, threadRootId: existing.threadRootId ?? null };
    }

    return this.createConversation({
      agentId,
      agentType: agent.agentType,
      workspacePath: agent.workspacePath ?? undefined,
      channelId,
      nodeId: agent.nodeId ?? undefined,
      threadKind: 'branch',
      isPrimaryThread: false,
      threadRootId: normalizedThreadRootId,
      title: '',
    });
  }

  listConversations(filter?: { channelId?: string; agentId?: string }): ConversationInfo[] {
    const convSelect = `SELECT id, channel_id as channelId, reply_target as replyTarget, title, agent_type as agentType,
                thread_kind as threadKind, is_primary_thread as isPrimaryThread,
                thread_root_id as threadRootId,
                workspace_path as workspacePath, status, node_id as nodeId,
                agent_id as agentId, created_at as createdAt, updated_at as updatedAt
         FROM conversations`;

    const mapRows = (rows: ConversationInfo[]) => rows.map((row) => ({
      ...row,
      isPrimaryThread: !!row.isPrimaryThread,
      threadRootId: row.threadRootId ?? null,
    }));

    if (filter?.channelId && filter?.agentId) {
      return mapRows(this.db.prepare(`${convSelect} WHERE channel_id = ? AND agent_id = ? ORDER BY is_primary_thread DESC, updated_at DESC`)
        .all(filter.channelId, filter.agentId) as ConversationInfo[]);
    }
    if (filter?.channelId) {
      return mapRows(this.db.prepare(`${convSelect} WHERE channel_id = ? ORDER BY updated_at DESC`)
        .all(filter.channelId) as ConversationInfo[]);
    }
    if (filter?.agentId) {
      return mapRows(this.db.prepare(`${convSelect} WHERE agent_id = ? ORDER BY is_primary_thread DESC, updated_at DESC`)
        .all(filter.agentId) as ConversationInfo[]);
    }
    return mapRows(this.db.prepare(`${convSelect} ORDER BY updated_at DESC`).all() as ConversationInfo[]);
  }

  getConversation(id: string): ConversationInfo | null {
    const row = this.db
      .prepare(
        `SELECT id, channel_id as channelId, reply_target as replyTarget, title, agent_type as agentType,
                thread_kind as threadKind, is_primary_thread as isPrimaryThread,
                thread_root_id as threadRootId,
                workspace_path as workspacePath, status, node_id as nodeId,
                agent_id as agentId, created_at as createdAt, updated_at as updatedAt
         FROM conversations WHERE id = ?`,
      )
      .get(id) as ConversationInfo | undefined;
    return row ? { ...row, isPrimaryThread: !!row.isPrimaryThread, threadRootId: row.threadRootId ?? null } : null;
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversation_prompt_queue WHERE conversation_id = ?').run(id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  /** Returns hostKeys (conversation:{id}:{agentType}) for all conversations of this agent */
  getAgentHostKeys(agentId: string): Array<{ nodeId: string; hostKey: string }> {
    const rows = this.db.prepare(
      `SELECT id, agent_type as agentType, node_id as nodeId
       FROM conversations WHERE agent_id = ? AND node_id IS NOT NULL`,
    ).all(agentId) as Array<{ id: string; agentType: string; nodeId: string }>;
    return rows.map((r) => ({ nodeId: r.nodeId, hostKey: `conversation:${r.id}:${r.agentType}` }));
  }

  /** Clear chat history and reset session (keeps workspace files) */
  clearAgentChat(agentId: string): ConversationInfo[] {
    const rows = this.db.prepare(
      `SELECT id, channel_id as channelId, agent_type as agentType, workspace_path as workspacePath,
              session_key as sessionKey, node_id as nodeId, created_at as createdAt,
              thread_kind as threadKind, is_primary_thread as isPrimaryThread
       FROM conversations
       WHERE agent_id = ?
       ORDER BY is_primary_thread DESC, updated_at DESC`,
    ).all(agentId) as Array<{
      id: string; channelId: string; agentType: AgentType; workspacePath: string | null;
      sessionKey: string; nodeId: string | null; createdAt: number;
      threadKind: ThreadKind; isPrimaryThread: number;
    }>;

    if (rows.length === 0) return [];

    const now = Date.now();
    this.db.prepare('DELETE FROM conversation_prompt_queue WHERE agent_id = ?').run(agentId);
    this.db.prepare(`DELETE FROM channel_messages WHERE channel_id = ?`).run(`dm:${agentId}`);
    this.db.prepare(`DELETE FROM agent_message_checkpoints WHERE agent_id = ?`).run(agentId);

    for (const row of rows) {
      const runIds = this.db.prepare(`SELECT run_id as runId FROM runs WHERE session_key = ?`)
        .all(row.sessionKey) as Array<{ runId: string }>;
      for (const run of runIds) {
        this.db.prepare('DELETE FROM events WHERE run_id = ?').run(run.runId);
      }
      this.db.prepare('DELETE FROM runs WHERE session_key = ?').run(row.sessionKey);

      const newSessionKey = randomUUID();
      const preset = getRuntimeDriver(row.agentType);
      createSession(this.db, {
        sessionKey: newSessionKey,
        agentCommand: preset.command,
        agentArgs: preset.args,
        cwd: row.workspacePath ?? this.config.workspaceRoot,
        loadSupported: false,
      });
      upsertBinding(
        this.db,
        { platform: 'web', chatId: row.channelId, threadId: row.id, userId: row.agentType },
        newSessionKey,
      );
      this.db.prepare(
        `UPDATE conversations SET session_key = ?, status = 'idle', title = '', updated_at = ? WHERE id = ?`,
      ).run(newSessionKey, now, row.id);
      this.db.prepare('DELETE FROM sessions WHERE session_key = ?').run(row.sessionKey);
    }

    return this.listConversations({ agentId });
  }

  resetAgent(agentId: string): ConversationInfo[] {
    const rows = this.db.prepare(
      `SELECT id, channel_id as channelId, agent_type as agentType, workspace_path as workspacePath,
              session_key as sessionKey, node_id as nodeId, created_at as createdAt,
              thread_kind as threadKind, is_primary_thread as isPrimaryThread
       FROM conversations
       WHERE agent_id = ?
       ORDER BY is_primary_thread DESC, updated_at DESC`,
    ).all(agentId) as Array<{
      id: string;
      channelId: string;
      agentType: AgentType;
      workspacePath: string | null;
      sessionKey: string;
      nodeId: string | null;
      createdAt: number;
      threadKind: ThreadKind;
      isPrimaryThread: number;
    }>;

    if (rows.length === 0) return [];

    const now = Date.now();
    this.db.prepare('DELETE FROM conversation_prompt_queue WHERE agent_id = ?').run(agentId);
    this.db.prepare(`DELETE FROM channel_messages WHERE channel_id = ?`).run(`dm:${agentId}`);
    this.db.prepare(`DELETE FROM agent_message_checkpoints WHERE agent_id = ?`).run(agentId);

    for (const row of rows) {
      const runIds = this.db.prepare(
        `SELECT run_id as runId FROM runs WHERE session_key = ?`,
      ).all(row.sessionKey) as Array<{ runId: string }>;

      for (const run of runIds) {
        this.db.prepare('DELETE FROM events WHERE run_id = ?').run(run.runId);
      }
      this.db.prepare('DELETE FROM runs WHERE session_key = ?').run(row.sessionKey);

      const newSessionKey = randomUUID();
      const preset = getRuntimeDriver(row.agentType);
      createSession(this.db, {
        sessionKey: newSessionKey,
        agentCommand: preset.command,
        agentArgs: preset.args,
        cwd: row.workspacePath ?? this.config.workspaceRoot,
        loadSupported: false,
      });
      upsertBinding(
        this.db,
        { platform: 'web', chatId: row.channelId, threadId: row.id, userId: row.agentType },
        newSessionKey,
      );

      this.db.prepare(
        `UPDATE conversations
         SET session_key = ?, status = 'idle', title = '', updated_at = ?
         WHERE id = ?`,
      ).run(newSessionKey, now, row.id);

      this.db.prepare('DELETE FROM sessions WHERE session_key = ?').run(row.sessionKey);
    }

    return this.listConversations({ agentId });
  }

  async dispatchToNode(conversationId: string, promptText: string): Promise<void> {
    await this.executionDispatcher.dispatchPrompt(conversationId, promptText);
  }

  async submitPrompt(
    conversationId: string,
    promptText: string,
    options?: { recordAsUserMessage?: boolean; activationContextText?: string; senderName?: string },
  ): Promise<{ queued: boolean; runId?: string }> {
    return this.executionDispatcher.submitPrompt(conversationId, promptText, options);
  }

  async onConversationSettled(conversationId: string): Promise<void> {
    await this.executionDispatcher.handleConversationSettled(conversationId);
  }

  clearQueuedPromptsForNode(nodeId: string): void {
    this.executionDispatcher.clearQueuedPromptsForNode(nodeId);
  }

  // ─── Channel CRUD ───

  joinChannel(agentId: string, channelId: string): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT OR IGNORE INTO agent_channel_memberships(agent_id, channel_id, is_home, joined_at)
       VALUES(?, ?, 0, ?)`
    ).run(agentId, channelId, now);
    upsertChannelSubscription(this.db, { agentId, channelId, subscribedAt: now, lastActiveAt: now });
  }

  leaveChannel(agentId: string, channelId: string): void {
    this.db.prepare(
      `DELETE FROM agent_channel_memberships WHERE agent_id = ? AND channel_id = ?`
    ).run(agentId, channelId);
    deleteChannelSubscription(this.db, channelId, agentId);
  }

  createChannel(params: {
    name: string;
    workspacePath?: string | null;
    description?: string;
    collaborationMode?: ChannelCollaborationMode;
  }): ChannelInfo {
    const channelId = params.name === 'default' ? 'default' : randomUUID();
    const now = Date.now();
    const collaborationMode = params.collaborationMode ?? 'mention_only';
    this.db
      .prepare(
        `INSERT INTO channels(channel_id, name, workspace_path, description, collaboration_mode, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(channelId, params.name, params.workspacePath ?? null, params.description ?? null, collaborationMode, now, now);
    return {
      channelId,
      name: params.name,
      workspacePath: params.workspacePath ?? null,
      description: params.description,
      collaborationMode,
      subscribedAgents: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  updateChannel(channelId: string, req: UpdateChannelRequest): ChannelInfo | null {
    const existing = this.getChannel(channelId);
    if (!existing) return null;
    const now = Date.now();
    const collaborationMode = req.collaborationMode ?? existing.collaborationMode ?? 'mention_only';
    this.db.prepare(
      `UPDATE channels SET description = ?, collaboration_mode = ?, updated_at = ? WHERE channel_id = ?`
    ).run(req.description ?? existing.description ?? null, collaborationMode, now, channelId);
    return {
      ...existing,
      description: req.description ?? existing.description,
      collaborationMode,
      updatedAt: now,
    };
  }

  clearChannelChat(channelId: string): ConversationInfo[] {
    const rows = this.db.prepare(
      `SELECT id, channel_id as channelId, agent_type as agentType, workspace_path as workspacePath,
              session_key as sessionKey
       FROM conversations
       WHERE channel_id = ? AND thread_kind = 'branch'
       ORDER BY updated_at DESC`,
    ).all(channelId) as Array<{
      id: string;
      channelId: string;
      agentType: AgentType;
      workspacePath: string | null;
      sessionKey: string;
    }>;

    const now = Date.now();

    this.db.prepare(`DELETE FROM channel_messages WHERE channel_id = ?`).run(channelId);
    this.db.prepare(`DELETE FROM agent_message_checkpoints WHERE channel_id = ?`).run(channelId);
    deleteTargetParticipantsForChannel(this.db, channelId);

    for (const row of rows) {
      const runIds = this.db.prepare(
        `SELECT run_id as runId FROM runs WHERE session_key = ?`,
      ).all(row.sessionKey) as Array<{ runId: string }>;

      this.db.prepare('DELETE FROM conversation_prompt_queue WHERE conversation_id = ?').run(row.id);

      for (const run of runIds) {
        this.db.prepare('DELETE FROM events WHERE run_id = ?').run(run.runId);
      }
      this.db.prepare('DELETE FROM runs WHERE session_key = ?').run(row.sessionKey);

      const newSessionKey = randomUUID();
      const preset = getRuntimeDriver(row.agentType);
      createSession(this.db, {
        sessionKey: newSessionKey,
        agentCommand: preset.command,
        agentArgs: preset.args,
        cwd: row.workspacePath ?? this.config.workspaceRoot,
        loadSupported: false,
      });
      upsertBinding(
        this.db,
        { platform: 'web', chatId: row.channelId, threadId: row.id, userId: row.agentType },
        newSessionKey,
      );
      this.db.prepare(
        `UPDATE conversations
         SET session_key = ?, status = 'idle', title = '', updated_at = ?
         WHERE id = ?`,
      ).run(newSessionKey, now, row.id);
      this.db.prepare('DELETE FROM sessions WHERE session_key = ?').run(row.sessionKey);
    }

    return this.listConversations({ channelId }).filter((item) => item.threadKind === 'branch');
  }

  listChannels(): ChannelInfo[] {
    const rows = this.db
      .prepare(
        `SELECT channel_id as channelId, name, workspace_path as workspacePath,
                description, collaboration_mode as collaborationMode,
                created_at as createdAt, updated_at as updatedAt
         FROM channels ORDER BY created_at ASC`,
      )
      .all() as Array<Omit<ChannelInfo, 'subscribedAgents'>>;
    return rows.map((row) => ({
      ...row,
      subscribedAgents: listChannelSubscriptions(this.db, row.channelId).map((item) => ({
        agentId: item.agentId,
        name: item.name,
      })),
    }));
  }

  getChannel(channelId: string): ChannelInfo | null {
    const row = this.db
      .prepare(
        `SELECT channel_id as channelId, name, workspace_path as workspacePath,
                description, collaboration_mode as collaborationMode,
                created_at as createdAt, updated_at as updatedAt
         FROM channels WHERE channel_id = ?`,
      )
      .get(channelId) as Omit<ChannelInfo, 'subscribedAgents'> | undefined;
    if (!row) return null;
    return {
      ...row,
      subscribedAgents: listChannelSubscriptions(this.db, channelId).map((item) => ({
        agentId: item.agentId,
        name: item.name,
      })),
    };
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

  private computeReplyTarget(params: {
    conversationId: string;
    channelId: string;
    threadKind: ThreadKind;
    isPrimaryThread: boolean;
    threadRootId: string | null;
  }): string {
    if (params.threadKind === 'direct') {
      return params.isPrimaryThread
        ? `dm:@${this.config.humanUserName}`
        : `dm:@${this.config.humanUserName}:${params.conversationId.slice(0, 8)}`;
    }

    const channel = this.getChannel(params.channelId);
    const channelName = channel?.name ?? params.channelId;
    const baseTarget = `#${channelName}`;
    return params.threadRootId ? `${baseTarget}:${params.threadRootId}` : baseTarget;
  }

  private backfillConversationReplyTargets(): void {
    const rows = this.db.prepare(
      `SELECT id, channel_id as channelId, thread_kind as threadKind,
              is_primary_thread as isPrimaryThread, thread_root_id as threadRootId
       FROM conversations
       WHERE reply_target IS NULL OR reply_target = ''`,
    ).all() as Array<{
      id: string;
      channelId: string;
      threadKind: ThreadKind;
      isPrimaryThread: number;
      threadRootId: string | null;
    }>;

    if (rows.length === 0) return;

    const updateReplyTarget = this.db.prepare(
      `UPDATE conversations
       SET reply_target = ?
       WHERE id = ?`,
    );

    for (const row of rows) {
      updateReplyTarget.run(
        this.computeReplyTarget({
          conversationId: row.id,
          channelId: row.channelId,
          threadKind: row.threadKind,
          isPrimaryThread: row.isPrimaryThread !== 0,
          threadRootId: row.threadRootId ?? null,
        }),
        row.id,
      );
    }
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
       FROM nodes WHERE status != 'deleted' ORDER BY provisioned_at DESC, created_at ASC`
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
       FROM nodes WHERE node_id = ? AND status != 'deleted'`
    ).get(nodeId) as MachineRow | undefined;

    if (!row) return null;
    const isOnline = !!this.nodeRegistry?.getNode(nodeId);
    return rowToMachineInfo(row, isOnline);
  }

  deleteMachine(nodeId: string): void {
    const agentIds = this.db.prepare(
      `SELECT agent_id as agentId FROM agents WHERE node_id = ?`,
    ).all(nodeId) as Array<{ agentId: string }>;

    for (const agent of agentIds) {
      this.deleteAgent(agent.agentId);
    }

    this.db.prepare(`UPDATE nodes SET status = 'deleted' WHERE node_id = ?`).run(nodeId);

    if (this.nodeRegistry) {
      const node = this.nodeRegistry.getNode(nodeId);
      if (node) {
        node.ws.close(4000, 'Machine has been deleted');
        this.nodeRegistry.unregister(nodeId);
      }
    }
  }

  private rowToAgentInfo(row: AgentRow): AgentInfo {
    const memberships = this.db.prepare(
      `SELECT channel_id as channelId FROM agent_channel_memberships WHERE agent_id = ?`
    ).all(row.agentId) as Array<{ channelId: string }>;
    return {
      agentId: row.agentId,
      name: row.name,
      agentType: row.agentType,
      channelId: row.channelId,
      channelIds: memberships.map((m) => m.channelId),
      systemPrompt: row.systemPrompt,
      ...(row.description ? { description: row.description } : {}),
      envVars: parseEnvVars(row.envVarsJson),
      disabledToolKinds: parseDisabledToolKinds(row.disabledToolKindsJson),
      nodeId: row.nodeId,
      workspacePath: row.workspacePath,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
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

function parseDisabledToolKinds(raw: string | null): AgentPermissionKind[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is AgentPermissionKind => typeof value === 'string');
    }
  } catch {
    // ignore
  }
  return undefined;
}
