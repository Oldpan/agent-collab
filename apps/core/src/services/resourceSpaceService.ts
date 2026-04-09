import type {
  ResourceFileResult,
  ResourceSpaceBackendType,
  ResourceTreeResult,
} from '@agent-collab/protocol';
import { AgentWorkspaceBroker } from './agentWorkspaceBroker.js';
import type { NodeRegistry } from './nodeRegistry.js';

type ResourceSpaceRecord = {
  resourceSpaceId: string;
  backendType: ResourceSpaceBackendType;
  nodeId?: string | null;
  rootPath: string;
};

export class ResourceSpaceServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class ResourceSpaceService {
  private readonly getResourceSpaceById: (resourceSpaceId: string) => ResourceSpaceRecord | null;
  private readonly broker: AgentWorkspaceBroker;
  private readonly nodeRegistry: NodeRegistry;

  constructor(params: {
    getResourceSpaceById: (resourceSpaceId: string) => ResourceSpaceRecord | null;
    broker: AgentWorkspaceBroker;
    nodeRegistry: NodeRegistry;
  }) {
    this.getResourceSpaceById = params.getResourceSpaceById;
    this.broker = params.broker;
    this.nodeRegistry = params.nodeRegistry;
  }

  async listTree(resourceSpaceId: string, relativePath: string): Promise<ResourceTreeResult> {
    const resourceSpace = this.getResourceSpaceById(resourceSpaceId);
    if (!resourceSpace) throw new ResourceSpaceServiceError(404, 'Resource space not found.');

    try {
      return await this.withResolvedNode(
        resourceSpace,
        async (nodeId) => this.broker.listDirectory(nodeId, resourceSpace.rootPath, relativePath, { scaffold: false }),
      );
    } catch (error) {
      throw mapResourceSpaceError(error);
    }
  }

  async readFile(resourceSpaceId: string, relativePath: string): Promise<ResourceFileResult> {
    const resourceSpace = this.getResourceSpaceById(resourceSpaceId);
    if (!resourceSpace) throw new ResourceSpaceServiceError(404, 'Resource space not found.');

    try {
      return await this.withResolvedNode(
        resourceSpace,
        async (nodeId) => this.broker.readFile(nodeId, resourceSpace.rootPath, relativePath, { scaffold: false }),
      );
    } catch (error) {
      throw mapResourceSpaceError(error);
    }
  }

  private async withResolvedNode<T>(
    resourceSpace: ResourceSpaceRecord,
    operation: (nodeId: string) => Promise<T>,
  ): Promise<T> {
    const candidateNodeIds = this.resolveCandidateNodeIds(resourceSpace);
    let lastError: unknown = null;

    for (const nodeId of candidateNodeIds) {
      try {
        return await operation(nodeId);
      } catch (error) {
        lastError = error;
        if (resourceSpace.backendType === 'shared_mount' && canTryNextSharedNode(error)) {
          continue;
        }
        throw error;
      }
    }

    throw lastError ?? new Error('No node could access this resource space.');
  }

  private resolveCandidateNodeIds(resourceSpace: ResourceSpaceRecord): string[] {
    if (resourceSpace.backendType === 'node_path') {
      if (!resourceSpace.nodeId) {
        throw new ResourceSpaceServiceError(409, 'Resource space is missing its node binding.');
      }
      return [resourceSpace.nodeId];
    }

    const onlineNodes = this.nodeRegistry
      .listNodes()
      .sort((a, b) => b.lastSeen - a.lastSeen);
    const preferredNodeId = resourceSpace.nodeId ?? null;
    const preferred = preferredNodeId
      ? onlineNodes.filter((node) => node.nodeId === preferredNodeId).map((node) => node.nodeId)
      : [];
    const fallbacks = onlineNodes
      .filter((node) => node.nodeId !== preferredNodeId)
      .map((node) => node.nodeId);
    const candidateNodeIds = [...preferred, ...fallbacks];

    if (candidateNodeIds.length === 0) {
      throw new ResourceSpaceServiceError(409, 'No online node can currently access this shared resource space.');
    }

    return candidateNodeIds;
  }
}

function canTryNextSharedNode(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return (
    message === 'Agent node is offline.'
    || message === 'Workspace request timed out.'
    || message.startsWith('not_found:')
    || message.startsWith('not_directory:')
    || message.startsWith('not_file:')
    || message.startsWith('io_error:')
  );
}

function mapResourceSpaceError(error: unknown): ResourceSpaceServiceError {
  if (error instanceof ResourceSpaceServiceError) {
    return error;
  }

  const message = String((error as Error)?.message ?? error);

  if (message === 'Agent node is offline.') {
    return new ResourceSpaceServiceError(409, message);
  }
  if (message === 'Workspace request timed out.') {
    return new ResourceSpaceServiceError(504, message);
  }
  if (message.startsWith('not_found:')) {
    return new ResourceSpaceServiceError(404, message.slice('not_found:'.length));
  }
  if (message.startsWith('path_outside_workspace:')) {
    return new ResourceSpaceServiceError(400, message.slice('path_outside_workspace:'.length));
  }
  if (message.startsWith('binary_file:')) {
    return new ResourceSpaceServiceError(415, message.slice('binary_file:'.length));
  }
  if (message.startsWith('file_too_large:')) {
    return new ResourceSpaceServiceError(413, message.slice('file_too_large:'.length));
  }
  if (message.startsWith('not_directory:') || message.startsWith('not_file:')) {
    return new ResourceSpaceServiceError(400, message.slice(message.indexOf(':') + 1));
  }
  return new ResourceSpaceServiceError(500, message);
}
