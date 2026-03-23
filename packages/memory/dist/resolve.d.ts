import type { MemoryBackend } from './types.js';
export declare function resolveMemoryBackend(agentType: string, workspacePath: string): MemoryBackend;
/**
 * Builds the full context text to inject at the start of a fresh ACP session.
 * Combines: system prompt + local native memory (from filesystem).
 * Returns '' if all parts are empty.
 */
export declare function buildAgentContextText(params: {
    systemPrompt: string;
    agentType: string;
    workspacePath: string;
}): Promise<string>;
