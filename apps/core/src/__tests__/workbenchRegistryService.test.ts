import { describe, expect, it } from 'vitest';
import type { WorkbenchRootInfo, WorkspaceInspectResult } from '@agent-collab/protocol';
import { WorkbenchRegistryService } from '../services/workbenchRegistryService.js';
import type { WorkbenchInspectBroker } from '../services/workbenchInspectBroker.js';
import type { WorkbenchRootService } from '../services/workbenchRootService.js';
import { createTestDb } from './helpers.js';

describe('WorkbenchRegistryService', () => {
  it('groups same-repo workspaces into one project and falls back to persisted metadata', async () => {
    const db = createTestDb();
    const roots: WorkbenchRootInfo[] = [
      {
        workbenchRootId: 'project:node-1:aaa',
        kind: 'project_space',
        displayName: 'api',
        rootPath: '/repos/api',
        nodeId: 'node-1',
        agentIds: ['agent-a'],
        writable: true,
        terminalSupported: true,
        terminalDisabledReason: null,
        sourceLabel: 'Project',
      },
      {
        workbenchRootId: 'project:node-1:bbb',
        kind: 'project_space',
        displayName: 'api-worktree',
        rootPath: '/repos/api-worktree',
        nodeId: 'node-1',
        agentIds: ['agent-b'],
        writable: true,
        terminalSupported: true,
        terminalDisabledReason: null,
        sourceLabel: 'Project',
      },
    ];

    const inspectResults = new Map<string, WorkspaceInspectResult>([
      ['/repos/api', {
        workspaceRoot: '/repos/api',
        isGit: true,
        repoRoot: '/repos/api',
        workspaceKind: 'local_checkout',
        branchName: 'main',
        remoteUrl: 'git@github.com:acme/api.git',
      }],
      ['/repos/api-worktree', {
        workspaceRoot: '/repos/api-worktree',
        isGit: true,
        repoRoot: '/repos/api-worktree',
        workspaceKind: 'worktree',
        branchName: 'feature-x',
        remoteUrl: 'https://github.com/acme/api.git',
      }],
    ]);

    const service = new WorkbenchRegistryService({
      db,
      workbenchRootService: {
        listRoots: () => roots,
      } as unknown as WorkbenchRootService,
      inspectBroker: {
        inspectWorkspace: async (_nodeId: string, rootPath: string) => inspectResults.get(rootPath) ?? null,
      } as WorkbenchInspectBroker,
    });

    const onlineProjects = await service.listProjects();
    expect(onlineProjects).toHaveLength(1);
    expect(onlineProjects[0]?.displayName).toBe('acme/api');
    expect(onlineProjects[0]?.workspaces).toHaveLength(2);
    expect(onlineProjects[0]?.workspaces.map((workspace) => workspace.rootPath)).toEqual([
      '/repos/api',
      '/repos/api-worktree',
    ]);

    const persistedProjects = db.prepare(
      'SELECT project_id as projectId, display_name as displayName FROM workbench_projects WHERE archived_at IS NULL',
    ).all() as Array<{ projectId: string; displayName: string }>;
    expect(persistedProjects).toHaveLength(1);
    expect(persistedProjects[0]?.displayName).toBe('acme/api');

    const persistedWorkspaceAgents = db.prepare(
      'SELECT workspace_id as workspaceId, agent_id as agentId FROM workbench_workspace_agents ORDER BY workspace_id, agent_id',
    ).all() as Array<{ workspaceId: string; agentId: string }>;
    expect(persistedWorkspaceAgents).toEqual([
      { workspaceId: 'project:node-1:aaa', agentId: 'agent-a' },
      { workspaceId: 'project:node-1:bbb', agentId: 'agent-b' },
    ]);

    const fallbackService = new WorkbenchRegistryService({
      db,
      workbenchRootService: {
        listRoots: () => roots,
      } as unknown as WorkbenchRootService,
      inspectBroker: {
        inspectWorkspace: async () => {
          throw new Error('node offline');
        },
      } as unknown as WorkbenchInspectBroker,
    });

    const offlineProjects = await fallbackService.listProjects();
    expect(offlineProjects).toHaveLength(1);
    expect(offlineProjects[0]?.projectId).toBe(onlineProjects[0]?.projectId);
    expect(offlineProjects[0]?.displayName).toBe('acme/api');
    expect(offlineProjects[0]?.workspaces).toHaveLength(2);

    db.close();
  });
});
