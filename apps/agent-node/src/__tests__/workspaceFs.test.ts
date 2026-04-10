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

  it('应生成 slock 风格的 MEMORY.md scaffold', () => {
    const root = createWorkspace();

    const result = readWorkspaceFile(root, 'MEMORY.md');

    expect(result.content).toContain('## Role');
    expect(result.content).toContain('## Key Knowledge');
    expect(result.content).toContain('## Active Context');
    expect(result.content).toContain('notes/channels/');
    expect(result.content).toContain('notes/domain.md');
  });

  it('应支持读取常见图片预览并返回 data url', () => {
    const root = createWorkspace();
    fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
    const pngBytes = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex');
    fs.writeFileSync(path.join(root, 'notes', 'plot.png'), pngBytes);

    const result = readWorkspaceFile(root, 'notes/plot.png');

    expect(result.mimeType).toBe('image/png');
    expect(result.content.startsWith('data:image/png;base64,')).toBe(true);
    expect(result.size).toBe(pngBytes.length);
  });

  it('应将 svg 当作图片预览返回', () => {
    const root = createWorkspace();
    fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
    fs.writeFileSync(path.join(root, 'notes', 'diagram.svg'), svg, 'utf8');

    const result = readWorkspaceFile(root, 'notes/diagram.svg');

    expect(result.mimeType).toBe('image/svg+xml');
    expect(result.content.startsWith('data:image/svg+xml;base64,')).toBe(true);
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
