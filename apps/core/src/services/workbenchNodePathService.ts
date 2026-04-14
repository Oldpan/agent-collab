import type {
  AgentWorkspaceFileResult,
  AgentWorkspaceListResult,
} from '@agent-collab/protocol';
import { AgentWorkspaceBroker } from './agentWorkspaceBroker.js';

export class WorkbenchNodePathServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class WorkbenchNodePathService {
  private readonly broker: AgentWorkspaceBroker;

  constructor(params: { broker: AgentWorkspaceBroker }) {
    this.broker = params.broker;
  }

  async listTree(nodeId: string | null, rootPath: string, relativePath: string): Promise<AgentWorkspaceListResult> {
    if (!nodeId) throw new WorkbenchNodePathServiceError(409, 'Project root is not bound to a remote node.');

    try {
      return await this.broker.listDirectory(nodeId, rootPath, relativePath, { scaffold: false });
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  }

  async readFile(nodeId: string | null, rootPath: string, relativePath: string): Promise<AgentWorkspaceFileResult> {
    if (!nodeId) throw new WorkbenchNodePathServiceError(409, 'Project root is not bound to a remote node.');

    try {
      return await this.broker.readFile(nodeId, rootPath, relativePath, { scaffold: false });
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  }
}

function mapWorkspaceError(error: unknown): WorkbenchNodePathServiceError {
  const message = String((error as Error)?.message ?? error);

  if (message === 'Agent node is offline.') {
    return new WorkbenchNodePathServiceError(409, message);
  }
  if (message === 'Workspace request timed out.') {
    return new WorkbenchNodePathServiceError(504, message);
  }
  if (message.startsWith('not_found:')) {
    return new WorkbenchNodePathServiceError(404, message.slice('not_found:'.length));
  }
  if (message.startsWith('path_outside_workspace:')) {
    return new WorkbenchNodePathServiceError(400, message.slice('path_outside_workspace:'.length));
  }
  if (message.startsWith('binary_file:')) {
    return new WorkbenchNodePathServiceError(415, message.slice('binary_file:'.length));
  }
  if (message.startsWith('file_too_large:')) {
    return new WorkbenchNodePathServiceError(413, message.slice('file_too_large:'.length));
  }
  if (message.startsWith('not_directory:') || message.startsWith('not_file:')) {
    return new WorkbenchNodePathServiceError(400, message.slice(message.indexOf(':') + 1));
  }
  return new WorkbenchNodePathServiceError(500, message);
}
