import { createRequire } from 'node:module';
import path from 'node:path';
import { ToolAuth, createSession, getSession, upsertBinding, log, } from '@agent-collab/runtime-acp';
import { getRuntimeDriver } from '@agent-collab/protocol';
import { AgentHost } from './agentHost.js';
import { enqueueDispatch, listPendingDispatches, removeDispatch, updateDispatchState, } from './dispatchQueueStore.js';
export class Executor {
    db;
    config;
    toolAuth;
    hosts = new Map();
    runToHost = new Map();
    send;
    createHost;
    constructor(params) {
        this.db = params.db;
        this.config = params.config;
        this.toolAuth = new ToolAuth(params.db);
        this.send = params.send;
        this.createHost = params.createHost ?? ((hostParams) => new AgentHost(hostParams));
    }
    async dispatch(msg, options) {
        const shouldPersist = options?.persist !== false;
        const { runId, conversationId, sessionKey, prompt, hostKey } = msg;
        const bindingKey = `node:${conversationId}:-:node_user`;
        const runtimeKey = hostKey || sessionKey;
        const driver = getRuntimeDriver(msg.agentType);
        log.info('[executor] dispatch received', {
            runId,
            conversationId,
            sessionKey,
            runtimeKey,
            dispatchMode: msg.dispatchMode,
            agentType: msg.agentType,
        });
        if (shouldPersist) {
            enqueueDispatch(this.db, msg, 'queued');
        }
        // Ensure local session row exists (bindings has FK → sessions)
        const existingSession = getSession(this.db, sessionKey);
        if (!existingSession) {
            createSession(this.db, {
                sessionKey,
                agentCommand: driver.command,
                agentArgs: driver.args,
                cwd: msg.workspacePath ?? this.config.workspaceRoot,
                loadSupported: false,
            });
            log.debug('[executor] created local session', { sessionKey, conversationId });
        }
        // Ensure binding exists
        upsertBinding(this.db, { platform: 'node', chatId: conversationId, threadId: null, userId: 'node_user' }, sessionKey);
        let channelBridgeMcpEntry;
        if (msg.channelBridgeConfig) {
            const { agentId, serverUrl, authToken } = msg.channelBridgeConfig;
            try {
                const req = createRequire(import.meta.url);
                const binPath = req.resolve('@agent-collab/channel-bridge');
                channelBridgeMcpEntry = {
                    name: 'chat',
                    command: 'node',
                    args: [binPath, '--agent-id', agentId, '--server-url', serverUrl],
                    env: authToken ? [{ name: 'CHANNEL_BRIDGE_AUTH_TOKEN', value: authToken }] : [],
                };
            }
            catch {
                log.warn('[executor] channel-bridge package not found, skipping MCP injection');
            }
        }
        let host = this.hosts.get(runtimeKey);
        if (host?.getState() === 'failed') {
            log.warn('[executor] recreating failed host', {
                runtimeKey,
                sessionKey,
                previousRunId: host.getCurrentRunId(),
                lastError: host.getLastError(),
            });
            host.close();
            this.hosts.delete(runtimeKey);
            host = undefined;
        }
        if (!host) {
            host = this.createHost({
                hostKey: runtimeKey,
                sessionKey,
                bindingKey,
                db: this.db,
                config: this.config,
                toolAuth: this.toolAuth,
                workspaceRoot: msg.workspacePath ?? this.config.workspaceRoot,
                agentCommand: driver.command,
                agentArgs: driver.args,
                env: msg.envVars,
                disabledToolKinds: msg.disabledToolKinds,
                channelBridgeMcpEntry,
                send: this.send,
                hooks: {
                    onRunStart: (dispatchMsg) => {
                        updateDispatchState(this.db, dispatchMsg.runId, 'running');
                    },
                    onRunFinish: (dispatchMsg) => {
                        removeDispatch(this.db, dispatchMsg.runId);
                    },
                },
            });
            this.hosts.set(runtimeKey, host);
        }
        this.runToHost.set(runId, runtimeKey);
        try {
            await host.dispatch(msg);
        }
        finally {
            this.runToHost.delete(runId);
            if (host.getState() === 'failed') {
                removeDispatch(this.db, runId);
            }
        }
    }
    resumePendingDispatches() {
        const pending = listPendingDispatches(this.db);
        if (pending.length === 0)
            return;
        log.warn('[executor] restoring pending dispatches after node restart', {
            count: pending.length,
        });
        for (const entry of pending) {
            const restoredMsg = entry.state === 'running'
                ? { ...entry.payload, dispatchMode: 'resume' }
                : entry.payload;
            this.send({
                type: 'run.event',
                runId: restoredMsg.runId,
                conversationId: restoredMsg.conversationId,
                event: {
                    type: 'conversation.status',
                    conversationId: restoredMsg.conversationId,
                    status: 'recovering',
                },
            });
            void this.dispatch(restoredMsg, { persist: false }).catch((error) => {
                log.warn('[executor] failed to restore pending dispatch', {
                    runId: restoredMsg.runId,
                    hostKey: restoredMsg.hostKey,
                    error: String(error?.message ?? error),
                });
                removeDispatch(this.db, restoredMsg.runId);
            });
        }
    }
    async cancelRun(runId) {
        const runtimeKey = this.runToHost.get(runId);
        if (!runtimeKey)
            return false;
        const host = this.hosts.get(runtimeKey);
        if (!host)
            return false;
        return host.cancelRun(runId);
    }
    async handlePermissionResponse(requestId, decision) {
        for (const host of this.hosts.values()) {
            const handled = await host.handlePermissionResponse(requestId, decision);
            if (handled)
                return true;
        }
        return false;
    }
    resetWorkspace(workspaceRoot) {
        const resolvedRoot = path.resolve(workspaceRoot);
        for (const [hostKey, host] of this.hosts.entries()) {
            if (path.resolve(host.getWorkspaceRoot()) !== resolvedRoot)
                continue;
            const currentRunId = host.getCurrentRunId();
            if (currentRunId) {
                this.runToHost.delete(currentRunId);
                removeDispatch(this.db, currentRunId);
            }
            host.close();
            this.hosts.delete(hostKey);
        }
        for (const pending of listPendingDispatches(this.db)) {
            const pendingRoot = path.resolve(pending.payload.workspacePath ?? this.config.workspaceRoot);
            if (pendingRoot !== resolvedRoot)
                continue;
            this.runToHost.delete(pending.runId);
            removeDispatch(this.db, pending.runId);
        }
    }
    close() {
        for (const host of this.hosts.values()) {
            host.close();
        }
        this.hosts.clear();
    }
}
