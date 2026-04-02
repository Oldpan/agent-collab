import { describe, expect, it, vi } from 'vitest';

const spawnAcpAgentMock = vi.fn(() => ({
  write: vi.fn(),
  onMessage: vi.fn(),
  onStderr: vi.fn(),
  onExit: vi.fn(),
  kill: vi.fn(),
}));

vi.mock('../src/acp/stdio.js', () => ({
  spawnAcpAgent: spawnAcpAgentMock,
}));

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
});
