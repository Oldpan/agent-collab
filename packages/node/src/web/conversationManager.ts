import { randomUUID } from 'node:crypto';

import type { Db } from '../db/db.js';
import type { AppConfig } from '../config.js';
import type { OutboundSink, UiMode } from '../gateway/types.js';
import type { ConversationInfo, AgentType } from '@agent-collab/wire-types';

import { log } from '../logging.js';
import { BindingRuntime } from '../gateway/bindingRuntime.js';
import { ToolAuth } from '../gateway/toolAuth.js';
import {
  createSession,
  createRun,
  finishRun,
  getSession,
  upsertBinding,
} from '../gateway/sessionStore.js';
import { getUiMode } from '../db/uiPrefStore.js';
import { buildReplayContextFromRecentRuns } from '../gateway/history.js';

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

  // Active runtimes keyed by sessionKey
  private readonly runtimesBySessionKey = new Map<
    string,
    { runtime: BindingRuntime; lastUsedMs: number }
  >();

  private gcTimer: NodeJS.Timeout | null = null;

  constructor(params: { db: Db; config: AppConfig }) {
    this.db = params.db;
    this.config = params.config;
    this.toolAuth = new ToolAuth(this.db);
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
  }): ConversationInfo {
    const id = randomUUID();
    const agentType: AgentType = params.agentType ?? 'claude_acp';
    const workspacePath = params.workspacePath ?? this.config.workspaceRoot;
    const title = params.title ?? '';
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

    // Create binding row (platform=web)
    const bindingKey = `web:${id}:-:web_user`;
    upsertBinding(
      this.db,
      { platform: 'web', chatId: id, threadId: null, userId: 'web_user' },
      sessionKey,
    );

    // Create conversations row
    this.db
      .prepare(
        `INSERT INTO conversations(id, title, agent_type, workspace_path, session_key, status, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, 'idle', ?, ?)`,
      )
      .run(id, title, agentType, workspacePath, sessionKey, now, now);

    return { id, title, agentType, workspacePath, status: 'idle', createdAt: now, updatedAt: now };
  }

  listConversations(): ConversationInfo[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, agent_type as agentType, workspace_path as workspacePath,
                status, created_at as createdAt, updated_at as updatedAt
         FROM conversations ORDER BY updated_at DESC`,
      )
      .all() as ConversationInfo[];
    return rows;
  }

  getConversation(id: string): ConversationInfo | null {
    const row = this.db
      .prepare(
        `SELECT id, title, agent_type as agentType, workspace_path as workspacePath,
                status, created_at as createdAt, updated_at as updatedAt
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

  // ─── Runtime management ───

  private getOrCreateRuntime(conversationId: string): BindingRuntime {
    const row = this.db
      .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conversationId) as { sessionKey: string } | undefined;

    if (!row) throw new Error(`Unknown conversation: ${conversationId}`);

    const { sessionKey } = row;
    const bindingKey = `web:${conversationId}:-:web_user`;

    const existing = this.runtimesBySessionKey.get(sessionKey);
    if (existing) {
      existing.lastUsedMs = Date.now();
      return existing.runtime;
    }

    const sess = getSession(this.db, sessionKey);
    if (!sess) throw new Error(`Missing session row: ${sessionKey}`);

    const agentArgs = parseAgentArgs(sess.agentArgsJson, this.config.acpAgentArgs);

    const rt = new BindingRuntime({
      db: this.db,
      config: this.config,
      toolAuth: this.toolAuth,
      sessionKey,
      bindingKey,
      workspaceRoot: sess.cwd,
      agentCommand: sess.agentCommand,
      agentArgs,
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
      .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conversationId) as { sessionKey: string } | undefined;

    if (!row) throw new Error(`Unknown conversation: ${conversationId}`);

    const { sessionKey } = row;
    const bindingKey = `web:${conversationId}:-:web_user`;
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
    const row = this.db
      .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conversationId) as { sessionKey: string } | undefined;

    if (!row) return { ok: false, message: 'Unknown conversation.' };

    const entry = this.runtimesBySessionKey.get(row.sessionKey);
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
