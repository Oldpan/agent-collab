import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { log } from '../logging.js';
import type { Db } from '../db/db.js';
import type { ToolAuth, ToolKind } from '../gateway/toolAuth.js';
import { WorkspaceLockManager, type WorkspaceLockLease } from '../runtime/workspaceLockManager.js';
import { resolveWorkspacePath } from '../tools/workspace.js';
import {
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './jsonrpc.js';
import { spawnAcpAgent, type StdioProcess } from './stdio.js';
import type {
  FsReadTextFileParams,
  FsReadTextFileResult,
  FsWriteTextFileParams,
  InitializeParams,
  InitializeResult,
  NewSessionParams,
  NewSessionResult,
  PromptParams,
  PromptResult,
  RequestPermissionParams,
  RequestPermissionResult,
  TerminalCreateParams,
  TerminalCreateResult,
  TerminalKillParams,
  TerminalOutputParams,
  TerminalOutputResult,
  TerminalReleaseParams,
  TerminalWaitForExitParams,
} from './types.js';

export type AcpRun = {
  runId: string;
  sessionKey: string;
  createdAtMs: number;
};

export type PermissionRequest = {
  requestId: JsonRpcId;
  sessionKey: string;
  sessionId: string;
  params: RequestPermissionParams;
  createdAtMs: number;
};

export type PermissionDecision =
  | { kind: 'selected'; optionId: string }
  | { kind: 'cancelled' };

export type ClientToolEvent = {
  phase: 'start' | 'end' | 'error';
  method: string;
  params: unknown;
  result?: unknown;
  error?: string;
};

export type AcpClientEvents = {
  onSessionUpdate?: (
    run: AcpRun,
    sessionId: string,
    update: any,
    eventSeq: number,
  ) => void;
  onPermissionRequest?: (req: PermissionRequest) => void;
  onClientTool?: (run: AcpRun, event: ClientToolEvent) => void;
  onTaskUpdate?: (run: AcpRun, task: { title: string; detail?: string; silent?: boolean }) => void;
  onAgentStderr?: (line: string) => void;
};

type PendingRequest = {
  method: string;
  resolve: (res: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
};

const ACP_BOOTSTRAP_TIMEOUT_MS = 60_000;

export class AcpClient {
  private readonly db: Db;
  private readonly workspaceRoot: string;
  private readonly agentCommand: string;
  private readonly agentArgs: string[];
  private readonly toolAuth: ToolAuth | null;
  private readonly defaultAllowTools: boolean;
  private readonly disabledToolKinds: ReadonlySet<ToolKind>;
  private readonly workspaceLockManager: WorkspaceLockManager;

  private readonly rpc: StdioProcess;
  private nextId = 1;

  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  // run-scoped state
  private currentRun: AcpRun | null = null;
  private readonly runSeq = new Map<string, number>();
  private readonly pendingLocalPermissions = new Map<
    JsonRpcId,
    {
      resolve: (decision: PermissionDecision) => void;
      reject: (error: Error) => void;
    }
  >();

  private readonly events: AcpClientEvents;

  constructor(params: {
    db: Db;
    workspaceRoot: string;
    agentCommand: string;
    agentArgs: string[];
    toolAuth?: ToolAuth;
    defaultAllowTools?: boolean;
    disabledToolKinds?: ToolKind[];
    events?: AcpClientEvents;
    rpc?: StdioProcess;
    env?: Record<string, string>;
    workspaceLockManager?: WorkspaceLockManager;
  }) {
    this.db = params.db;
    this.workspaceRoot = params.workspaceRoot;
    this.agentCommand = params.agentCommand;
    this.agentArgs = params.agentArgs;
    this.toolAuth = params.toolAuth ?? null;
    this.defaultAllowTools = params.defaultAllowTools ?? false;
    this.disabledToolKinds = new Set(params.disabledToolKinds ?? []);
    this.events = params.events ?? {};
    this.workspaceLockManager = params.workspaceLockManager ?? new WorkspaceLockManager();

    this.rpc =
      params.rpc ?? spawnAcpAgent(this.agentCommand, this.agentArgs, params.env, this.workspaceRoot);
    this.rpc.onMessage((m) => this.handleMessage(m));
    this.rpc.onStderr((line) => this.events.onAgentStderr?.(line));
    this.rpc.onExit?.((info) => {
      this.rejectAllPending(
        this.makeTransportError(info.error
          ? `ACP agent exited: ${info.error}`
          : 'ACP agent exited (code=' +
            String(info.code) +
            ', signal=' +
            String(info.signal) +
            ')'),
      );
      this.rejectAllLocalPermissions(
        this.makeTransportError(
          info.error
            ? `ACP agent exited while waiting for permission response: ${info.error}`
            : 'ACP agent exited while waiting for permission response',
        ),
      );
    });
  }

  close(): void {
    this.rejectAllPending(this.makeTransportError('ACP client closed'));
    this.rejectAllLocalPermissions(this.makeTransportError('ACP client closed'));
    for (const [terminalId, state] of this.terminals.entries()) {
      state.releaseLock?.();
      state.releaseLock = undefined;
      this.killChild(state.child);
      this.terminals.delete(terminalId);
    }
    this.rpc.kill();
  }

  private initPromise: Promise<InitializeResult> | null = null;

  async initialize(): Promise<InitializeResult> {
    if (this.initPromise) return this.initPromise;

    const params: InitializeParams = {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: {
        name: 'cli-gateway',
        title: 'cli-gateway',
        version: '0.1.0',
      },
    };

    this.initPromise = this.request<InitializeParams, InitializeResult>(
      'initialize',
      params,
      ACP_BOOTSTRAP_TIMEOUT_MS,
    );

    return this.initPromise;
  }

  async newSession(params: NewSessionParams): Promise<NewSessionResult> {
    return this.request<NewSessionParams, NewSessionResult>(
      'session/new',
      params,
      ACP_BOOTSTRAP_TIMEOUT_MS,
    );
  }

  async prompt(
    run: AcpRun,
    params: PromptParams,
    timeoutMs?: number,
  ): Promise<PromptResult> {
    this.currentRun = run;
    this.runSeq.set(run.runId, this.getExistingRunSeq(run.runId));

    try {
      const result = await this.request<PromptParams, PromptResult>(
        'session/prompt',
        params,
        timeoutMs,
      );
      return result;
    } finally {
      this.currentRun = null;
      this.runSeq.delete(run.runId);
    }
  }

  notifyCancel(sessionId: string): void {
    this.rpc.write({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId },
    });
  }

  async respondPermission(
    req: PermissionRequest,
    decision: PermissionDecision,
  ): Promise<void> {
    const local = this.pendingLocalPermissions.get(req.requestId);
    if (local) {
      this.pendingLocalPermissions.delete(req.requestId);
      local.resolve(decision);
      return;
    }

    const outcome: RequestPermissionResult['outcome'] =
      decision.kind === 'cancelled'
        ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId: decision.optionId };

    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: req.requestId,
      result: { outcome },
    };

    this.rpc.write(msg);
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        pending.resolve(message);
      }
      return;
    }

    if (isNotification(message)) {
      if (message.method === 'session/update') {
        const params = message.params as any;
        const sessionId = params?.sessionId as string | undefined;
        const update = params?.update;
        if (this.currentRun && sessionId) {
          const eventSeq = this.appendEvent(
            this.currentRun.runId,
            'session/update',
            params,
          );
          void this.events.onSessionUpdate?.(
            this.currentRun,
            sessionId,
            update,
            eventSeq,
          );
        }
      }
      return;
    }

    if (isRequest(message)) {
      // Agent -> Client requests
      void this.handleAgentRequest(message);
      return;
    }
  }

  private async handleAgentRequest(req: JsonRpcRequest): Promise<void> {
    const run = this.currentRun;

    const emitTool = (event: ClientToolEvent) => {
      if (!run) return;
      this.events.onClientTool?.(run, event);
    };

    try {
      switch (req.method) {
        case 'session/request_permission': {
          const params = req.params as RequestPermissionParams;
          const sessionKey = this.currentRun?.sessionKey ?? 'unknown';
          const pr: PermissionRequest = {
            requestId: req.id,
            sessionKey,
            sessionId: params.sessionId,
            params,
            createdAtMs: Date.now(),
          };
          this.events.onPermissionRequest?.(pr);
          return;
        }

        case 'fs/read_text_file': {
          const params = req.params as FsReadTextFileParams;
          emitTool({ phase: 'start', method: req.method, params });

          await this.ensureAuthorized({
            kind: 'read',
            method: req.method,
            params,
          });
          const resolvedPath = resolveWorkspacePath(
            this.workspaceRoot,
            params.path,
          );
          const content = readTextFileWithLimit(
            resolvedPath,
            params.line,
            params.limit,
          );
          this.respond(req.id, { content } satisfies FsReadTextFileResult);

          emitTool({
            phase: 'end',
            method: req.method,
            params,
            result: { bytes: content.length },
          });
          return;
        }

        case 'fs/write_text_file': {
          const params = req.params as FsWriteTextFileParams;
          emitTool({ phase: 'start', method: req.method, params: { path: params.path } });

          await this.ensureAuthorized({
            kind: 'edit',
            method: req.method,
            params,
          });
          const resolvedPath = resolveWorkspacePath(
            this.workspaceRoot,
            params.path,
          );
          const memoryWriteGuard = createMemoryWriteGuard(this.workspaceRoot, resolvedPath);
          const lease = await this.acquireWorkspaceWriteLock(req.method, params);
          try {
            memoryWriteGuard?.assertLatest(lease.waited);
            fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
            fs.writeFileSync(resolvedPath, params.content, 'utf8');
            this.respond(req.id, {});
          } finally {
            lease.release();
          }

          emitTool({
            phase: 'end',
            method: req.method,
            params: { path: params.path },
            result: { bytes: params.content.length },
          });
          return;
        }

        case 'terminal/create': {
          const params = req.params as TerminalCreateParams;
          emitTool({
            phase: 'start',
            method: req.method,
            params: {
              command: params.command,
              args: params.args,
              cwd: params.cwd,
            },
          });

          await this.ensureAuthorized({
            kind: 'execute',
            method: req.method,
            params,
          });
          const lease = await this.acquireWorkspaceWriteLock(req.method, params);
          let terminalId: string | null = null;
          try {
            terminalId = await this.terminalCreate(params, lease);
          } catch (error) {
            lease.release();
            throw error;
          }
          this.respond(req.id, { terminalId } satisfies TerminalCreateResult);

          emitTool({
            phase: 'end',
            method: req.method,
            params: {
              command: params.command,
              args: params.args,
              cwd: params.cwd,
            },
            result: { terminalId },
          });
          return;
        }

        case 'terminal/output': {
          const params = req.params as TerminalOutputParams;
          const out = this.terminalOutput(params);
          this.respond(req.id, out satisfies TerminalOutputResult);
          return;
        }

        case 'terminal/wait_for_exit': {
          const params = req.params as TerminalWaitForExitParams;
          emitTool({
            phase: 'start',
            method: req.method,
            params: { terminalId: params.terminalId },
          });

          const res = await this.terminalWaitForExit(params);
          this.respond(req.id, res);

          emitTool({
            phase: 'end',
            method: req.method,
            params: { terminalId: params.terminalId },
            result: res,
          });
          return;
        }

        case 'terminal/kill': {
          const params = req.params as TerminalKillParams;
          await this.ensureAuthorized({
            kind: 'execute',
            method: req.method,
            params,
          });
          this.terminalKill(params);
          this.respond(req.id, {});
          return;
        }

        case 'terminal/release': {
          const params = req.params as TerminalReleaseParams;
          this.terminalRelease(params);
          this.respond(req.id, {});
          return;
        }

        default: {
          this.respondError(req.id, -32601, `Method not found: ${req.method}`);
        }
      }
    } catch (error: any) {
      log.error('Agent request handler error', req.method, error);
      emitTool({
        phase: 'error',
        method: req.method,
        params: req.params,
        error: String(error?.message ?? error),
      });
      this.respondError(req.id, -32000, String(error?.message ?? error));
    }
  }

  private request<TParams, TResult>(
    method: string,
    params: TParams,
    timeoutMs?: number,
  ): Promise<TResult> {
    const id = this.nextId++;

    return new Promise<TResult>((resolve, reject) => {
      const timer =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => {
              this.rejectPendingRequest(
                id,
                this.makeTransportError(
                  'ACP request timed out: ' + method + ' (' + String(timeoutMs) + 'ms)',
                ),
              );
            }, timeoutMs)
          : null;

      this.pending.set(id, {
        method,
        resolve: (res) => {
          if ('error' in res) {
            const code =
              typeof res.error?.code === 'number'
                ? ' (code ' + String(res.error.code) + ')'
                : '';
            const data =
              res.error?.data !== undefined
                ? '; data=' + formatJsonRpcErrorData(res.error.data)
                : '';
            reject(new Error(String(res.error.message) + code + data));
            return;
          }

          resolve(res.result as TResult);
        },
        reject,
        timer,
      });

      try {
        const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
        this.rpc.write(req);
      } catch (error: any) {
        this.rejectPendingRequest(
          id,
          this.makeTransportError(String(error?.message ?? error)),
        );
      }
    });
  }

  private rejectPendingRequest(id: JsonRpcId, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    pending.reject(error);
  }

  private rejectAllPending(error: Error): void {
    for (const id of this.pending.keys()) {
      const detail = this.makeTransportError(
        error.message + '; pending_id=' + String(id),
      );
      this.rejectPendingRequest(id, detail);
    }
  }

  private rejectAllLocalPermissions(error: Error): void {
    for (const [id, pending] of this.pendingLocalPermissions.entries()) {
      this.pendingLocalPermissions.delete(id);
      const detail = this.makeTransportError(
        error.message + '; permission_request_id=' + String(id),
      );
      pending.reject(detail);
    }
  }

  private makeTransportError(message: string): Error {
    const err = new Error(message);
    err.name = 'AcpTransportError';
    return err;
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.rpc.write({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    this.rpc.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private appendEvent(runId: string, method: string, payload: unknown): number {
    const prev = this.runSeq.get(runId) ?? 0;
    const seq = prev + 1;
    this.runSeq.set(runId, seq);

    this.db
      .prepare(
        'INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)',
      )
      .run(runId, seq, method, JSON.stringify(payload), Date.now());

    return seq;
  }

  private getExistingRunSeq(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) as maxSeq FROM events WHERE run_id = ?')
      .get(runId) as { maxSeq?: number } | undefined;
    return typeof row?.maxSeq === 'number' ? row.maxSeq : 0;
  }

  private async ensureAuthorized(params: {
    kind: ToolKind;
    method: string;
    params: unknown;
  }): Promise<void> {
    const { kind } = params;
    const sessionKey = this.currentRun?.sessionKey;

    // Tool calls should only occur within a prompt turn.
    if (!sessionKey) {
      throw new Error(
        `Tool call not allowed outside prompt turn (kind=${kind})`,
      );
    }

    if (this.disabledToolKinds.has(kind)) {
      throw new Error(`Tool call denied by agent settings: ${kind} disabled.`);
    }

    if (this.defaultAllowTools) {
      return;
    }

    // If auth is not wired, default deny (secure by default).
    if (!this.toolAuth) {
      throw new Error(`Tool call denied (no ToolAuth): ${kind}`);
    }

    if (
      this.toolAuth.consume(sessionKey, kind, {
        method: params.method,
        params: params.params,
        workspaceRoot: this.workspaceRoot,
      })
    ) {
      return;
    }

    if (!this.events.onPermissionRequest) {
      throw new Error(
        `Tool call denied by policy: ${kind}. Approve in permission UI (Allow) or use /allow <n>.`,
      );
    }

    const req = buildLocalPermissionRequest({
      sessionKey,
      kind,
      method: params.method,
      params: params.params,
    });

    const decision = await new Promise<PermissionDecision>((resolve, reject) => {
      this.pendingLocalPermissions.set(req.requestId, { resolve, reject });

      try {
        this.events.onPermissionRequest?.(req);
      } catch (error: any) {
        this.pendingLocalPermissions.delete(req.requestId);
        reject(new Error(String(error?.message ?? error)));
      }
    });

    if (decision.kind === 'cancelled') {
      throw new Error(
        `Tool call denied by policy: ${kind}. Approve in permission UI (Allow) or use /allow <n>.`,
      );
    }

    if (
      this.toolAuth.consume(sessionKey, kind, {
        method: params.method,
        params: params.params,
        workspaceRoot: this.workspaceRoot,
      })
    ) {
      return;
    }

    throw new Error(
      `Tool call denied by policy: ${kind}. Approve in permission UI (Allow) or use /allow <n>.`,
    );
  }

  // terminal management (minimal)

  private readonly terminals = new Map<
    string,
    {
      child: ReturnType<typeof spawn>;
      output: string;
      truncated: boolean;
      byteLimit: number;
      releaseLock?: () => void;
    }
  >();

  private async withWorkspaceWriteLock<T>(
    method: string,
    params: unknown,
    action: () => Promise<T> | T,
  ): Promise<T> {
    const lease = await this.acquireWorkspaceWriteLock(method, params);
    try {
      return await action();
    } finally {
      lease.release();
    }
  }

  private async acquireWorkspaceWriteLock(
    method: string,
    params: unknown,
  ): Promise<WorkspaceLockLease> {
    const run = this.currentRun;
    return this.workspaceLockManager.acquire(this.workspaceRoot, {
      onWaitStart: () => {
        if (!run) return;
        this.events.onTaskUpdate?.(run, {
          title: 'waiting for workspace lock',
          detail: buildWorkspaceLockWaitDetail(method, params),
          silent: true,
        });
      },
    });
  }

  private async terminalCreate(
    params: TerminalCreateParams,
    lease: WorkspaceLockLease,
  ): Promise<string> {
    const terminalId = randomUUID();
    const cwd = params.cwd
      ? resolveWorkspacePath(this.workspaceRoot, params.cwd)
      : this.workspaceRoot;

    const byteLimit = params.outputByteLimit ?? 256_000;

    // Claude Code ACP may pass shell commands with operators (&&, |, etc.) as a single string.
    // Wrap in sh -c so the shell can interpret them correctly.
    const hasShellOperators = /[&|;<>$`\\!]/.test(params.command) || (params.args ?? []).length === 0;
    const [spawnCmd, spawnArgs] = hasShellOperators
      ? ['sh', ['-c', params.command, ...(params.args ?? [])]]
      : [params.command, params.args ?? []];

    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      env: {
        ...process.env,
        ...(params.env ?? []).reduce<Record<string, string>>((acc, kv) => {
          acc[kv.name] = kv.value;
          return acc;
        }, {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const state: {
      child: ReturnType<typeof spawn>;
      output: string;
      truncated: boolean;
      byteLimit: number;
      releaseLock?: () => void;
    } = {
      child,
      output: '',
      truncated: false,
      byteLimit,
      releaseLock: () => lease.release(),
    };
    this.terminals.set(terminalId, state);

    const onData = (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      state.output += chunk;
      if (state.output.length > state.byteLimit) {
        state.output = state.output.slice(
          state.output.length - state.byteLimit,
        );
        state.truncated = true;
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', () => {
      state.releaseLock?.();
      state.releaseLock = undefined;
    });

    return terminalId;
  }

  private terminalOutput(params: TerminalOutputParams): TerminalOutputResult {
    const state = this.terminals.get(params.terminalId);
    if (!state) throw new Error(`Unknown terminalId: ${params.terminalId}`);

    const exitStatus =
      state.child.exitCode !== null || state.child.signalCode !== null
        ? { exitCode: state.child.exitCode, signal: state.child.signalCode }
        : null;

    return {
      output: state.output,
      truncated: state.truncated,
      exitStatus,
    };
  }

  private terminalWaitForExit(
    params: TerminalWaitForExitParams,
  ): Promise<{ exitCode?: number | null; signal?: string | null }> {
    const state = this.terminals.get(params.terminalId);
    if (!state) throw new Error(`Unknown terminalId: ${params.terminalId}`);

    return new Promise((resolve) => {
      state.child.once('exit', (code, signal) => {
        resolve({ exitCode: code, signal });
      });
    });
  }

  private terminalKill(params: TerminalKillParams): void {
    const state = this.terminals.get(params.terminalId);
    if (!state) throw new Error(`Unknown terminalId: ${params.terminalId}`);
    this.killChild(state.child);
  }

  private terminalRelease(params: TerminalReleaseParams): void {
    const state = this.terminals.get(params.terminalId);
    if (!state) return;
    this.terminals.delete(params.terminalId);
  }

  private killChild(child: ReturnType<typeof spawn>): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL');
  }
}

function buildWorkspaceLockWaitDetail(method: string, params: unknown): string {
  if (method === 'fs/write_text_file') {
    const pathValue = typeof (params as { path?: unknown })?.path === 'string'
      ? (params as { path: string }).path
      : 'file';
    return `Waiting to write ${pathValue}.`;
  }

  if (method === 'terminal/create') {
    const command = typeof (params as { command?: unknown })?.command === 'string'
      ? (params as { command: string }).command
      : 'command';
    return `Waiting to execute ${command}.`;
  }

  return 'Waiting for another run to finish mutating this workspace.';
}

function formatJsonRpcErrorData(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildLocalPermissionRequest(params: {
  sessionKey: string;
  kind: ToolKind;
  method: string;
  params: unknown;
}): PermissionRequest {
  const sessionId =
    typeof (params.params as { sessionId?: unknown } | null)?.sessionId ===
    'string'
      ? String((params.params as { sessionId?: string }).sessionId)
      : 'unknown';

  return {
    requestId: `localperm-${randomUUID()}`,
    sessionKey: params.sessionKey,
    sessionId,
    createdAtMs: Date.now(),
    params: {
      sessionId,
      toolCall: {
        title: buildLocalToolTitle(params.method, params.params),
        kind: params.kind,
        name: params.method,
        arguments: buildLocalPermissionArgs(params.params),
      },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        {
          optionId: 'allow_always',
          name: 'Always allow',
          kind: 'allow_always',
        },
        { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
        {
          optionId: 'reject_always',
          name: 'Always reject',
          kind: 'reject_always',
        },
      ],
    },
  };
}

function buildLocalToolTitle(method: string, rawParams: unknown): string {
  const params = (rawParams ?? {}) as Record<string, unknown>;

  if (method === 'fs/read_text_file') {
    const target = stringOrFallback(params.path, '<path>');
    return truncateInline(`read: ${target}`, 180);
  }

  if (method === 'fs/write_text_file') {
    const target = stringOrFallback(params.path, '<path>');
    return truncateInline(`edit: ${target}`, 180);
  }

  if (method === 'terminal/create') {
    const command = stringOrFallback(params.command, '<command>');
    const args = Array.isArray(params.args)
      ? params.args
          .filter((item): item is string => typeof item === 'string')
          .join(' ')
      : '';
    const full = args ? `${command} ${args}` : command;
    return truncateInline(`run: ${full}`, 180);
  }

  if (method === 'terminal/kill') {
    const terminalId = stringOrFallback(params.terminalId, '<terminal_id>');
    return truncateInline(`run: kill terminal ${terminalId}`, 180);
  }

  return truncateInline(method, 180);
}

function buildLocalPermissionArgs(rawParams: unknown): unknown {
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return rawParams;
  }

  const source = rawParams as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'sessionId') continue;
    args[key] = sanitizePermissionArgValue(key, value);
  }

  return args;
}

function sanitizePermissionArgValue(key: string, value: unknown): unknown {
  if (key === 'content' && typeof value === 'string') {
    return value.length > 240
      ? `${value.slice(0, 237)}... (${value.length} chars)`
      : value;
  }

  if (key === 'env' && Array.isArray(value)) {
    return value.map((item) => {
      if (!item || typeof item !== 'object') return '<env>';
      const name = (item as { name?: unknown }).name;
      return typeof name === 'string' && name.trim() ? name.trim() : '<env>';
    });
  }

  return value;
}

function truncateInline(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 3) + '...';
}

function stringOrFallback(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

type FileVersionSnapshot = {
  exists: boolean;
  size: number | null;
  mtimeMs: number | null;
};

type MemoryWriteGuard = {
  assertLatest: (waited: boolean) => void;
};

function createMemoryWriteGuard(
  workspaceRoot: string,
  resolvedPath: string,
): MemoryWriteGuard | null {
  const memoryPath = path.resolve(workspaceRoot, 'MEMORY.md');
  if (path.resolve(resolvedPath) !== memoryPath) return null;

  const before = snapshotFileVersion(memoryPath);
  return {
    assertLatest(waited: boolean) {
      if (!waited) return;
      const after = snapshotFileVersion(memoryPath);
      if (
        before.exists !== after.exists ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new Error(
          'MEMORY.md changed while waiting for workspace lock. Read the latest MEMORY.md and retry your update.',
        );
      }
    },
  };
}

function snapshotFileVersion(filePath: string): FileVersionSnapshot {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat) {
    return { exists: false, size: null, mtimeMs: null };
  }
  return {
    exists: true,
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
  };
}

function readTextFileWithLimit(
  filePath: string,
  line?: number,
  limit?: number,
): string {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!line || !limit) return content;

  const lines = content.split(/\r?\n/);
  const startIndex = Math.max(0, line - 1);
  return lines.slice(startIndex, startIndex + limit).join('\n');
}
