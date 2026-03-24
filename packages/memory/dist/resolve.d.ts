import type { MemoryBackend } from './types.js';
export declare function resolveMemoryBackend(agentType: string, workspacePath: string): MemoryBackend;
/**
 * Builds the full context text to inject at the start of a fresh ACP session.
 * Combines: dynamic system prompt + local memory guide + local native memory (from filesystem).
 *
 * agentDescription is the agent's role description (previously stored as systemPrompt in DB).
 * toolPrefix controls the MCP tool name prefix (default: 'mcp__chat__').
 */
export declare function buildAgentContextText(params: {
    agentName: string;
    agentDescription?: string;
    agentType: string;
    workspacePath: string;
    toolPrefix?: string;
}): Promise<string>;
