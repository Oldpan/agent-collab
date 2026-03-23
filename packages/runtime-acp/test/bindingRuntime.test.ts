import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BindingRuntime,
  ToolAuth,
  createSession,
  getSession,
  migrate,
  openDb,
  updateAcpSessionId,
  type Db,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type StdioProcess,
} from '../src/index.js';

class FakeRpc implements StdioProcess {
  readonly promptCalls: Array<{ sessionId: string; prompt: unknown[] }> = [];
  readonly createdSessions: string[] = [];

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
        case 'session/new': {
          const sessionId = `fresh-session-${this.createdSessions.length + 1}`;
          this.createdSessions.push(sessionId);
          this.respond(req.id, { sessionId });
          return;
        }
        case 'session/prompt': {
          const params = req.params as { sessionId: string; prompt: unknown[] };
          this.promptCalls.push({ sessionId: params.sessionId, prompt: params.prompt });

          if (params.sessionId === 'stale-session') {
            this.respondError(
              req.id,
              -32603,
              'Internal error',
              'stream disconnected before completion: tls handshake eof',
            );
            return;
          }

          this.respond(req.id, { stopReason: 'end_turn' });
          return;
        }
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

  private respondError(
    id: JsonRpcRequest['id'],
    code: number,
    message: string,
    data?: unknown,
  ): void {
    queueMicrotask(() => {
      this.messageHandlers.forEach((handler) =>
        handler({ jsonrpc: '2.0', id, error: { code, message, data } }),
      );
    });
  }
}

describe('BindingRuntime stale session recovery', () => {
  const openDbs: Db[] = [];

  afterEach(() => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
  });

  it('should reset a stale ACP session and retry once on resume', async () => {
    const dbPath = join(tmpdir(), `runtime-acp-test-${randomUUID()}.db`);
    const db = openDb(dbPath);
    migrate(db);
    openDbs.push(db);

    createSession(db, {
      sessionKey: 'session-1',
      agentCommand: 'codex',
      agentArgs: ['exec'],
      cwd: '/tmp',
      loadSupported: true,
    });
    updateAcpSessionId(db, 'session-1', 'stale-session');

    const rpc = new FakeRpc();
    const runtime = new BindingRuntime({
      db,
      config: {
        acpAgentCommand: 'codex',
        acpAgentArgs: ['exec'],
        uiJsonMaxChars: 3_000,
      },
      toolAuth: new ToolAuth(db),
      sessionKey: 'session-1',
      bindingKey: 'node:conv-1:-:node_user',
      workspaceRoot: '/tmp',
      acpRpc: rpc,
    });

    (runtime as any).acpSessionId = 'stale-session';

    const sink = {
      sendText: async () => {},
    };

    const result = await runtime.prompt({
      runId: 'run-1',
      promptText: '继续',
      contextText: '[System Prompt]\\nctx',
      sink,
      uiMode: 'summary',
      actorUserId: 'node_user',
    });

    expect(result.stopReason).toBe('end_turn');
    expect(rpc.promptCalls).toHaveLength(2);
    expect(rpc.promptCalls[0]?.sessionId).toBe('stale-session');
    expect(rpc.promptCalls[1]?.sessionId).toBe('fresh-session-1');
    expect(rpc.promptCalls[1]?.prompt).toEqual([
      { type: 'text', text: '[System Prompt]\\nctx' },
      { type: 'text', text: '继续' },
    ]);

    const session = getSession(db, 'session-1');
    expect(session?.acpSessionId).toBe('fresh-session-1');

    runtime.close();
  });
});
