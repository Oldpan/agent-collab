import fs from 'node:fs/promises';
import path from 'node:path';
import type { MemoryBackend } from './types.js';

/**
 * Reads <workspacePath>/.agent-collab/memory/MEMORY.md.
 * Used for non-Claude runtimes (codex_acp, etc.) as the platform fallback.
 */
export class WorkspaceMemoryBackend implements MemoryBackend {
  private readonly memoryPath: string;

  constructor(workspacePath: string) {
    this.memoryPath = path.join(workspacePath, 'MEMORY.md');
  }

  async load(): Promise<string> {
    try {
      return await fs.readFile(this.memoryPath, 'utf8');
    } catch {
      return '';
    }
  }
}
