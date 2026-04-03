import fs from 'node:fs';
import path from 'node:path';

import type { CodexTranscriptFileEntry, WorkspaceErrorCode } from '@agent-collab/protocol';

const CLAUDE_RUNTIME_DIRNAME = '.claude-runtime';
const CLAUDE_PROJECTS_DIRNAME = 'projects';
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

type ClaudeTranscriptListResult = {
  rootPath: string;
  files: CodexTranscriptFileEntry[];
  truncated: boolean;
};

type ClaudeTranscriptReadResult = {
  rootPath: string;
  path: string;
  content: string;
  size: number;
  modifiedAt: number | null;
};

export class ClaudeTranscriptFsError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function listClaudeTranscriptFiles(workspaceRoot: string, maxFiles = 1000): ClaudeTranscriptListResult {
  const rootPath = getClaudeProjectsRoot(workspaceRoot);
  const files: CodexTranscriptFileEntry[] = [];
  const normalizedMax = Math.max(1, Math.min(maxFiles, 5000));

  const rootStat = fs.statSync(rootPath, { throwIfNoEntry: false });
  if (!rootStat) {
    return { rootPath, files: [], truncated: false };
  }
  if (!rootStat.isDirectory()) {
    throw new ClaudeTranscriptFsError('not_directory', 'Claude transcript root is not a directory.');
  }

  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      files.push({
        path: toRelativeTranscriptPath(rootPath, absolutePath),
        size: stat.size,
        modifiedAt: Math.floor(stat.mtimeMs),
      });
    }
  }

  files.sort((a, b) => {
    if (a.modifiedAt !== b.modifiedAt) return b.modifiedAt - a.modifiedAt;
    return a.path.localeCompare(b.path);
  });

  return {
    rootPath,
    files: files.slice(0, normalizedMax),
    truncated: files.length > normalizedMax,
  };
}

export function readClaudeTranscriptFile(workspaceRoot: string, relativePath: string): ClaudeTranscriptReadResult {
  const rootPath = getClaudeProjectsRoot(workspaceRoot);
  const absolutePath = resolveTranscriptPath(rootPath, relativePath);
  const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
  if (!stat) throw new ClaudeTranscriptFsError('not_found', 'Claude transcript not found.');
  if (!stat.isFile()) throw new ClaudeTranscriptFsError('not_file', 'Claude transcript path is not a file.');
  if (stat.size > MAX_TRANSCRIPT_BYTES) {
    throw new ClaudeTranscriptFsError('file_too_large', `Claude transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes.`);
  }

  const contentBuffer = fs.readFileSync(absolutePath);
  if (looksBinary(contentBuffer)) {
    throw new ClaudeTranscriptFsError('binary_file', 'Claude transcript is not a text file.');
  }

  return {
    rootPath,
    path: normalizeRelativePath(relativePath),
    content: contentBuffer.toString('utf8'),
    size: stat.size,
    modifiedAt: Math.floor(stat.mtimeMs),
  };
}

function getClaudeProjectsRoot(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), CLAUDE_RUNTIME_DIRNAME, CLAUDE_PROJECTS_DIRNAME);
}

function resolveTranscriptPath(rootPath: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const absolutePath = path.resolve(rootPath, normalized);
  const resolvedRoot = path.resolve(rootPath);
  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ClaudeTranscriptFsError('path_outside_workspace', 'Transcript path escapes Claude transcript root.');
  }
  return absolutePath;
}

function toRelativeTranscriptPath(rootPath: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(rootPath), path.resolve(absolutePath));
  return normalizeRelativePath(relative);
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/^\/+/, '').split(path.sep).join('/').trim();
}

function looksBinary(content: Buffer): boolean {
  const limit = Math.min(content.length, 8000);
  for (let index = 0; index < limit; index += 1) {
    if (content[index] === 0) return true;
  }
  return false;
}
