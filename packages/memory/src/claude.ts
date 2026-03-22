import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MemoryBackend } from './types.js';

/** Max lines to read from MEMORY.md — Claude only auto-loads the first 200 lines */
const MAX_LINES = 200;

/**
 * Derives the Claude project key from a workspace path.
 * Claude maps absolute paths by replacing all '/' with '-' and prepending '-'.
 * e.g. /ai/code/agi/agent-collab → -ai-code-agi-agent-collab
 */
function deriveClaudeProjectKey(workspacePath: string): string {
  return workspacePath.replace(/\//g, '-');
}

/**
 * Reads ~/.claude/projects/<project-key>/memory/MEMORY.md (read-only).
 * Writing is managed by Claude Code itself — the platform never writes here.
 */
export class ClaudeMemoryBackend implements MemoryBackend {
  private readonly memoryPath: string;

  constructor(workspacePath: string) {
    const projectKey = deriveClaudeProjectKey(workspacePath);
    this.memoryPath = path.join(os.homedir(), '.claude', 'projects', projectKey, 'memory', 'MEMORY.md');
  }

  async load(): Promise<string> {
    try {
      const content = await fs.readFile(this.memoryPath, 'utf8');
      const lines = content.split('\n');
      if (lines.length <= MAX_LINES) return content;
      return lines.slice(0, MAX_LINES).join('\n');
    } catch {
      return '';
    }
  }
}
