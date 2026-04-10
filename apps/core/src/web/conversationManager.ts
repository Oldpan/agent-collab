import { randomUUID } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import type {
  ConversationInfo,
  AgentType,
  ChannelInfo,
  AgentInfo,
  CreateAgentRequest,
  UpdateAgentRequest,
  UpdateChannelRequest,
  ResourceSpaceInfo,
  CreateResourceSpaceRequest,
  UpdateResourceSpaceRequest,
  MachineInfo,
  CreateMachineRequest,
  ThreadKind,
  AgentPermissionKind,
} from '@agent-collab/protocol';
import { normalizeThreadShortIdInput } from '@agent-collab/protocol';
import {
  log,
  createSession,
  upsertBinding,
} from '@agent-collab/runtime-acp';
import type { Db } from '@agent-collab/runtime-acp';
import { getRuntimeDriver } from '@agent-collab/protocol';
import type { AppConfig } from '../config.js';
import { ExecutionDispatcher } from '../execution/executionDispatcher.js';
import type { PromptActivationMetadata } from '../execution/executionDispatcher.js';
import type { NodeRegistry } from '../services/nodeRegistry.js';
import type { ActivationContextMessage } from './activationContext.js';
import { resolveThreadRootLookup } from './threadRoots.js';
import {
  deleteTargetParticipantsForAgent,
  deleteTargetParticipantsForAgentInChannel,
  deleteTargetParticipantsForChannel,
} from './targetParticipants.js';
import { buildDirectReplyTarget, resolveDirectUserName } from './directReplyTargets.js';

function slugifyAgentName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function normalizeChannelThreadRootId(threadRootId?: string | null): string | null {
  return normalizeThreadShortIdInput(threadRootId);
}

type AgentRow = {
  agentId: string;
  name: string;
  agentType: AgentType;
  model: string | null;
  reasoningEffort: string | null;
  channelId: string;
  systemPrompt: string;
  description: string | null;
  envVarsJson: string | null;
  disabledToolKindsJson: string | null;
  nodeId: string | null;
  workspacePath: string | null;
  skillRootsJson: string | null;
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
    const model = params.model?.trim() || null;
    const reasoningEffort = params.reasoningEffort?.trim() || null;
    const channelId = params.channelId ?? 'default';
    const envVarsJson = params.envVars && Object.keys(params.envVars).length > 0
      ? JSON.stringify(params.envVars)
      : null;
    const disabledToolKindsJson = params.disabledToolKinds && params.disabledToolKinds.length > 0
      ? JSON.stringify(params.disabledToolKinds)
      : null;
    const skillRootsJson = params.skillRoots && params.skillRoots.length > 0
      ? JSON.stringify(params.skillRoots)
      : null;
    const now = Date.now();

    const workspacePath = params.workspacePath
      ?? path.join(os.homedir(), '.agent-collab', 'agents', `${agentId}-${slugifyAgentName(params.name)}`);
    fs.mkdirSync(workspacePath, { recursive: true });

    const description = params.description?.trim() || null;

    this.db.prepare(
      `INSERT INTO agents(agent_id, name, agent_type, model, reasoning_effort, channel_id, system_prompt, description, memory, env_vars, disabled_tool_kinds, node_id, workspace_path, skill_roots, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      agentId, params.name, agentType, model, reasoningEffort, channelId,
      params.systemPrompt ?? '', description, '',
      envVarsJson, disabledToolKindsJson, params.nodeId ?? null, workspacePath, skillRootsJson,
      now, now,
    );
    this.db.prepare(
      `INSERT OR IGNORE INTO agent_channel_memberships(agent_id, channel_id, is_home, joined_at)
       VALUES(?, ?, 1, ?)`
    ).run(agentId, channelId, now);

    return {
      agentId, name: params.name, agentType, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), channelId, channelIds: [channelId],
      systemPrompt: params.systemPrompt ?? '',
      ...(description ? { description } : {}),
      envVars: params.envVars, disabledToolKinds: params.disabledToolKinds, nodeId: params.nodeId ?? null,
      workspacePath, skillRoots: params.skillRoots, createdAt: now, updatedAt: now,
    };
  }

  listAgents(channelId?: string): AgentInfo[] {
    const sql = channelId
      ? `SELECT a.agent_id as agentId, a.name, a.agent_type as agentType, a.model, a.reasoning_effort as reasoningEffort, a.channel_id as channelId,
                a.system_prompt as systemPrompt, a.description,
                a.env_vars as envVarsJson, a.disabled_tool_kinds as disabledToolKindsJson,
                a.node_id as nodeId, a.workspace_path as workspacePath, a.skill_roots as skillRootsJson,
                a.created_at as createdAt, a.updated_at as updatedAt
         FROM agents a
         JOIN agent_channel_memberships m ON m.agent_id = a.agent_id
         WHERE m.channel_id = ? ORDER BY a.updated_at DESC`
      : `SELECT agent_id as agentId, name, agent_type as agentType, model, reasoning_effort as reasoningEffort, channel_id as channelId,
                system_prompt as systemPrompt, description,
                env_vars as envVarsJson, disabled_tool_kinds as disabledToolKindsJson,
                node_id as nodeId, workspace_path as workspacePath, skill_roots as skillRootsJson,
                created_at as createdAt, updated_at as updatedAt
         FROM agents ORDER BY updated_at DESC`;
    const rows = channelId
      ? this.db.prepare(sql).all(channelId) as Array<AgentRow>
      : this.db.prepare(sql).all() as Array<AgentRow>;
    return rows.map((row) => this.rowToAgentInfo(row));
  }

  getAgent(agentId: string): AgentInfo | null {
    const row = this.db.prepare(
      `SELECT agent_id as agentId, name, agent_type as agentType, model, reasoning_effort as reasoningEffort, channel_id as channelId,
              system_prompt as systemPrompt, description,
              env_vars as envVarsJson, disabled_tool_kinds as disabledToolKindsJson,
              node_id as nodeId, workspace_path as workspacePath, skill_roots as skillRootsJson,
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
    const model = 'model' in req ? (req.model?.trim() || null) : (existing.model ?? null);
    const reasoningEffort = 'reasoningEffort' in req ? (req.reasoningEffort?.trim() || null) : (existing.reasoningEffort ?? null);
    const envVars = req.envVars ?? existing.envVars;
    const disabledToolKinds = req.disabledToolKinds ?? existing.disabledToolKinds;
    const skillRoots = req.skillRoots ?? existing.skillRoots;
    const channelId = req.channelId ?? existing.channelId;
    const envVarsJson = envVars && Object.keys(envVars).length > 0
      ? JSON.stringify(envVars)
      : null;
    const disabledToolKindsJson = disabledToolKinds && disabledToolKinds.length > 0
      ? JSON.stringify(disabledToolKinds)
      : null;
    const skillRootsJson = skillRoots && skillRoots.length > 0
      ? JSON.stringify(skillRoots)
      : null;

    this.db.prepare(
      `UPDATE agents
       SET name = ?, system_prompt = ?, description = ?, model = ?, reasoning_effort = ?, env_vars = ?, disabled_tool_kinds = ?, channel_id = ?, skill_roots = ?, updated_at = ?
       WHERE agent_id = ?`
    ).run(name, systemPrompt, description, model, reasoningEffort, envVarsJson, disabledToolKindsJson, channelId, skillRootsJson, now, agentId);

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

    return this.getAgent(agentId) ?? {
      ...existing,
      name,
      systemPrompt,
      description: description ?? undefined,
      model: model ?? undefined,
      reasoningEffort: reasoningEffort ?? undefined,
      envVars,
      disabledToolKinds,
      skillRoots,
      channelId,
      updatedAt: now,
    } satisfies AgentInfo;
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
    userId?: string | null;
  }): ConversationInfo {
    const id = randomUUID();
    const userId = params.userId ?? null;

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
      userId,
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
        `INSERT INTO conversations(id, channel_id, reply_target, title, agent_type, workspace_path, session_key, status, thread_kind, is_primary_thread, thread_root_id, env_vars, node_id, agent_id, user_id, history_reset_at, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, channelId, replyTarget, title, agentType, workspacePath, sessionKey, threadKind, isPrimaryThread ? 1 : 0, threadRootId, envVarsJson, nodeId, params.agentId ?? null, userId, now, now);

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
      userId,
    };
  }

  openAgentThread(agentId: string, userId?: string | null): ConversationInfo | null {
    const agent = this.getAgent(agentId);
    if (!agent) return null;

    // Look for existing primary thread for this (agent, user) pair
    const existing = userId
      ? this.db.prepare(
          `SELECT id, channel_id as channelId, title, agent_type as agentType,
                  reply_target as replyTarget,
                  thread_kind as threadKind, is_primary_thread as isPrimaryThread,
                  thread_root_id as threadRootId,
                  workspace_path as workspacePath, status, node_id as nodeId,
                  agent_id as agentId, user_id as userId, created_at as createdAt, updated_at as updatedAt
           FROM conversations
           WHERE agent_id = ? AND user_id = ? AND is_primary_thread = 1
           ORDER BY updated_at DESC
           LIMIT 1`,
        ).get(agentId, userId) as ConversationInfo | undefined
      : this.db.prepare(
          `SELECT id, channel_id as channelId, title, agent_type as agentType,
                  reply_target as replyTarget,
                  thread_kind as threadKind, is_primary_thread as isPrimaryThread,
                  thread_root_id as threadRootId,
                  workspace_path as workspacePath, status, node_id as nodeId,
                  agent_id as agentId, user_id as userId, created_at as createdAt, updated_at as updatedAt
           FROM conversations
           WHERE agent_id = ? AND user_id IS NULL AND is_primary_thread = 1
           ORDER BY updated_at DESC
           LIMIT 1`,
        ).get(agentId) as ConversationInfo | undefined;

    if (existing) {
      const canonicalReplyTarget = this.computeReplyTarget({
        conversationId: existing.id,
        channelId: existing.channelId,
        threadKind: existing.threadKind,
        isPrimaryThread: !!existing.isPrimaryThread,
        threadRootId: existing.threadRootId ?? null,
        userId: existing.userId ?? null,
      });
      if ((existing.replyTarget ?? '').trim() !== canonicalReplyTarget) {
        this.db.prepare(
          `UPDATE conversations
           SET reply_target = ?, updated_at = ?
           WHERE id = ?`,
        ).run(canonicalReplyTarget, Date.now(), existing.id);
        existing.replyTarget = canonicalReplyTarget;
      }
      return { ...existing, isPrimaryThread: !!existing.isPrimaryThread, userId: existing.userId ?? null };
    }

    // Create new per-user primary thread
    return this.createConversation({
      agentId,
      agentType: agent.agentType,
      workspacePath: agent.workspacePath ?? undefined,
      channelId: agent.channelId,
      nodeId: agent.nodeId ?? undefined,
      threadKind: 'direct',
      isPrimaryThread: true,
      title: '',
      userId: userId ?? null,
    });
  }

  openAgentDirectThread(agentId: string, userId: string | null | undefined, threadRootId: string): ConversationInfo | null {
    const agent = this.getAgent(agentId);
    if (!agent) return null;

    const normalizedThreadRootId = normalizeChannelThreadRootId(threadRootId);
    if (!normalizedThreadRootId) return null;
    const dmChannelId = `dm:${agentId}`;
    const threadRootLookup = resolveThreadRootLookup(this.db, dmChannelId, normalizedThreadRootId);
    const canonicalThreadRootId = threadRootLookup?.canonicalThreadRootId ?? normalizedThreadRootId;
    const acceptableThreadRootIds = new Set(threadRootLookup?.alternateThreadRootIds ?? [canonicalThreadRootId]);

    const existingCandidates = userId
      ? this.db.prepare(
          `SELECT id, channel_id as channelId, title, agent_type as agentType,
                  reply_target as replyTarget,
                  thread_kind as threadKind, is_primary_thread as isPrimaryThread,
                  thread_root_id as threadRootId,
                  workspace_path as workspacePath, status, node_id as nodeId,
                  agent_id as agentId, user_id as userId, created_at as createdAt, updated_at as updatedAt
           FROM conversations
           WHERE agent_id = ? AND user_id = ? AND thread_kind = 'direct' AND is_primary_thread = 0
           ORDER BY updated_at DESC`,
        ).all(agentId, userId) as ConversationInfo[]
      : this.db.prepare(
          `SELECT id, channel_id as channelId, title, agent_type as agentType,
                  reply_target as replyTarget,
                  thread_kind as threadKind, is_primary_thread as isPrimaryThread,
                  thread_root_id as threadRootId,
                  workspace_path as workspacePath, status, node_id as nodeId,
                  agent_id as agentId, user_id as userId, created_at as createdAt, updated_at as updatedAt
           FROM conversations
           WHERE agent_id = ? AND user_id IS NULL AND thread_kind = 'direct' AND is_primary_thread = 0
           ORDER BY updated_at DESC`,
        ).all(agentId) as ConversationInfo[];
    const existing = existingCandidates.find(
      (candidate) => candidate.threadRootId != null && acceptableThreadRootIds.has(candidate.threadRootId),
    );

    if (existing) {
      const canonicalReplyTarget = this.computeReplyTarget({
        conversationId: existing.id,
        channelId: existing.channelId,
        threadKind: existing.threadKind,
        isPrimaryThread: false,
        threadRootId: existing.threadRootId ?? canonicalThreadRootId,
        userId: existing.userId ?? userId ?? null,
      });
      if ((existing.replyTarget ?? '').trim() !== canonicalReplyTarget) {
        this.db.prepare(
          `UPDATE conversations
           SET reply_target = ?, updated_at = ?
           WHERE id = ?`,
        ).run(canonicalReplyTarget, Date.now(), existing.id);
        existing.replyTarget = canonicalReplyTarget;
      }
      return {
        ...existing,
        isPrimaryThread: !!existing.isPrimaryThread,
        threadRootId: existing.threadRootId ?? canonicalThreadRootId,
        userId: existing.userId ?? userId ?? null,
      };
    }

    return this.createConversation({
      agentId,
      agentType: agent.agentType,
      workspacePath: agent.workspacePath ?? undefined,
      channelId: agent.channelId,
      nodeId: agent.nodeId ?? undefined,
      threadKind: 'direct',
      isPrimaryThread: false,
      threadRootId: canonicalThreadRootId,
      title: '',
      userId: userId ?? null,
    });
  }

  openAgentChannelThread(agentId: string, channelId: string, threadRootId?: string | null): ConversationInfo | null {
    const agent = this.getAgent(agentId);
    if (!agent) return null;

    const normalizedThreadRootId = normalizeChannelThreadRootId(threadRootId);
    const threadRootLookup = normalizedThreadRootId
      ? resolveThreadRootLookup(this.db, channelId, normalizedThreadRootId)
      : null;
    const canonicalThreadRootId = threadRootLookup?.canonicalThreadRootId ?? normalizedThreadRootId;
    const acceptableThreadRootIds = new Set(threadRootLookup?.alternateThreadRootIds ?? []);
    const existing = (normalizedThreadRootId
      ? (this.db.prepare(
        `SELECT id, channel_id as channelId, title, agent_type as agentType,
                reply_target as replyTarget,
                thread_kind as threadKind, is_primary_thread as isPrimaryThread,
                thread_root_id as threadRootId,
                workspace_path as workspacePath, status, node_id as nodeId,
                agent_id as agentId, created_at as createdAt, updated_at as updatedAt
         FROM conversations
         WHERE agent_id = ? AND channel_id = ? AND thread_kind = 'branch'
         ORDER BY updated_at DESC`,
      ).all(agentId, channelId) as ConversationInfo[]).find(
        (candidate) => candidate.threadRootId != null && acceptableThreadRootIds.has(candidate.threadRootId),
      )
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
      threadRootId: canonicalThreadRootId,
      title: '',
    });
  }

  listConversations(filter?: { channelId?: string; agentId?: string; userId?: string; isAdmin?: boolean }): ConversationInfo[] {
    const convSelect = `SELECT id, channel_id as channelId, reply_target as replyTarget, title, agent_type as agentType,
                thread_kind as threadKind, is_primary_thread as isPrimaryThread,
                thread_root_id as threadRootId,
                workspace_path as workspacePath, status, node_id as nodeId,
                agent_id as agentId, user_id as userId, created_at as createdAt, updated_at as updatedAt
         FROM conversations`;

    const mapRows = (rows: ConversationInfo[]) => rows.map((row) => ({
      ...row,
      isPrimaryThread: !!row.isPrimaryThread,
      threadRootId: row.threadRootId ?? null,
      userId: (row as ConversationInfo & { userId?: string | null }).userId ?? null,
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

    // Top-level list: apply per-user DM filter
    // Real channel threads (branch in non-default channel) are shared; everything else is per-user
    if (filter?.userId) {
      if (filter.isAdmin) {
        // Admin: real channel branches (shared) + their own DMs + legacy NULL-user DMs
        return mapRows(this.db.prepare(
          `${convSelect} WHERE (
            (thread_kind = 'branch' AND channel_id != 'default')
            OR user_id = ?
            OR user_id IS NULL
          ) ORDER BY updated_at DESC`,
        ).all(filter.userId) as ConversationInfo[]);
      } else {
        // Regular user: real channel branches (shared) + their own DMs only
        return mapRows(this.db.prepare(
          `${convSelect} WHERE (
            (thread_kind = 'branch' AND channel_id != 'default')
            OR user_id = ?
          ) ORDER BY updated_at DESC`,
        ).all(filter.userId) as ConversationInfo[]);
      }
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
                agent_id as agentId, user_id as userId, created_at as createdAt, updated_at as updatedAt
         FROM conversations WHERE id = ?`,
      )
      .get(id) as (ConversationInfo & { userId?: string | null }) | undefined;
    return row
      ? {
          ...row,
          isPrimaryThread: !!row.isPrimaryThread,
          threadRootId: row.threadRootId ?? null,
          userId: row.userId ?? null,
        }
      : null;
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversation_prompt_queue WHERE conversation_id = ?').run(id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  private deleteRunStateForSession(sessionKey: string): void {
    const runIds = this.db.prepare(
      `SELECT run_id as runId FROM runs WHERE session_key = ?`,
    ).all(sessionKey) as Array<{ runId: string }>;

    for (const run of runIds) {
      this.db.prepare('DELETE FROM events WHERE run_id = ?').run(run.runId);
      this.db.prepare('DELETE FROM run_debug_inputs WHERE run_id = ?').run(run.runId);
    }

    this.db.prepare('DELETE FROM run_debug_inputs WHERE session_key = ?').run(sessionKey);
    this.db.prepare('DELETE FROM runs WHERE session_key = ?').run(sessionKey);
  }

  /** Returns hostKeys (conversation:{id}:{agentType}) for all conversations of this agent */
  getAgentHostKeys(agentId: string): Array<{ nodeId: string; hostKey: string }> {
    const rows = this.db.prepare(
      `SELECT id, agent_type as agentType, node_id as nodeId
       FROM conversations WHERE agent_id = ? AND node_id IS NOT NULL`,
    ).all(agentId) as Array<{ id: string; agentType: string; nodeId: string }>;
    return rows.map((r) => ({ nodeId: r.nodeId, hostKey: `conversation:${r.id}:${r.agentType}` }));
  }

  getConversationHostKey(conversationId: string): { nodeId: string; hostKey: string } | null {
    const row = this.db.prepare(
      `SELECT id, agent_type as agentType, node_id as nodeId
       FROM conversations WHERE id = ? AND node_id IS NOT NULL`,
    ).get(conversationId) as { id: string; agentType: string; nodeId: string } | undefined;
    if (!row) return null;
    return { nodeId: row.nodeId, hostKey: `conversation:${row.id}:${row.agentType}` };
  }

  /** Clear one conversation's chat/runtime state and rotate it to a new session (keeps workspace files). */
  clearConversationChat(conversationId: string): ConversationInfo | null {
    const row = this.db.prepare(
      `SELECT id, channel_id as channelId, reply_target as replyTarget, agent_type as agentType,
              workspace_path as workspacePath, session_key as sessionKey, node_id as nodeId,
              thread_kind as threadKind, is_primary_thread as isPrimaryThread, agent_id as agentId
       FROM conversations
       WHERE id = ?`,
    ).get(conversationId) as {
      id: string;
      channelId: string;
      replyTarget: string | null;
      agentType: AgentType;
      workspacePath: string | null;
      sessionKey: string;
      nodeId: string | null;
      threadKind: ThreadKind;
      isPrimaryThread: number;
      agentId: string | null;
    } | undefined;

    if (!row) return null;

    const now = Date.now();
    this.db.prepare('DELETE FROM conversation_prompt_queue WHERE conversation_id = ?').run(conversationId);

    if (row.threadKind === 'direct' && row.agentId) {
      const directTarget = (row.replyTarget ?? '').trim();
      const directTargetPrefix = `${directTarget}:%`;
      this.db.prepare(
        `DELETE FROM channel_messages
         WHERE channel_id = ? AND (target = ? OR target LIKE ?)`,
      ).run(`dm:${row.agentId}`, directTarget, directTargetPrefix);
    }

    this.deleteRunStateForSession(row.sessionKey);

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
       SET session_key = ?, status = 'idle', title = '', history_reset_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(newSessionKey, now, now, row.id);
    this.db.prepare('DELETE FROM sessions WHERE session_key = ?').run(row.sessionKey);

    return this.getConversation(conversationId);
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
      this.deleteRunStateForSession(row.sessionKey);

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
         SET session_key = ?, status = 'idle', title = '', history_reset_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(newSessionKey, now, now, row.id);
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
    const dmChannelId = `dm:${agentId}`;
    this.db.prepare('DELETE FROM conversation_prompt_queue WHERE agent_id = ?').run(agentId);
    this.db.prepare(`DELETE FROM channel_messages WHERE channel_id = ?`).run(dmChannelId);
    this.db.prepare(`DELETE FROM tasks WHERE channel_id = ?`).run(dmChannelId);
    this.db.prepare(`DELETE FROM channel_task_sequences WHERE channel_id = ?`).run(dmChannelId);
    deleteTargetParticipantsForChannel(this.db, dmChannelId);
    const hasDmThreadContextSnapshots = this.db
      .prepare(
        `SELECT 1 as hasRow
         FROM sqlite_master
         WHERE type = 'table' AND name = 'dm_thread_context_snapshots'
         LIMIT 1`,
      )
      .get() as { hasRow: number } | undefined;
    if (hasDmThreadContextSnapshots) {
      this.db.prepare(`DELETE FROM dm_thread_context_snapshots WHERE channel_id = ?`).run(dmChannelId);
    }
    this.db.prepare(`DELETE FROM agent_message_checkpoints WHERE agent_id = ?`).run(agentId);

    for (const row of rows) {
      this.deleteRunStateForSession(row.sessionKey);

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
         SET session_key = ?, status = 'idle', title = '', history_reset_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(newSessionKey, now, now, row.id);

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
    options?: {
      recordAsUserMessage?: boolean;
      activationContextText?: string;
      replayOverlapRecentMessages?: ActivationContextMessage[];
      senderName?: string;
      clientMessageId?: string;
      activationMetadata?: PromptActivationMetadata;
    },
  ): Promise<{ queued: boolean; runId?: string }> {
    return this.executionDispatcher.submitPrompt(conversationId, promptText, options);
  }

  async onConversationSettled(conversationId: string): Promise<void> {
    await this.executionDispatcher.handleConversationSettled(conversationId);
  }

  handleRunAccepted(runId: string, conversationId: string): boolean {
    return this.executionDispatcher.handleRunAccepted(runId, conversationId);
  }

  rejectPendingDispatchesForNode(nodeId: string, errorMessage: string): void {
    this.executionDispatcher.rejectPendingDispatchesForNode(nodeId, errorMessage);
  }

  // ─── Channel CRUD ───

  joinChannel(agentId: string, channelId: string): void {
    const now = Date.now();
    const membershipCount = this.db.prepare(
      `SELECT COUNT(*) as count FROM agent_channel_memberships WHERE agent_id = ?`,
    ).get(agentId) as { count: number };
    const makeHome = Number(membershipCount?.count ?? 0) === 0;
    this.db.prepare(
      `INSERT OR IGNORE INTO agent_channel_memberships(agent_id, channel_id, is_home, joined_at)
       VALUES(?, ?, ?, ?)`
    ).run(agentId, channelId, makeHome ? 1 : 0, now);
    if (makeHome) {
      this.db.prepare(`UPDATE agents SET channel_id = ?, updated_at = ? WHERE agent_id = ?`)
        .run(channelId, now, agentId);
    }
  }

  leaveChannel(agentId: string, channelId: string): void {
    const agent = this.getAgent(agentId);
    this.db.prepare(
      `DELETE FROM agent_channel_memberships WHERE agent_id = ? AND channel_id = ?`
    ).run(agentId, channelId);
    deleteTargetParticipantsForAgentInChannel(this.db, { agentId, channelId });
    if (agent?.channelId === channelId) {
      const nextHome = this.db.prepare(
        `SELECT channel_id as channelId
         FROM agent_channel_memberships
         WHERE agent_id = ?
         ORDER BY is_home DESC, joined_at ASC
         LIMIT 1`,
      ).get(agentId) as { channelId: string } | undefined;
      const nextChannelId = nextHome?.channelId ?? 'default';
      this.db.prepare(
        `UPDATE agents SET channel_id = ?, updated_at = ? WHERE agent_id = ?`,
      ).run(nextChannelId, Date.now(), agentId);
      this.db.prepare(
        `UPDATE agent_channel_memberships
         SET is_home = CASE WHEN channel_id = ? THEN 1 ELSE 0 END
         WHERE agent_id = ?`,
      ).run(nextChannelId, agentId);
    }
  }

  createChannel(params: {
    name: string;
    workspacePath?: string | null;
    description?: string;
  }): ChannelInfo {
    const channelId = params.name === 'default' ? 'default' : randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO channels(channel_id, name, workspace_path, description, collaboration_mode, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(channelId, params.name, params.workspacePath ?? null, params.description ?? null, 'mention_only', now, now);
    return {
      channelId,
      name: params.name,
      workspacePath: params.workspacePath ?? null,
      description: params.description,
      members: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  updateChannel(channelId: string, req: UpdateChannelRequest): ChannelInfo | null {
    const existing = this.getChannel(channelId);
    if (!existing) return null;
    const now = Date.now();
    this.db.prepare(
      `UPDATE channels SET description = ?, updated_at = ? WHERE channel_id = ?`
    ).run(req.description ?? existing.description ?? null, now, channelId);
    return {
      ...existing,
      description: req.description ?? existing.description,
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
    this.db.prepare(`DELETE FROM tasks WHERE channel_id = ?`).run(channelId);
    this.db.prepare(`DELETE FROM thread_task_bindings WHERE channel_id = ?`).run(channelId);
    this.db.prepare(`DELETE FROM channel_task_sequences WHERE channel_id = ?`).run(channelId);
    this.db.prepare(`DELETE FROM agent_message_checkpoints WHERE channel_id = ?`).run(channelId);
    deleteTargetParticipantsForChannel(this.db, channelId);

    for (const row of rows) {
      this.db.prepare('DELETE FROM conversation_prompt_queue WHERE conversation_id = ?').run(row.id);
      this.deleteRunStateForSession(row.sessionKey);

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
         SET session_key = ?, status = 'idle', title = '', history_reset_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(newSessionKey, now, now, row.id);
      this.db.prepare('DELETE FROM sessions WHERE session_key = ?').run(row.sessionKey);
    }

    return this.listConversations({ channelId }).filter((item) => item.threadKind === 'branch');
  }

  listChannels(): ChannelInfo[] {
    const rows = this.db
      .prepare(
        `SELECT channel_id as channelId, name, workspace_path as workspacePath,
                description,
                created_at as createdAt, updated_at as updatedAt
         FROM channels ORDER BY created_at ASC`,
      )
      .all() as ChannelInfo[];
    return rows.map((row) => ({
      ...row,
      members: this.listChannelMembers(row.channelId),
    }));
  }

  getChannel(channelId: string): ChannelInfo | null {
    const row = this.db
      .prepare(
        `SELECT channel_id as channelId, name, workspace_path as workspacePath,
                description,
                created_at as createdAt, updated_at as updatedAt
         FROM channels WHERE channel_id = ?`,
      )
      .get(channelId) as ChannelInfo | undefined;
    if (!row) return null;
    return {
      ...row,
      members: this.listChannelMembers(channelId),
    };
  }

  createResourceSpace(params: CreateResourceSpaceRequest): ResourceSpaceInfo {
    const resourceSpaceId = randomUUID();
    const now = Date.now();
    const description = params.description?.trim() || null;
    const channelId = params.channelId?.trim() || null;
    const nodeId = params.nodeId?.trim() || null;

    this.db.prepare(
      `INSERT INTO resource_spaces(
        resource_space_id,
        name,
        resource_type,
        backend_type,
        node_id,
        root_path,
        channel_id,
        description,
        created_at,
        updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      resourceSpaceId,
      params.name,
      params.resourceType,
      params.backendType,
      nodeId,
      params.rootPath,
      channelId,
      description,
      now,
      now,
    );

    return {
      resourceSpaceId,
      name: params.name,
      resourceType: params.resourceType,
      backendType: params.backendType,
      nodeId,
      rootPath: params.rootPath,
      channelId,
      description,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateResourceSpace(resourceSpaceId: string, req: UpdateResourceSpaceRequest): ResourceSpaceInfo | null {
    const existing = this.getResourceSpace(resourceSpaceId);
    if (!existing) return null;

    const nextName = req.name ?? existing.name;
    const nextResourceType = req.resourceType ?? existing.resourceType;
    const nextBackendType = req.backendType ?? existing.backendType;
    const nextNodeId = req.nodeId !== undefined ? (req.nodeId?.trim() || null) : (existing.nodeId ?? null);
    const nextRootPath = req.rootPath ?? existing.rootPath;
    const nextChannelId = req.channelId !== undefined ? (req.channelId?.trim() || null) : (existing.channelId ?? null);
    const nextDescription = req.description !== undefined
      ? (req.description?.trim() || null)
      : (existing.description ?? null);
    const now = Date.now();

    this.db.prepare(
      `UPDATE resource_spaces
       SET name = ?,
           resource_type = ?,
           backend_type = ?,
           node_id = ?,
           root_path = ?,
           channel_id = ?,
           description = ?,
           updated_at = ?
       WHERE resource_space_id = ?`,
    ).run(
      nextName,
      nextResourceType,
      nextBackendType,
      nextNodeId,
      nextRootPath,
      nextChannelId,
      nextDescription,
      now,
      resourceSpaceId,
    );

    return {
      resourceSpaceId,
      name: nextName,
      resourceType: nextResourceType,
      backendType: nextBackendType,
      nodeId: nextNodeId,
      rootPath: nextRootPath,
      channelId: nextChannelId,
      description: nextDescription,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
  }

  deleteResourceSpace(resourceSpaceId: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM resource_spaces
       WHERE resource_space_id = ?`,
    ).run(resourceSpaceId);
    return result.changes > 0;
  }

  listResourceSpaces(): ResourceSpaceInfo[] {
    return this.db.prepare(
      `SELECT resource_space_id as resourceSpaceId,
              name,
              resource_type as resourceType,
              backend_type as backendType,
              node_id as nodeId,
              root_path as rootPath,
              channel_id as channelId,
              description,
              created_at as createdAt,
              updated_at as updatedAt
       FROM resource_spaces
       ORDER BY created_at ASC`,
    ).all() as ResourceSpaceInfo[];
  }

  getResourceSpace(resourceSpaceId: string): ResourceSpaceInfo | null {
    const row = this.db.prepare(
      `SELECT resource_space_id as resourceSpaceId,
              name,
              resource_type as resourceType,
              backend_type as backendType,
              node_id as nodeId,
              root_path as rootPath,
              channel_id as channelId,
              description,
              created_at as createdAt,
              updated_at as updatedAt
       FROM resource_spaces
       WHERE resource_space_id = ?`,
    ).get(resourceSpaceId) as ResourceSpaceInfo | undefined;
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

  private computeReplyTarget(params: {
    conversationId: string;
    channelId: string;
    threadKind: ThreadKind;
    isPrimaryThread: boolean;
    threadRootId: string | null;
    userId?: string | null;
  }): string {
    if (params.threadKind === 'direct') {
      const userName = resolveDirectUserName(this.db, params.userId, this.config.humanUserName);
      return buildDirectReplyTarget({
        isPrimaryThread: params.isPrimaryThread,
        userName,
        threadRootId: params.threadRootId,
      });
    }

    const channel = this.getChannel(params.channelId);
    const channelName = channel?.name ?? params.channelId;
    const baseTarget = `#${channelName}`;
    return params.threadRootId ? `${baseTarget}:${params.threadRootId}` : baseTarget;
  }

  private backfillConversationReplyTargets(): void {
    const rows = this.db.prepare(
      `SELECT id, channel_id as channelId, thread_kind as threadKind,
              is_primary_thread as isPrimaryThread, thread_root_id as threadRootId,
              user_id as userId, reply_target as replyTarget
       FROM conversations
       WHERE thread_kind = 'direct' OR reply_target IS NULL OR reply_target = ''`,
    ).all() as Array<{
      id: string;
      channelId: string;
      threadKind: ThreadKind;
      isPrimaryThread: number;
      threadRootId: string | null;
      userId: string | null;
      replyTarget: string | null;
    }>;

    if (rows.length === 0) return;

    const updateReplyTarget = this.db.prepare(
      `UPDATE conversations
       SET reply_target = ?
       WHERE id = ?`,
    );

    for (const row of rows) {
      const canonicalReplyTarget = this.computeReplyTarget({
        conversationId: row.id,
        channelId: row.channelId,
        threadKind: row.threadKind,
        isPrimaryThread: row.isPrimaryThread !== 0,
        threadRootId: row.threadRootId ?? null,
        userId: row.userId ?? null,
      });
      if ((row.replyTarget ?? '').trim() === canonicalReplyTarget) continue;
      updateReplyTarget.run(canonicalReplyTarget, row.id);
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
      ...(row.model ? { model: row.model } : {}),
      ...(row.reasoningEffort ? { reasoningEffort: row.reasoningEffort } : {}),
      channelId: row.channelId,
      channelIds: memberships.map((m) => m.channelId),
      systemPrompt: row.systemPrompt,
      ...(row.description ? { description: row.description } : {}),
      envVars: parseEnvVars(row.envVarsJson),
      disabledToolKinds: parseDisabledToolKinds(row.disabledToolKindsJson),
      nodeId: row.nodeId,
      workspacePath: row.workspacePath,
      skillRoots: parseStringArray(row.skillRootsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private listChannelMembers(channelId: string): Array<{ agentId: string; name: string }> {
    return this.db.prepare(
      `SELECT a.agent_id as agentId, a.name
       FROM agent_channel_memberships m
       JOIN agents a ON a.agent_id = m.agent_id
       WHERE m.channel_id = ?
       ORDER BY a.name COLLATE NOCASE ASC`,
    ).all(channelId) as Array<{ agentId: string; name: string }>;
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

function parseStringArray(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    }
  } catch {
    // ignore
  }
  return undefined;
}
