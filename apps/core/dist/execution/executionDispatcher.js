import { randomUUID } from 'node:crypto';
import { getRuntimeDriver } from '@agent-collab/protocol';
import { buildAgentContextText } from '@agent-collab/memory';
import { createRun, finishRun, log } from '@agent-collab/runtime-acp';
import { bumpAgentMessageCheckpoint, getAgentMessageCheckpoint } from '../web/messageCheckpoints.js';
import { buildDirectActivationPrompt } from '../web/directActivationPrompt.js';
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
    async dispatchPrompt(conversationId, promptText, options) {
        const row = this.db.prepare(`SELECT session_key as sessionKey, agent_type as agentType,
              workspace_path as workspacePath, env_vars as envVarsJson,
              node_id as nodeId, agent_id as agentId
       FROM conversations WHERE id = ?`).get(conversationId);
        if (!row)
            throw new Error(`Unknown conversation: ${conversationId}`);
        if (!row.nodeId)
            throw new Error('No agent node assigned. Connect an agent-node first.');
        const runId = randomUUID();
        const hostKey = `conversation:${conversationId}:${row.agentType}`;
        const dispatchMode = this.getDispatchMode(row.sessionKey);
        const driver = getRuntimeDriver(row.agentType);
        const recordAsUserMessage = options?.recordAsUserMessage ?? true;
        // Persist run and user message BEFORE node connectivity check so they survive
        // even if the node is offline — the user's message will still be visible after refresh.
        createRun(this.db, { runId, sessionKey: row.sessionKey, promptText });
        this.updateStatus(conversationId, 'active');
        let contextText = '';
        let agentEnvVars;
        let disabledToolKinds;
        let dmActivationCheckpoint;
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
                if (dispatchMode !== 'cold_start') {
                    const replayText = this.buildConversationReplayText(row.sessionKey, runId);
                    if (replayText)
                        contextText += '\n\n' + replayText;
                }
                if (recordAsUserMessage) {
                    // Persist DM user messages to channel_messages so history/replay stay complete
                    // even though the triggering message is also injected directly into this run prompt.
                    const dmChannelId = `dm:${row.agentId}`;
                    const msgSeq = (() => {
                        const r = this.db
                            .prepare('SELECT MAX(seq) as maxSeq FROM channel_messages WHERE channel_id = ?')
                            .get(dmChannelId);
                        return (r.maxSeq ?? 0) + 1;
                    })();
                    const humanUserName = this.config.humanUserName;
                    this.db.prepare(`INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
             VALUES(?, ?, 'user', ?, 'user', ?, ?, ?, ?)`).run(randomUUID(), dmChannelId, humanUserName, `dm:@${agent.name}`, promptText, msgSeq, Date.now());
                    // Checkpoint will be bumped after confirmed delivery to avoid silent message
                    // loss if the node is offline or the send fails.
                    dmActivationCheckpoint = { channelId: dmChannelId, seq: msgSeq };
                    promptText = buildDirectActivationPrompt({
                        agentName: agent.name,
                        senderName: humanUserName,
                        content: promptText,
                    });
                }
                const pendingCount = this.countPendingMessages(row.agentId, agent.channelIds ?? []);
                if (pendingCount > 0) {
                    const label = pendingCount === 1 ? '1 unread message' : `${pendingCount} unread messages`;
                    contextText += `\n\n[Inbox]\n${label} in your channels since last check. Call check_messages when ready.`;
                }
            }
        }
        const node = this.nodeRegistry?.getNode(row.nodeId);
        if (!node) {
            finishRun(this.db, { runId, error: 'Node not connected' });
            this.updateStatus(conversationId, 'idle');
            log.warn('[dispatcher] node not connected', { nodeId: row.nodeId, conversationId });
            throw new Error(`Node not connected: ${row.nodeId}`);
        }
        log.info('[dispatcher] dispatching prompt', {
            nodeId: row.nodeId,
            conversationId,
            runId,
            dispatchMode,
            hostKey,
        });
        let channelBridgeConfig;
        if (row.agentId) {
            const cbHost = this.config.webHost === '0.0.0.0' ? '127.0.0.1' : this.config.webHost;
            channelBridgeConfig = {
                agentId: row.agentId,
                conversationId,
                serverUrl: `http://${cbHost}:${this.config.webPort}`,
            };
        }
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
            channelBridgeConfig,
        });
        if (!sent) {
            finishRun(this.db, { runId, error: 'Node disconnected during dispatch' });
            this.updateStatus(conversationId, 'idle');
            throw new Error(`Node disconnected: ${row.nodeId}`);
        }
        if (dmActivationCheckpoint) {
            bumpAgentMessageCheckpoint(this.db, row.agentId, dmActivationCheckpoint.channelId, dmActivationCheckpoint.seq, null);
        }
        return { runId, dispatchMode, hostKey };
    }
    async submitPrompt(conversationId, promptText, options) {
        const row = this.db.prepare(`SELECT agent_id as agentId
       FROM conversations
       WHERE id = ?`).get(conversationId);
        if (!row)
            throw new Error(`Unknown conversation: ${conversationId}`);
        if (!row.agentId) {
            await this.dispatchPrompt(conversationId, promptText, options);
            return { queued: false };
        }
        const blocking = this.findBlockingConversation(row.agentId, conversationId);
        if (blocking) {
            this.enqueuePrompt(row.agentId, conversationId, promptText, options);
            this.updateStatus(conversationId, 'queued');
            return { queued: true };
        }
        await this.dispatchPrompt(conversationId, promptText, options);
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
        const next = this.db.prepare(`SELECT queue_id as queueId, agent_id as agentId, conversation_id as conversationId,
              prompt_text as promptText, record_as_user_message as recordAsUserMessage
       FROM conversation_prompt_queue
       WHERE agent_id = ?
       ORDER BY created_at ASC, queue_id ASC
       LIMIT 1`).get(row.agentId);
        if (!next)
            return;
        this.db.prepare('DELETE FROM conversation_prompt_queue WHERE queue_id = ?').run(next.queueId);
        try {
            await this.dispatchPrompt(next.conversationId, next.promptText, {
                recordAsUserMessage: next.recordAsUserMessage !== 0,
            });
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
    /**
     * Rebuild recent conversation history from core's DB (content.delta events) so that
     * a freshly restarted ACP process can recover context it would otherwise have lost.
     */
    buildConversationReplayText(sessionKey, excludeRunId) {
        if (!this.config.contextReplayEnabled || this.config.contextReplayRuns <= 0)
            return '';
        const runs = this.db.prepare(`SELECT run_id as runId, prompt_text as promptText, stop_reason as stopReason, error
       FROM runs
       WHERE session_key = ? AND run_id != ? AND ended_at IS NOT NULL
       ORDER BY started_at DESC
       LIMIT ?`).all(sessionKey, excludeRunId, this.config.contextReplayRuns);
        const chronological = runs.slice().reverse();
        const blocks = [];
        for (const run of chronological) {
            const events = this.db.prepare(`SELECT payload_json as payloadJson FROM events
         WHERE run_id = ? AND method = 'node/event'
         ORDER BY seq ASC`).all(run.runId);
            let assistantText = '';
            for (const ev of events) {
                try {
                    const parsed = JSON.parse(ev.payloadJson);
                    if (parsed?.type === 'content.delta' && typeof parsed.text === 'string') {
                        assistantText += parsed.text;
                    }
                }
                catch { /* ignore malformed rows */ }
            }
            const assistantLine = assistantText.trim()
                ? assistantText.trim()
                : run.error
                    ? `[error] ${run.error}`
                    : run.stopReason
                        ? `[stop_reason] ${run.stopReason}`
                        : '';
            blocks.push(`User: ${run.promptText}`);
            if (assistantLine)
                blocks.push(`Assistant: ${assistantLine}`);
        }
        const raw = blocks.join('\n');
        if (!raw.trim())
            return '';
        const header = 'Context (previous messages, for continuity after restart):\n';
        const full = header + raw;
        if (full.length <= this.config.contextReplayMaxChars)
            return full;
        return header + raw.slice(Math.max(0, raw.length - this.config.contextReplayMaxChars));
    }
    countPendingMessages(agentId, channelIds) {
        const dmChannelId = `dm:${agentId}`;
        const allChannels = Array.from(new Set([...channelIds, dmChannelId]));
        let total = 0;
        for (const channelId of allChannels) {
            const threadKeys = this.db.prepare(`SELECT DISTINCT COALESCE(thread_root_id, '') as threadKey
         FROM channel_messages WHERE channel_id = ? AND sender_id != ?`).all(channelId, agentId).map((r) => r.threadKey);
            for (const threadKey of threadKeys) {
                const checkpoint = getAgentMessageCheckpoint(this.db, agentId, channelId, threadKey || null);
                const row = this.db.prepare(`SELECT COUNT(*) as count FROM channel_messages
           WHERE channel_id = ? AND seq > ? AND sender_id != ? AND COALESCE(thread_root_id, '') = ?`).get(channelId, checkpoint, agentId, threadKey);
                total += row.count;
            }
        }
        return total;
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
    enqueuePrompt(agentId, conversationId, promptText, options) {
        const now = Date.now();
        this.db.prepare(`INSERT INTO conversation_prompt_queue(agent_id, conversation_id, prompt_text, record_as_user_message, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?)`).run(agentId, conversationId, promptText, (options?.recordAsUserMessage ?? true) ? 1 : 0, now, now);
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
