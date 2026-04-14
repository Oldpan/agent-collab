import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  AgentInfo,
  ResourceSpaceInfo,
  WorkbenchRootInfo,
} from '@agent-collab/protocol';
import type { NodeRegistry } from './nodeRegistry.js';

export type ResolvedWorkbenchRoot = WorkbenchRootInfo & {
  rootPath: string;
};

export class WorkbenchRootService {
  private readonly getAgentById: (agentId: string) => AgentInfo | null;
  private readonly listAgents: () => AgentInfo[];
  private readonly getResourceSpaceById: (resourceSpaceId: string) => ResourceSpaceInfo | null;
  private readonly listResourceSpaces: () => ResourceSpaceInfo[];
  private readonly nodeRegistry: NodeRegistry;

  constructor(params: {
    getAgentById: (agentId: string) => AgentInfo | null;
    listAgents: () => AgentInfo[];
    getResourceSpaceById: (resourceSpaceId: string) => ResourceSpaceInfo | null;
    listResourceSpaces: () => ResourceSpaceInfo[];
    nodeRegistry: NodeRegistry;
  }) {
    this.getAgentById = params.getAgentById;
    this.listAgents = params.listAgents;
    this.getResourceSpaceById = params.getResourceSpaceById;
    this.listResourceSpaces = params.listResourceSpaces;
    this.nodeRegistry = params.nodeRegistry;
  }

  static buildAgentRootId(agentId: string): string {
    return `agent:${agentId}`;
  }

  static buildProjectRootId(nodeId: string, projectPath: string): string {
    const digest = createHash('sha1')
      .update(nodeId)
      .update('\0')
      .update(canonicalizeWorkbenchRootPath(projectPath))
      .digest('hex')
      .slice(0, 16);
    return `project:${nodeId}:${digest}`;
  }

  static buildResourceRootId(resourceSpaceId: string): string {
    return `resource:${resourceSpaceId}`;
  }

  listRoots(): WorkbenchRootInfo[] {
    const projectRoots = this.listProjectRoots();
    const resourceRoots = this.listResourceSpaces()
      .map((resourceSpace) => this.resourceSpaceToRoot(resourceSpace));
    return [...projectRoots, ...resourceRoots];
  }

  getRoot(rootId: string): ResolvedWorkbenchRoot | null {
    const parsed = parseWorkbenchRootId(rootId);
    if (!parsed) return null;

    if (parsed.kind === 'agent_workspace') {
      const agent = this.getAgentById(parsed.id);
      const root = agent ? this.agentToMemoryRoot(agent) : null;
      return root ? { ...root, rootPath: canonicalizeWorkbenchRootPath(agent!.workspacePath!) } : null;
    }

    if (parsed.kind === 'project_space') {
      const root = this.listProjectRoots().find((entry) => entry.workbenchRootId === rootId) ?? null;
      return root ? { ...root, rootPath: canonicalizeWorkbenchRootPath(root.rootPath) } : null;
    }

    const resourceSpace = this.getResourceSpaceById(parsed.id);
    const root = resourceSpace ? this.resourceSpaceToRoot(resourceSpace) : null;
    return root ? { ...root, rootPath: canonicalizeWorkbenchRootPath(resourceSpace!.rootPath) } : null;
  }

  private listProjectRoots(): WorkbenchRootInfo[] {
    const grouped = new Map<string, AgentInfo[]>();
    for (const agent of this.listAgents()) {
      const nodeId = agent.nodeId?.trim() || null;
      const projectPath = agent.projectPath?.trim() || null;
      if (!nodeId || !projectPath || !isAbsoluteWorkbenchRootPath(projectPath)) continue;
      const canonicalProjectPath = canonicalizeWorkbenchRootPath(projectPath);
      const key = `${nodeId}\u0000${canonicalProjectPath}`;
      const bucket = grouped.get(key);
      if (bucket) {
        bucket.push(agent);
      } else {
        grouped.set(key, [agent]);
      }
    }

    return [...grouped.entries()]
      .map(([key, agents]) => {
        const [nodeId, projectPath] = key.split('\u0000');
        return this.projectAgentsToRoot(nodeId!, projectPath!, agents);
      })
      .filter((root): root is WorkbenchRootInfo => !!root);
  }

  private agentToMemoryRoot(agent: AgentInfo): WorkbenchRootInfo | null {
    if (!agent.workspacePath) return null;
    const node = agent.nodeId ? this.nodeRegistry.getNode(agent.nodeId) : null;
    const terminalSupported = Boolean(agent.nodeId && node?.terminalBackendAvailable);
    return {
      workbenchRootId: WorkbenchRootService.buildAgentRootId(agent.agentId),
      kind: 'agent_workspace',
      displayName: agent.name,
      rootPath: canonicalizeWorkbenchRootPath(agent.workspacePath),
      nodeId: agent.nodeId ?? null,
      agentId: agent.agentId,
      writable: true,
      terminalSupported,
      terminalDisabledReason: agent.nodeId
        ? terminalSupported
          ? null
          : 'Persistent terminal backend is unavailable on the assigned node.'
        : 'Agent is not assigned to a remote node.',
      sourceLabel: 'Agent Workspace',
    };
  }

  private projectAgentsToRoot(nodeId: string, projectPath: string, agents: AgentInfo[]): WorkbenchRootInfo | null {
    if (agents.length === 0) return null;
    const node = this.nodeRegistry.getNode(nodeId);
    const terminalSupported = Boolean(node?.terminalBackendAvailable);
    const displayName = getWorkbenchPathBasename(projectPath) || projectPath;
    const agentIds = agents.map((agent) => agent.agentId).sort((left, right) => left.localeCompare(right));
    return {
      workbenchRootId: WorkbenchRootService.buildProjectRootId(nodeId, projectPath),
      kind: 'project_space',
      displayName,
      rootPath: canonicalizeWorkbenchRootPath(projectPath),
      nodeId,
      agentIds,
      writable: true,
      terminalSupported,
      terminalDisabledReason: terminalSupported
        ? null
        : 'Persistent terminal backend is unavailable on the bound node.',
      sourceLabel: 'Project',
    };
  }

  private resourceSpaceToRoot(resourceSpace: ResourceSpaceInfo): WorkbenchRootInfo {
    const node = resourceSpace.nodeId ? this.nodeRegistry.getNode(resourceSpace.nodeId) : null;
    const terminalSupported = resourceSpace.backendType === 'node_path'
      && !!resourceSpace.nodeId
      && Boolean(node?.terminalBackendAvailable);
    const terminalDisabledReason = terminalSupported
      ? null
      : resourceSpace.backendType === 'shared_mount'
        ? 'Shared-mount resources do not support persistent terminals.'
        : resourceSpace.nodeId
          ? 'Persistent terminal backend is unavailable on the bound node.'
          : 'Resource space is missing its node binding.';

    return {
      workbenchRootId: WorkbenchRootService.buildResourceRootId(resourceSpace.resourceSpaceId),
      kind: 'resource_space',
      displayName: resourceSpace.name,
      rootPath: canonicalizeWorkbenchRootPath(resourceSpace.rootPath),
      nodeId: resourceSpace.nodeId ?? null,
      resourceSpaceId: resourceSpace.resourceSpaceId,
      resourceType: resourceSpace.resourceType,
      backendType: resourceSpace.backendType,
      writable: false,
      terminalSupported,
      terminalDisabledReason,
      sourceLabel: 'Shared Resource',
    };
  }
}

function parseWorkbenchRootId(rootId: string): { kind: 'agent_workspace' | 'project_space' | 'resource_space'; id: string } | null {
  if (rootId.startsWith('agent:')) {
    const id = rootId.slice('agent:'.length).trim();
    return id ? { kind: 'agent_workspace', id } : null;
  }
  if (rootId.startsWith('project:')) {
    const id = rootId.slice('project:'.length).trim();
    return id ? { kind: 'project_space', id } : null;
  }
  if (rootId.startsWith('resource:')) {
    const id = rootId.slice('resource:'.length).trim();
    return id ? { kind: 'resource_space', id } : null;
  }
  return null;
}

export function canonicalizeWorkbenchRootPath(rootPath: string): string {
  const trimmed = rootPath.trim();
  if (!trimmed) return rootPath;
  const pathModule = detectWorkbenchPathModule(trimmed);
  if (!pathModule.isAbsolute(trimmed)) return trimmed;
  const normalized = pathModule.normalize(trimmed);
  const parsed = pathModule.parse(normalized);
  if (normalized === parsed.root) return normalized;
  return normalized.replace(pathModule === path.win32 ? /[\\/]+$/ : /\/+$/, '');
}

export function isAbsoluteWorkbenchRootPath(rootPath: string): boolean {
  const trimmed = rootPath.trim();
  if (!trimmed) return false;
  return path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed);
}

export function getWorkbenchPathBasename(rootPath: string): string {
  const canonical = canonicalizeWorkbenchRootPath(rootPath);
  const pathModule = detectWorkbenchPathModule(canonical);
  return pathModule.basename(canonical);
}

function detectWorkbenchPathModule(rootPath: string): typeof path.posix | typeof path.win32 {
  if (/^[a-zA-Z]:[\\/]/.test(rootPath) || rootPath.startsWith('\\\\') || rootPath.includes('\\')) {
    return path.win32;
  }
  return path.posix;
}
