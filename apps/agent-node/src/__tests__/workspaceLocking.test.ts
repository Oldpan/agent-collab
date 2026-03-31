import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceLockManager } from '@agent-collab/runtime-acp';

import { readWorkspaceFile, writeWorkspaceFile } from '../workspaceFs.js';

const tempDirs: string[] = [];

describe('workspace platform writes', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('平台侧 writeWorkspaceFile 应参与同一把 workspace 锁', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-node-workspace-lock-'));
    tempDirs.push(root);
    const lockManager = new WorkspaceLockManager();
    const manualLease = await lockManager.acquire(root);

    const writePromise = lockManager.runExclusive(root, async () =>
      writeWorkspaceFile(root, 'notes/channels/default.md', '# default\n', 'overwrite'),
    );

    await delay(30);
    expect(fs.existsSync(path.join(root, 'notes/channels/default.md'))).toBe(false);

    manualLease.release();
    await writePromise;

    const result = readWorkspaceFile(root, 'notes/channels/default.md');
    expect(result.content).toContain('# default');
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
