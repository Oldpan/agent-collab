import type { AgentInfo } from '@agent-collab/protocol';

type MentionableAgent = Pick<AgentInfo, 'agentId' | 'name'>;

export function findMentionedAgents(content: string, agents: MentionableAgent[]): MentionableAgent[] {
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  const mentioned = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(content)) !== null) {
    mentioned.add(match[1].toLowerCase());
  }

  if (mentioned.size === 0) return [];
  return agents.filter((agent) => mentioned.has(agent.name.toLowerCase()));
}
