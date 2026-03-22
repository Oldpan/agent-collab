import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspacePath, } from '@agent-collab/runtime-acp';
const MAX_PREVIEW_BYTES = 256 * 1024;
export class WorkspaceFsError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export function listWorkspaceDirectory(workspaceRoot, relativePath) {
    ensureWorkspaceScaffold(workspaceRoot);
    const resolved = resolveRelativeWorkspacePath(workspaceRoot, relativePath);
    const stat = fs.statSync(resolved, { throwIfNoEntry: false });
    if (!stat)
        throw new WorkspaceFsError('not_found', 'Path not found.');
    if (!stat.isDirectory())
        throw new WorkspaceFsError('not_directory', 'Path is not a directory.');
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
        };
    })
        .sort((a, b) => {
        if (a.kind !== b.kind)
            return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return {
        relativePath: normalizeRelativePath(relativePath),
        entries,
    };
}
export function readWorkspaceFile(workspaceRoot, relativePath) {
    ensureWorkspaceScaffold(workspaceRoot);
    const resolved = resolveRelativeWorkspacePath(workspaceRoot, relativePath);
    const stat = fs.statSync(resolved, { throwIfNoEntry: false });
    if (!stat)
        throw new WorkspaceFsError('not_found', 'Path not found.');
    if (!stat.isFile())
        throw new WorkspaceFsError('not_file', 'Path is not a file.');
    if (stat.size > MAX_PREVIEW_BYTES) {
        throw new WorkspaceFsError('file_too_large', `File exceeds preview limit (${MAX_PREVIEW_BYTES} bytes).`);
    }
    const contentBuffer = fs.readFileSync(resolved);
    if (looksBinary(contentBuffer)) {
        throw new WorkspaceFsError('binary_file', 'Binary files are not supported for preview.');
    }
    return {
        relativePath: normalizeRelativePath(relativePath),
        content: contentBuffer.toString('utf8'),
        mimeType: resolved.toLowerCase().endsWith('.md') ? 'text/markdown' : 'text/plain',
        size: stat.size,
        modifiedAt: Math.floor(stat.mtimeMs),
    };
}
function resolveRelativeWorkspacePath(workspaceRoot, relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const absoluteRequested = normalized
        ? path.resolve(workspaceRoot, normalized)
        : path.resolve(workspaceRoot);
    try {
        return resolveWorkspacePath(workspaceRoot, absoluteRequested);
    }
    catch {
        throw new WorkspaceFsError('path_outside_workspace', 'Path escapes workspace root.');
    }
}
function ensureWorkspaceScaffold(workspaceRoot) {
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'notes'), { recursive: true });
    const memoryPath = path.join(workspaceRoot, 'MEMORY.md');
    if (!fs.existsSync(memoryPath)) {
        fs.writeFileSync(memoryPath, [
            '# Memory',
            '',
            'Use this file as the durable memory index for this agent.',
            '',
            '## Notes',
            '- Store additional memory files under `notes/`.',
            '',
        ].join('\n'), 'utf8');
    }
}
function normalizeRelativePath(relativePath) {
    return relativePath.replace(/^\/+/, '').trim();
}
function toRelativeWorkspacePath(workspaceRoot, absolutePath) {
    const relative = path.relative(path.resolve(workspaceRoot), path.resolve(absolutePath));
    return relative === '.' ? '' : relative.split(path.sep).join('/');
}
function looksBinary(content) {
    const limit = Math.min(content.length, 8_000);
    for (let index = 0; index < limit; index += 1) {
        if (content[index] === 0)
            return true;
    }
    return false;
}
