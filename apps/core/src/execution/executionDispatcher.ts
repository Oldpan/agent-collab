import { randomUUID } from 'node:crypto';

import type { AgentInfo, ConversationStatus } from '@agent-collab/protocol';
import { getRuntimeDriver, type RuntimeDispatchMode } from '@agent-collab/protocol';
import { buildAgentContextText } from '@agent-collab/memory';
import { createRun, finishRun, log } from '@agent-collab/runtime-acp';
import type { Db } from '@agent-collab/runtime-acp';
import type { AppConfig } from '../config.js';
import type { NodeRegistry } from '../services/nodeRegistry.js';

export class ExecutionDispatcher {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly nodeRegistry?: NodeRegistry;
  private readonly getAgentById: (agentId: string) => AgentInfo | null;

  constructor(params: {
    db: Db;
    config: AppConfig;
    nodeRegistry?: NodeRegistry;
    getAgentById: (agentId: string) => AgentInfo | null;
  }) {
    this.db = params.db;
    this.config = params.config;
    this.nodeRegistry = params.nodeRegistry;
    this.getAgentById = params.getAgentById;
  }

  async dispatchPrompt(
    conversationId: string,
    promptText: string,
  ): Promise<{ runId: string; dispatchMode: RuntimeDispatchMode; hostKey: string }> {
    const row = this.db.prepare(
      `SELECT session_key as sessionKey, agent_type as agentType,
              workspace_path as workspacePath, env_vars as envVarsJson,
              node_id as nodeId, agent_id as agentId
       FROM conversations WHERE id = ?`
    ).get(conversationId) as {
      sessionKey: string;
      agentType: AgentInfo['agentType'];
      workspacePath: string | null;
      envVarsJson: string | null;
      nodeId: string | null;
      agentId: string | null;
    } | undefined;

    if (!row) throw new Error(`Unknown conversation: ${conversationId}`);
    if (!row.nodeId) throw new Error('No agent node assigned. Connect an agent-node first.');

    const node = this.nodeRegistry?.getNode(row.nodeId);
    if (!node) {
      log.warn('[dispatcher] node not connected', { nodeId: row.nodeId, conversationId });
      throw new Error(`Node not connected: ${row.nodeId}`);
    }

    const runId = randomUUID();
    const hostKey = `conversation:${conversationId}:${row.agentType}`;
    const dispatchMode = this.getDispatchMode(row.sessionKey);
    const driver = getRuntimeDriver(row.agentType);

    createRun(this.db, { runId, sessionKey: row.sessionKey, promptText });
    this.updateStatus(conversationId, 'active');

    let contextText = '';
    let agentEnvVars: Record<string, string> | undefined;
    let disabledToolKinds: AgentInfo['disabledToolKinds'];
    if (row.agentId) {
      const agent = this.getAgentById(row.agentId);
      if (agent) {
        agentEnvVars = agent.envVars;
        disabledToolKinds = agent.disabledToolKinds;
        contextText = await buildAgentContextText({
          agentName: agent.name,
          agentDescription: agent.systemPrompt || undefined,
          agentType: agent.agentType,
          workspacePath: row.workspacePath ?? this.config.workspaceRoot,
        });
      }
    }

    log.info('[dispatcher] dispatching prompt', {
      nodeId: row.nodeId,
      conversationId,
      runId,
      dispatchMode,
      hostKey,
    });

    let channelBridgeConfig: { agentId: string; serverUrl: string } | undefined;
    if (row.agentId) {
      const cbHost = this.config.webHost === '0.0.0.0' ? '127.0.0.1' : this.config.webHost;
      channelBridgeConfig = {
        agentId: row.agentId,
        serverUrl: `http://${cbHost}:${this.config.webPort}`,
      };
    }

    const sent = this.nodeRegistry!.send(row.nodeId, {
      type: 'run.dispatch',
      runId,
      conversationId,
      agentType: row.agentType,
      workspacePath: row.workspacePath,
      envVars: {
        ...(agentEnvVars ?? {}),
        ...(parseEnvVars(row.envVarsJson) ?? {}),
        ...(driver.defaultEnv ?? {}),
      },
      disabledToolKinds,
      prompt: promptText,
      sessionKey: row.sessionKey,
      hostKey,
      dispatchMode,
      contextText: contextText || undefined,
      channelBridgeConfig,
    });

    if (!sent) {
      finishRun(this.db, { runId, error: 'Node disconnected during dispatch' });
      this.updateStatus(conversationId, 'idle');
      throw new Error(`Node disconnected: ${row.nodeId}`);
    }

    return { runId, dispatchMode, hostKey };
  }

  async submitPrompt(
    conversationId: string,
    promptText: string,
  ): Promise<{ queued: boolean }> {
    const row = this.db.prepare(
      `SELECT agent_id as agentId
       FROM conversations
       WHERE id = ?`,
    ).get(conversationId) as { agentId: string | null } | undefined;

    if (!row) throw new Error(`Unknown conversation: ${conversationId}`);

    if (!row.agentId) {
      await this.dispatchPrompt(conversationId, promptText);
      return { queued: false };
    }

    const blocking = this.findBlockingConversation(row.agentId, conversationId);
    if (blocking) {
      this.enqueuePrompt(row.agentId, conversationId, promptText);
      this.updateStatus(conversationId, 'queued');
      return { queued: true };
    }

    await this.dispatchPrompt(conversationId, promptText);
    return { queued: false };
  }

  async handleApproval(
    conversationId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ): Promise<{ ok: boolean; message: string }> {
    const convRow = this.db
      .prepare('SELECT node_id as nodeId FROM conversations WHERE id = ?')
      .get(conversationId) as { nodeId: string | null } | undefined;

    if (!convRow) return { ok: false, message: 'Unknown conversation.' };
    if (!convRow.nodeId) return { ok: false, message: 'No agent node assigned to this conversation.' };

    const sent = this.nodeRegistry?.send(convRow.nodeId, {
      type: 'permission.response',
      requestId,
      decision,
    });
    if (sent) {
      this.updateStatus(conversationId, 'active');
      return { ok: true, message: '' };
    }
    return { ok: false, message: 'Node not connected.' };
  }

  cancelConversationRun(
    conversationId: string,
  ): { ok: boolean; message: string; runId?: string } {
    const row = this.db.prepare(
      `SELECT c.node_id as nodeId, r.run_id as runId
       FROM conversations c
       LEFT JOIN runs r ON r.session_key = c.session_key AND r.ended_at IS NULL
       WHERE c.id = ?
       ORDER BY r.started_at DESC
       LIMIT 1`
    ).get(conversationId) as { nodeId: string | null; runId: string | null } | undefined;

    if (!row) return { ok: false, message: 'Unknown conversation.' };
    if (!row.runId) return { ok: false, message: 'No active run to cancel.' };
    if (!row.nodeId) return { ok: false, message: 'No agent node assigned to this conversation.' };

    const sent = this.nodeRegistry?.send(row.nodeId, {
      type: 'run.cancel',
      runId: row.runId,
    });
    return sent
      ? { ok: true, message: '', runId: row.runId }
      : { ok: false, message: 'Node not connected.' };
  }

  async handleConversationSettled(conversationId: string): Promise<void> {
    const row = this.db.prepare(
      `SELECT agent_id as agentId
       FROM conversations
       WHERE id = ?`,
    ).get(conversationId) as { agentId: string | null } | undefined;

    if (!row?.agentId) return;
    if (this.findBlockingConversation(row.agentId)) return;

    const next = this.db.prepare(
      `SELECT queue_id as queueId, agent_id as agentId, conversation_id as conversationId, prompt_text as promptText
       FROM conversation_prompt_queue
       WHERE agent_id = ?
       ORDER BY created_at ASC, queue_id ASC
       LIMIT 1`,
    ).get(row.agentId) as {
      queueId: number;
      agentId: string;
      conversationId: string;
      promptText: string;
    } | undefined;

    if (!next) return;

    this.db.prepare('DELETE FROM conversation_prompt_queue WHERE queue_id = ?').run(next.queueId);
    try {
      await this.dispatchPrompt(next.conversationId, next.promptText);
    } catch {
      this.updateStatus(next.conversationId, 'failed');
    }
  }

  clearQueuedPromptsForNode(nodeId: string): void {
    this.db.prepare(
      `DELETE FROM conversation_prompt_queue
       WHERE conversation_id IN (
         SELECT id FROM conversations WHERE node_id = ?
       )`,
    ).run(nodeId);
  }

  ensureConversationSessionAgent(
    agentType: AgentInfo['agentType'],
  ): { command: string; args: string[] } {
    const driver = getRuntimeDriver(agentType);
    return { command: driver.command, args: [...driver.args] };
  }

  private getDispatchMode(sessionKey: string): RuntimeDispatchMode {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM runs WHERE session_key = ?')
      .get(sessionKey) as { count: number };
    return row.count > 0 ? 'resume' : 'cold_start';
  }

  private updateStatus(conversationId: string, status: ConversationStatus): void {
    this.db
      .prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), conversationId);
  }

  private findBlockingConversation(
    agentId: string,
    excludeConversationId?: string,
  ): { id: string; status: ConversationStatus } | null {
    const row = this.db.prepare(
      `SELECT id, status
       FROM conversations
       WHERE agent_id = ?
         AND status IN ('active', 'recovering', 'awaiting_approval')
         AND (? IS NULL OR id != ?)
       ORDER BY updated_at ASC
       LIMIT 1`,
    ).get(agentId, excludeConversationId ?? null, excludeConversationId ?? null) as {
      id: string;
      status: ConversationStatus;
    } | undefined;
    return row ?? null;
  }

  private enqueuePrompt(agentId: string, conversationId: string, promptText: string): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO conversation_prompt_queue(agent_id, conversation_id, prompt_text, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?)`,
    ).run(agentId, conversationId, promptText, now, now);
  }
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
