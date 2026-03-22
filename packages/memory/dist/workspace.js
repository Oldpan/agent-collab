import fs from 'node:fs/promises';
import path from 'node:path';
/**
 * Reads <workspacePath>/.agent-collab/memory/MEMORY.md.
 * Used for non-Claude runtimes (codex_acp, etc.) as the platform fallback.
 */
export class WorkspaceMemoryBackend {
    memoryPath;
    constructor(workspacePath) {
        this.memoryPath = path.join(workspacePath, 'MEMORY.md');
    }
    async load() {
        try {
            return await fs.readFile(this.memoryPath, 'utf8');
        }
        catch {
            return '';
        }
    }
}
