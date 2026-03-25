import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureIsolatedClaudeConfig,
  getIsolatedClaudeConfigDir,
  getIsolatedClaudeStatePath,
} from '../claudeConfig.js';

const tempDirs: string[] = [];

describe('claudeConfig', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('应在 workspace 下生成独立 Claude 配置目录和状态文件', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-'));
    tempDirs.push(workspaceRoot);

    const configDir = ensureIsolatedClaudeConfig(workspaceRoot);

    expect(configDir).toBe(getIsolatedClaudeConfigDir(workspaceRoot));
    expect(fs.existsSync(path.join(configDir, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'settings.local.json'))).toBe(true);
    expect(fs.existsSync(getIsolatedClaudeStatePath(workspaceRoot))).toBe(true);
    expect(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')).toContain('{}');
  });
});
