import type { WorkspaceInspectResult } from '@agent-collab/protocol';

import { inspectWorkspaceGitContext, WorkspaceGitError } from './workspaceGit.js';

export class WorkspaceInspectError extends WorkspaceGitError {}

export function inspectWorkspace(workspaceRoot: string): WorkspaceInspectResult {
  try {
    const context = inspectWorkspaceGitContext(workspaceRoot);
    return {
      workspaceRoot: context.workspaceRoot,
      isGit: context.isGit,
      repoRoot: context.repoRoot,
      workspaceKind: context.workspaceKind,
      branchName: context.branchName,
      remoteUrl: context.remoteUrl,
    };
  } catch (error) {
    if (error instanceof WorkspaceGitError) {
      throw new WorkspaceInspectError(error.code, error.message);
    }
    throw error;
  }
}
