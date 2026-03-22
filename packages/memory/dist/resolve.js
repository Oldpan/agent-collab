import { ClaudeMemoryBackend } from './claude.js';
import { WorkspaceMemoryBackend } from './workspace.js';
export function resolveMemoryBackend(agentType, workspacePath) {
    if (agentType === 'claude_acp') {
        return new ClaudeMemoryBackend(workspacePath);
    }
    return new WorkspaceMemoryBackend(workspacePath);
}
/**
 * Builds the full context text to inject at the start of a fresh ACP session.
 * Combines: system prompt + platform memory (from DB) + local native memory (from filesystem).
 * Returns '' if all parts are empty.
 */
export async function buildAgentContextText(params) {
    const { systemPrompt, memory, agentType, workspacePath } = params;
    const backend = resolveMemoryBackend(agentType, workspacePath);
    const nativeMemory = await backend.load();
    const parts = [];
    if (systemPrompt.trim())
        parts.push(`[System Prompt]\n${systemPrompt.trim()}`);
    if (memory.trim())
        parts.push(`[Platform Memory]\n${memory.trim()}`);
    if (nativeMemory.trim())
        parts.push(`[Local Memory]\n${nativeMemory.trim()}`);
    return parts.join('\n\n');
}
