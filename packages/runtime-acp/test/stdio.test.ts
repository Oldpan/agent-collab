import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { accessSyncMock, spawnMock, createInterfaceMock } = vi.hoisted(() => ({
  accessSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  createInterfaceMock: vi.fn(() => {
    const rl = new EventEmitter() as EventEmitter & { close?: () => void };
    rl.close = () => {};
    return rl;
  }),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual.default,
      accessSync: accessSyncMock,
    },
    accessSync: accessSyncMock,
  };
});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:readline', () => ({
  default: {
    createInterface: createInterfaceMock,
  },
}));

describe('spawnAcpAgent', () => {
  afterEach(() => {
    vi.clearAllMocks();
    accessSyncMock.mockImplementation(() => undefined);
    createInterfaceMock.mockImplementation(() => {
      const rl = new EventEmitter() as EventEmitter & { close?: () => void };
      rl.close = () => {};
      return rl;
    });
  });

  it('falls back to npx when codex-acp is missing from PATH', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    accessSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const { spawnAcpAgent } = await import('../src/acp/stdio.js');
    spawnAcpAgent('codex-acp', ['-c', 'approval_policy="never"']);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['-y', '@zed-industries/codex-acp@latest', '-c', 'approval_policy="never"'],
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  it('surfaces child process spawn errors through onExit immediately', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    accessSyncMock.mockImplementation(() => undefined);

    const { spawnAcpAgent } = await import('../src/acp/stdio.js');
    const rpc = spawnAcpAgent('codex-acp', []);
    const onExit = vi.fn();
    rpc.onExit?.(onExit);

    child.emit('error', new Error('spawn codex-acp ENOENT'));

    expect(onExit).toHaveBeenCalledWith({
      code: null,
      signal: null,
      error: 'spawn codex-acp ENOENT',
    });
    expect(() => rpc.write({ jsonrpc: '2.0', id: 1, result: {} })).toThrow(
      'ACP process is not running',
    );
  });
});

function createFakeChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn() };
  child.kill = vi.fn();
  return child;
}
