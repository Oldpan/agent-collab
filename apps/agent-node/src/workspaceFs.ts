import fs from 'node:fs';
import path from 'node:path';

import {
  resolveWorkspacePath,
} from '@agent-collab/runtime-acp';
import type {
  AgentWorkspaceEntry,
  WorkspacePreviewMimeType,
  WorkspaceErrorCode,
  WorkspaceWriteMode,
} from '@agent-collab/protocol';

const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 5 * 1024 * 1024;

type WorkspaceListResult = {
  relativePath: string;
  entries: AgentWorkspaceEntry[];
};

type WorkspaceReadResult = {
  relativePath: string;
  content: string;
  mimeType: WorkspacePreviewMimeType;
  size: number;
  modifiedAt: number | null;
};

export class WorkspaceFsError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function listWorkspaceDirectory(
  workspaceRoot: string,
  relativePath: string,
  options?: { scaffold?: boolean },
): WorkspaceListResult {
  if (options?.scaffold !== false) ensureWorkspaceScaffold(workspaceRoot);
  const resolved = resolveRelativeWorkspacePath(workspaceRoot, relativePath);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat) throw new WorkspaceFsError('not_found', 'Path not found.');
  if (!stat.isDirectory()) throw new WorkspaceFsError('not_directory', 'Path is not a directory.');

  const entries = fs
    .readdirSync(resolved, { withFileTypes: true })
    .map((entry) => {
      const absoluteEntry = path.join(resolved, entry.name);
      const entryStat = fs.statSync(absoluteEntry, { throwIfNoEntry: false });
      const childRelativePath = toRelativeWorkspacePath(workspaceRoot, absoluteEntry);
      return {
        name: entry.name,
        path: childRelativePath,
        kind: entry.isDirectory() ? 'directory' : 'file',
        size: entry.isDirectory() ? null : (entryStat?.size ?? null),
        modifiedAt: entryStat?.mtimeMs ? Math.floor(entryStat.mtimeMs) : null,
      } satisfies AgentWorkspaceEntry;
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return {
    relativePath: normalizeRelativePath(relativePath),
    entries,
  };
}

export function readWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  options?: { scaffold?: boolean },
): WorkspaceReadResult {
  if (options?.scaffold !== false) ensureWorkspaceScaffold(workspaceRoot);
  const resolved = resolveRelativeWorkspacePath(workspaceRoot, relativePath);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat) throw new WorkspaceFsError('not_found', 'Path not found.');
  if (!stat.isFile()) throw new WorkspaceFsError('not_file', 'Path is not a file.');
  const mimeType = getPreviewMimeType(resolved);
  const isImage = mimeType.startsWith('image/');
  const maxPreviewBytes = isImage ? MAX_IMAGE_PREVIEW_BYTES : MAX_TEXT_PREVIEW_BYTES;
  if (stat.size > maxPreviewBytes) {
    throw new WorkspaceFsError('file_too_large', `File exceeds preview limit (${maxPreviewBytes} bytes).`);
  }

  const contentBuffer = fs.readFileSync(resolved);
  if (isImage) {
    return {
      relativePath: normalizeRelativePath(relativePath),
      content: `data:${mimeType};base64,${contentBuffer.toString('base64')}`,
      mimeType,
      size: stat.size,
      modifiedAt: Math.floor(stat.mtimeMs),
    };
  }

  if (looksBinary(contentBuffer)) {
    throw new WorkspaceFsError('binary_file', 'Binary files are not supported for preview.');
  }

  return {
    relativePath: normalizeRelativePath(relativePath),
    content: contentBuffer.toString('utf8'),
    mimeType,
    size: stat.size,
    modifiedAt: Math.floor(stat.mtimeMs),
  };
}

export function resetWorkspaceDirectory(workspaceRoot: string): void {
  const resolvedRoot = path.resolve(workspaceRoot);
  if (resolvedRoot === path.parse(resolvedRoot).root) {
    throw new WorkspaceFsError('io_error', 'Refusing to reset filesystem root.');
  }

  fs.mkdirSync(resolvedRoot, { recursive: true });

  for (const entry of fs.readdirSync(resolvedRoot, { withFileTypes: true })) {
    const target = path.join(resolvedRoot, entry.name);
    fs.rmSync(target, { recursive: true, force: true });
  }

  ensureWorkspaceScaffold(resolvedRoot);
}

export function writeWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  content: string,
  mode: WorkspaceWriteMode,
): { relativePath: string; modifiedAt: number | null } {
  ensureWorkspaceScaffold(workspaceRoot);
  const resolved = resolveRelativeWorkspacePath(workspaceRoot, relativePath);

  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const existing = fs.statSync(resolved, { throwIfNoEntry: false });
  if (existing?.isDirectory()) {
    throw new WorkspaceFsError('not_file', 'Path is a directory.');
  }

  if (mode === 'append') {
    fs.appendFileSync(resolved, content, 'utf8');
  } else {
    fs.writeFileSync(resolved, content, 'utf8');
  }

  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  return {
    relativePath: normalizeRelativePath(relativePath),
    modifiedAt: stat?.mtimeMs ? Math.floor(stat.mtimeMs) : null,
  };
}

function resolveRelativeWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const absoluteRequested = normalized
    ? path.resolve(workspaceRoot, normalized)
    : path.resolve(workspaceRoot);

  try {
    return resolveWorkspacePath(workspaceRoot, absoluteRequested);
  } catch {
    throw new WorkspaceFsError('path_outside_workspace', 'Path escapes workspace root.');
  }
}

function ensureWorkspaceScaffold(workspaceRoot: string): void {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'notes', 'channels'), { recursive: true });

  const memoryPath = path.join(workspaceRoot, 'MEMORY.md');
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(
      memoryPath,
      [
        '# Memory',
        '',
        '## Role',
        '- Capture your current role and responsibilities here.',
        '',
        '## Key Knowledge',
        '- Create and use `notes/user-preferences.md` for stable user preferences and conventions as needed.',
        '- Read and extend `notes/channels/` for channel purpose, reset markers, and ongoing context.',
        '- Create and use `notes/domain.md` for domain-specific knowledge and conventions as needed.',
        '- Create and use `notes/work-log.md` for important decisions and completed work as needed.',
        '- Add any other detailed notes under `notes/<topic>.md` as needed.',
        '',
        '## Active Context',
        '- First startup.',
        '',
      ].join('\n'),
      'utf8',
    );
  }
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/^\/+/, '').trim();
}

function toRelativeWorkspacePath(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(absolutePath));
  return relative === '.' ? '' : relative.split(path.sep).join('/');
}

function getPreviewMimeType(filePath: string): WorkspacePreviewMimeType {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith('.md')) return 'text/markdown';
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.gif')) return 'image/gif';
  if (normalized.endsWith('.svg')) return 'image/svg+xml';
  return 'text/plain';
}

function looksBinary(content: Buffer): boolean {
  const limit = Math.min(content.length, 8_000);
  for (let index = 0; index < limit; index += 1) {
    if (content[index] === 0) return true;
  }
  return false;
}
