import { BindingRuntime, createRun, finishRun, getUiMode, log, } from '@agent-collab/runtime-acp';
import { NodeSink } from './nodeSink.js';
export class AgentHost {
    hostKey;
    sessionKey;
    workspaceRoot;
    runtime;
    db;
    send;
    hooks;
    state = 'idle';
    inbox = [];
    processing = false;
    currentRunId = null;
    lastWakeAt = null;
    lastSleepAt = Date.now();
    lastError = null;
    constructor(params) {
        this.hostKey = params.hostKey;
        this.sessionKey = params.sessionKey;
        this.workspaceRoot = params.workspaceRoot;
        this.db = params.db;
        this.send = params.send;
        this.hooks = params.hooks ?? {};
        this.runtime = new BindingRuntime({
            db: params.db,
            config: params.config,
            toolAuth: params.toolAuth,
            sessionKey: params.sessionKey,
            bindingKey: params.bindingKey,
            workspaceRoot: params.workspaceRoot,
            agentCommand: params.agentCommand,
            agentArgs: params.agentArgs,
            env: params.env,
            disabledToolKinds: params.disabledToolKinds,
            channelBridgeMcpEntry: params.channelBridgeMcpEntry,
        });
    }
    getState() {
        return this.state;
    }
    getCurrentRunId() {
        return this.currentRunId;
    }
    getLastWakeAt() {
        return this.lastWakeAt;
    }
    getLastSleepAt() {
        return this.lastSleepAt;
    }
    getInboxSize() {
        return this.inbox.length;
    }
    getLastError() {
        return this.lastError;
    }
    getWorkspaceRoot() {
        return this.workspaceRoot;
    }
    hasPendingApproval() {
        return this.runtime.hasPendingPermission();
    }
    isIdleExpired(now, idleTimeoutMs) {
        if (this.state !== 'idle')
            return false;
        if (this.currentRunId)
            return false;
        if (this.inbox.length > 0)
            return false;
        if (this.hasPendingApproval())
            return false;
        if (!this.lastSleepAt)
            return false;
        return now - this.lastSleepAt >= idleTimeoutMs;
    }
    async dispatch(msg) {
        return new Promise((resolve, reject) => {
            if (this.state === 'failed') {
                reject(new Error(this.lastError ?? `Host ${this.hostKey} is failed`));
                return;
            }
            if (this.processing || this.currentRunId) {
                log.info('[agent-host] queued dispatch in inbox', {
                    hostKey: this.hostKey,
                    runId: msg.runId,
                    conversationId: msg.conversationId,
                    inboxSize: this.inbox.length + 1,
                });
            }
            this.inbox.push({ msg, resolve, reject });
            void this.processInbox();
        });
    }
    async processInbox() {
        if (this.processing || this.state === 'failed')
            return;
        this.processing = true;
        try {
            while (this.inbox.length > 0) {
                const pending = this.inbox.shift();
                try {
                    await this.runDispatch(pending.msg);
                    pending.resolve();
                }
                catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    pending.reject(err);
                    if (this.getState() === 'failed') {
                        this.failPendingInbox(err);
                        break;
                    }
                }
            }
        }
        finally {
            this.processing = false;
            if (this.getState() !== 'failed' && !this.currentRunId) {
                this.state = 'idle';
                this.lastSleepAt = Date.now();
            }
        }
    }
    async runDispatch(msg) {
        const { runId, conversationId, prompt } = msg;
        const sink = new NodeSink(runId, conversationId, this.send, {
            onPermissionRequest: () => {
                this.hooks.onAwaitingApproval?.(msg);
            },
        });
        if (msg.dispatchMode === 'resume') {
            log.info('[agent-host] waking existing host', {
                hostKey: this.hostKey,
                sessionKey: this.sessionKey,
                lastWakeAt: this.lastWakeAt,
                lastSleepAt: this.lastSleepAt,
            });
        }
        const existingRun = this.db
            .prepare(`SELECT run_id as runId FROM runs WHERE run_id = ?`)
            .get(runId);
        if (!existingRun) {
            createRun(this.db, { runId, sessionKey: this.sessionKey, promptText: prompt });
        }
        this.state = 'active';
        this.currentRunId = runId;
        this.lastWakeAt = Date.now();
        this.lastSleepAt = null;
        this.lastError = null;
        this.hooks.onRunStart?.(msg);
        const nowMs = Date.now();
        this.send({
            type: 'run.event',
            runId,
            conversationId,
            event: { type: 'turn.begin', turnId: runId, startedAt: nowMs, promptText: prompt },
        });
        this.send({
            type: 'run.event',
            runId,
            conversationId,
            event: { type: 'conversation.status', conversationId, status: 'active' },
        });
        try {
            const uiMode = getUiMode(this.db, `node:${conversationId}:-:node_user`) ?? 'summary';
            const result = await this.runtime.prompt({
                runId,
                promptText: prompt,
                sink,
                uiMode,
                systemPromptText: msg.systemPromptText,
                contextText: msg.contextText,
                actorUserId: 'node_user',
            });
            finishRun(this.db, { runId, stopReason: result.stopReason });
            this.state = 'idle';
            log.info('[agent-host] run finished', {
                hostKey: this.hostKey,
                runId,
                conversationId,
                stopReason: result.stopReason,
                dispatchMode: msg.dispatchMode,
                inboxSize: this.inbox.length,
            });
            this.send({ type: 'run.end', runId, conversationId, stopReason: result.stopReason });
        }
        catch (error) {
            const errMsg = String(error?.message ?? error);
            this.state = 'failed';
            this.lastError = errMsg;
            log.warn('[agent-host] run error', {
                hostKey: this.hostKey,
                runId,
                conversationId,
                error: errMsg,
            });
            finishRun(this.db, { runId, error: errMsg });
            this.send({ type: 'run.end', runId, conversationId, error: errMsg });
            throw error instanceof Error ? error : new Error(errMsg);
        }
        finally {
            this.hooks.onRunFinish?.(msg);
            this.currentRunId = null;
            if (this.state !== 'failed') {
                this.state = 'idle';
                this.lastSleepAt = Date.now();
            }
        }
    }
    failPendingInbox(cause) {
        while (this.inbox.length > 0) {
            const pending = this.inbox.shift();
            this.send({
                type: 'run.end',
                runId: pending.msg.runId,
                conversationId: pending.msg.conversationId,
                error: cause.message,
            });
            pending.reject(cause);
        }
    }
    async cancelRun(runId) {
        if (this.currentRunId !== runId)
            return false;
        return this.runtime.cancelCurrentRun(runId);
    }
    async handlePermissionResponse(requestId, decision) {
        return this.runtime.respondToPermission(requestId, decision);
    }
    close() {
        this.failPendingInbox(new Error(`Host ${this.hostKey} closed`));
        this.runtime.close();
    }
}
