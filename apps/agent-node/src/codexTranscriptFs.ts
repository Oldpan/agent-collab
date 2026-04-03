import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CodexTranscriptFileEntry, WorkspaceErrorCode } from '@agent-collab/protocol';

const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

type CodexTranscriptListResult = {
  rootPath: string;
  files: CodexTranscriptFileEntry[];
  truncated: boolean;
};

type CodexTranscriptReadResult = {
  rootPath: string;
  path: string;
  content: string;
  size: number;
  modifiedAt: number | null;
};

export class CodexTranscriptFsError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function listCodexTranscriptFiles(maxFiles = 1000): CodexTranscriptListResult {
  const rootPath = CODEX_SESSIONS_ROOT;
  const files: CodexTranscriptFileEntry[] = [];
  const normalizedMax = Math.max(1, Math.min(maxFiles, 5000));

  const rootStat = fs.statSync(rootPath, { throwIfNoEntry: false });
  if (!rootStat) {
    return { rootPath, files: [], truncated: false };
  }
  if (!rootStat.isDirectory()) {
    throw new CodexTranscriptFsError('not_directory', 'Codex sessions root is not a directory.');
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
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      files.push({
        path: toRelativeTranscriptPath(absolutePath),
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

export function readCodexTranscriptFile(relativePath: string): CodexTranscriptReadResult {
  const rootPath = CODEX_SESSIONS_ROOT;
  const absolutePath = resolveTranscriptPath(relativePath);
  const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
  if (!stat) throw new CodexTranscriptFsError('not_found', 'Codex transcript not found.');
  if (!stat.isFile()) throw new CodexTranscriptFsError('not_file', 'Codex transcript path is not a file.');
  if (stat.size > MAX_TRANSCRIPT_BYTES) {
    throw new CodexTranscriptFsError('file_too_large', `Codex transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes.`);
  }

  const contentBuffer = fs.readFileSync(absolutePath);
  if (looksBinary(contentBuffer)) {
    throw new CodexTranscriptFsError('binary_file', 'Codex transcript is not a text file.');
  }

  return {
    rootPath,
    path: normalizeRelativePath(relativePath),
    content: contentBuffer.toString('utf8'),
    size: stat.size,
    modifiedAt: Math.floor(stat.mtimeMs),
  };
}

function resolveTranscriptPath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const absolutePath = path.resolve(CODEX_SESSIONS_ROOT, normalized);
  const rootPath = path.resolve(CODEX_SESSIONS_ROOT);
  if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}${path.sep}`)) {
    throw new CodexTranscriptFsError('path_outside_workspace', 'Transcript path escapes Codex sessions root.');
  }
  return absolutePath;
}

function toRelativeTranscriptPath(absolutePath: string): string {
  const relative = path.relative(path.resolve(CODEX_SESSIONS_ROOT), path.resolve(absolutePath));
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
