import type { MemoryBackend } from './types.js';
/**
 * Reads ~/.claude/projects/<project-key>/memory/MEMORY.md (read-only).
 * Writing is managed by Claude Code itself — the platform never writes here.
 */
export declare class ClaudeMemoryBackend implements MemoryBackend {
    private readonly memoryPath;
    constructor(workspacePath: string);
    load(): Promise<string>;
}
