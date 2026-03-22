import type { MemoryBackend } from './types.js';
/**
 * Reads <workspacePath>/.agent-collab/memory/MEMORY.md.
 * Used for non-Claude runtimes (codex_acp, etc.) as the platform fallback.
 */
export declare class WorkspaceMemoryBackend implements MemoryBackend {
    private readonly memoryPath;
    constructor(workspacePath: string);
    load(): Promise<string>;
}
