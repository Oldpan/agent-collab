import { randomUUID } from 'node:crypto';

import type { ConversationInfo, AgentType, ChannelInfo } from '@agent-collab/protocol';
import {
  log,
  BindingRuntime,
  ToolAuth,
  createSession,
  createRun,
  finishRun,
  getSession,
  upsertBinding,
  getUiMode,
  buildReplayContextFromRecentRuns,
} from '@agent-collab/runtime-acp';
import type { Db, OutboundSink, UiMode } from '@agent-collab/runtime-acp';
import type { AppConfig } from '../config.js';
import type { NodeRegistry } from '../services/nodeRegistry.js';

// Agent CLI presets
const CLI_PRESETS: Record<AgentType, { command: string; args: string[] }> = {
  claude_acp: {
    command: 'npx',
    args: ['-y', '@zed-industries/claude-code-acp@latest'],
  },
  codex_acp: {
    command: 'npx',
    args: ['-y', '@zed-industries/codex-acp@latest'],
  },
};

export class ConversationManager {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly toolAuth: ToolAuth;
  private readonly nodeRegistry?: NodeRegistry;

  // Active runtimes keyed by sessionKey
  private readonly runtimesBySessionKey = new Map<
    string,
    { runtime: BindingRuntime; lastUsedMs: number }
  >();

  private gcTimer: NodeJS.Timeout | null = null;

  constructor(params: { db: Db; config: AppConfig; nodeRegistry?: NodeRegistry }) {
    this.db = params.db;
    this.config = params.config;
    this.toolAuth = new ToolAuth(this.db);
    this.nodeRegistry = params.nodeRegistry;
  }

  getDb(): Db {
    return this.db;
  }

  start(): void {
    this.gcTimer = setInterval(() => {
      try {
        this.gc();
      } catch (error) {
        log.warn('runtime GC error', error);
      }
    }, 60_000);
    log.info('ConversationManager ready');
  }

  close(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    for (const entry of this.runtimesBySessionKey.values()) {
      entry.runtime.close();
    }
    this.runtimesBySessionKey.clear();
  }

  // ─── CRUD ───

  createConversation(params: {
    agentType?: AgentType;
    workspacePath?: string;
    title?: string;
    channelId?: string;
    envVars?: Record<string, string>;
    nodeId?: string;
  }): ConversationInfo {
    const id = randomUUID();
    const agentType: AgentType = params.agentType ?? 'claude_acp';
    const workspacePath = params.workspacePath ?? this.config.workspaceRoot;
    const title = params.title ?? '';
    const channelId = params.channelId ?? 'default';
    const envVarsJson = params.envVars && Object.keys(params.envVars).length > 0
      ? JSON.stringify(params.envVars)
      : null;
    const now = Date.now();

    const sessionKey = randomUUID();
    const preset = CLI_PRESETS[agentType];

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
        `INSERT INTO conversations(id, channel_id, title, agent_type, workspace_path, session_key, status, env_vars, node_id, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)`,
      )
      .run(id, channelId, title, agentType, workspacePath, sessionKey, envVarsJson, params.nodeId ?? null, now, now);

    return { id, channelId, title, agentType, workspacePath, status: 'idle', createdAt: now, updatedAt: now, nodeId: params.nodeId ?? null };
  }

  listConversations(channelId?: string): ConversationInfo[] {
    const sql = channelId
      ? `SELECT id, channel_id as channelId, title, agent_type as agentType,
                workspace_path as workspacePath, status, node_id as nodeId,
                created_at as createdAt, updated_at as updatedAt
         FROM conversations WHERE channel_id = ? ORDER BY updated_at DESC`
      : `SELECT id, channel_id as channelId, title, agent_type as agentType,
                workspace_path as workspacePath, status, node_id as nodeId,
                created_at as createdAt, updated_at as updatedAt
         FROM conversations ORDER BY updated_at DESC`;
    const rows = channelId
      ? this.db.prepare(sql).all(channelId)
      : this.db.prepare(sql).all();
    return rows as ConversationInfo[];
  }

  getConversation(id: string): ConversationInfo | null {
    const row = this.db
      .prepare(
        `SELECT id, channel_id as channelId, title, agent_type as agentType,
                workspace_path as workspacePath, status, node_id as nodeId,
                created_at as createdAt, updated_at as updatedAt
         FROM conversations WHERE id = ?`,
      )
      .get(id) as ConversationInfo | undefined;
    return row ?? null;
  }

  deleteConversation(id: string): void {
    const conv = this.getConversation(id);
    if (!conv) return;

    // Find and clean up runtime
    const row = this.db
      .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(id) as { sessionKey: string } | undefined;

    if (row) {
      const entry = this.runtimesBySessionKey.get(row.sessionKey);
      if (entry) {
        entry.runtime.close();
        this.runtimesBySessionKey.delete(row.sessionKey);
      }
    }

    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  async dispatchToNode(conversationId: string, promptText: string): Promise<void> {
    const row = this.db.prepare(
      `SELECT session_key as sessionKey, agent_type as agentType,
              workspace_path as workspacePath, env_vars as envVarsJson, node_id as nodeId
       FROM conversations WHERE id = ?`
    ).get(conversationId) as {
      sessionKey: string; agentType: string; workspacePath: string | null;
      envVarsJson: string | null; nodeId: string;
    } | undefined;

    if (!row) throw new Error(`Unknown conversation: ${conversationId}`);

    const node = this.nodeRegistry?.getNode(row.nodeId);
    if (!node) {
      log.warn('[conv-mgr] node not connected', { nodeId: row.nodeId, conversationId });
      throw new Error(`Node not connected: ${row.nodeId}`);
    }

    const runId = randomUUID();
    createRun(this.db, { runId, sessionKey: row.sessionKey, promptText });
    this.updateStatus(conversationId, 'busy');

    log.info('[conv-mgr] dispatching to node', { nodeId: row.nodeId, conversationId, runId });

    const sent = this.nodeRegistry!.send(row.nodeId, {
      type: 'run.dispatch',
      runId,
      conversationId,
      agentType: row.agentType,
      workspacePath: row.workspacePath,
      envVars: parseEnvVars(row.envVarsJson),
      prompt: promptText,
      sessionKey: row.sessionKey,
    });

    if (!sent) {
      // WebSocket closed between getNode check and send — mark the orphaned run as failed
      finishRun(this.db, { runId, error: 'Node disconnected during dispatch' });
      this.updateStatus(conversationId, 'idle');
      throw new Error(`Node disconnected: ${row.nodeId}`);
    }
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

  // ─── Runtime management ───

  private getOrCreateRuntime(conversationId: string): BindingRuntime {
    const row = this.db
      .prepare(
        `SELECT session_key as sessionKey, channel_id as channelId,
                agent_type as agentType, env_vars as envVarsJson
         FROM conversations WHERE id = ?`,
      )
      .get(conversationId) as {
        sessionKey: string;
        channelId: string;
        agentType: string;
        envVarsJson: string | null;
      } | undefined;

    if (!row) throw new Error(`Unknown conversation: ${conversationId}`);

    const { sessionKey, channelId, agentType } = row;
    const bindingKey = `web:${channelId}:${conversationId}:${agentType}`;

    const existing = this.runtimesBySessionKey.get(sessionKey);
    if (existing) {
      existing.lastUsedMs = Date.now();
      return existing.runtime;
    }

    const sess = getSession(this.db, sessionKey);
    if (!sess) throw new Error(`Missing session row: ${sessionKey}`);

    const agentArgs = parseAgentArgs(sess.agentArgsJson, this.config.acpAgentArgs);
    const envVars = parseEnvVars(row.envVarsJson);

    const rt = new BindingRuntime({
      db: this.db,
      config: this.config,
      toolAuth: this.toolAuth,
      sessionKey,
      bindingKey,
      workspaceRoot: sess.cwd,
      agentCommand: sess.agentCommand,
      agentArgs,
      env: envVars,
    });

    this.runtimesBySessionKey.set(sessionKey, {
      runtime: rt,
      lastUsedMs: Date.now(),
    });

    this.enforceRuntimeLimit();
    return rt;
  }

  private gc(): void {
    const now = Date.now();
    const ttlMs = this.config.runtimeIdleTtlSeconds * 1000;

    for (const [sessionKey, entry] of this.runtimesBySessionKey.entries()) {
      if (now - entry.lastUsedMs <= ttlMs) continue;
      entry.runtime.close();
      this.runtimesBySessionKey.delete(sessionKey);
    }
    this.enforceRuntimeLimit();
  }

  private enforceRuntimeLimit(): void {
    const max = this.config.maxBindingRuntimes;
    if (this.runtimesBySessionKey.size <= max) return;

    const entries = [...this.runtimesBySessionKey.entries()].sort(
      (a, b) => a[1].lastUsedMs - b[1].lastUsedMs,
    );

    const removeCount = Math.max(0, entries.length - max);
    for (let i = 0; i < removeCount; i++) {
      const [sessionKey, entry] = entries[i];
      entry.runtime.close();
      this.runtimesBySessionKey.delete(sessionKey);
    }
  }

  // ─── Prompt handling ───

  async sendPrompt(
    conversationId: string,
    text: string,
    sink: OutboundSink,
    attachments?: Array<{ uri: string; mimeType?: string }>,
  ): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT session_key as sessionKey, channel_id as channelId, agent_type as agentType
         FROM conversations WHERE id = ?`,
      )
      .get(conversationId) as { sessionKey: string; channelId: string; agentType: string } | undefined;

    if (!row) throw new Error(`Unknown conversation: ${conversationId}`);

    const { sessionKey, channelId, agentType } = row;
    const bindingKey = `web:${channelId}:${conversationId}:${agentType}`;
    const rt = this.getOrCreateRuntime(conversationId);

    // Update status to busy
    this.updateStatus(conversationId, 'busy');

    const runId = randomUUID();
    createRun(this.db, { runId, sessionKey, promptText: text });

    // Build context for fresh sessions
    let contextText = '';
    const isFreshSession = !rt.hasSessionId();
    if (isFreshSession && this.config.contextReplayEnabled && this.config.contextReplayRuns > 0) {
      contextText = buildReplayContextFromRecentRuns(this.db, {
        sessionKey,
        excludeRunId: runId,
        maxRuns: this.config.contextReplayRuns,
        maxChars: this.config.contextReplayMaxChars,
      });
    }

    try {
      const uiMode: UiMode = getUiMode(this.db, bindingKey) ?? this.config.uiDefaultMode;

      const result = await rt.prompt({
        runId,
        promptText: text,
        promptResources: attachments,
        sink,
        uiMode,
        contextText,
        actorUserId: 'web_user',
      });

      finishRun(this.db, { runId, stopReason: result.stopReason });
    } catch (error: any) {
      finishRun(this.db, { runId, error: String(error?.message ?? error) });

      // Evict broken runtimes on transport errors
      if (isAcpTransportError(error)) {
        const stale = this.runtimesBySessionKey.get(sessionKey);
        stale?.runtime.close();
        this.runtimesBySessionKey.delete(sessionKey);
      }

      throw error;
    } finally {
      this.updateStatus(conversationId, 'idle');
    }
  }

  async handleApproval(
    conversationId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ): Promise<{ ok: boolean; message: string }> {
    const convRow = this.db
      .prepare('SELECT session_key as sessionKey, node_id as nodeId FROM conversations WHERE id = ?')
      .get(conversationId) as { sessionKey: string; nodeId: string | null } | undefined;

    if (!convRow) return { ok: false, message: 'Unknown conversation.' };

    if (convRow.nodeId) {
      const sent = this.nodeRegistry?.send(convRow.nodeId, {
        type: 'permission.response',
        requestId,
        decision,
      });
      return sent ? { ok: true, message: '' } : { ok: false, message: 'Node not connected.' };
    }

    const entry = this.runtimesBySessionKey.get(convRow.sessionKey);
    if (!entry) return { ok: false, message: 'No active runtime. Send a message first.' };

    return entry.runtime.decidePermission({ decision, requestId, actorUserId: 'web_user' });
  }

  private updateStatus(conversationId: string, status: string): void {
    this.db
      .prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), conversationId);
  }
}

function parseAgentArgs(raw: string, fallback: string[]): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return [...fallback];
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

function isAcpTransportError(error: unknown): boolean {
  const name = String((error as any)?.name ?? '').trim();
  if (name === 'AcpTransportError') return true;

  const message = String((error as any)?.message ?? error ?? '').toLowerCase();
  return (
    message.includes('acp process is not running') ||
    message.includes('acp agent exited') ||
    message.includes('acp request timed out')
  );
}
