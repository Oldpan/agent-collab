import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { getWorkspaceGitDiff, getWorkspaceGitStatus, runWorkspaceGitAction } from '../workspaceGit.js';

const tempDirs: string[] = [];

describe('workspaceGit', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('应对非 git 目录返回 isGit=false', () => {
    const root = createTempDir('workspace-git-dir-');
    fs.writeFileSync(path.join(root, 'README.md'), '# Hello\n', 'utf8');

    const status = getWorkspaceGitStatus(root);
    const diff = getWorkspaceGitDiff(root, 'uncommitted');

    expect(status.isGit).toBe(false);
    expect(diff.isGit).toBe(false);
    expect(diff.files).toEqual([]);
  });

  it('应返回未提交变更及结构化 diff', () => {
    const root = createGitRepo();
    fs.writeFileSync(path.join(root, 'README.md'), '# Repo\n\nchanged\n', 'utf8');

    const status = getWorkspaceGitStatus(root);
    const diff = getWorkspaceGitDiff(root, 'uncommitted');

    expect(status.isGit).toBe(true);
    expect(status.isDirty).toBe(true);
    expect(status.changedFiles).toBe(1);
    expect(diff.mode).toBe('uncommitted');
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.path).toBe('README.md');
    expect(diff.files[0]?.hunks.length).toBeGreaterThan(0);
  });

  it('应将 status 和 diff 限制在 project 子目录范围内', () => {
    const root = createGitRepo();
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'index.ts'), 'export const value = 1;\n', 'utf8');
    execFileSync('git', ['add', 'app/index.ts'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'add app'], { cwd: root, stdio: 'ignore' });

    fs.writeFileSync(path.join(root, 'app', 'index.ts'), 'export const value = 2;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'README.md'), '# Repo\n\noutside change\n', 'utf8');

    const projectRoot = path.join(root, 'app');
    const status = getWorkspaceGitStatus(projectRoot);
    const diff = getWorkspaceGitDiff(projectRoot, 'uncommitted');

    expect(status.changedFiles).toBe(1);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.path).toBe('index.ts');
  });

  it('commit_all 应拒绝提交 project 子目录之外已 staged 的改动', () => {
    const root = createGitRepo();
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'index.ts'), 'export const value = 1;\n', 'utf8');
    execFileSync('git', ['add', 'app/index.ts'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'add app'], { cwd: root, stdio: 'ignore' });

    fs.writeFileSync(path.join(root, 'app', 'index.ts'), 'export const value = 2;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'README.md'), '# Repo\n\nstaged outside\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'ignore' });

    const projectRoot = path.join(root, 'app');
    expect(() => runWorkspaceGitAction(projectRoot, 'commit_all', 'scoped change')).toThrow(
      'Cannot commit from this project directory',
    );
  });
});

function createTempDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function createGitRepo(): string {
  const root = createTempDir('workspace-git-repo-');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'README.md'), '# Repo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  return root;
}
