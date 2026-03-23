import { WorkspaceMemoryBackend } from './workspace.js';
import type { MemoryBackend } from './types.js';

export function resolveMemoryBackend(agentType: string, workspacePath: string): MemoryBackend {
  void agentType;
  return new WorkspaceMemoryBackend(workspacePath);
}

function buildLocalMemoryGuide(workspacePath: string): string {
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

/**
 * Builds the full context text to inject at the start of a fresh ACP session.
 * Combines: system prompt + local native memory (from filesystem).
 * Returns '' if all parts are empty.
 */
export async function buildAgentContextText(params: {
  systemPrompt: string;
  agentType: string;
  workspacePath: string;
}): Promise<string> {
  const { systemPrompt, agentType, workspacePath } = params;

  const backend = resolveMemoryBackend(agentType, workspacePath);
  const nativeMemory = await backend.load();

  const parts: string[] = [];
  if (systemPrompt.trim()) parts.push(`[System Prompt]\n${systemPrompt.trim()}`);
  parts.push(`[Local Memory Guide]\n${buildLocalMemoryGuide(workspacePath)}`);
  if (nativeMemory.trim()) parts.push(`[Local Memory]\n${nativeMemory.trim()}`);

  return parts.join('\n\n');
}
