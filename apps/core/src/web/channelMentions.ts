import { extractMentionedNames, type AgentInfo } from '@agent-collab/protocol';

type MentionableAgent = Pick<AgentInfo, 'agentId' | 'name'>;

export function findMentionedAgents(content: string, agents: MentionableAgent[]): MentionableAgent[] {
  const mentioned = new Set(extractMentionedNames(content));

  if (mentioned.size === 0) return [];
  return agents.filter((agent) => mentioned.has(agent.name.toLowerCase()));
}
