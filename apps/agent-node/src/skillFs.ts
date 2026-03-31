import fs from 'node:fs';
import path from 'node:path';

import type {
  AgentSkillEntry,
  AgentSkillListResult,
  AgentSkillSummary,
} from '@agent-collab/protocol';
import { WorkspaceFsError } from './workspaceFs.js';

const MAX_PREVIEW_BYTES = 256 * 1024;

type SkillReadResult = {
  path: string;
  content: string;
  mimeType: 'text/markdown' | 'text/plain';
  size: number;
  modifiedAt: number | null;
};

export function listSkills(
  skillRoots: string[],
  requestedPath?: string | null,
): AgentSkillListResult {
  const roots = normalizeRoots(skillRoots);
  if (roots.length === 0) {
    return { path: null, roots: [], skills: [], entries: [] };
  }

  if (requestedPath?.trim()) {
    const resolvedPath = resolveSkillPath(roots, requestedPath);
    const stat = fs.statSync(resolvedPath, { throwIfNoEntry: false });
    if (!stat) throw new WorkspaceFsError('not_found', 'Path not found.');
    if (!stat.isDirectory()) throw new WorkspaceFsError('not_directory', 'Path is not a directory.');

    return {
      path: resolvedPath,
      roots,
      skills: [],
      entries: listDirectoryEntries(resolvedPath),
    };
  }

  const seen = new Set<string>();
  const skills: AgentSkillSummary[] = [];

  for (const root of roots) {
    for (const skill of scanSkillRoot(root)) {
      if (seen.has(skill.path)) continue;
      seen.add(skill.path);
      skills.push(skill);
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return {
    path: null,
    roots,
    skills,
    entries: [],
  };
}

export function readSkillFile(
  skillRoots: string[],
  skillPath: string,
): SkillReadResult {
  const roots = normalizeRoots(skillRoots);
  const resolvedPath = resolveSkillPath(roots, skillPath);
  const stat = fs.statSync(resolvedPath, { throwIfNoEntry: false });
  if (!stat) throw new WorkspaceFsError('not_found', 'Path not found.');
  if (!stat.isFile()) throw new WorkspaceFsError('not_file', 'Path is not a file.');
  if (stat.size > MAX_PREVIEW_BYTES) {
    throw new WorkspaceFsError('file_too_large', `File exceeds preview limit (${MAX_PREVIEW_BYTES} bytes).`);
  }

  const contentBuffer = fs.readFileSync(resolvedPath);
  if (looksBinary(contentBuffer)) {
    throw new WorkspaceFsError('binary_file', 'Binary files are not supported for preview.');
  }

  return {
    path: resolvedPath,
    content: contentBuffer.toString('utf8'),
    mimeType: resolvedPath.toLowerCase().endsWith('.md') ? 'text/markdown' : 'text/plain',
    size: stat.size,
    modifiedAt: Math.floor(stat.mtimeMs),
  };
}

function normalizeRoots(skillRoots: string[]): string[] {
  return skillRoots
    .map((value) => path.resolve(value.trim()))
    .filter((value) => value && path.isAbsolute(value))
    .filter((value, index, list) => list.indexOf(value) === index)
    .filter((value) => {
      const stat = fs.statSync(value, { throwIfNoEntry: false });
      return Boolean(stat?.isDirectory());
    });
}

function resolveSkillPath(roots: string[], candidatePath: string): string {
  if (!path.isAbsolute(candidatePath)) {
    throw new WorkspaceFsError('path_outside_workspace', 'Skill path must be absolute.');
  }

  const resolved = path.resolve(candidatePath);
  const allowed = roots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!allowed) {
    throw new WorkspaceFsError('path_outside_workspace', 'Path escapes configured skill roots.');
  }
  return resolved;
}

function listDirectoryEntries(directoryPath: string): AgentSkillEntry[] {
  return fs.readdirSync(directoryPath, { withFileTypes: true }).map((entry) => {
    const absoluteEntry = path.join(directoryPath, entry.name);
    const entryStat = fs.statSync(absoluteEntry, { throwIfNoEntry: false });
    return {
      name: entry.name,
      path: absoluteEntry,
      kind: entry.isDirectory() ? 'directory' : 'file',
      size: entry.isDirectory() ? null : (entryStat?.size ?? null),
      modifiedAt: entryStat?.mtimeMs ? Math.floor(entryStat.mtimeMs) : null,
    } satisfies AgentSkillEntry;
  }).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function scanSkillRoot(root: string): AgentSkillSummary[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: AgentSkillSummary[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const skillPath = path.join(root, entry.name, 'SKILL.md');
      const stat = fs.statSync(skillPath, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      skills.push(parseSkillSummary(entry.name, skillPath, root));
    }
  }

  return skills;
}

function parseSkillSummary(defaultName: string, skillPath: string, sourceRoot: string): AgentSkillSummary {
  const summary: AgentSkillSummary = {
    name: defaultName,
    path: skillPath,
    sourceRoot,
  };

  try {
    const content = fs.readFileSync(skillPath, 'utf8');
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) return summary;

    for (const line of frontmatter[1].split('\n')) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      if (key === 'name' && value) summary.name = value;
      if (key === 'description' && value) summary.description = value;
    }
  } catch {
    // Ignore malformed or unreadable frontmatter and fall back to basename metadata.
  }

  return summary;
}

function looksBinary(content: Buffer): boolean {
  const limit = Math.min(content.length, 8_000);
  for (let index = 0; index < limit; index += 1) {
    if (content[index] === 0) return true;
  }
  return false;
}
