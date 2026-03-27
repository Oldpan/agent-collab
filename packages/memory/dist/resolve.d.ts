import type { MemoryBackend } from './types.js';
export declare function resolveMemoryBackend(agentType: string, workspacePath: string): MemoryBackend;
export declare function buildAgentSessionSystemPromptText(params: {
    agentName: string;
    agentDescription?: string;
    workspacePath: string;
    toolPrefix?: string;
}): string;
/**
 * Builds the non-system context text to inject at the start of a fresh ACP session.
 * Combines: local memory guide + local native memory (from filesystem).
 *
 * agentDescription is intentionally excluded here and belongs in the true system prompt.
 * toolPrefix controls the MCP tool name prefix (default: 'mcp__chat__').
 */
export declare function buildAgentContextText(params: {
    agentName: string;
    agentDescription?: string;
    agentType: string;
    workspacePath: string;
    toolPrefix?: string;
}): Promise<string>;
