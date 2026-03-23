import { WorkspaceMemoryBackend } from './workspace.js';
export function resolveMemoryBackend(agentType, workspacePath) {
    void agentType;
    return new WorkspaceMemoryBackend(workspacePath);
}
/**
 * Builds the full context text to inject at the start of a fresh ACP session.
 * Combines: system prompt + local native memory (from filesystem).
 * Returns '' if all parts are empty.
 */
export async function buildAgentContextText(params) {
    const { systemPrompt, agentType, workspacePath } = params;
    const backend = resolveMemoryBackend(agentType, workspacePath);
    const nativeMemory = await backend.load();
    const parts = [];
    if (systemPrompt.trim())
        parts.push(`[System Prompt]\n${systemPrompt.trim()}`);
    if (nativeMemory.trim())
        parts.push(`[Local Memory]\n${nativeMemory.trim()}`);
    return parts.join('\n\n');
}
