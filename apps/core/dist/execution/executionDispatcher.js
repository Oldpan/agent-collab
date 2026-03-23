import { randomUUID } from 'node:crypto';
import { getRuntimeDriver } from '@agent-collab/protocol';
import { buildAgentContextText } from '@agent-collab/memory';
import { createRun, finishRun, log } from '@agent-collab/runtime-acp';
export class ExecutionDispatcher {
    db;
    config;
    nodeRegistry;
    getAgentById;
    constructor(params) {
        this.db = params.db;
        this.config = params.config;
        this.nodeRegistry = params.nodeRegistry;
        this.getAgentById = params.getAgentById;
    }
    async dispatchPrompt(conversationId, promptText) {
        const row = this.db.prepare(`SELECT session_key as sessionKey, agent_type as agentType,
              workspace_path as workspacePath, env_vars as envVarsJson,
              node_id as nodeId, agent_id as agentId
       FROM conversations WHERE id = ?`).get(conversationId);
        if (!row)
            throw new Error(`Unknown conversation: ${conversationId}`);
        if (!row.nodeId)
            throw new Error('No agent node assigned. Connect an agent-node first.');
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
        let agentEnvVars;
        let disabledToolKinds;
        if (row.agentId) {
            const agent = this.getAgentById(row.agentId);
            if (agent) {
                agentEnvVars = agent.envVars;
                disabledToolKinds = agent.disabledToolKinds;
                contextText = await buildAgentContextText({
                    systemPrompt: agent.systemPrompt,
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
        const sent = this.nodeRegistry.send(row.nodeId, {
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
        });
        if (!sent) {
            finishRun(this.db, { runId, error: 'Node disconnected during dispatch' });
            this.updateStatus(conversationId, 'idle');
            throw new Error(`Node disconnected: ${row.nodeId}`);
        }
        return { runId, dispatchMode, hostKey };
    }
    async submitPrompt(conversationId, promptText) {
        const row = this.db.prepare(`SELECT agent_id as agentId
       FROM conversations
       WHERE id = ?`).get(conversationId);
        if (!row)
            throw new Error(`Unknown conversation: ${conversationId}`);
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
    async handleApproval(conversationId, requestId, decision) {
        const convRow = this.db
            .prepare('SELECT node_id as nodeId FROM conversations WHERE id = ?')
            .get(conversationId);
        if (!convRow)
            return { ok: false, message: 'Unknown conversation.' };
        if (!convRow.nodeId)
            return { ok: false, message: 'No agent node assigned to this conversation.' };
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
    cancelConversationRun(conversationId) {
        const row = this.db.prepare(`SELECT c.node_id as nodeId, r.run_id as runId
       FROM conversations c
       LEFT JOIN runs r ON r.session_key = c.session_key AND r.ended_at IS NULL
       WHERE c.id = ?
       ORDER BY r.started_at DESC
       LIMIT 1`).get(conversationId);
        if (!row)
            return { ok: false, message: 'Unknown conversation.' };
        if (!row.runId)
            return { ok: false, message: 'No active run to cancel.' };
        if (!row.nodeId)
            return { ok: false, message: 'No agent node assigned to this conversation.' };
        const sent = this.nodeRegistry?.send(row.nodeId, {
            type: 'run.cancel',
            runId: row.runId,
        });
        return sent
            ? { ok: true, message: '', runId: row.runId }
            : { ok: false, message: 'Node not connected.' };
    }
    async handleConversationSettled(conversationId) {
        const row = this.db.prepare(`SELECT agent_id as agentId
       FROM conversations
       WHERE id = ?`).get(conversationId);
        if (!row?.agentId)
            return;
        if (this.findBlockingConversation(row.agentId))
            return;
        const next = this.db.prepare(`SELECT queue_id as queueId, agent_id as agentId, conversation_id as conversationId, prompt_text as promptText
       FROM conversation_prompt_queue
       WHERE agent_id = ?
       ORDER BY created_at ASC, queue_id ASC
       LIMIT 1`).get(row.agentId);
        if (!next)
            return;
        this.db.prepare('DELETE FROM conversation_prompt_queue WHERE queue_id = ?').run(next.queueId);
        try {
            await this.dispatchPrompt(next.conversationId, next.promptText);
        }
        catch {
            this.updateStatus(next.conversationId, 'failed');
        }
    }
    clearQueuedPromptsForNode(nodeId) {
        this.db.prepare(`DELETE FROM conversation_prompt_queue
       WHERE conversation_id IN (
         SELECT id FROM conversations WHERE node_id = ?
       )`).run(nodeId);
    }
    ensureConversationSessionAgent(agentType) {
        const driver = getRuntimeDriver(agentType);
        return { command: driver.command, args: [...driver.args] };
    }
    getDispatchMode(sessionKey) {
        const row = this.db
            .prepare('SELECT COUNT(*) as count FROM runs WHERE session_key = ?')
            .get(sessionKey);
        return row.count > 0 ? 'resume' : 'cold_start';
    }
    updateStatus(conversationId, status) {
        this.db
            .prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
            .run(status, Date.now(), conversationId);
    }
    findBlockingConversation(agentId, excludeConversationId) {
        const row = this.db.prepare(`SELECT id, status
       FROM conversations
       WHERE agent_id = ?
         AND status IN ('active', 'recovering', 'awaiting_approval')
         AND (? IS NULL OR id != ?)
       ORDER BY updated_at ASC
       LIMIT 1`).get(agentId, excludeConversationId ?? null, excludeConversationId ?? null);
        return row ?? null;
    }
    enqueuePrompt(agentId, conversationId, promptText) {
        const now = Date.now();
        this.db.prepare(`INSERT INTO conversation_prompt_queue(agent_id, conversation_id, prompt_text, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?)`).run(agentId, conversationId, promptText, now, now);
    }
}
function parseEnvVars(raw) {
    if (!raw)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        // ignore
    }
    return undefined;
}
