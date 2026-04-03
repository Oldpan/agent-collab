import type { RunDispatchMsg, NodeToCore } from '@agent-collab/protocol';
import {
  BindingRuntime,
  createRun,
  finishRun,
  getUiMode,
  log,
  type Db,
  type ToolKind,
  type ToolAuth,
  type UiMode,
  type McpServerEntry,
  type WorkspaceLockManager,
} from '@agent-collab/runtime-acp';
import type { AgentNodeConfig } from './config.js';
import { NodeSink } from './nodeSink.js';

type SendFn = (msg: NodeToCore) => void;

export type HostState = 'idle' | 'active' | 'failed';

type PendingDispatch = {
  msg: RunDispatchMsg;
  resolve: () => void;
  reject: (error: Error) => void;
};

type RunLifecycleHooks = {
  onRunStart?: (msg: RunDispatchMsg) => void;
  onAwaitingApproval?: (msg: RunDispatchMsg) => void;
  onRunFinish?: (msg: RunDispatchMsg) => void;
};

export class AgentHost {
  readonly hostKey: string;
  readonly sessionKey: string;
  private readonly workspaceRoot: string;
  private readonly runtime: BindingRuntime;
  private readonly db: Db;
  private readonly send: SendFn;
  private readonly hooks: RunLifecycleHooks;
  private state: HostState = 'idle';
  private readonly inbox: PendingDispatch[] = [];
  private processing = false;
  private currentRunId: string | null = null;
  private lastWakeAt: number | null = null;
  private lastSleepAt: number | null = Date.now();
  private lastError: string | null = null;

  constructor(params: {
    hostKey: string;
    sessionKey: string;
    bindingKey: string;
    db: Db;
    config: AgentNodeConfig;
    toolAuth: ToolAuth;
    workspaceRoot: string;
    agentCommand: string;
    agentArgs: string[];
    env?: Record<string, string>;
    disabledToolKinds?: ToolKind[];
    channelBridgeMcpEntry?: McpServerEntry;
    workspaceLockManager?: WorkspaceLockManager;
    send: SendFn;
    hooks?: RunLifecycleHooks;
  }) {
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
      workspaceLockManager: params.workspaceLockManager,
    });
  }

  getState(): HostState {
    return this.state;
  }

  getCurrentRunId(): string | null {
    return this.currentRunId;
  }

  getLastWakeAt(): number | null {
    return this.lastWakeAt;
  }

  getLastSleepAt(): number | null {
    return this.lastSleepAt;
  }

  getInboxSize(): number {
    return this.inbox.length;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  hasPendingApproval(): boolean {
    return this.runtime.hasPendingPermission();
  }

  isIdleExpired(now: number, idleTimeoutMs: number): boolean {
    if (this.state !== 'idle') return false;
    if (this.currentRunId) return false;
    if (this.inbox.length > 0) return false;
    if (this.hasPendingApproval()) return false;
    if (!this.lastSleepAt) return false;
    return now - this.lastSleepAt >= idleTimeoutMs;
  }

  async dispatch(msg: RunDispatchMsg): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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

  private async processInbox(): Promise<void> {
    if (this.processing || this.state === 'failed') return;
    this.processing = true;

    try {
      while (this.inbox.length > 0) {
        const pending = this.inbox.shift()!;

        try {
          await this.runDispatch(pending.msg);
          pending.resolve();
        } catch (error: any) {
          const err = error instanceof Error ? error : new Error(String(error));
          pending.reject(err);

          if (this.getState() === 'failed') {
            this.failPendingInbox(err);
            break;
          }
        }
      }
    } finally {
      this.processing = false;
      if (this.getState() !== 'failed' && !this.currentRunId) {
        this.state = 'idle';
        this.lastSleepAt = Date.now();
      }
    }
  }

  private async runDispatch(msg: RunDispatchMsg): Promise<void> {
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
      .get(runId) as { runId: string } | undefined;
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
      const uiMode: UiMode = getUiMode(this.db, `node:${conversationId}:-:node_user`) ?? 'summary';
      const result = await this.runtime.prompt({
        runId,
        promptText: prompt,
        sink,
        uiMode,
        systemPromptText: msg.systemPromptText,
        contextText: msg.contextText,
        actorUserId: 'node_user',
        onPrepared: async (prepared) => {
          this.send({
            type: 'run.debug.snapshot',
            runId,
            conversationId,
            sessionKey: this.sessionKey,
            acpSessionId: prepared.sessionId,
            isFreshSession: prepared.isFreshSession,
            isExact: prepared.isFreshSession || Boolean(prepared.effectiveSystemPromptText),
            effectiveSystemPromptText: prepared.effectiveSystemPromptText,
            effectiveContextText: prepared.effectiveContextText,
          });
        },
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
    } catch (error: any) {
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
    } finally {
      this.hooks.onRunFinish?.(msg);
      this.currentRunId = null;
      if (this.state !== 'failed') {
        this.state = 'idle';
        this.lastSleepAt = Date.now();
      }
    }
  }

  private failPendingInbox(cause: Error): void {
    while (this.inbox.length > 0) {
      const pending = this.inbox.shift()!;
      this.send({
        type: 'run.end',
        runId: pending.msg.runId,
        conversationId: pending.msg.conversationId,
        error: cause.message,
      });
      pending.reject(cause);
    }
  }

  async cancelRun(runId: string): Promise<boolean> {
    if (this.currentRunId !== runId) return false;
    return this.runtime.cancelCurrentRun(runId);
  }

  async handlePermissionResponse(
    requestId: string,
    decision: 'allow' | 'deny',
  ): Promise<boolean> {
    return this.runtime.respondToPermission(requestId, decision);
  }

  close(): void {
    this.failPendingInbox(new Error(`Host ${this.hostKey} closed`));
    this.runtime.close();
  }
}
