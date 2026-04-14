import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import type {
  WorkbenchGitAction,
  WorkbenchGitActionResult,
  WorkbenchGitDiffFile,
  WorkbenchGitDiffFileStatus,
  WorkbenchGitDiffHunk,
  WorkbenchGitDiffLine,
  WorkbenchGitDiffMode,
  WorkbenchGitDiffResult,
  WorkbenchGitStatusResult,
  WorkspaceErrorCode,
  WorkspaceInspectResult,
} from '@agent-collab/protocol';

export class WorkspaceGitError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type GitPorcelainEntry = {
  code: string;
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  oldPath: string | null;
};

type DiffFileMeta = {
  path: string;
  oldPath: string | null;
  status: WorkbenchGitDiffFileStatus;
  isNew: boolean;
  isDeleted: boolean;
  isUntracked: boolean;
};

type GitContext = {
  workspaceRoot: string;
  isGit: boolean;
  repoRoot: string | null;
  workspaceKind: WorkspaceInspectResult['workspaceKind'];
  branchName: string | null;
  remoteUrl: string | null;
};

export function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
  const normalized = path.isAbsolute(workspaceRoot)
    ? path.normalize(workspaceRoot)
    : path.resolve(workspaceRoot);
  const parsed = path.parse(normalized);
  if (normalized === parsed.root) return normalized;
  return normalized.replace(/[\\/]+$/, '');
}

export function inspectWorkspaceGitContext(workspaceRoot: string): GitContext {
  const normalizedRoot = canonicalizeWorkspaceRoot(workspaceRoot);
  const stat = fs.statSync(normalizedRoot, { throwIfNoEntry: false });
  if (!stat) {
    throw new WorkspaceGitError('not_found', 'Workspace root not found.');
  }
  if (!stat.isDirectory()) {
    throw new WorkspaceGitError('not_directory', 'Workspace root is not a directory.');
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

  return {
    workspaceRoot: normalizedRoot,
    isGit: true,
    repoRoot: canonicalizeWorkspaceRoot(repoRoot),
    workspaceKind: detectWorkspaceKind(normalizedRoot),
    branchName: normalizeOptionalValue(runGitCommand(normalizedRoot, ['branch', '--show-current'])),
    remoteUrl: normalizeOptionalValue(runGitCommand(normalizedRoot, ['config', '--get', 'remote.origin.url'])),
  };
}

export function getWorkspaceGitStatus(workspaceRoot: string): WorkbenchGitStatusResult {
  const context = inspectWorkspaceGitContext(workspaceRoot);
  if (!context.isGit || !context.repoRoot) {
    return {
      workspaceRoot: context.workspaceRoot,
      isGit: false,
      repoRoot: null,
      workspaceKind: context.workspaceKind,
      branchName: null,
      remoteUrl: null,
      baseRef: null,
      hasRemote: false,
      isDirty: false,
      changedFiles: 0,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      aheadOfOrigin: 0,
      behindOfOrigin: 0,
      aheadBehind: null,
    };
  }

  const entries = readPorcelainEntries(context.workspaceRoot);
  const changedPaths = new Set(entries.map((entry) => entry.path));
  const stagedPaths = new Set<string>();
  const unstagedPaths = new Set<string>();
  const untrackedPaths = new Set<string>();

  for (const entry of entries) {
    if (entry.code === '??') {
      untrackedPaths.add(entry.path);
      continue;
    }
    if (entry.indexStatus !== ' ' && entry.indexStatus !== '?') {
      stagedPaths.add(entry.path);
    }
    if (entry.worktreeStatus !== ' ' && entry.worktreeStatus !== '?') {
      unstagedPaths.add(entry.path);
    }
  }

  const baseRef = resolveBaseRef(context.workspaceRoot, context.branchName);
  const upstreamRef = resolveUpstreamRef(context.workspaceRoot, context.branchName);

  return {
    workspaceRoot: context.workspaceRoot,
    isGit: true,
    repoRoot: context.repoRoot,
    workspaceKind: context.workspaceKind,
    branchName: context.branchName,
    remoteUrl: context.remoteUrl,
    baseRef,
    hasRemote: Boolean(context.remoteUrl),
    isDirty: changedPaths.size > 0,
    changedFiles: changedPaths.size,
    stagedFiles: stagedPaths.size,
    unstagedFiles: unstagedPaths.size,
    untrackedFiles: untrackedPaths.size,
    ...resolveOriginCounts(context.workspaceRoot, upstreamRef),
    aheadBehind: baseRef ? resolveAheadBehind(context.workspaceRoot, baseRef) : null,
  };
}

export function getWorkspaceGitDiff(
  workspaceRoot: string,
  mode: WorkbenchGitDiffMode,
): WorkbenchGitDiffResult {
  const status = getWorkspaceGitStatus(workspaceRoot);
  if (!status.isGit) {
    return {
      workspaceRoot: status.workspaceRoot,
      isGit: false,
      mode,
      baseRef: null,
      files: [],
    };
  }

  const entries = readPorcelainEntries(status.workspaceRoot);
  const fileMeta = new Map<string, DiffFileMeta>();
  if (mode === 'uncommitted') {
    for (const entry of entries) {
      fileMeta.set(entry.path, buildMetaFromPorcelainEntry(entry));
    }
  }

  const files = new Map<string, WorkbenchGitDiffFile>();
  const parseAndMerge = (patch: string): void => {
    for (const file of parseUnifiedDiff(patch)) {
      const meta = fileMeta.get(file.path);
      const previous = files.get(file.path);
      files.set(file.path, mergeDiffFile(previous, meta ? applyMeta(file, meta) : file));
    }
  };

  if (mode === 'base') {
    if (!status.baseRef) {
      return {
        workspaceRoot: status.workspaceRoot,
        isGit: true,
        mode,
        baseRef: null,
        files: [],
      };
    }
    const patch = runGitCommandAllowOutput(
      status.workspaceRoot,
      ['diff', '--find-renames', '--no-color', '--unified=3', `${status.baseRef}...HEAD`, '--', '.'],
    );
    const nameStatus = parseNameStatusEntries(runGitCommandAllowOutput(
      status.workspaceRoot,
      ['diff', '--find-renames', '--name-status', '-z', `${status.baseRef}...HEAD`, '--', '.'],
    ));
    for (const entry of nameStatus) {
      fileMeta.set(entry.path, buildMetaFromNameStatus(entry));
    }
    parseAndMerge(patch);
    for (const meta of fileMeta.values()) {
      if (!files.has(meta.path)) {
        files.set(meta.path, emptyDiffFile(meta));
      }
    }
    return {
      workspaceRoot: status.workspaceRoot,
      isGit: true,
      mode,
      baseRef: status.baseRef,
      files: sortDiffFiles([...files.values()]),
    };
  }

  const hasHead = gitRefExists(status.workspaceRoot, 'HEAD');
  if (hasHead) {
    parseAndMerge(runGitCommandAllowOutput(
      status.workspaceRoot,
      ['diff', '--find-renames', '--no-color', '--unified=3', 'HEAD', '--', '.'],
    ));
  } else {
    parseAndMerge(runGitCommandAllowOutput(
      status.workspaceRoot,
      ['diff', '--find-renames', '--no-color', '--unified=3', '--cached', '--', '.'],
    ));
    parseAndMerge(runGitCommandAllowOutput(
      status.workspaceRoot,
      ['diff', '--find-renames', '--no-color', '--unified=3', '--', '.'],
    ));
  }

  for (const meta of fileMeta.values()) {
    if (!meta.isUntracked) continue;
    const patch = buildUntrackedPatch(status.workspaceRoot, meta.path);
    const parsed = parseUnifiedDiff(patch)[0];
    files.set(meta.path, parsed ? applyMeta(parsed, meta) : emptyDiffFile(meta));
  }

  for (const meta of fileMeta.values()) {
    if (!files.has(meta.path)) {
      files.set(meta.path, emptyDiffFile(meta));
    } else {
      files.set(meta.path, applyMeta(files.get(meta.path)!, meta));
    }
  }

  return {
    workspaceRoot: status.workspaceRoot,
    isGit: true,
    mode,
    baseRef: status.baseRef,
    files: sortDiffFiles([...files.values()]),
  };
}

export function runWorkspaceGitAction(
  workspaceRoot: string,
  action: WorkbenchGitAction,
  commitMessage?: string,
): WorkbenchGitActionResult {
  const status = getWorkspaceGitStatus(workspaceRoot);
  if (!status.isGit) {
    throw new WorkspaceGitError('io_error', 'Workspace root is not a git repository.');
  }

  let args: string[];
  if (action === 'fetch') {
    args = ['fetch', '--all', '--prune'];
  } else if (action === 'pull_ff_only') {
    args = ['pull', '--ff-only'];
  } else if (action === 'push') {
    args = ['push'];
  } else {
    const message = commitMessage?.trim() ?? '';
    if (!message) {
      throw new WorkspaceGitError('io_error', 'Commit message is required.');
    }
    assertNoStagedChangesOutsideWorkspace(status.workspaceRoot, status.repoRoot);
    const addResult = spawnGit(status.workspaceRoot, ['add', '-A', '--', '.']);
    if (!addResult.ok) {
      throw new WorkspaceGitError('io_error', formatGitFailure('Failed to stage workspace changes.', addResult));
    }
    args = ['commit', '-m', message];
  }

  const result = spawnGit(status.workspaceRoot, args);
  if (!result.ok) {
    throw new WorkspaceGitError('io_error', formatGitFailure(`Git ${action} failed.`, result));
  }

  const nextStatus = getWorkspaceGitStatus(status.workspaceRoot);
  return {
    workspaceRoot: status.workspaceRoot,
    action,
    stdout: result.stdout,
    stderr: result.stderr,
    branchName: nextStatus.branchName,
  };
}

function runGitCommand(cwd: string, args: string[]): string | null {
  const result = runGitRaw(cwd, args);
  if (!result.ok) return null;
  const value = result.stdout.trim();
  return value || null;
}

function runGitCommandAllowOutput(cwd: string, args: string[]): string {
  const result = runGitRaw(cwd, args, { allowNonZero: true });
  return result.stdout;
}

function runGitRaw(
  cwd: string,
  args: string[],
  options?: { allowNonZero?: boolean },
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    return { ok: false, stdout: '', stderr: String(result.error.message) };
  }
  if ((result.status ?? 1) !== 0 && !options?.allowNonZero) {
    return {
      ok: false,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }
  return {
    ok: (result.status ?? 0) === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function spawnGit(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return {
    ok: !result.error && (result.status ?? 1) === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : ''),
    status: result.status,
  };
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

function readPorcelainEntries(workspaceRoot: string): GitPorcelainEntry[] {
  const result = runGitRaw(
    workspaceRoot,
    ['-c', 'status.renames=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'],
  );
  if (!result.ok) return [];
  const chunks = result.stdout.split('\0').filter(Boolean);
  const entries: GitPorcelainEntry[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const raw = chunks[index]!;
    const code = raw.slice(0, 2);
    const pathValue = raw.length > 3 ? raw.slice(3) : '';
    if (!pathValue) continue;
    let oldPath: string | null = null;
    let currentPath = pathValue;
    if (code[0] === 'R' || code[0] === 'C') {
      oldPath = pathValue;
      currentPath = chunks[index + 1] ?? pathValue;
      index += 1;
    }
    entries.push({
      code,
      indexStatus: code[0] ?? ' ',
      worktreeStatus: code[1] ?? ' ',
      path: currentPath,
      oldPath,
    });
  }
  return entries;
}

function resolveBaseRef(workspaceRoot: string, branchName: string | null): string | null {
  const originHead = normalizeOptionalValue(runGitCommand(workspaceRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']));
  if (originHead) return originHead;

  const remoteCandidates = ['origin/main', 'origin/master'];
  for (const candidate of remoteCandidates) {
    if (gitRefExists(workspaceRoot, `refs/remotes/${candidate}`)) return candidate;
  }

  const localCandidates = [branchName === 'main' ? null : 'main', branchName === 'master' ? null : 'master']
    .filter((item): item is string => !!item);
  for (const candidate of localCandidates) {
    if (gitRefExists(workspaceRoot, `refs/heads/${candidate}`)) return candidate;
  }

  return null;
}

function assertNoStagedChangesOutsideWorkspace(workspaceRoot: string, repoRoot: string | null): void {
  if (!repoRoot) return;

  const normalizedWorkspaceRoot = canonicalizeWorkspaceRoot(workspaceRoot);
  const normalizedRepoRoot = canonicalizeWorkspaceRoot(repoRoot);
  if (normalizedWorkspaceRoot === normalizedRepoRoot) return;

  const scopePrefix = toGitRelativePath(path.relative(normalizedRepoRoot, normalizedWorkspaceRoot));
  if (!scopePrefix || scopePrefix.startsWith('..')) return;

  const outsideEntries = readPorcelainEntries(normalizedRepoRoot).filter((entry) => {
    if (entry.code === '??') return false;
    if (entry.indexStatus === ' ' || entry.indexStatus === '?') return false;
    return !isRepoPathWithinWorkspaceScope(entry.path, scopePrefix)
      || (entry.oldPath ? !isRepoPathWithinWorkspaceScope(entry.oldPath, scopePrefix) : false);
  });

  if (outsideEntries.length === 0) return;

  const preview = outsideEntries
    .slice(0, 5)
    .map((entry) => entry.path)
    .join(', ');
  const suffix = outsideEntries.length > 5 ? ` (+${outsideEntries.length - 5} more)` : '';
  throw new WorkspaceGitError(
    'io_error',
    `Cannot commit from this project directory because there are staged changes outside ${scopePrefix}: ${preview}${suffix}`,
  );
}

function resolveUpstreamRef(workspaceRoot: string, branchName: string | null): string | null {
  const upstream = normalizeOptionalValue(runGitCommand(
    workspaceRoot,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
  ));
  if (upstream) return upstream;
  if (!branchName) return null;
  const candidate = `origin/${branchName}`;
  return gitRefExists(workspaceRoot, `refs/remotes/${candidate}`) ? candidate : null;
}

function gitRefExists(workspaceRoot: string, ref: string): boolean {
  return runGitRaw(workspaceRoot, ['show-ref', '--verify', '--quiet', ref]).ok;
}

function resolveOriginCounts(
  workspaceRoot: string,
  upstreamRef: string | null,
): { aheadOfOrigin: number; behindOfOrigin: number } {
  if (!upstreamRef) return { aheadOfOrigin: 0, behindOfOrigin: 0 };
  const counts = resolveAheadBehind(workspaceRoot, upstreamRef);
  return {
    aheadOfOrigin: counts.ahead,
    behindOfOrigin: counts.behind,
  };
}

function resolveAheadBehind(
  workspaceRoot: string,
  ref: string,
): { ahead: number; behind: number } {
  const result = normalizeOptionalValue(runGitCommand(
    workspaceRoot,
    ['rev-list', '--left-right', '--count', `${ref}...HEAD`],
  ));
  if (!result) return { ahead: 0, behind: 0 };
  const [behindRaw, aheadRaw] = result.split(/\s+/);
  const behind = Number.parseInt(behindRaw ?? '0', 10);
  const ahead = Number.parseInt(aheadRaw ?? '0', 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

function buildMetaFromPorcelainEntry(entry: GitPorcelainEntry): DiffFileMeta {
  const status = resolveDiffStatus(entry.code, entry.indexStatus, entry.worktreeStatus);
  return {
    path: entry.path,
    oldPath: entry.oldPath,
    status,
    isNew: status === 'added' || status === 'untracked',
    isDeleted: status === 'deleted',
    isUntracked: status === 'untracked',
  };
}

function parseNameStatusEntries(raw: string): Array<{ statusCode: string; path: string; oldPath: string | null }> {
  const chunks = raw.split('\0').filter(Boolean);
  const entries: Array<{ statusCode: string; path: string; oldPath: string | null }> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    const tabIndex = chunk.indexOf('\t');
    if (tabIndex < 0) continue;
    const statusCode = chunk.slice(0, tabIndex).trim();
    const firstPath = chunk.slice(tabIndex + 1);
    if (!firstPath) continue;
    if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
      const nextPath = chunks[index + 1] ?? '';
      if (!nextPath) continue;
      entries.push({ statusCode, oldPath: firstPath, path: nextPath });
      index += 1;
      continue;
    }
    entries.push({ statusCode, oldPath: null, path: firstPath });
  }
  return entries;
}

function isRepoPathWithinWorkspaceScope(repoPath: string, scopePrefix: string): boolean {
  const normalizedPath = toGitRelativePath(repoPath);
  return normalizedPath === scopePrefix || normalizedPath.startsWith(`${scopePrefix}/`);
}

function toGitRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function buildMetaFromNameStatus(entry: { statusCode: string; path: string; oldPath: string | null }): DiffFileMeta {
  const status = mapNameStatus(entry.statusCode);
  return {
    path: entry.path,
    oldPath: entry.oldPath,
    status,
    isNew: status === 'added',
    isDeleted: status === 'deleted',
    isUntracked: false,
  };
}

function resolveDiffStatus(
  code: string,
  indexStatus: string,
  worktreeStatus: string,
): WorkbenchGitDiffFileStatus {
  if (code === '??') return 'untracked';
  if (indexStatus === 'U' || worktreeStatus === 'U') return 'conflicted';
  if (indexStatus === 'R' || worktreeStatus === 'R') return 'renamed';
  if (indexStatus === 'C' || worktreeStatus === 'C') return 'copied';
  if (indexStatus === 'T' || worktreeStatus === 'T') return 'type_changed';
  if (indexStatus === 'D' || worktreeStatus === 'D') return 'deleted';
  if (indexStatus === 'A' || worktreeStatus === 'A') return 'added';
  return 'modified';
}

function mapNameStatus(statusCode: string): WorkbenchGitDiffFileStatus {
  const normalized = statusCode.trim().toUpperCase();
  if (normalized.startsWith('R')) return 'renamed';
  if (normalized.startsWith('C')) return 'copied';
  if (normalized.startsWith('A')) return 'added';
  if (normalized.startsWith('D')) return 'deleted';
  if (normalized.startsWith('T')) return 'type_changed';
  if (normalized.startsWith('U')) return 'conflicted';
  if (normalized.startsWith('M')) return 'modified';
  return 'unknown';
}

function parseUnifiedDiff(patch: string): WorkbenchGitDiffFile[] {
  if (!patch.trim()) return [];
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const files: WorkbenchGitDiffFile[] = [];
  let currentFile: WorkbenchGitDiffFile | null = null;
  let currentHunk: WorkbenchGitDiffHunk | null = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  const pushCurrentHunk = (): void => {
    if (!currentFile || !currentHunk) return;
    currentFile.hunks.push(currentHunk);
    currentHunk = null;
  };

  const pushCurrentFile = (): void => {
    if (!currentFile) return;
    pushCurrentHunk();
    files.push(currentFile);
    currentFile = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      pushCurrentFile();
      const { oldPath, path } = parseDiffGitHeader(line);
      currentFile = {
        path,
        oldPath,
        status: 'modified',
        isNew: false,
        isDeleted: false,
        isUntracked: false,
        hunks: [],
      };
      continue;
    }
    if (!currentFile) continue;

    if (line.startsWith('--- ')) {
      const oldPath = parsePatchPath(line.slice(4));
      currentFile.oldPath = oldPath;
      if (oldPath === null) currentFile.isNew = true;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const nextPath = parsePatchPath(line.slice(4));
      if (nextPath) currentFile.path = nextPath;
      if (nextPath === null) currentFile.isDeleted = true;
      continue;
    }
    if (line.startsWith('@@ ')) {
      pushCurrentHunk();
      currentHunk = {
        header: line,
        lines: [],
      };
      const parsed = parseHunkHeader(line);
      oldLineNumber = parsed.oldLine;
      newLineNumber = parsed.newLine;
      continue;
    }
    if (!currentHunk) continue;

    if (line.startsWith('\\')) {
      currentHunk.lines.push({
        type: 'header',
        content: line,
        oldLineNumber: null,
        newLineNumber: null,
      });
      continue;
    }

    const prefix = line[0] ?? '';
    if (prefix === ' ') {
      currentHunk.lines.push(makeDiffLine('context', line, oldLineNumber, newLineNumber));
      oldLineNumber += 1;
      newLineNumber += 1;
      continue;
    }
    if (prefix === '+') {
      currentHunk.lines.push(makeDiffLine('add', line, null, newLineNumber));
      newLineNumber += 1;
      continue;
    }
    if (prefix === '-') {
      currentHunk.lines.push(makeDiffLine('remove', line, oldLineNumber, null));
      oldLineNumber += 1;
    }
  }

  pushCurrentFile();
  return files.filter((file) => file.path);
}

function parseDiffGitHeader(line: string): { oldPath: string | null; path: string } {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (!match) {
    return { oldPath: null, path: line };
  }
  return {
    oldPath: match[1] ?? null,
    path: match[2] ?? match[1] ?? line,
  };
}

function parsePatchPath(rawPath: string): string | null {
  const value = rawPath.trim();
  if (value === '/dev/null') return null;
  if (value.startsWith('a/')) return value.slice(2);
  if (value.startsWith('b/')) return value.slice(2);
  return value;
}

function parseHunkHeader(header: string): { oldLine: number; newLine: number } {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  return {
    oldLine: Number.parseInt(match?.[1] ?? '0', 10),
    newLine: Number.parseInt(match?.[2] ?? '0', 10),
  };
}

function makeDiffLine(
  type: WorkbenchGitDiffLine['type'],
  content: string,
  oldLineNumber: number | null,
  newLineNumber: number | null,
): WorkbenchGitDiffLine {
  return {
    type,
    content,
    oldLineNumber,
    newLineNumber,
  };
}

function buildUntrackedPatch(workspaceRoot: string, relativePath: string): string {
  const result = spawnSync('git', ['diff', '--no-index', '--no-color', '--unified=3', '--', '/dev/null', relativePath], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.stdout ?? '';
}

function emptyDiffFile(meta: DiffFileMeta): WorkbenchGitDiffFile {
  return {
    path: meta.path,
    oldPath: meta.oldPath,
    status: meta.status,
    isNew: meta.isNew,
    isDeleted: meta.isDeleted,
    isUntracked: meta.isUntracked,
    hunks: [],
  };
}

function applyMeta(file: WorkbenchGitDiffFile, meta: DiffFileMeta): WorkbenchGitDiffFile {
  return {
    ...file,
    oldPath: meta.oldPath ?? file.oldPath,
    status: meta.status,
    isNew: meta.isNew,
    isDeleted: meta.isDeleted,
    isUntracked: meta.isUntracked,
  };
}

function mergeDiffFile(
  left: WorkbenchGitDiffFile | undefined,
  right: WorkbenchGitDiffFile,
): WorkbenchGitDiffFile {
  if (!left) return right;
  return {
    ...right,
    oldPath: right.oldPath ?? left.oldPath,
    hunks: [...left.hunks, ...right.hunks],
  };
}

function sortDiffFiles(files: WorkbenchGitDiffFile[]): WorkbenchGitDiffFile[] {
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function formatGitFailure(
  prefix: string,
  result: { stdout: string; stderr: string; status: number | null },
): string {
  const detail = [result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!detail) {
    return result.status != null ? `${prefix} Exit code ${result.status}.` : prefix;
  }
  return `${prefix}\n${detail}`;
}
