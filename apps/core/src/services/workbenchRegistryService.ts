import { createHash } from 'node:crypto';

import type { Db } from '@agent-collab/runtime-acp';
import { log } from '@agent-collab/runtime-acp';
import type {
  WorkbenchProjectInfo,
  WorkbenchProjectKind,
  WorkbenchRootInfo,
  WorkbenchWorkspaceInfo,
  WorkspaceInspectResult,
} from '@agent-collab/protocol';
import {
  canonicalizeWorkbenchRootPath,
  getWorkbenchPathBasename,
  WorkbenchRootService,
} from './workbenchRootService.js';
import type { WorkbenchInspectBroker } from './workbenchInspectBroker.js';

type ProjectSpaceRoot = WorkbenchRootInfo & {
  kind: 'project_space';
  agentIds: string[];
};

type ProjectSnapshot = {
  projectId: string;
  displayName: string;
  projectKind: WorkbenchProjectKind;
  primaryRootPath: string;
  remoteUrl: string | null;
  workspace: WorkbenchWorkspaceInfo;
};

type PersistedWorkspaceRecord = {
  projectId: string;
  projectDisplayName: string;
  projectKind: WorkbenchProjectKind;
  primaryRootPath: string | null;
  projectRemoteUrl: string | null;
  workspaceDisplayName: string;
  workspaceRootPath: string;
  workspaceKind: WorkbenchWorkspaceInfo['workspaceKind'];
  branchName: string | null;
  workspaceRemoteUrl: string | null;
};

export class WorkbenchRegistryService {
  private readonly db: Db;
  private readonly workbenchRootService: WorkbenchRootService;
  private readonly inspectBroker: WorkbenchInspectBroker;

  constructor(params: {
    db: Db;
    workbenchRootService: WorkbenchRootService;
    inspectBroker: WorkbenchInspectBroker;
  }) {
    this.db = params.db;
    this.workbenchRootService = params.workbenchRootService;
    this.inspectBroker = params.inspectBroker;
  }

  async listProjects(): Promise<WorkbenchProjectInfo[]> {
    const persisted = this.loadPersistedWorkspaceRecords();
    const projectRoots = this.workbenchRootService
      .listRoots()
      .filter((root): root is ProjectSpaceRoot => (
        root.kind === 'project_space'
        && !!root.nodeId
        && Array.isArray(root.agentIds)
        && root.agentIds.length > 0
      ));

    const snapshots = await Promise.all(projectRoots.map((root) => this.buildProjectSnapshot(
      root,
      persisted.get(root.workbenchRootId) ?? null,
    )));
    const grouped = new Map<string, ProjectSnapshot[]>();
    for (const snapshot of snapshots) {
      const bucket = grouped.get(snapshot.projectId);
      if (bucket) {
        bucket.push(snapshot);
      } else {
        grouped.set(snapshot.projectId, [snapshot]);
      }
    }

    const projects = [...grouped.entries()]
      .map(([projectId, group]) => {
        const sortedGroup = [...group].sort((left, right) => (
          left.workspace.rootPath.localeCompare(right.workspace.rootPath)
        ));
        const primary = sortedGroup[0]!;
        return {
          projectId,
          displayName: primary.displayName,
          projectKind: primary.projectKind,
          primaryRootPath: primary.primaryRootPath,
          remoteUrl: primary.remoteUrl,
          workspaces: sortedGroup
            .map((snapshot) => snapshot.workspace)
            .sort((left, right) => left.rootPath.localeCompare(right.rootPath)),
        } satisfies WorkbenchProjectInfo;
      })
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
    this.persistProjects(projects);
    return projects;
  }

  private async buildProjectSnapshot(
    root: ProjectSpaceRoot,
    persisted: PersistedWorkspaceRecord | null,
  ): Promise<ProjectSnapshot> {
    const inspect = await this.inspectProjectRoot(root);
    const canonicalRootPath = canonicalizeWorkbenchRootPath(root.rootPath);
    const displayName = inspect
      ? resolveProjectDisplayName(canonicalRootPath, inspect)
      : (persisted?.workspaceDisplayName ?? (getWorkbenchPathBasename(canonicalRootPath) || canonicalRootPath));
    const projectId = inspect
      ? buildProjectId(buildProjectKey(root, inspect))
      : (persisted?.projectId ?? buildProjectId(buildProjectKey(root, null)));
    return {
      projectId,
      displayName: inspect ? displayName : (persisted?.projectDisplayName ?? displayName),
      projectKind: inspect?.isGit ? 'git' : (persisted?.projectKind ?? 'directory'),
      primaryRootPath: persisted?.primaryRootPath ? canonicalizeWorkbenchRootPath(persisted.primaryRootPath) : canonicalRootPath,
      remoteUrl: inspect?.remoteUrl ?? persisted?.projectRemoteUrl ?? null,
      workspace: {
        workspaceId: root.workbenchRootId,
        workbenchRootId: root.workbenchRootId,
        displayName,
        rootPath: canonicalRootPath,
        workspaceKind: inspect?.workspaceKind ?? persisted?.workspaceKind ?? 'directory',
        branchName: inspect?.branchName ?? persisted?.branchName ?? null,
        remoteUrl: inspect?.remoteUrl ?? persisted?.workspaceRemoteUrl ?? null,
        nodeId: root.nodeId,
        agentIds: [...root.agentIds].sort((left, right) => left.localeCompare(right)),
        writable: root.writable,
        terminalSupported: root.terminalSupported,
        terminalDisabledReason: root.terminalDisabledReason ?? null,
      },
    };
  }

  private async inspectProjectRoot(root: ProjectSpaceRoot): Promise<WorkspaceInspectResult | null> {
    if (!root.nodeId) return null;
    try {
      return await this.inspectBroker.inspectWorkspace(root.nodeId, root.rootPath);
    } catch (error) {
      log.debug('[workbench-registry] project inspect unavailable', {
        rootId: root.workbenchRootId,
        nodeId: root.nodeId,
        rootPath: root.rootPath,
        error: String((error as Error)?.message ?? error),
      });
      return null;
    }
  }

  private loadPersistedWorkspaceRecords(): Map<string, PersistedWorkspaceRecord> {
    const rows = this.db.prepare(
      `SELECT ww.workbench_root_id as workbenchRootId,
              ww.display_name as workspaceDisplayName,
              ww.root_path as workspaceRootPath,
              ww.workspace_kind as workspaceKind,
              ww.branch_name as branchName,
              ww.remote_url as workspaceRemoteUrl,
              wp.project_id as projectId,
              wp.display_name as projectDisplayName,
              wp.project_kind as projectKind,
              wp.primary_root_path as primaryRootPath,
              wp.remote_url as projectRemoteUrl
         FROM workbench_workspaces ww
         JOIN workbench_projects wp ON wp.project_id = ww.project_id
        WHERE ww.archived_at IS NULL
          AND wp.archived_at IS NULL`,
    ).all() as Array<{
      workbenchRootId: string;
      workspaceDisplayName: string;
      workspaceRootPath: string;
      workspaceKind: WorkbenchWorkspaceInfo['workspaceKind'];
      branchName: string | null;
      workspaceRemoteUrl: string | null;
      projectId: string;
      projectDisplayName: string;
      projectKind: WorkbenchProjectKind;
      primaryRootPath: string | null;
      projectRemoteUrl: string | null;
    }>;

    return new Map(rows.map((row) => [row.workbenchRootId, row]));
  }

  private persistProjects(projects: WorkbenchProjectInfo[]): void {
    const now = Date.now();
    const upsertProject = this.db.prepare(
      `INSERT INTO workbench_projects(
         project_id,
         project_kind,
         display_name,
         primary_root_path,
         remote_url,
         created_at,
         updated_at,
         archived_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(project_id) DO UPDATE SET
         project_kind = excluded.project_kind,
         display_name = excluded.display_name,
         primary_root_path = excluded.primary_root_path,
         remote_url = excluded.remote_url,
         updated_at = excluded.updated_at,
         archived_at = NULL`,
    );
    const upsertWorkspace = this.db.prepare(
      `INSERT INTO workbench_workspaces(
         workspace_id,
         workbench_root_id,
         project_id,
         agent_id,
         root_path,
         display_name,
         workspace_kind,
         branch_name,
         remote_url,
         created_at,
         updated_at,
         archived_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(workspace_id) DO UPDATE SET
         workbench_root_id = excluded.workbench_root_id,
         project_id = excluded.project_id,
         agent_id = excluded.agent_id,
         root_path = excluded.root_path,
         display_name = excluded.display_name,
         workspace_kind = excluded.workspace_kind,
         branch_name = excluded.branch_name,
         remote_url = excluded.remote_url,
         updated_at = excluded.updated_at,
         archived_at = NULL`,
    );
    const clearWorkspaceAgents = this.db.prepare(
      `DELETE FROM workbench_workspace_agents WHERE workspace_id = ?`,
    );
    const insertWorkspaceAgent = this.db.prepare(
      `INSERT OR REPLACE INTO workbench_workspace_agents(
         workspace_id,
         agent_id,
         created_at,
         updated_at
       ) VALUES(?, ?, ?, ?)`,
    );
    const archiveStaleProjects = this.db.prepare(
      `UPDATE workbench_projects
          SET archived_at = ?, updated_at = ?
        WHERE archived_at IS NULL`,
    );
    const archiveStaleWorkspaces = this.db.prepare(
      `UPDATE workbench_workspaces
          SET archived_at = ?, updated_at = ?
        WHERE archived_at IS NULL`,
    );
    const unarchiveProject = this.db.prepare(
      `UPDATE workbench_projects
          SET archived_at = NULL, updated_at = ?
        WHERE project_id = ?`,
    );
    const unarchiveWorkspace = this.db.prepare(
      `UPDATE workbench_workspaces
          SET archived_at = NULL, updated_at = ?
        WHERE workspace_id = ?`,
    );
    const deleteArchivedWorkspaceAgents = this.db.prepare(
      `DELETE FROM workbench_workspace_agents
        WHERE workspace_id IN (
          SELECT workspace_id
            FROM workbench_workspaces
           WHERE archived_at IS NOT NULL
        )`,
    );

    this.db.transaction(() => {
      archiveStaleProjects.run(now, now);
      archiveStaleWorkspaces.run(now, now);

      for (const project of projects) {
        upsertProject.run(
          project.projectId,
          project.projectKind,
          project.displayName,
          project.primaryRootPath,
          project.remoteUrl,
          now,
          now,
        );
        unarchiveProject.run(now, project.projectId);

        for (const workspace of project.workspaces) {
          const primaryAgentId = workspace.agentIds?.[0] ?? workspace.agentId ?? '';
          upsertWorkspace.run(
            workspace.workspaceId,
            workspace.workbenchRootId,
            project.projectId,
            primaryAgentId,
            workspace.rootPath,
            workspace.displayName,
            workspace.workspaceKind,
            workspace.branchName,
            workspace.remoteUrl,
            now,
            now,
          );
          unarchiveWorkspace.run(now, workspace.workspaceId);
          clearWorkspaceAgents.run(workspace.workspaceId);
          for (const agentId of workspace.agentIds ?? (workspace.agentId ? [workspace.agentId] : [])) {
            insertWorkspaceAgent.run(workspace.workspaceId, agentId, now, now);
          }
        }
      }

      deleteArchivedWorkspaceAgents.run();
    })();
  }
}

function resolveProjectDisplayName(rootPath: string, inspect: WorkspaceInspectResult): string {
  const remoteDisplayName = inspect.remoteUrl ? normalizeRemoteDisplayName(inspect.remoteUrl) : null;
  if (remoteDisplayName) return remoteDisplayName;
  if (inspect.isGit && inspect.repoRoot) {
    const repoRoot = canonicalizeWorkbenchRootPath(inspect.repoRoot);
    return getWorkbenchPathBasename(repoRoot) || repoRoot;
  }
  return getWorkbenchPathBasename(rootPath) || rootPath;
}

function buildProjectId(projectKey: string): string {
  return `project:${createHash('sha1').update(projectKey).digest('hex').slice(0, 16)}`;
}

function buildProjectKey(
  root: ProjectSpaceRoot,
  inspect: WorkspaceInspectResult | null,
): string {
  if (inspect?.remoteUrl) {
    return `remote:${root.nodeId}:${normalizeRemoteKey(inspect.remoteUrl)}`;
  }
  if (inspect?.isGit && inspect.repoRoot) {
    return `repo:${root.nodeId}:${canonicalizeWorkbenchRootPath(inspect.repoRoot)}`;
  }
  return `directory:${root.nodeId}:${canonicalizeWorkbenchRootPath(root.rootPath)}`;
}

function normalizeRemoteDisplayName(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  const scpMatch = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (scpMatch) {
    return buildRemoteDisplayName(normalizeRemotePath(scpMatch[2]));
  }

  try {
    const parsed = new URL(trimmed);
    return buildRemoteDisplayName(normalizeRemotePath(parsed.pathname));
  } catch {
    return null;
  }
}

function normalizeRemotePath(value: string): string {
  return value
    .trim()
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

function normalizeRemoteKey(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return 'unknown';

  const scpMatch = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (scpMatch) {
    return `${scpMatch[1]!.toLowerCase()}/${normalizeRemotePath(scpMatch[2]!)}`;
  }

  try {
    const parsed = new URL(trimmed);
    return `${parsed.host.toLowerCase()}/${normalizeRemotePath(parsed.pathname)}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function buildRemoteDisplayName(remotePath: string): string | null {
  const segments = remotePath.split('/').filter(Boolean);
  if (segments.length >= 2) {
    return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
  }
  return segments[0] ?? null;
}
