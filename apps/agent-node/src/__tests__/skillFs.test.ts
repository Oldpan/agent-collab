import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listSkills, readSkillFile } from '../skillFs.js';
import { WorkspaceFsError } from '../workspaceFs.js';

const tempDirs: string[] = [];

describe('skillFs', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('应扫描 skill roots 并返回发现到的 skills', () => {
    const root = createSkillRoot();
    const deployDir = path.join(root, 'deploy');
    fs.mkdirSync(deployDir, { recursive: true });
    fs.writeFileSync(
      path.join(deployDir, 'SKILL.md'),
      ['---', 'name: deploy', 'description: Deployment workflow', '---', '', '# Deploy'].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(root, 'notes.md'), '# Notes', 'utf8');

    const result = listSkills([root]);

    expect(result.path).toBeNull();
    expect(result.roots).toEqual([root]);
    expect(result.skills).toEqual([
      {
        name: 'deploy',
        path: path.join(root, 'deploy', 'SKILL.md'),
        sourceRoot: root,
        description: 'Deployment workflow',
      },
    ]);
  });

  it('应列出已解析目录下的文件', () => {
    const root = createSkillRoot();
    const deployDir = path.join(root, 'deploy');
    fs.mkdirSync(path.join(deployDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(deployDir, 'SKILL.md'), '# Deploy', 'utf8');

    const result = listSkills([root], deployDir);

    expect(result.path).toBe(deployDir);
    expect(result.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'directory:assets',
      'file:SKILL.md',
    ]);
  });

  it('应读取 skill markdown 文件内容', () => {
    const root = createSkillRoot();
    const skillPath = path.join(root, 'deploy', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '# Deploy\nChecklist', 'utf8');

    const result = readSkillFile([root], skillPath);

    expect(result.path).toBe(skillPath);
    expect(result.mimeType).toBe('text/markdown');
    expect(result.content).toContain('Checklist');
  });

  it('应拒绝跳出 skill roots 的路径', () => {
    const root = createSkillRoot();

    expect(() => listSkills([root], '/etc')).toThrowError(WorkspaceFsError);
    expect(() => readSkillFile([root], '/etc/passwd')).toThrow('Path escapes configured skill roots.');
  });
});

function createSkillRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-'));
  tempDirs.push(root);
  return root;
}
