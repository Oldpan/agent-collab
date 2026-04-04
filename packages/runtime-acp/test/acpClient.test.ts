import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { createSession, migrate, openDb, type Db, type JsonRpcMessage, type JsonRpcRequest, type StdioProcess } from '../src/index.js';

const { spawnAcpAgentMock } = vi.hoisted(() => ({
  spawnAcpAgentMock: vi.fn(() => ({
    write: vi.fn(),
    onMessage: vi.fn(),
    onStderr: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock('../src/acp/stdio.js', () => ({
  spawnAcpAgent: spawnAcpAgentMock,
}));

/* eslint-disable @typescript-eslint/no-unused-vars */
const unusedMockShape = {
  write: vi.fn(),
  onMessage: vi.fn(),
  onStderr: vi.fn(),
  onExit: vi.fn(),
  kill: vi.fn(),
};
/* eslint-enable @typescript-eslint/no-unused-vars */

describe('AcpClient', () => {
  it('应以 workspaceRoot 作为 ACP 子进程 cwd 启动', async () => {
    const { AcpClient } = await import('../src/acp/client.js');

    new AcpClient({
      db: {} as any,
      workspaceRoot: '/tmp/workspace-root',
      agentCommand: 'codex-acp',
      agentArgs: [],
    });

    expect(spawnAcpAgentMock).toHaveBeenCalledWith(
      'codex-acp',
      [],
      undefined,
      '/tmp/workspace-root',
    );
  });

  it('terminal 退出后在 release 前仍可读取 output', async () => {
    const { AcpClient } = await import('../src/acp/client.js');
    const db = openTestDb();
    const rpc = new SessionUpdateRpc();
    createSession(db, {
      sessionKey: 'session-resume-seq',
      agentCommand: 'codex-acp',
      agentArgs: [],
      cwd: '/tmp/workspace-root',
      loadSupported: true,
    });
    db.prepare(
      'INSERT INTO runs(run_id, session_key, prompt_text, started_at) VALUES(?, ?, ?, ?)',
    ).run('run-resume-seq', 'session-resume-seq', 'seed', Date.now());
    db.prepare(
      'INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)',
    ).run('run-resume-seq', 5, 'seed', JSON.stringify({ ok: true }), Date.now());

    const client = new AcpClient({
      db,
      workspaceRoot: '/tmp/workspace-root',
      agentCommand: 'codex-acp',
      agentArgs: [],
      rpc,
    });

    await client.initialize();
    const session = await client.newSession({ cwd: '/tmp/workspace-root' });
    const result = await client.prompt(
      {
        runId: 'run-resume-seq',
        sessionKey: 'session-resume-seq',
        createdAtMs: Date.now(),
      },
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'resume run' }] },
      10_000,
    );

    expect(result.stopReason).toBe('end_turn');
    const rows = db.prepare(
      'SELECT seq, method FROM events WHERE run_id = ? ORDER BY seq ASC',
    ).all('run-resume-seq') as Array<{ seq: number; method: string }>;
    expect(rows.map((row) => row.seq)).toEqual([5, 6]);
    expect(rows[1]?.method).toBe('session/update');

    client.close();
    db.close();
  });
});

class SessionUpdateRpc implements StdioProcess {
  private readonly messageHandlers: Array<(message: JsonRpcMessage) => void> = [];
  private readonly stderrHandlers: Array<(line: string) => void> = [];
  private readonly exitHandlers: Array<
    (info: { code: number | null; signal: NodeJS.Signals | null }) => void
  > = [];

  write(message: JsonRpcMessage): void {
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
          queueMicrotask(() => {
            this.emit({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: (req.params as { sessionId: string }).sessionId,
                update: { sessionUpdate: 'agent_message_delta', delta: 'hello' },
              },
            });
            this.respond(req.id, { stopReason: 'end_turn' });
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
      this.emit({ jsonrpc: '2.0', id, result });
    });
  }

  private emit(message: JsonRpcMessage): void {
    this.messageHandlers.forEach((handler) => handler(message));
  }
}

function openTestDb(): Db {
  const db = openDb(`/tmp/runtime-acp-acpclient-${randomUUID()}.db`);
  migrate(db);
  return db;
}
