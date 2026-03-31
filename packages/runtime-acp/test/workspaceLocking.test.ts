import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  BindingRuntime,
  ToolAuth,
  WorkspaceLockManager,
  createSession,
  migrate,
  openDb,
  type Db,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type StdioProcess,
  type UiEvent,
} from '../src/index.js';

const openDbs: Db[] = [];
const tempDirs: string[] = [];

class SingleToolRpc implements StdioProcess {
  readonly toolResponses: unknown[] = [];
  readonly toolErrors: unknown[] = [];

  private readonly messageHandlers: Array<(message: JsonRpcMessage) => void> = [];
  private readonly stderrHandlers: Array<(line: string) => void> = [];
  private readonly exitHandlers: Array<
    (info: { code: number | null; signal: NodeJS.Signals | null }) => void
  > = [];
  private activePromptId: JsonRpcRequest['id'] | null = null;

  constructor(
    private readonly toolMethod: string,
    private readonly toolParams: unknown,
  ) {}

  write(message: JsonRpcMessage): void {
    if (!('method' in message) && 'id' in message) {
      if (message.id === 'tool-1') {
        if ('result' in message) this.toolResponses.push(message.result);
        if ('error' in message) this.toolErrors.push(message.error);
        if (this.activePromptId !== null) {
          this.respond(this.activePromptId, { stopReason: 'end_turn' });
          this.activePromptId = null;
        }
      }
      return;
    }

    if ('method' in message && 'id' in message) {
      const req = message as JsonRpcRequest;
      switch (req.method) {
        case 'initialize':
          this.respond(req.id, {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          });
          return;
        case 'session/new':
          this.respond(req.id, { sessionId: `session-${randomUUID()}` });
          return;
        case 'session/prompt':
          this.activePromptId = req.id;
          queueMicrotask(() => {
            this.messageHandlers.forEach((handler) =>
              handler({
                jsonrpc: '2.0',
                id: 'tool-1',
                method: this.toolMethod,
                params: this.toolParams,
              }),
            );
          });
          return;
        default:
          throw new Error(`Unhandled method in fake rpc: ${req.method}`);
      }
    }
  }

  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onStderr(cb: (line: string) => void): void {
    this.stderrHandlers.push(cb);
  }

  onExit(
    cb: (info: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ): void {
    this.exitHandlers.push(cb);
  }

  kill(): void {
    this.exitHandlers.forEach((handler) => handler({ code: 0, signal: null }));
  }

  private respond(id: JsonRpcRequest['id'], result: unknown): void {
    queueMicrotask(() => {
      this.messageHandlers.forEach((handler) =>
        handler({ jsonrpc: '2.0', id, result }),
      );
    });
  }
}

describe('workspace locking', () => {
  afterEach(() => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('fs/write_text_file 应等待已有 workspace 写锁，并发出等待任务更新', async () => {
    const workspaceRoot = createWorkspace();
    const lockManager = new WorkspaceLockManager();
    const manualLease = await lockManager.acquire(workspaceRoot);

    const runtime = createRuntime({
      sessionKey: 'session-write-wait',
      workspaceRoot,
      lockManager,
      rpc: new SingleToolRpc('fs/write_text_file', {
        path: join(workspaceRoot, 'MEMORY.md'),
        content: '# Updated\n',
      }),
    });
    const uiEvents: UiEvent[] = [];

    const promptPromise = runtime.prompt({
      runId: 'run-write-wait',
      promptText: 'write memory',
      sink: {
        sendText: async () => {},
        sendUi: async (event) => {
          uiEvents.push(event);
        },
      },
      uiMode: 'summary',
      actorUserId: 'node_user',
    });

    expect(await raceWithDelay(promptPromise, 40)).toBe('pending');
    expect(
      uiEvents.some(
        (event) =>
          event.kind === 'task' &&
          event.title === 'waiting for workspace lock' &&
          event.silent === true,
      ),
    ).toBe(true);

    manualLease.release();
    await promptPromise;

    expect(fs.readFileSync(join(workspaceRoot, 'MEMORY.md'), 'utf8')).toContain('# Updated');
    runtime.close();
  });

  it('fs/read_text_file 不应被 workspace 写锁阻塞', async () => {
    const workspaceRoot = createWorkspace();
    const lockManager = new WorkspaceLockManager();
    const manualLease = await lockManager.acquire(workspaceRoot);

    const runtime = createRuntime({
      sessionKey: 'session-read-free',
      workspaceRoot,
      lockManager,
      rpc: new SingleToolRpc('fs/read_text_file', {
        path: join(workspaceRoot, 'MEMORY.md'),
      }),
    });

    const promptPromise = runtime.prompt({
      runId: 'run-read-free',
      promptText: 'read memory',
      sink: { sendText: async () => {} },
      uiMode: 'summary',
      actorUserId: 'node_user',
    });

    expect(await raceWithDelay(promptPromise, 80)).toBe('resolved');

    manualLease.release();
    runtime.close();
  });

  it('terminal/create 应持有 workspace 锁直到子进程退出', async () => {
    const workspaceRoot = createWorkspace();
    const lockManager = new WorkspaceLockManager();

    const runtimeA = createRuntime({
      sessionKey: 'session-terminal-lock-a',
      workspaceRoot,
      lockManager,
      rpc: new SingleToolRpc('terminal/create', {
        command: 'sleep',
        args: ['0.15'],
      }),
    });
    const runtimeB = createRuntime({
      sessionKey: 'session-terminal-lock-b',
      workspaceRoot,
      lockManager,
      rpc: new SingleToolRpc('fs/write_text_file', {
        path: join(workspaceRoot, 'notes/channels/default.md'),
        content: '# default\n',
      }),
    });

    await runtimeA.prompt({
      runId: 'run-terminal-lock-a',
      promptText: 'start command',
      sink: { sendText: async () => {} },
      uiMode: 'summary',
      actorUserId: 'node_user',
    });

    const promptB = runtimeB.prompt({
      runId: 'run-terminal-lock-b',
      promptText: 'write after command',
      sink: { sendText: async () => {} },
      uiMode: 'summary',
      actorUserId: 'node_user',
    });

    expect(await raceWithDelay(promptB, 40)).toBe('pending');
    expect(await raceWithDelay(promptB, 800)).toBe('resolved');
    expect(fs.readFileSync(join(workspaceRoot, 'notes/channels/default.md'), 'utf8')).toContain('# default');

    runtimeA.close();
    runtimeB.close();
  });
});

function createWorkspace(): string {
  const workspaceRoot = fs.mkdtempSync(join(tmpdir(), 'runtime-acp-lock-'));
  tempDirs.push(workspaceRoot);
  fs.mkdirSync(join(workspaceRoot, 'notes', 'channels'), { recursive: true });
  fs.writeFileSync(join(workspaceRoot, 'MEMORY.md'), '# Memory\n', 'utf8');
  return workspaceRoot;
}

function createRuntime(params: {
  sessionKey: string;
  workspaceRoot: string;
  lockManager: WorkspaceLockManager;
  rpc: StdioProcess;
}): BindingRuntime {
  const dbPath = join(tmpdir(), `runtime-acp-lock-${randomUUID()}.db`);
  const db = openDb(dbPath);
  migrate(db);
  openDbs.push(db);

  createSession(db, {
    sessionKey: params.sessionKey,
    agentCommand: 'codex',
    agentArgs: [],
    cwd: params.workspaceRoot,
    loadSupported: true,
  });

  return new BindingRuntime({
    db,
    config: {
      acpAgentCommand: 'codex',
      acpAgentArgs: [],
      uiJsonMaxChars: 3_000,
    },
    toolAuth: new ToolAuth(db),
    sessionKey: params.sessionKey,
    bindingKey: `node:${params.sessionKey}:-:node_user`,
    workspaceRoot: params.workspaceRoot,
    acpRpc: params.rpc,
    workspaceLockManager: params.lockManager,
  });
}

async function raceWithDelay<T>(
  promise: Promise<T>,
  delayMs: number,
): Promise<'resolved' | 'pending'> {
  return Promise.race([
    promise.then(() => 'resolved' as const),
    delay(delayMs).then(() => 'pending' as const),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
