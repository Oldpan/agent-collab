export class AgentSkillsServiceError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}
export class AgentSkillsService {
    getAgentById;
    broker;
    constructor(params) {
        this.getAgentById = params.getAgentById;
        this.broker = params.broker;
    }
    async listSkills(agentId, skillPath) {
        const agent = this.getAgentById(agentId);
        if (!agent)
            throw new AgentSkillsServiceError(404, 'Agent not found.');
        if (!agent.nodeId)
            throw new AgentSkillsServiceError(409, 'Agent is not assigned to a remote node.');
        const skillRoots = normalizeSkillRoots(agent.skillRoots);
        if (skillRoots.length === 0) {
            throw new AgentSkillsServiceError(409, 'Agent has no skill roots configured.');
        }
        try {
            return await this.broker.listSkills(agent.nodeId, skillRoots, {
                agentType: agent.agentType,
                workspaceRoot: agent.workspacePath ?? null,
            }, skillPath ?? null);
        }
        catch (error) {
            throw mapSkillError(error);
        }
    }
    async readSkillFile(agentId, skillPath) {
        const agent = this.getAgentById(agentId);
        if (!agent)
            throw new AgentSkillsServiceError(404, 'Agent not found.');
        if (!agent.nodeId)
            throw new AgentSkillsServiceError(409, 'Agent is not assigned to a remote node.');
        const skillRoots = normalizeSkillRoots(agent.skillRoots);
        if (skillRoots.length === 0) {
            throw new AgentSkillsServiceError(409, 'Agent has no skill roots configured.');
        }
        try {
            return await this.broker.readSkillFile(agent.nodeId, skillRoots, {
                agentType: agent.agentType,
                workspaceRoot: agent.workspacePath ?? null,
            }, skillPath);
        }
        catch (error) {
            throw mapSkillError(error);
        }
    }
}
function normalizeSkillRoots(skillRoots) {
    return (skillRoots ?? []).map((value) => value.trim()).filter(Boolean);
}
function mapSkillError(error) {
    const message = String(error?.message ?? error);
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
