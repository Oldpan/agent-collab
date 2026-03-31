import fs from 'node:fs';
import path from 'node:path';

import type { AgentType } from '@agent-collab/protocol';

const MANIFEST_FILENAME = '.agent-collab-managed-links.json';

type EnsureNativeSkillMountsParams = {
  agentType: AgentType;
  workspaceRoot: string;
  skillRoots?: string[];
};

export function ensureNativeSkillMounts(params: EnsureNativeSkillMountsParams): void {
  const mountRoot = resolveMountRoot(params);
  if (!mountRoot) return;

  const normalizedRoots = normalizeRoots(params.skillRoots ?? []);
  fs.mkdirSync(mountRoot, { recursive: true });

  const manifestPath = path.join(mountRoot, MANIFEST_FILENAME);
  const previousEntries = readManifestEntries(manifestPath);
  for (const entryName of previousEntries) {
    removeManagedEntry(path.join(mountRoot, entryName));
  }

  const managedEntries: string[] = [];
  for (const candidate of collectSkillCandidates(normalizedRoots)) {
    const destinationPath = path.join(mountRoot, candidate.name);
    if (fs.existsSync(destinationPath)) {
      continue;
    }
    fs.symlinkSync(candidate.targetPath, destinationPath, 'dir');
    managedEntries.push(candidate.name);
  }

  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ entries: managedEntries }, null, 2)}\n`,
    'utf8',
  );
}

function resolveMountRoot(params: EnsureNativeSkillMountsParams): string | null {
  if (params.agentType === 'codex_acp') {
    return path.join(path.resolve(params.workspaceRoot), '.agents', 'skills');
  }
  if (params.agentType === 'claude_acp') {
    return path.join(path.resolve(params.workspaceRoot), '.claude', 'skills');
  }
  return null;
}

function normalizeRoots(skillRoots: string[]): string[] {
  return skillRoots
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value))
    .filter((value, index, list) => list.indexOf(value) === index)
    .filter((value) => fs.statSync(value, { throwIfNoEntry: false })?.isDirectory() ?? false);
}

function collectSkillCandidates(skillRoots: string[]): Array<{ name: string; targetPath: string }> {
  const seen = new Set<string>();
  const results: Array<{ name: string; targetPath: string }> = [];

  for (const root of skillRoots) {
    const entries = safeReadDir(root);
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (seen.has(entry.name)) continue;

      const targetPath = path.join(root, entry.name);
      const skillFile = path.join(targetPath, 'SKILL.md');
      if (!(fs.statSync(skillFile, { throwIfNoEntry: false })?.isFile() ?? false)) continue;

      seen.add(entry.name);
      results.push({ name: entry.name, targetPath });
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

function safeReadDir(root: string): fs.Dirent[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readManifestEntries(manifestPath: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

function removeManagedEntry(entryPath: string): void {
  try {
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(entryPath);
    }
  } catch {
    // Ignore stale manifest entries and continue rebuilding managed links.
  }
}
