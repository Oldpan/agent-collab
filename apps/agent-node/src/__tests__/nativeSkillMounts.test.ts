import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureNativeSkillMounts } from '../nativeSkillMounts.js';

const tempDirs: string[] = [];

describe('nativeSkillMounts', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('应为 codex 在 workspace 下创建 .agents/skills 软链', () => {
    const workspaceRoot = createTempDir('codex-workspace-');
    const skillRoot = createTempDir('codex-skills-');
    const deployDir = path.join(skillRoot, 'deploy');
    fs.mkdirSync(deployDir, { recursive: true });
    fs.writeFileSync(path.join(deployDir, 'SKILL.md'), '# Deploy', 'utf8');
    fs.writeFileSync(path.join(skillRoot, 'notes.md'), '# Notes', 'utf8');

    ensureNativeSkillMounts({
      agentType: 'codex_acp',
      workspaceRoot,
      skillRoots: [skillRoot],
    });

    const mountedDir = path.join(workspaceRoot, '.agents', 'skills');
    const mountedSkill = path.join(mountedDir, 'deploy');
    expect(fs.existsSync(mountedSkill)).toBe(true);
    expect(fs.lstatSync(mountedSkill).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(mountedSkill)).toBe(fs.realpathSync(deployDir));
    expect(fs.existsSync(path.join(mountedDir, 'notes.md'))).toBe(false);
  });

  it('应为 claude 在 workspace 下创建 .claude/skills 软链', () => {
    const workspaceRoot = createTempDir('claude-workspace-');
    const skillRoot = createTempDir('claude-skills-');
    const reviewDir = path.join(skillRoot, 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'SKILL.md'), '# Review', 'utf8');

    ensureNativeSkillMounts({
      agentType: 'claude_acp',
      workspaceRoot,
      skillRoots: [skillRoot],
    });

    const mountedSkill = path.join(workspaceRoot, '.claude', 'skills', 'review');
    expect(fs.existsSync(mountedSkill)).toBe(true);
    expect(fs.lstatSync(mountedSkill).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(mountedSkill)).toBe(fs.realpathSync(reviewDir));
  });

  it('重建挂载时应清理旧的托管软链', () => {
    const workspaceRoot = createTempDir('cleanup-workspace-');
    const oldRoot = createTempDir('cleanup-old-skills-');
    const newRoot = createTempDir('cleanup-new-skills-');
    const oldSkillDir = path.join(oldRoot, 'old-skill');
    const newSkillDir = path.join(newRoot, 'new-skill');
    fs.mkdirSync(oldSkillDir, { recursive: true });
    fs.mkdirSync(newSkillDir, { recursive: true });
    fs.writeFileSync(path.join(oldSkillDir, 'SKILL.md'), '# Old', 'utf8');
    fs.writeFileSync(path.join(newSkillDir, 'SKILL.md'), '# New', 'utf8');

    ensureNativeSkillMounts({
      agentType: 'codex_acp',
      workspaceRoot,
      skillRoots: [oldRoot],
    });
    ensureNativeSkillMounts({
      agentType: 'codex_acp',
      workspaceRoot,
      skillRoots: [newRoot],
    });

    const mountedDir = path.join(workspaceRoot, '.agents', 'skills');
    expect(fs.existsSync(path.join(mountedDir, 'old-skill'))).toBe(false);
    expect(fs.realpathSync(path.join(mountedDir, 'new-skill'))).toBe(fs.realpathSync(newSkillDir));
  });
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
