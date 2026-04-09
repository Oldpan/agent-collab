import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listWorkspaceDirectory, readWorkspaceFile, writeWorkspaceFile, WorkspaceFsError } from '../workspaceFs.js';

const tempDirs: string[] = [];

describe('workspaceFs', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('应列出 workspace 根目录并按目录优先排序', () => {
    const root = createWorkspace();

    const result = listWorkspaceDirectory(root, '');

    expect(result.relativePath).toBe('');
    expect(result.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'directory:notes',
      'file:MEMORY.md',
    ]);
  });

  it('应读取 markdown 文件内容', () => {
    const root = createWorkspace();

    const result = readWorkspaceFile(root, 'MEMORY.md');

    expect(result.mimeType).toBe('text/markdown');
    expect(result.content).toContain('# Memory');
  });

  it('应支持写入和追加文本文件', () => {
    const root = createWorkspace();

    writeWorkspaceFile(root, 'notes/channels/default.md', '# default\n', 'overwrite');
    writeWorkspaceFile(root, 'notes/channels/default.md', '\n## History Reset\n', 'append');

    const result = readWorkspaceFile(root, 'notes/channels/default.md');

    expect(result.content).toContain('# default');
    expect(result.content).toContain('## History Reset');
  });

  it('应拒绝跳出 workspace 的路径', () => {
    const root = createWorkspace();

    expect(() => listWorkspaceDirectory(root, '../')).toThrowError(WorkspaceFsError);
    expect(() => readWorkspaceFile(root, '../secret.txt')).toThrow('Path escapes workspace root.');
  });

  it('scaffold=false 时不应自动创建 MEMORY.md 或 notes', () => {
    const root = createWorkspace();
    fs.rmSync(path.join(root, 'MEMORY.md'), { force: true });
    fs.rmSync(path.join(root, 'notes'), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, 'README.md'), '# Docs\n', 'utf8');

    const result = listWorkspaceDirectory(root, '', { scaffold: false });

    expect(result.entries.map((entry) => entry.name)).toEqual(['README.md']);
    expect(fs.existsSync(path.join(root, 'MEMORY.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'notes'))).toBe(false);
  });
});

function createWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
  tempDirs.push(root);
  return root;
}
