import { WorkspaceMemoryBackend } from './workspace.js';
import { buildAgentSystemPrompt } from './systemPrompt.js';
export function resolveMemoryBackend(agentType, workspacePath) {
    void agentType;
    return new WorkspaceMemoryBackend(workspacePath);
}
function buildLocalMemoryGuide(workspacePath) {
    return [
        'Local memory is stored as ordinary workspace files, not as MCP resources.',
        `Workspace root: \`${workspacePath}\``,
        'Use normal file read/edit tools against these paths when you need to inspect or update memory:',
        '- `MEMORY.md`',
        '- `notes/*.md`',
        'Do not use MCP resource-reading tools such as `ReadMcpResourceTool` for local memory files.',
        'If a memory read/write attempt fails, do not loop on the same failing tool call. Switch to normal workspace file tools or explain the concrete blocker.',
    ].join('\n');
}
export function buildAgentSessionSystemPromptText(params) {
    const { agentName, agentDescription, workspacePath, toolPrefix = 'mcp__chat__' } = params;
    return buildAgentSystemPrompt({ name: agentName, description: agentDescription }, { toolPrefix, workspacePath, includeStdinNotification: true });
}
/**
 * Builds the non-system context text to inject at the start of a fresh ACP session.
 * Combines: local memory guide + local native memory (from filesystem).
 *
 * agentDescription is intentionally excluded here and belongs in the true system prompt.
 * toolPrefix controls the MCP tool name prefix (default: 'mcp__chat__').
 */
export async function buildAgentContextText(params) {
    const { agentType, workspacePath } = params;
    const backend = resolveMemoryBackend(agentType, workspacePath);
    const nativeMemory = await backend.load();
    const parts = [];
    parts.push(`[Local Memory Guide]\n${buildLocalMemoryGuide(workspacePath)}`);
    if (nativeMemory.trim())
        parts.push(`[Local Memory]\n${nativeMemory.trim()}`);
    return parts.join('\n\n');
}
