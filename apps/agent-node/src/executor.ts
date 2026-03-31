import { createRequire } from 'node:module';
import path from 'node:path';
import {
  ToolAuth,
  createSession,
  getSession,
  upsertBinding,
  log,
  type McpServerEntry,
} from '@agent-collab/runtime-acp';
import type { Db } from '@agent-collab/runtime-acp';
import { getRuntimeDriver, type RunDispatchMsg, type NodeToCore } from '@agent-collab/protocol';
import type { AgentNodeConfig } from './config.js';
import { AgentHost } from './agentHost.js';
import { ensureIsolatedClaudeConfig } from './claudeConfig.js';
import { ensureNativeSkillMounts } from './nativeSkillMounts.js';
import {
  enqueueDispatch,
  listPendingDispatches,
  removeDispatch,
  updateDispatchState,
  type PersistedDispatch,
} from './dispatchQueueStore.js';

type SendFn = (msg: NodeToCore) => void;
type HostInstance = Pick<
  AgentHost,
  'dispatch' | 'cancelRun' | 'handlePermissionResponse' | 'close' | 'getState' | 'getCurrentRunId' | 'getLastError' | 'getWorkspaceRoot' | 'getLastSleepAt' | 'hasPendingApproval' | 'isIdleExpired'
>;
type CreateHostFn = (params: ConstructorParameters<typeof AgentHost>[0]) => HostInstance;

export class Executor {
  private readonly db: Db;
  private readonly config: AgentNodeConfig;
  private readonly toolAuth: ToolAuth;
  private readonly hosts = new Map<string, HostInstance>();
  private readonly runToHost = new Map<string, string>();
  private readonly send: SendFn;
  private readonly createHost: CreateHostFn;
  private readonly hostSweepTimer: NodeJS.Timeout;

  constructor(params: { db: Db; config: AgentNodeConfig; send: SendFn; createHost?: CreateHostFn }) {
    this.db = params.db;
    this.config = params.config;
    this.toolAuth = new ToolAuth(params.db);
    this.send = params.send;
    this.createHost = params.createHost ?? ((hostParams) => new AgentHost(hostParams));
    this.hostSweepTimer = setInterval(() => {
      this.reapIdleHosts();
    }, this.config.hostSweepIntervalMs);
    this.hostSweepTimer.unref?.();
  }

  async dispatch(msg: RunDispatchMsg, options?: { persist?: boolean }): Promise<void> {
    const shouldPersist = options?.persist !== false;
    const { runId, conversationId, sessionKey, prompt, hostKey } = msg;
    const bindingKey = `node:${conversationId}:-:node_user`;
    const runtimeKey = hostKey || sessionKey;
    const driver = getRuntimeDriver(msg.agentType);
    const workspaceRoot = msg.workspacePath ?? this.config.workspaceRoot;
    const runtimeEnv = { ...(msg.envVars ?? {}) };

    if (msg.agentType === 'claude_acp') {
      const claudeConfigDir = ensureIsolatedClaudeConfig(workspaceRoot);
      runtimeEnv.CLAUDE_CONFIG_DIR = claudeConfigDir;
      ensureNativeSkillMounts({
        agentType: msg.agentType,
        workspaceRoot,
        skillRoots: msg.skillRoots,
      });
    } else {
      ensureNativeSkillMounts({
        agentType: msg.agentType,
        workspaceRoot,
        skillRoots: msg.skillRoots,
      });
    }

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
        cwd: workspaceRoot,
        loadSupported: false,
      });
      log.debug('[executor] created local session', { sessionKey, conversationId });
    }

    // Ensure binding exists
    upsertBinding(
      this.db,
      { platform: 'node', chatId: conversationId, threadId: null, userId: 'node_user' },
      sessionKey,
    );

    let channelBridgeMcpEntry: McpServerEntry | undefined;
    if (msg.channelBridgeConfig) {
      const { agentId, conversationId, serverUrl, authToken } = msg.channelBridgeConfig;
      try {
        const req = createRequire(import.meta.url);
        const binPath = req.resolve('@agent-collab/channel-bridge');
        channelBridgeMcpEntry = {
          name: 'chat',
          command: 'node',
          args: [
            binPath,
            '--agent-id',
            agentId,
            '--conversation-id',
            conversationId,
            '--server-url',
            serverUrl,
          ],
          env: authToken ? [{ name: 'CHANNEL_BRIDGE_AUTH_TOKEN', value: authToken }] : [],
        };
      } catch {
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
        workspaceRoot,
        agentCommand: driver.command,
        agentArgs: driver.args,
        env: runtimeEnv,
        disabledToolKinds: msg.disabledToolKinds,
        channelBridgeMcpEntry,
        send: this.send,
        hooks: {
          onRunStart: (dispatchMsg) => {
            updateDispatchState(this.db, dispatchMsg.runId, 'running');
          },
          onAwaitingApproval: (dispatchMsg) => {
            updateDispatchState(this.db, dispatchMsg.runId, 'awaiting_approval');
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
    } finally {
      this.runToHost.delete(runId);
      if (host.getState() === 'failed') {
        removeDispatch(this.db, runId);
      }
    }
  }

  resumePendingDispatches(): void {
    const pending = listPendingDispatches(this.db);
    if (pending.length === 0) return;

    log.warn('[executor] restoring pending dispatches after node restart', {
      count: pending.length,
    });

    for (const entry of pending) {
      if (entry.state === 'awaiting_approval') {
        this.failApprovalRecovery(entry);
        continue;
      }

      const existingHost = this.hosts.get(entry.hostKey);
      if (existingHost?.getCurrentRunId() === entry.runId && existingHost.getState() !== 'failed') {
        log.info('[executor] pending dispatch already attached to live host, skipping redispatch', {
          runId: entry.runId,
          hostKey: entry.hostKey,
          state: entry.state,
        });
        this.send({
          type: 'run.event',
          runId: entry.runId,
          conversationId: entry.payload.conversationId,
          event: {
            type: 'conversation.status',
            conversationId: entry.payload.conversationId,
            status: 'recovering',
          },
        });
        continue;
      }

      const restoredMsg: RunDispatchMsg =
        entry.state === 'running'
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
          error: String((error as Error)?.message ?? error),
        });
        removeDispatch(this.db, restoredMsg.runId);
      });
    }
  }

  private failApprovalRecovery(entry: PersistedDispatch): void {
    log.warn('[executor] approval request cannot be restored after reconnect/restart', {
      runId: entry.runId,
      hostKey: entry.hostKey,
    });

    const host = this.hosts.get(entry.hostKey);
    if (host) {
      const currentRunId = host.getCurrentRunId();
      if (currentRunId) {
        this.runToHost.delete(currentRunId);
      }
      host.close();
      this.hosts.delete(entry.hostKey);
    }

    this.runToHost.delete(entry.runId);
    removeDispatch(this.db, entry.runId);
    this.send({
      type: 'run.end',
      runId: entry.runId,
      conversationId: entry.payload.conversationId,
      error: 'Approval request lost during reconnect. Re-run required.',
    });
  }

  private reapIdleHosts(): void {
    const now = Date.now();
    for (const [hostKey, host] of this.hosts.entries()) {
      if (!host.isIdleExpired(now, this.config.hostIdleTimeoutMs)) continue;
      log.info('[executor] reaping idle host', {
        hostKey,
        lastSleepAt: host.getLastSleepAt(),
      });
      host.close();
      this.hosts.delete(hostKey);
    }
  }

  async cancelRun(runId: string): Promise<boolean> {
    const runtimeKey = this.runToHost.get(runId);
    if (!runtimeKey) return false;
    const host = this.hosts.get(runtimeKey);
    if (!host) return false;
    return host.cancelRun(runId);
  }

  async handlePermissionResponse(
    requestId: string,
    decision: 'allow' | 'deny',
  ): Promise<boolean> {
    for (const host of this.hosts.values()) {
      const handled = await host.handlePermissionResponse(requestId, decision);
      if (handled) return true;
    }
    return false;
  }

  closeHost(hostKey: string): void {
    const host = this.hosts.get(hostKey);
    if (!host) return;
    const currentRunId = host.getCurrentRunId();
    if (currentRunId) {
      this.runToHost.delete(currentRunId);
      removeDispatch(this.db, currentRunId);
    }
    host.close();
    this.hosts.delete(hostKey);
  }

  resetWorkspace(workspaceRoot: string): void {
    const resolvedRoot = path.resolve(workspaceRoot);

    for (const [hostKey, host] of this.hosts.entries()) {
      if (path.resolve(host.getWorkspaceRoot()) !== resolvedRoot) continue;
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
      if (pendingRoot !== resolvedRoot) continue;
      this.runToHost.delete(pending.runId);
      removeDispatch(this.db, pending.runId);
    }
  }

  close(): void {
    clearInterval(this.hostSweepTimer);
    for (const host of this.hosts.values()) {
      host.close();
    }
    this.hosts.clear();
  }
}
