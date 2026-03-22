import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listWorkspaceDirectory, readWorkspaceFile, WorkspaceFsError } from '../workspaceFs.js';

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

  it('应拒绝跳出 workspace 的路径', () => {
    const root = createWorkspace();

    expect(() => listWorkspaceDirectory(root, '../')).toThrowError(WorkspaceFsError);
    expect(() => readWorkspaceFile(root, '../secret.txt')).toThrow('Path escapes workspace root.');
  });
});

function createWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
  tempDirs.push(root);
  return root;
}
