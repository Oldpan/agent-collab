export class AgentWorkspaceServiceError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}
export class AgentWorkspaceService {
    getAgentById;
    broker;
    constructor(params) {
        this.getAgentById = params.getAgentById;
        this.broker = params.broker;
    }
    async listWorkspace(agentId, relativePath) {
        const agent = this.getAgentById(agentId);
        if (!agent)
            throw new AgentWorkspaceServiceError(404, 'Agent not found.');
        if (!agent.nodeId)
            throw new AgentWorkspaceServiceError(409, 'Agent is not assigned to a remote node.');
        if (!agent.workspacePath)
            throw new AgentWorkspaceServiceError(409, 'Agent has no workspace configured.');
        try {
            return await this.broker.listDirectory(agent.nodeId, agent.workspacePath, relativePath);
        }
        catch (error) {
            throw mapWorkspaceError(error);
        }
    }
    async readWorkspaceFile(agentId, relativePath) {
        const agent = this.getAgentById(agentId);
        if (!agent)
            throw new AgentWorkspaceServiceError(404, 'Agent not found.');
        if (!agent.nodeId)
            throw new AgentWorkspaceServiceError(409, 'Agent is not assigned to a remote node.');
        if (!agent.workspacePath)
            throw new AgentWorkspaceServiceError(409, 'Agent has no workspace configured.');
        try {
            return await this.broker.readFile(agent.nodeId, agent.workspacePath, relativePath);
        }
        catch (error) {
            throw mapWorkspaceError(error);
        }
    }
}
function mapWorkspaceError(error) {
    const message = String(error?.message ?? error);
    if (message === 'Agent node is offline.') {
        return new AgentWorkspaceServiceError(409, message);
    }
    if (message === 'Workspace request timed out.') {
        return new AgentWorkspaceServiceError(504, message);
    }
    if (message.startsWith('not_found:')) {
        return new AgentWorkspaceServiceError(404, message.slice('not_found:'.length));
    }
    if (message.startsWith('path_outside_workspace:')) {
        return new AgentWorkspaceServiceError(400, message.slice('path_outside_workspace:'.length));
    }
    if (message.startsWith('binary_file:')) {
        return new AgentWorkspaceServiceError(415, message.slice('binary_file:'.length));
    }
    if (message.startsWith('file_too_large:')) {
        return new AgentWorkspaceServiceError(413, message.slice('file_too_large:'.length));
    }
    if (message.startsWith('not_directory:') || message.startsWith('not_file:')) {
        return new AgentWorkspaceServiceError(400, message.slice(message.indexOf(':') + 1));
    }
    return new AgentWorkspaceServiceError(500, message);
}
