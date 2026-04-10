import { WorkspaceMemoryBackend } from './workspace.js';
import type { MemoryBackend } from './types.js';
import { buildAgentSystemPrompt } from './systemPrompt.js';

export function resolveMemoryBackend(agentType: string, workspacePath: string): MemoryBackend {
  void agentType;
  return new WorkspaceMemoryBackend(workspacePath);
}

function buildLocalMemoryGuide(workspacePath: string): string {
  void workspacePath;
  return '';
}

export function buildAgentSessionSystemPromptText(params: {
  agentName: string;
  agentBio?: string;
  agentDescription?: string;
  workspacePath: string;
  toolPrefix?: string;
}): string {
  const { agentName, agentBio, agentDescription, workspacePath, toolPrefix = 'mcp__chat__' } = params;

  return buildAgentSystemPrompt(
    { name: agentName, bio: agentBio, description: agentDescription },
    { toolPrefix, workspacePath, includeStdinNotification: true },
  );
}

/**
 * Local memory is no longer pre-injected into fresh ACP sessions.
 * Agents read MEMORY.md and any needed notes directly from the workspace.
 */
export async function buildAgentContextText(params: {
  agentName: string;
  agentDescription?: string;
  agentType: string;
  workspacePath: string;
  toolPrefix?: string;
}): Promise<string> {
  void params;
  return '';
}
