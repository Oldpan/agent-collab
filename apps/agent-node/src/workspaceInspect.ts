import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import type { WorkspaceErrorCode, WorkspaceInspectResult } from '@agent-collab/protocol';

export class WorkspaceInspectError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function inspectWorkspace(workspaceRoot: string): WorkspaceInspectResult {
  const normalizedRoot = canonicalizeWorkspaceRoot(workspaceRoot);
  const stat = fs.statSync(normalizedRoot, { throwIfNoEntry: false });
  if (!stat) {
    throw new WorkspaceInspectError('not_found', 'Workspace root not found.');
  }
  if (!stat.isDirectory()) {
    throw new WorkspaceInspectError('not_directory', 'Workspace root is not a directory.');
  }

  const repoRoot = runGitCommand(normalizedRoot, ['rev-parse', '--show-toplevel']);
  if (!repoRoot) {
    return {
      workspaceRoot: normalizedRoot,
      isGit: false,
      repoRoot: null,
      workspaceKind: 'directory',
      branchName: null,
      remoteUrl: null,
    };
  }

  const normalizedRepoRoot = canonicalizeWorkspaceRoot(repoRoot);
  const branchName = runGitCommand(normalizedRoot, ['branch', '--show-current']);
  const remoteUrl = normalizeOptionalValue(runGitCommand(normalizedRoot, ['config', '--get', 'remote.origin.url']));
  const workspaceKind = detectWorkspaceKind(normalizedRoot);

  return {
    workspaceRoot: normalizedRoot,
    isGit: true,
    repoRoot: normalizedRepoRoot,
    workspaceKind,
    branchName: normalizeOptionalValue(branchName),
    remoteUrl,
  };
}

function runGitCommand(cwd: string, args: string[]): string | null {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const value = output.trim();
    return value || null;
  } catch {
    return null;
  }
}

function detectWorkspaceKind(workspaceRoot: string): WorkspaceInspectResult['workspaceKind'] {
  const gitEntry = path.join(workspaceRoot, '.git');
  const gitStat = fs.statSync(gitEntry, { throwIfNoEntry: false });
  if (gitStat?.isFile()) {
    const superprojectRoot = runGitCommand(workspaceRoot, ['rev-parse', '--show-superproject-working-tree']);
    return superprojectRoot ? 'local_checkout' : 'worktree';
  }
  return 'local_checkout';
}

function normalizeOptionalValue(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
  const normalized = path.isAbsolute(workspaceRoot)
    ? path.normalize(workspaceRoot)
    : path.resolve(workspaceRoot);
  const parsed = path.parse(normalized);
  if (normalized === parsed.root) return normalized;
  return normalized.replace(/[\\/]+$/, '');
}
