import { WorkspaceMemoryBackend } from './workspace.js';
import type { MemoryBackend } from './types.js';

export function resolveMemoryBackend(agentType: string, workspacePath: string): MemoryBackend {
  void agentType;
  return new WorkspaceMemoryBackend(workspacePath);
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
  if (nativeMemory.trim()) parts.push(`[Local Memory]\n${nativeMemory.trim()}`);

  return parts.join('\n\n');
}
