import type {
  AgentType,
  AgentSkillFileResult,
  AgentSkillListResult,
} from '@agent-collab/protocol';
import { AgentSkillsBroker } from './agentSkillsBroker.js';

export class AgentSkillsServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class AgentSkillsService {
  private readonly getAgentById: (agentId: string) => {
    agentId: string;
    agentType: AgentType;
    nodeId?: string | null;
    workspacePath?: string | null;
    skillRoots?: string[];
  } | null;
  private readonly broker: AgentSkillsBroker;

  constructor(params: {
    getAgentById: (agentId: string) => {
      agentId: string;
      agentType: AgentType;
      nodeId?: string | null;
      workspacePath?: string | null;
      skillRoots?: string[];
    } | null;
    broker: AgentSkillsBroker;
  }) {
    this.getAgentById = params.getAgentById;
    this.broker = params.broker;
  }

  async listSkills(agentId: string, skillPath?: string | null): Promise<AgentSkillListResult> {
    const agent = this.getAgentById(agentId);
    if (!agent) throw new AgentSkillsServiceError(404, 'Agent not found.');
    if (!agent.nodeId) throw new AgentSkillsServiceError(409, 'Agent is not assigned to a remote node.');

    const skillRoots = normalizeSkillRoots(agent.skillRoots);
    if (skillRoots.length === 0) {
      throw new AgentSkillsServiceError(409, 'Agent has no skill roots configured.');
    }

    try {
      return await this.broker.listSkills(
        agent.nodeId,
        skillRoots,
        {
          agentType: agent.agentType,
          workspaceRoot: agent.workspacePath ?? null,
        },
        skillPath ?? null,
      );
    } catch (error) {
      throw mapSkillError(error);
    }
  }

  async readSkillFile(agentId: string, skillPath: string): Promise<AgentSkillFileResult> {
    const agent = this.getAgentById(agentId);
    if (!agent) throw new AgentSkillsServiceError(404, 'Agent not found.');
    if (!agent.nodeId) throw new AgentSkillsServiceError(409, 'Agent is not assigned to a remote node.');

    const skillRoots = normalizeSkillRoots(agent.skillRoots);
    if (skillRoots.length === 0) {
      throw new AgentSkillsServiceError(409, 'Agent has no skill roots configured.');
    }

    try {
      return await this.broker.readSkillFile(
        agent.nodeId,
        skillRoots,
        {
          agentType: agent.agentType,
          workspaceRoot: agent.workspacePath ?? null,
        },
        skillPath,
      );
    } catch (error) {
      throw mapSkillError(error);
    }
  }
}

function normalizeSkillRoots(skillRoots?: string[]): string[] {
  return (skillRoots ?? []).map((value) => value.trim()).filter(Boolean);
}

function mapSkillError(error: unknown): AgentSkillsServiceError {
  const message = String((error as Error)?.message ?? error);

  if (message === 'Agent node is offline.') {
    return new AgentSkillsServiceError(409, message);
  }
  if (message === 'Skill request timed out.') {
    return new AgentSkillsServiceError(504, message);
  }
  if (message.startsWith('not_found:')) {
    return new AgentSkillsServiceError(404, message.slice('not_found:'.length));
  }
  if (message.startsWith('path_outside_workspace:')) {
    return new AgentSkillsServiceError(400, message.slice('path_outside_workspace:'.length));
  }
  if (message.startsWith('binary_file:')) {
    return new AgentSkillsServiceError(415, message.slice('binary_file:'.length));
  }
  if (message.startsWith('file_too_large:')) {
    return new AgentSkillsServiceError(413, message.slice('file_too_large:'.length));
  }
  if (message.startsWith('not_directory:') || message.startsWith('not_file:')) {
    return new AgentSkillsServiceError(400, message.slice(message.indexOf(':') + 1));
  }
  return new AgentSkillsServiceError(500, message);
}
