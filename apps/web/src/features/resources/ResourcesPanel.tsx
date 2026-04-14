import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderSearchIcon,
  GitBranchIcon,
  HashIcon,
  MenuIcon,
  MessageSquareIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  TerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type {
  AgentInfo,
  AgentWorkspaceEntry,
  ChannelInfo,
  ConversationInfo,
  CreateResourceSpaceRequest,
  MachineInfo,
  ResourceSpaceInfo,
  WorkbenchGitAction,
  WorkbenchGitActionApiResult,
  WorkbenchGitDiffApiResult,
  WorkbenchGitDiffMode,
  WorkbenchGitStatusApiResult,
  WorkbenchFileResult,
  WorkbenchProjectInfo,
  WorkbenchRootInfo,
  WorkbenchTerminalInfo,
  WorkbenchWorkspaceInfo,
} from "@agent-collab/protocol";
import { FileMarkdownResponse } from "@/components/ai-elements/message";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CreateDialog } from "@/components/ui/create-dialog";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { inferCodeLanguageFromPath, shouldRenderMarkdownPreview } from "@/lib/filePreview";
import { useAuth } from "@/hooks/useAuth";
import {
  analyzeResource,
  createWorkbenchTerminal,
  deleteWorkbenchTerminal,
  getWorkbenchGitDiff,
  getWorkbenchGitStatus,
  listWorkbenchProjects,
  listWorkbenchRoots,
  listWorkbenchTerminals,
  listWorkbenchTree,
  readWorkbenchFile,
  runWorkbenchGitAction,
} from "@/lib/api";
import {
  loadWorkbenchPersistenceState,
  saveWorkbenchPersistenceState,
} from "./workbenchPersistence";
import { WorkspaceAgentPane } from "./WorkspaceAgentPane";
import { WorkspaceChangesPane } from "./WorkspaceChangesPane";
import { WorkspaceDiffTab } from "./WorkspaceDiffTab";
import { useWorkbenchExplorerStore } from "./workbenchExplorerStore";
import { useWorkbenchLayoutStore } from "./workbenchLayoutStore";
import { useWorkbenchTabsStore } from "./workbenchTabsStore";
import {
  createDefaultWorkbenchRootLayout,
  findWorkbenchPane,
  listWorkbenchPaneLeaves,
  normalizeWorkbenchRootLayout,
  type ExplorerTab,
  type WorkbenchPaneLeaf,
  type WorkbenchPaneId,
  type WorkbenchPaneNode,
  type WorkbenchTab,
} from "./workbenchTypes";

type PaneDropPosition = "center" | "left" | "right" | "top" | "bottom";
type PaneDropTarget = { paneId: WorkbenchPaneId; position: PaneDropPosition } | null;

type ResourcesPanelProps = {
  resourceSpaces: ResourceSpaceInfo[];
  channels: ChannelInfo[];
  agents: AgentInfo[];
  conversations: ConversationInfo[];
  machines: MachineInfo[];
  isAdmin?: boolean;
  onToggleSidebar?: () => void;
  onExitResources: () => void;
  onCreateResourceSpace: (req: CreateResourceSpaceRequest) => Promise<ResourceSpaceInfo>;
  onDeleteResourceSpace: (resourceSpaceId: string) => Promise<void>;
  onOpenConversation: (conversation: ConversationInfo) => void;
  onOpenAgentThread: (agentId: string) => void;
  onEnsureAgentConversation: (agentId: string) => Promise<ConversationInfo>;
};

type DirectoryState = Record<string, AgentWorkspaceEntry[]>;
const EMPTY_WORKBENCH_TABS: WorkbenchTab[] = [];

const KEY_DEFAULT_FILE_NAMES = [
  "README.md",
  "README.mdx",
  "README.markdown",
  "README.mdown",
  "README.mkd",
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "Cargo.toml",
  "summary.md",
  "metrics.json",
  "config.json",
  "results.json",
  "notes.md",
];

function getPaneDropPosition(event: DragEvent<HTMLDivElement>): PaneDropPosition {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const edgeThreshold = Math.min(96, Math.max(40, Math.min(rect.width, rect.height) * 0.28));
  const edgeDistances = [
    { position: "left" as const, distance: x },
    { position: "right" as const, distance: rect.width - x },
    { position: "top" as const, distance: y },
    { position: "bottom" as const, distance: rect.height - y },
  ].filter((entry) => entry.distance <= edgeThreshold);

  if (edgeDistances.length === 0) {
    return "center";
  }

  edgeDistances.sort((a, b) => a.distance - b.distance);
  return edgeDistances[0]?.position ?? "center";
}

export function ResourcesPanel({
  resourceSpaces,
  channels,
  agents,
  conversations,
  machines,
  isAdmin = false,
  onToggleSidebar,
  onExitResources,
  onCreateResourceSpace,
  onDeleteResourceSpace,
  onOpenConversation,
  onOpenAgentThread,
  onEnsureAgentConversation,
}: ResourcesPanelProps) {
  const { user } = useAuth();
  const persistedState = useMemo(
    () => loadWorkbenchPersistenceState(user?.id),
    [user?.id],
  );
  const tabsByRoot = useWorkbenchTabsStore((state) => state.tabsByRoot);
  const hydrateTabs = useWorkbenchTabsStore((state) => state.hydrate);
  const upsertTab = useWorkbenchTabsStore((state) => state.upsertTab);
  const replaceTabs = useWorkbenchTabsStore((state) => state.replaceTabs);
  const removeTab = useWorkbenchTabsStore((state) => state.removeTab);
  const layoutByRoot = useWorkbenchLayoutStore((state) => state.layoutByRoot);
  const hydrateLayouts = useWorkbenchLayoutStore((state) => state.hydrate);
  const syncRootLayout = useWorkbenchLayoutStore((state) => state.syncRoot);
  const openTabInLayout = useWorkbenchLayoutStore((state) => state.openTab);
  const focusLayoutTab = useWorkbenchLayoutStore((state) => state.focusTab);
  const focusLayoutPane = useWorkbenchLayoutStore((state) => state.focusPane);
  const splitLayoutPane = useWorkbenchLayoutStore((state) => state.splitPane);
  const closeLayoutPane = useWorkbenchLayoutStore((state) => state.closePane);
  const closeTabInLayout = useWorkbenchLayoutStore((state) => state.closeTab);
  const setLayoutSplitSizes = useWorkbenchLayoutStore((state) => state.setSplitSizes);
  const explorerTabByRoot = useWorkbenchExplorerStore((state) => state.explorerTabByRoot);
  const explorerCollapsedByRoot = useWorkbenchExplorerStore((state) => state.explorerCollapsedByRoot);
  const hydrateExplorer = useWorkbenchExplorerStore((state) => state.hydrate);
  const setStoredExplorerTab = useWorkbenchExplorerStore((state) => state.setExplorerTab);
  const setStoredExplorerCollapsed = useWorkbenchExplorerStore((state) => state.setExplorerCollapsed);
  const [roots, setRoots] = useState<WorkbenchRootInfo[]>([]);
  const [projects, setProjects] = useState<WorkbenchProjectInfo[]>([]);
  const [loadingRoots, setLoadingRoots] = useState(false);
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const [directories, setDirectories] = useState<DirectoryState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set());
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [recentProjectIds, setRecentProjectIds] = useState<string[]>(persistedState.recentProjectIds);
  const [lastWorkspaceIdByProject, setLastWorkspaceIdByProject] = useState<Record<string, string>>(persistedState.lastWorkspaceIdByProject);
  const [fileCache, setFileCache] = useState<Record<string, WorkbenchFileResult>>({});
  const [loadingFileKey, setLoadingFileKey] = useState<string | null>(null);
  const [gitStatusByRoot, setGitStatusByRoot] = useState<Record<string, WorkbenchGitStatusApiResult>>({});
  const [loadingGitStatus, setLoadingGitStatus] = useState<Set<string>>(new Set());
  const [gitDiffByKey, setGitDiffByKey] = useState<Record<string, WorkbenchGitDiffApiResult>>({});
  const [loadingGitDiff, setLoadingGitDiff] = useState<Set<string>>(new Set());
  const [gitDiffModeByRoot, setGitDiffModeByRoot] = useState<Record<string, WorkbenchGitDiffMode>>({});
  const [runningGitActionKey, setRunningGitActionKey] = useState<string | null>(null);
  const [showGitActionsMenu, setShowGitActionsMenu] = useState(false);
  const [workbenchNotice, setWorkbenchNotice] = useState<string | null>(null);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [terminalsByRoot, setTerminalsByRoot] = useState<Record<string, WorkbenchTerminalInfo[]>>({});
  const [recentTerminalDirsByRoot, setRecentTerminalDirsByRoot] = useState<Record<string, string[]>>(persistedState.recentTerminalDirsByWorkspaceId);
  const [lastLaunchCwdByRoot, setLastLaunchCwdByRoot] = useState<Record<string, string>>(persistedState.lastLaunchCwdByWorkspaceId);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [question, setQuestion] = useState("");
  const [askingAgent, setAskingAgent] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deletingResourceSpace, setDeletingResourceSpace] = useState(false);
  const [workbenchError, setWorkbenchError] = useState<string | null>(null);
  const [paneDropTarget, setPaneDropTarget] = useState<PaneDropTarget>(null);
  const hydratedPersistenceUserIdRef = useRef<string | null>(null);
  const tabsByRootRef = useRef<Record<string, WorkbenchTab[]>>(tabsByRoot);
  const openingAgentTabRootIdsRef = useRef<Set<string>>(new Set());
  const initializedRootIdRef = useRef<string | null>(null);

  useEffect(() => {
    tabsByRootRef.current = tabsByRoot;
  }, [tabsByRoot]);

  useEffect(() => {
    if (!user?.id || hydratedPersistenceUserIdRef.current === user.id) return;
    const state = loadWorkbenchPersistenceState(user.id);
    setRecentProjectIds(state.recentProjectIds);
    setLastWorkspaceIdByProject(state.lastWorkspaceIdByProject);
    hydrateTabs(state.tabsByWorkspaceId);
    hydrateLayouts(state.layoutByWorkspaceId);
    hydrateExplorer({
      explorerTabByRoot: state.explorerTabByWorkspaceId,
      explorerCollapsedByRoot: state.explorerCollapsedByWorkspaceId,
    });
    setRecentTerminalDirsByRoot(state.recentTerminalDirsByWorkspaceId);
    setLastLaunchCwdByRoot(state.lastLaunchCwdByWorkspaceId);
    hydratedPersistenceUserIdRef.current = user.id;
  }, [hydrateExplorer, hydrateLayouts, hydrateTabs, user?.id]);

  useEffect(() => {
    if (!user?.id || hydratedPersistenceUserIdRef.current !== user.id) return;
    saveWorkbenchPersistenceState(user.id, {
      recentProjectIds,
      lastWorkspaceIdByProject,
      tabsByWorkspaceId: tabsByRoot,
      layoutByWorkspaceId: layoutByRoot,
      explorerTabByWorkspaceId: explorerTabByRoot,
      explorerCollapsedByWorkspaceId: explorerCollapsedByRoot,
      recentTerminalDirsByWorkspaceId: recentTerminalDirsByRoot,
      lastLaunchCwdByWorkspaceId: lastLaunchCwdByRoot,
    });
  }, [
    explorerCollapsedByRoot,
    explorerTabByRoot,
    lastLaunchCwdByRoot,
    lastWorkspaceIdByProject,
    layoutByRoot,
    recentProjectIds,
    recentTerminalDirsByRoot,
    tabsByRoot,
    user?.id,
  ]);

  const selectedRoot = useMemo(
    () => roots.find((root) => root.workbenchRootId === selectedRootId) ?? null,
    [roots, selectedRootId],
  );
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.projectId, project])),
    [projects],
  );
  const projectByRootId = useMemo(() => {
    const next = new Map<string, WorkbenchProjectInfo>();
    for (const project of projects) {
      for (const workspace of project.workspaces) {
        next.set(workspace.workbenchRootId, project);
      }
    }
    return next;
  }, [projects]);
  const selectedProject = selectedRoot ? projectByRootId.get(selectedRoot.workbenchRootId) ?? null : null;
  const selectedResourceSpace = useMemo(
    () => (
      selectedRoot?.kind === "resource_space"
        ? resourceSpaces.find((item) => item.resourceSpaceId === selectedRoot.resourceSpaceId) ?? null
        : null
    ),
    [resourceSpaces, selectedRoot],
  );
  const selectedAgent = useMemo(
    () => (
      selectedRoot?.kind === "agent_workspace"
        ? agents.find((item) => item.agentId === selectedRoot.agentId) ?? null
        : null
    ),
    [agents, selectedRoot],
  );
  const selectedProjectAgents = useMemo(() => {
    if (!selectedRoot || selectedRoot.kind !== "project_space") return [] as AgentInfo[];
    const linkedAgentIds = new Set(selectedRoot.agentIds ?? []);
    return agents
      .filter((agent) => linkedAgentIds.has(agent.agentId))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [agents, selectedRoot]);
  const directConversationByAgentId = useMemo(() => {
    const next = new Map<string, ConversationInfo>();
    for (const conversation of conversations) {
      if (!conversation.agentId) continue;
      if (conversation.threadKind !== "direct" || !conversation.isPrimaryThread) continue;
      next.set(conversation.agentId, conversation);
    }
    return next;
  }, [conversations]);
  const conversationById = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations],
  );
  const machineNameById = useMemo(
    () => new Map(machines.map((machine) => [machine.nodeId, machine.name])),
    [machines],
  );
  const recentProjects = useMemo(
    () => recentProjectIds
      .map((projectId) => projectById.get(projectId) ?? null)
      .filter((project): project is WorkbenchProjectInfo => !!project),
    [projectById, recentProjectIds],
  );
  const resourceRoots = useMemo(
    () => roots.filter((root) => root.kind === "resource_space"),
    [roots],
  );
  const agentWorkspaceSignature = useMemo(
    () => agents
      .map((agent) => `${agent.agentId}:${agent.nodeId ?? ""}:${agent.projectPath ?? ""}`)
      .sort()
      .join("|"),
    [agents],
  );
  const resourceRootSignature = useMemo(
    () => resourceSpaces
      .map((resourceSpace) => `${resourceSpace.resourceSpaceId}:${resourceSpace.nodeId ?? ""}:${resourceSpace.rootPath}`)
      .sort()
      .join("|"),
    [resourceSpaces],
  );
  const rootEntries = selectedRoot
    ? directories[buildDirectoryCacheKey(selectedRoot.workbenchRootId, "")] ?? []
    : [];
  const currentTabs = useMemo(
    () => (selectedRoot ? (tabsByRoot[selectedRoot.workbenchRootId] ?? EMPTY_WORKBENCH_TABS) : EMPTY_WORKBENCH_TABS),
    [selectedRoot, tabsByRoot],
  );
  const selectedRootIsSplitCapable = selectedRoot?.kind !== "agent_workspace";
  const selectedRootLayout = useMemo(() => {
    if (!selectedRoot) return null;
    try {
      return normalizeWorkbenchRootLayout(
        layoutByRoot[selectedRoot.workbenchRootId]
          ?? createDefaultWorkbenchRootLayout(currentTabs.map((tab) => tab.id), currentTabs[0]?.id),
        currentTabs.map((tab) => tab.id),
        { splitCapable: selectedRoot.kind !== "agent_workspace" },
      );
    } catch {
      return createDefaultWorkbenchRootLayout(currentTabs.map((tab) => tab.id), currentTabs[0]?.id);
    }
  }, [currentTabs, layoutByRoot, selectedRoot]);
  const tabsById = useMemo(
    () => new Map(currentTabs.map((tab) => [tab.id, tab])),
    [currentTabs],
  );
  const paneLeaves = useMemo(
    () => selectedRootLayout ? listWorkbenchPaneLeaves(selectedRootLayout.root) : [],
    [selectedRootLayout],
  );
  const focusedPaneId: WorkbenchPaneId = selectedRootLayout?.focusedPaneId ?? paneLeaves[0]?.id ?? "pane-1";
  const focusedPane = selectedRootLayout ? findWorkbenchPane(selectedRootLayout.root, focusedPaneId) : null;
  const focusedPaneActiveTab = focusedPane
    ? (focusedPane.tabIds
      .map((tabId) => tabsById.get(tabId) ?? null)
      .find((tab): tab is WorkbenchTab => !!tab && tab.id === (focusedPane.activeTabId ?? tab.id))
      ?? focusedPane.tabIds.map((tabId) => tabsById.get(tabId) ?? null).find((tab): tab is WorkbenchTab => !!tab)
      ?? null)
    : null;
  const activeTab = focusedPaneActiveTab;
  const activeFile = selectedRoot && activeTab && (activeTab.kind === "file" || activeTab.kind === "diff")
    ? fileCache[buildFileCacheKey(selectedRoot.workbenchRootId, activeTab.path)] ?? null
    : null;
  const activeFilePath = activeTab && (activeTab.kind === "file" || activeTab.kind === "diff") ? activeTab.path : null;
  const selectedGitStatus = selectedRoot ? gitStatusByRoot[selectedRoot.workbenchRootId] ?? null : null;
  const selectedDiffMode = selectedRoot ? (gitDiffModeByRoot[selectedRoot.workbenchRootId] ?? "uncommitted") : "uncommitted";
  const selectedGitDiffKey = selectedRoot ? buildGitDiffCacheKey(selectedRoot.workbenchRootId, selectedDiffMode) : null;
  const selectedGitDiff = selectedGitDiffKey ? gitDiffByKey[selectedGitDiffKey] ?? null : null;
  const selectedRootSupportsChanges = Boolean(
    selectedRoot?.kind === "project_space"
    && (selectedGitStatus?.isGit ?? selectedProject?.projectKind === "git"),
  );
  const hasGitRemote = selectedGitStatus?.hasRemote ?? false;
  const currentGitAction = selectedRoot && runningGitActionKey?.startsWith(`${selectedRoot.workbenchRootId}:`)
    ? runningGitActionKey.slice(selectedRoot.workbenchRootId.length + 1) as WorkbenchGitAction
    : null;
  const selectedExplorerTab: ExplorerTab = selectedRoot
    ? selectedRootSupportsChanges
      ? (explorerTabByRoot[selectedRoot.workbenchRootId] ?? "changes")
      : "files"
    : "files";
  const explorerCollapsed = selectedRoot ? explorerCollapsedByRoot[selectedRoot.workbenchRootId] ?? true : true;
  const paneCount = paneLeaves.length;
  const activeFileSupportsAnalysis = activeFile
    ? activeFile.mimeType === "text/markdown" || activeFile.mimeType === "text/plain"
    : false;

  const refreshRoots = useCallback(async () => {
    setLoadingRoots(true);
    setWorkbenchError(null);
    try {
      const [projectsResult, rootsResult] = await Promise.allSettled([
        listWorkbenchProjects(),
        listWorkbenchRoots(),
      ] as const);

      if (rootsResult.status === "fulfilled") {
        setRoots(rootsResult.value);
      } else {
        throw rootsResult.reason;
      }

      if (projectsResult.status === "fulfilled") {
        setProjects(projectsResult.value.projects);
      } else {
        setProjects((current) => current);
        setWorkbenchError(String((projectsResult.reason as Error)?.message ?? projectsResult.reason));
      }

      return rootsResult.value;
    } catch (error) {
      setWorkbenchError(String((error as Error)?.message ?? error));
      return [];
    } finally {
      setLoadingRoots(false);
    }
  }, []);

  useEffect(() => {
    void refreshRoots();
  }, [agentWorkspaceSignature, resourceRootSignature, refreshRoots]);

  useEffect(() => {
    if (roots.length === 0) {
      setSelectedRootId(null);
      return;
    }
    if (selectedRootId && roots.some((root) => root.workbenchRootId === selectedRootId)) {
      return;
    }
    const preferredRecentRootId = recentProjectIds
      .map((projectId) => {
        const project = projectById.get(projectId);
        if (!project) return null;
        const preferredWorkspaceId = lastWorkspaceIdByProject[project.projectId];
        return project.workspaces.find((workspace) => workspace.workspaceId === preferredWorkspaceId)?.workbenchRootId
          ?? project.workspaces[0]?.workbenchRootId
          ?? null;
      })
      .find(Boolean);
    const defaultProjectRootId = projects[0]?.workspaces[0]?.workbenchRootId ?? null;
    setSelectedRootId(preferredRecentRootId ?? defaultProjectRootId ?? roots[0]?.workbenchRootId ?? null);
  }, [lastWorkspaceIdByProject, projectById, projects, recentProjectIds, roots, selectedRootId]);

  useEffect(() => {
    if (!agents.length) {
      setSelectedAgentId("");
      return;
    }
    setSelectedAgentId((current) => (
      current && agents.some((agent) => agent.agentId === current)
        ? current
        : agents[0]?.agentId ?? ""
    ));
  }, [agents]);

  useEffect(() => {
    setExpanded(new Set());
    setLoadingDirectories(new Set());
    setWorkbenchError(null);
    setWorkbenchNotice(null);
    setShowGitActionsMenu(false);
    setPaneDropTarget(null);
    setQuestion("");
    initializedRootIdRef.current = null;
  }, [selectedRootId]);

  useEffect(() => {
    if (!selectedRoot) return;
    syncRootLayout(selectedRoot.workbenchRootId, currentTabs.map((tab) => tab.id), {
      splitCapable: selectedRoot.kind !== "agent_workspace",
    });
  }, [currentTabs, selectedRoot, syncRootLayout]);

  useEffect(() => {
    if (!selectedRoot || !selectedRootSupportsChanges) return;
    if (explorerTabByRoot[selectedRoot.workbenchRootId]) return;
    setStoredExplorerTab(selectedRoot.workbenchRootId, "changes");
  }, [explorerTabByRoot, selectedRoot, selectedRootSupportsChanges, setStoredExplorerTab]);

  const rememberProjectSelection = useCallback((projectId: string, workspaceId: string) => {
    setRecentProjectIds((prev) => [projectId, ...prev.filter((item) => item !== projectId)].slice(0, 6));
    setLastWorkspaceIdByProject((prev) => ({ ...prev, [projectId]: workspaceId }));
  }, []);

  const setExplorerTab = useCallback((rootId: string, tab: ExplorerTab) => {
    setStoredExplorerTab(rootId, tab);
  }, [setStoredExplorerTab]);

  useEffect(() => {
    if (!selectedProject || !selectedRoot || selectedRoot.kind !== "project_space") return;
    rememberProjectSelection(selectedProject.projectId, selectedRoot.workbenchRootId);
  }, [rememberProjectSelection, selectedProject, selectedRoot]);

  const handleSelectProject = useCallback((project: WorkbenchProjectInfo) => {
    const workspace = project.workspaces.find((item) => item.workspaceId === lastWorkspaceIdByProject[project.projectId])
      ?? project.workspaces[0];
    if (!workspace) return;
    rememberProjectSelection(project.projectId, workspace.workspaceId);
    setSelectedRootId(workspace.workbenchRootId);
  }, [lastWorkspaceIdByProject, rememberProjectSelection]);

  const handleSelectWorkspace = useCallback((project: WorkbenchProjectInfo, workspace: WorkbenchWorkspaceInfo) => {
    rememberProjectSelection(project.projectId, workspace.workspaceId);
    setSelectedRootId(workspace.workbenchRootId);
  }, [rememberProjectSelection]);

  const toggleProjectExpanded = useCallback((projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  const loadDirectory = useCallback(async (root: WorkbenchRootInfo, resourcePath: string, options?: { force?: boolean }) => {
    const directoryKey = buildDirectoryCacheKey(root.workbenchRootId, resourcePath);
    if (!options?.force && directories[directoryKey]) return directories[directoryKey];

    setWorkbenchError(null);
    setLoadingDirectories((prev) => new Set(prev).add(directoryKey));
    try {
      const result = await listWorkbenchTree(root.workbenchRootId, resourcePath);
      const visibleEntries = filterVisibleWorkbenchEntries(root, resourcePath, result.entries);
      setDirectories((prev) => ({ ...prev, [directoryKey]: visibleEntries }));
      return visibleEntries;
    } catch (error) {
      setWorkbenchError(String((error as Error)?.message ?? error));
      return null;
    } finally {
      setLoadingDirectories((prev) => {
        const next = new Set(prev);
        next.delete(directoryKey);
        return next;
      });
    }
  }, [directories]);

  const loadFile = useCallback(async (root: WorkbenchRootInfo, resourcePath: string) => {
    const cacheKey = buildFileCacheKey(root.workbenchRootId, resourcePath);
    setWorkbenchError(null);
    setLoadingFileKey(cacheKey);
    try {
      const result = await readWorkbenchFile(root.workbenchRootId, resourcePath);
      setFileCache((prev) => ({ ...prev, [cacheKey]: result }));
      return result;
    } catch (error) {
      setWorkbenchError(String((error as Error)?.message ?? error));
      return null;
    } finally {
      setLoadingFileKey((current) => (current === cacheKey ? null : current));
    }
  }, []);

  const loadGitStatus = useCallback(async (root: WorkbenchRootInfo, options?: { force?: boolean }) => {
    if (root.kind !== "project_space") return null;
    if (!options?.force && gitStatusByRoot[root.workbenchRootId]) {
      return gitStatusByRoot[root.workbenchRootId] ?? null;
    }

    setWorkbenchError(null);
    setLoadingGitStatus((prev) => new Set(prev).add(root.workbenchRootId));
    try {
      const result = await getWorkbenchGitStatus(root.workbenchRootId);
      setGitStatusByRoot((prev) => ({ ...prev, [root.workbenchRootId]: result }));
      return result;
    } catch (error) {
      setWorkbenchError(String((error as Error)?.message ?? error));
      return null;
    } finally {
      setLoadingGitStatus((prev) => {
        const next = new Set(prev);
        next.delete(root.workbenchRootId);
        return next;
      });
    }
  }, [gitStatusByRoot]);

  const loadGitDiff = useCallback(async (
    root: WorkbenchRootInfo,
    mode: WorkbenchGitDiffMode,
    options?: { force?: boolean },
  ) => {
    if (root.kind !== "project_space") return null;
    const cacheKey = buildGitDiffCacheKey(root.workbenchRootId, mode);
    if (!options?.force && gitDiffByKey[cacheKey]) {
      return gitDiffByKey[cacheKey] ?? null;
    }

    setWorkbenchError(null);
    setLoadingGitDiff((prev) => new Set(prev).add(cacheKey));
    try {
      const result = await getWorkbenchGitDiff(root.workbenchRootId, mode);
      setGitDiffByKey((prev) => ({ ...prev, [cacheKey]: result }));
      return result;
    } catch (error) {
      setWorkbenchError(String((error as Error)?.message ?? error));
      return null;
    } finally {
      setLoadingGitDiff((prev) => {
        const next = new Set(prev);
        next.delete(cacheKey);
        return next;
      });
    }
  }, [gitDiffByKey]);

  useEffect(() => {
    if (!selectedRoot || selectedRoot.kind !== "project_space") return;
    void loadGitStatus(selectedRoot);
  }, [loadGitStatus, selectedRoot]);

  useEffect(() => {
    if (!selectedRoot || selectedRoot.kind !== "project_space") return;
    if (selectedExplorerTab !== "changes") return;
    if (selectedGitStatus && !selectedGitStatus.isGit) return;
    void loadGitDiff(selectedRoot, selectedDiffMode);
  }, [loadGitDiff, selectedDiffMode, selectedExplorerTab, selectedGitStatus, selectedRoot]);

  useEffect(() => {
    if (!selectedRoot || selectedRoot.kind !== "project_space") return;
    const openDiffModes = new Set(
      currentTabs
        .filter((tab): tab is Extract<WorkbenchTab, { kind: "diff" }> => tab.kind === "diff")
        .map((tab) => tab.mode),
    );
    openDiffModes.forEach((mode) => {
      void loadGitDiff(selectedRoot, mode);
    });
  }, [currentTabs, loadGitDiff, selectedRoot]);

  const openFileTab = useCallback(async (
    root: WorkbenchRootInfo,
    resourcePath: string,
    options?: { paneId?: WorkbenchPaneId; location?: "focused" | "other" },
  ) => {
    const title = (resourcePath.split("/").filter(Boolean).pop() ?? resourcePath) || "Root";
    const tabId = buildFileTabId(resourcePath);
    upsertTab(root.workbenchRootId, { id: tabId, kind: "file", path: resourcePath, title });
    openTabInLayout(root.workbenchRootId, tabId, {
      paneId: options?.paneId,
      location: options?.location,
      splitCapable: root.kind !== "agent_workspace",
    });
    const cacheKey = buildFileCacheKey(root.workbenchRootId, resourcePath);
    if (!fileCache[cacheKey]) {
      await loadFile(root, resourcePath);
    }
  }, [fileCache, loadFile, openTabInLayout, upsertTab]);

  const openDiffTab = useCallback((
    root: WorkbenchRootInfo,
    resourcePath: string,
    mode: WorkbenchGitDiffMode,
    options?: { paneId?: WorkbenchPaneId; location?: "focused" | "other" },
  ) => {
    const title = `${resourcePath.split("/").filter(Boolean).pop() ?? resourcePath} (${mode === "base" ? "base" : "diff"})`;
    const tabId = buildDiffTabId(resourcePath, mode);
    upsertTab(root.workbenchRootId, { id: tabId, kind: "diff", path: resourcePath, mode, title });
    openTabInLayout(root.workbenchRootId, tabId, {
      paneId: options?.paneId,
      location: options?.location,
      splitCapable: root.kind !== "agent_workspace",
    });
  }, [openTabInLayout, upsertTab]);

  const openTerminalTab = useCallback((
    root: WorkbenchRootInfo,
    terminal: WorkbenchTerminalInfo,
    options?: { paneId?: WorkbenchPaneId; location?: "focused" | "other" },
  ) => {
    const tabId = buildTerminalTabId(terminal.terminalId);
    upsertTab(root.workbenchRootId, {
      id: tabId,
      kind: "terminal",
      terminalId: terminal.terminalId,
      title: terminal.name,
    });
    openTabInLayout(root.workbenchRootId, tabId, {
      paneId: options?.paneId,
      location: options?.location,
      splitCapable: root.kind !== "agent_workspace",
    });
  }, [openTabInLayout, upsertTab]);

  const openAgentTab = useCallback((root: WorkbenchRootInfo, agentId: string, conversation: ConversationInfo, title: string) => {
    const tabId = buildAgentTabId(agentId);
    upsertTab(root.workbenchRootId, {
      id: tabId,
      kind: "agent",
      agentId,
      conversationId: conversation.id,
      title,
    });
    openTabInLayout(root.workbenchRootId, tabId, { splitCapable: false, paneId: "pane-1" });
  }, [openTabInLayout, upsertTab]);

  const handleOpenWorkspaceAgentTab = useCallback(async (root: WorkbenchRootInfo, options?: { ensure?: boolean }) => {
    if (root.kind !== "agent_workspace" || !root.agentId) return null;
    if (openingAgentTabRootIdsRef.current.has(root.workbenchRootId)) return null;

    openingAgentTabRootIdsRef.current.add(root.workbenchRootId);
    setWorkbenchError(null);
    try {
      const conversation = directConversationByAgentId.get(root.agentId)
        ?? (options?.ensure === false ? null : await onEnsureAgentConversation(root.agentId));
      if (!conversation) return null;
      const agent = agents.find((item) => item.agentId === root.agentId) ?? null;
      openAgentTab(root, root.agentId, conversation, agent?.name ?? "Agent");
      return conversation;
    } catch (error) {
      setWorkbenchError(String((error as Error)?.message ?? error));
      return null;
    } finally {
      openingAgentTabRootIdsRef.current.delete(root.workbenchRootId);
    }
  }, [agents, directConversationByAgentId, onEnsureAgentConversation, openAgentTab]);

  const closeTab = useCallback(async (root: WorkbenchRootInfo, tabId: string) => {
    const currentTabsForRoot = tabsByRootRef.current[root.workbenchRootId] ?? [];
    const targetTab = currentTabsForRoot.find((tab) => tab.id === tabId) ?? null;
    if (targetTab?.kind === "terminal") {
      try {
        await deleteWorkbenchTerminal(root.workbenchRootId, targetTab.terminalId);
      } catch (error) {
        setWorkbenchError(String((error as Error)?.message ?? error));
        return;
      }
      setTerminalsByRoot((prev) => ({
        ...prev,
        [root.workbenchRootId]: (prev[root.workbenchRootId] ?? []).filter((terminal) => terminal.terminalId !== targetTab.terminalId),
      }));
    }
    const nextTabs = currentTabsForRoot.filter((tab) => tab.id !== tabId);
    removeTab(root.workbenchRootId, tabId);
    closeTabInLayout(root.workbenchRootId, tabId, nextTabs.map((tab) => tab.id), {
      splitCapable: root.kind !== "agent_workspace",
    });
  }, [closeTabInLayout, removeTab]);

  const loadTerminals = useCallback(async (root: WorkbenchRootInfo, options?: { force?: boolean }) => {
    if (!root.terminalSupported) return [];
    if (!options?.force && terminalsByRoot[root.workbenchRootId]) {
      return terminalsByRoot[root.workbenchRootId] ?? [];
    }

    setWorkbenchError(null);
    try {
      const result = await listWorkbenchTerminals(root.workbenchRootId);
      setTerminalsByRoot((prev) => ({ ...prev, [root.workbenchRootId]: result.terminals }));
      const liveTerminalIds = new Set(result.terminals.map((terminal) => terminal.terminalId));
      const currentTabsForRoot = tabsByRootRef.current[root.workbenchRootId] ?? [];
      const nextTabs = currentTabsForRoot.filter((tab) => tab.kind !== "terminal" || liveTerminalIds.has(tab.terminalId));
      if (nextTabs.length !== currentTabsForRoot.length) {
        replaceTabs(root.workbenchRootId, nextTabs);
        syncRootLayout(root.workbenchRootId, nextTabs.map((tab) => tab.id), {
          splitCapable: root.kind !== "agent_workspace",
        });
      }
      return result.terminals;
    } catch (error) {
      setWorkbenchError(String((error as Error)?.message ?? error));
      return [];
    }
  }, [replaceTabs, syncRootLayout, terminalsByRoot]);

  const handleCreateTerminal = useCallback(async (cwd?: string) => {
    if (!selectedRoot?.terminalSupported) return;
    setWorkbenchError(null);
    try {
      const normalizedCwd = normalizeLaunchCwd(cwd);
      const terminal = await createWorkbenchTerminal(selectedRoot.workbenchRootId, { cwd: normalizedCwd });
      setTerminalsByRoot((prev) => ({
        ...prev,
        [selectedRoot.workbenchRootId]: [...(prev[selectedRoot.workbenchRootId] ?? []).filter((item) => item.terminalId !== terminal.terminalId), terminal],
      }));
      setLastLaunchCwdByRoot((prev) => ({
        ...prev,
        [selectedRoot.workbenchRootId]: normalizedCwd,
      }));
      setRecentTerminalDirsByRoot((prev) => ({
        ...prev,
        [selectedRoot.workbenchRootId]: mergeRecentTerminalDirs(
          prev[selectedRoot.workbenchRootId] ?? [],
          normalizedCwd,
        ),
      }));
      openTerminalTab(selectedRoot, terminal, { paneId: focusedPaneId });
    } catch (error) {
      setWorkbenchError(String((error as Error)?.message ?? error));
    }
  }, [focusedPaneId, openTerminalTab, selectedRoot]);

  useEffect(() => {
    if (!selectedRoot) return;
    const existingTabs = tabsByRoot[selectedRoot.workbenchRootId] ?? [];
    if (existingTabs.length > 0) return;
    if (initializedRootIdRef.current === selectedRoot.workbenchRootId) return;
    initializedRootIdRef.current = selectedRoot.workbenchRootId;

    if (selectedRoot.kind === "agent_workspace" && selectedRoot.agentId) {
      void handleOpenWorkspaceAgentTab(selectedRoot);
      return;
    }

    if (selectedRoot.kind === "project_space") {
      return;
    }

    const rootDirectoryKey = buildDirectoryCacheKey(selectedRoot.workbenchRootId, "");
    if (directories[rootDirectoryKey] || loadingDirectories.has(rootDirectoryKey)) return;

    void loadDirectory(selectedRoot, "").then((entries) => {
      if (!entries || entries.length === 0) return;
      const defaultEntry = pickDefaultWorkbenchEntry(selectedRoot, entries);
      if (defaultEntry?.kind === "file") {
        void openFileTab(selectedRoot, defaultEntry.path);
      }
    });
  }, [
    directories,
    handleOpenWorkspaceAgentTab,
    loadDirectory,
    loadingDirectories,
    openFileTab,
    selectedRoot,
    tabsByRoot,
  ]);

  useEffect(() => {
    if (!selectedRoot?.terminalSupported) return;
    if (terminalsByRoot[selectedRoot.workbenchRootId]) return;
    void loadTerminals(selectedRoot);
  }, [loadTerminals, selectedRoot, terminalsByRoot]);

  useEffect(() => {
    if (!selectedRoot) return;
    const rootDirectoryKey = buildDirectoryCacheKey(selectedRoot.workbenchRootId, "");
    if (directories[rootDirectoryKey] || loadingDirectories.has(rootDirectoryKey)) return;
    void loadDirectory(selectedRoot, "");
  }, [directories, loadDirectory, loadingDirectories, selectedRoot]);

  useEffect(() => {
    if (!selectedRoot || !activeTab || activeTab.kind !== "file") return;
    const cacheKey = buildFileCacheKey(selectedRoot.workbenchRootId, activeTab.path);
    if (fileCache[cacheKey] || loadingFileKey === cacheKey) return;
    void loadFile(selectedRoot, activeTab.path);
  }, [activeTab, fileCache, loadFile, loadingFileKey, selectedRoot]);

  const handleToggleDirectory = useCallback((resourcePath: string) => {
    if (!selectedRoot) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(resourcePath)) {
        next.delete(resourcePath);
      } else {
        next.add(resourcePath);
      }
      return next;
    });
    if (!directories[buildDirectoryCacheKey(selectedRoot.workbenchRootId, resourcePath)]) {
      void loadDirectory(selectedRoot, resourcePath);
    }
  }, [directories, loadDirectory, selectedRoot]);

  const collectDiffModesForRoot = useCallback((
    root: WorkbenchRootInfo,
    options?: { preferredMode?: WorkbenchGitDiffMode; activeTab?: WorkbenchTab | null },
  ): WorkbenchGitDiffMode[] => {
    const modes = new Set<WorkbenchGitDiffMode>();
    const rootTabs = tabsByRootRef.current[root.workbenchRootId] ?? [];
    for (const tab of rootTabs) {
      if (tab.kind === "diff") {
        modes.add(tab.mode);
      }
    }
    if (options?.activeTab?.kind === "diff") {
      modes.add(options.activeTab.mode);
    }
    if (options?.preferredMode) {
      modes.add(options.preferredMode);
    }
    if (modes.size === 0) {
      modes.add("uncommitted");
    }
    return [...modes];
  }, []);

  const refreshRootContent = useCallback(async (root: WorkbenchRootInfo, tab: WorkbenchTab | null) => {
    setDirectories((prev) => clearDirectoryEntriesForRoot(prev, root.workbenchRootId));
    setExpanded(new Set());
    setWorkbenchError(null);
    const entries = await loadDirectory(root, "", { force: true });
    if (tab?.kind === "file") {
      await loadFile(root, tab.path);
    } else if (tab?.kind === "diff") {
      await loadGitDiff(root, tab.mode, { force: true });
    } else if (!tab && entries && root.kind !== "project_space") {
      const defaultEntry = pickDefaultWorkbenchEntry(root, entries);
      if (defaultEntry?.kind === "file") {
        await openFileTab(root, defaultEntry.path);
      }
    }
    if (root.terminalSupported) {
      await loadTerminals(root, { force: true });
    }
    if (root.kind === "project_space") {
      const status = await loadGitStatus(root, { force: true });
      if (status?.isGit) {
        const preferredMode = selectedRoot?.workbenchRootId === root.workbenchRootId ? selectedDiffMode : undefined;
        await Promise.all(
          collectDiffModesForRoot(root, { preferredMode, activeTab: tab }).map((mode) =>
            loadGitDiff(root, mode, { force: true }),
          ),
        );
      }
    }
  }, [collectDiffModesForRoot, loadDirectory, loadFile, loadGitDiff, loadGitStatus, loadTerminals, openFileTab, selectedDiffMode, selectedRoot]);

  const handleRefresh = useCallback(async () => {
    if (!selectedRoot) return;
    await refreshRoots();
    await refreshRootContent(selectedRoot, activeTab);
  }, [activeTab, refreshRootContent, refreshRoots, selectedRoot]);

  const executeGitAction = useCallback(async (
    root: WorkbenchRootInfo,
    action: WorkbenchGitAction,
    options?: { commitMessage?: string },
  ): Promise<WorkbenchGitActionApiResult | null> => {
    const actionKey = `${root.workbenchRootId}:${action}`;
    setRunningGitActionKey(actionKey);
    setWorkbenchError(null);
    setWorkbenchNotice(null);
    try {
      const result = await runWorkbenchGitAction(root.workbenchRootId, {
        action,
        commitMessage: options?.commitMessage,
      });
      await refreshRootContent(root, activeTab);
      setWorkbenchNotice(formatGitActionNotice(result));
      return result;
    } catch (error) {
      setWorkbenchError(String((error as Error)?.message ?? error));
      return null;
    } finally {
      setRunningGitActionKey((current) => (current === actionKey ? null : current));
    }
  }, [activeTab, refreshRootContent]);

  const handleAnalyze = useCallback(async () => {
    if (!selectedResourceSpace || !activeFilePath || !selectedAgentId || !question.trim() || askingAgent) return;
    setAskingAgent(true);
    setWorkbenchError(null);
    try {
      const result = await analyzeResource(selectedResourceSpace.resourceSpaceId, {
        agentId: selectedAgentId,
        question: question.trim(),
        path: activeFilePath,
      });
      onOpenConversation(result.conversation);
    } catch (error) {
      setWorkbenchError(String((error as Error)?.message ?? error));
    } finally {
      setAskingAgent(false);
    }
  }, [activeFilePath, askingAgent, onOpenConversation, question, selectedAgentId, selectedResourceSpace]);

  const handleDeleteResourceSpace = useCallback(async () => {
    if (!selectedResourceSpace || deletingResourceSpace) return;
    setDeletingResourceSpace(true);
    setWorkbenchError(null);
    try {
      await onDeleteResourceSpace(selectedResourceSpace.resourceSpaceId);
      await refreshRoots();
      setShowDeleteDialog(false);
    } catch (error) {
      setWorkbenchError(String((error as Error)?.message ?? error));
    } finally {
      setDeletingResourceSpace(false);
    }
  }, [deletingResourceSpace, onDeleteResourceSpace, selectedResourceSpace]);

  const handleSubmitCommit = useCallback(async () => {
    if (!selectedRoot || selectedRoot.kind !== "project_space") return;
    const message = commitMessage.trim();
    if (!message) {
      setWorkbenchError("Commit message is required.");
      return;
    }
    const result = await executeGitAction(selectedRoot, "commit_all", { commitMessage: message });
    if (result) {
      setShowCommitDialog(false);
      setCommitMessage("");
    }
  }, [commitMessage, executeGitAction, selectedRoot]);

  const handlePaneFileDrop = useCallback(async (paneId: WorkbenchPaneId, event: DragEvent<HTMLDivElement>) => {
    if (!selectedRoot) return;
    event.preventDefault();
    const dropPosition = getPaneDropPosition(event);
    setPaneDropTarget(null);
    const payload = parseWorkbenchFileDropPayload(event.dataTransfer.getData(WORKBENCH_FILE_DRAG_MIME));
    if (!payload) return;
    if (payload.rootId !== selectedRoot.workbenchRootId) return;
    if (!selectedRootIsSplitCapable || dropPosition === "center") {
      await openFileTab(selectedRoot, payload.path, { paneId });
      return;
    }

    const splitConfig = (
      dropPosition === "left"
        ? { direction: "horizontal" as const, placement: "before" as const }
        : dropPosition === "right"
          ? { direction: "horizontal" as const, placement: "after" as const }
          : dropPosition === "top"
            ? { direction: "vertical" as const, placement: "before" as const }
            : { direction: "vertical" as const, placement: "after" as const }
    );
    const nextPaneId = splitLayoutPane(
      selectedRoot.workbenchRootId,
      paneId,
      splitConfig.direction,
      { splitCapable: true, placement: splitConfig.placement },
    );
    await openFileTab(selectedRoot, payload.path, { paneId: nextPaneId });
  }, [openFileTab, selectedRoot, selectedRootIsSplitCapable, splitLayoutPane]);

  const renderPaneContent = useCallback((paneId: WorkbenchPaneId, activePaneTab: WorkbenchTab | null) => {
    if (!selectedRoot) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-sm text-stone-600">
          Choose a project or shared resource to open this workspace.
        </div>
      );
    }

    if (!activePaneTab) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-sm text-stone-600">
          Open a file, diff, or terminal into this pane.
        </div>
      );
    }

    switch (activePaneTab.kind) {
      case "agent": {
        const conversation = conversationById.get(activePaneTab.conversationId)
          ?? directConversationByAgentId.get(activePaneTab.agentId)
          ?? null;
        return (
          <WorkspaceAgentPane
            conversation={conversation}
            agent={selectedAgent}
            onOpenChat={selectedRoot.agentId ? () => onOpenAgentThread(selectedRoot.agentId!) : undefined}
          />
        );
      }
      case "file": {
        const paneFile = fileCache[buildFileCacheKey(selectedRoot.workbenchRootId, activePaneTab.path)] ?? null;
        return (
          <div className="h-full overflow-auto">
            <div className="px-4 py-4">
              {loadingFileKey === buildFileCacheKey(selectedRoot.workbenchRootId, activePaneTab.path) ? (
                <div className="text-sm text-stone-600">Loading file...</div>
              ) : paneFile ? (
                <WorkbenchFilePreview file={paneFile} filePath={activePaneTab.path} />
              ) : (
                <div className="text-sm text-stone-600">File preview unavailable.</div>
              )}
            </div>
          </div>
        );
      }
      case "diff": {
        const diffCacheKey = buildGitDiffCacheKey(selectedRoot.workbenchRootId, activePaneTab.mode);
        const diffResult = gitDiffByKey[diffCacheKey] ?? null;
        const diffFile = diffResult?.files.find((file) => file.path === activePaneTab.path) ?? null;
        return (
          <WorkspaceDiffTab
            filePath={activePaneTab.path}
            file={diffFile}
            status={selectedGitStatus}
            mode={activePaneTab.mode}
            loading={loadingGitDiff.has(diffCacheKey)}
            onOpenFile={() => void openFileTab(selectedRoot, activePaneTab.path, { paneId })}
          />
        );
      }
      case "terminal":
        return (
          <WorkbenchTerminalPane
            key={`${selectedRoot.workbenchRootId}:${activePaneTab.terminalId}`}
            rootId={selectedRoot.workbenchRootId}
            terminalId={activePaneTab.terminalId}
          />
        );
      default:
        return null;
    }
  }, [
    conversationById,
    directConversationByAgentId,
    fileCache,
    gitDiffByKey,
    loadingFileKey,
    loadingGitDiff,
    onOpenAgentThread,
    openFileTab,
    selectedAgent,
    selectedGitStatus,
    selectedRoot,
  ]);

  const renderPaneLeaf = useCallback((pane: WorkbenchPaneLeaf) => {
    if (!selectedRoot) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-sm text-stone-600">
          Choose a project or shared resource to open this workspace.
        </div>
      );
    }

    const paneTabs = pane.tabIds
      .map((tabId) => tabsById.get(tabId) ?? null)
      .filter((tab): tab is WorkbenchTab => !!tab);
    const activePaneTab = paneTabs.find((tab) => tab.id === pane.activeTabId) ?? paneTabs[0] ?? null;
    const paneFocused = focusedPaneId === pane.id;
    const paneDropHovered = paneDropTarget?.paneId === pane.id;
    const paneDropPosition = paneDropHovered ? paneDropTarget?.position ?? "center" : null;

    return (
      <div
        className={cn(
          "relative flex h-full min-h-0 flex-col bg-[#fffdf5]",
          paneFocused ? "outline outline-2 outline-offset-[-2px] outline-[rgba(196,181,253,0.52)]" : "",
          paneDropHovered ? "bg-[#fff1a9]" : "",
        )}
        onMouseDown={() => focusLayoutPane(selectedRoot.workbenchRootId, pane.id, { splitCapable: selectedRootIsSplitCapable })}
        onDragOver={(event) => {
          if (!selectedRootIsSplitCapable) return;
          if (!event.dataTransfer.types.includes(WORKBENCH_FILE_DRAG_MIME)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          const nextPosition = getPaneDropPosition(event);
          if (paneDropTarget?.paneId !== pane.id || paneDropTarget.position !== nextPosition) {
            setPaneDropTarget({ paneId: pane.id, position: nextPosition });
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          if (paneDropTarget?.paneId === pane.id) {
            setPaneDropTarget(null);
          }
        }}
        onDrop={(event) => void handlePaneFileDrop(pane.id, event)}
      >
        {paneDropHovered ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-0 z-10 rounded-sm border-2 border-dashed border-[#8b7be8] bg-[rgba(196,181,253,0.08)]",
              paneDropPosition === "center" ? "inset-3" : "",
              paneDropPosition === "left" ? "right-1/2" : "",
              paneDropPosition === "right" ? "left-1/2" : "",
              paneDropPosition === "top" ? "bottom-1/2" : "",
              paneDropPosition === "bottom" ? "top-1/2" : "",
            )}
          >
            <div className="flex h-full items-center justify-center px-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-violet-950">
              {paneDropPosition === "center"
                ? "Open Here"
                : paneDropPosition === "left"
                  ? "Split Left"
                  : paneDropPosition === "right"
                    ? "Split Right"
                    : paneDropPosition === "top"
                      ? "Split Up"
                      : "Split Down"}
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2 border-b-2 border-amber-300/80 bg-[#fff3b3] px-2 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {paneTabs.length === 0 ? (
              <div className="px-2 text-xs text-stone-600">
                {paneDropHovered ? "Drop to open or split." : "Drag a file here or to an edge to split."}
              </div>
            ) : paneTabs.map((tab) => {
              const isActive = activePaneTab?.id === tab.id;
              return (
                <div
                  key={tab.id}
                  className={cn(
                    "group flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] shadow-[2px_2px_0_0_rgba(180,120,32,0.12)]",
                    isActive
                      ? "border-zinc-900 bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]"
                      : "border-amber-300 bg-[#fffdf5] text-stone-700 hover:bg-[#fff1a9]",
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1"
                    onClick={() => focusLayoutTab(
                      selectedRoot.workbenchRootId,
                      pane.id,
                      tab.id,
                      { splitCapable: selectedRootIsSplitCapable },
                    )}
                  >
                    {tab.kind === "terminal" ? (
                      <TerminalIcon className="size-3.5" />
                    ) : tab.kind === "agent" ? (
                      <BotIcon className="size-3.5" />
                    ) : tab.kind === "diff" ? (
                      <GitBranchIcon className="size-3.5" />
                    ) : (
                      <FileTextIcon className="size-3.5" />
                    )}
                    <span className="max-w-[96px] truncate xl:max-w-[144px]">{tab.title}</span>
                  </button>
                  <button
                    type="button"
                    title="Close tab"
                    aria-label="Close tab"
                    className={cn(
                      "inline-flex size-4 shrink-0 items-center justify-center rounded-sm transition-colors",
                      isActive
                        ? "bg-[rgba(0,0,0,0.08)] text-stone-950 hover:bg-[rgba(0,0,0,0.14)]"
                        : "text-stone-600 hover:bg-[#fff1a9]",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      void closeTab(selectedRoot, tab.id);
                    }}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="min-h-0 flex-1">
          {renderPaneContent(pane.id, activePaneTab)}
        </div>
      </div>
    );
  }, [
    closeTab,
    focusedPaneId,
    focusLayoutPane,
    focusLayoutTab,
    handlePaneFileDrop,
    paneDropTarget,
    renderPaneContent,
    selectedRoot,
    selectedRootIsSplitCapable,
    tabsById,
  ]);

  const renderPaneNode = useCallback((node: WorkbenchPaneNode): ReactNode => {
    if (!selectedRoot) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-sm text-stone-600">
          Choose a project or shared resource to open this workspace.
        </div>
      );
    }

    if (node.kind === "pane") {
      return renderPaneLeaf(node);
    }

    return (
      <ResizablePanelGroup
        direction={node.direction === "vertical" ? "vertical" : "horizontal"}
        onLayout={(sizes) => {
          if (sizes.length === 2) {
            const nextSizes: [number, number] = [sizes[0] ?? 50, sizes[1] ?? 50];
            if (Math.abs((node.sizes[0] ?? 50) - nextSizes[0]) < 0.25 && Math.abs((node.sizes[1] ?? 50) - nextSizes[1]) < 0.25) {
              return;
            }
            setLayoutSplitSizes(
              selectedRoot.workbenchRootId,
              node.id,
              nextSizes,
              { splitCapable: selectedRootIsSplitCapable },
            );
          }
        }}
        className="h-full"
      >
        <ResizablePanel defaultSize={node.sizes[0]} minSize={18}>
          {renderPaneNode(node.first)}
        </ResizablePanel>
        <ResizableHandle withHandle showHandleOnHover />
        <ResizablePanel defaultSize={node.sizes[1]} minSize={18}>
          {renderPaneNode(node.second)}
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }, [renderPaneLeaf, selectedRoot, selectedRootIsSplitCapable, setLayoutSplitSizes]);

  return (
    <div className="flex h-full flex-col bg-[#fff9d0] text-stone-900">
      <div className="border-b-2 border-amber-300/80 bg-[#fffdf5] px-4 py-3 shadow-[0_4px_0_0_rgba(180,120,32,0.08)]">
        <div className="flex items-center gap-3">
          {onToggleSidebar ? (
            <button
              type="button"
              className="cursor-pointer shrink-0 rounded-sm border-2 border-amber-300 bg-[#fffdf5] p-1 shadow-[3px_3px_0_0_rgba(180,120,32,0.12)] hover:bg-[#fff1a9]"
              onClick={onToggleSidebar}
              title="Open sidebar"
              aria-label="Open sidebar"
            >
              <MenuIcon className="size-4 text-stone-700" />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FolderSearchIcon className="size-4 shrink-0 text-stone-700" />
              <h2 className="truncate text-sm font-semibold tracking-tight text-stone-900">Workspace</h2>
            </div>
            <div className="mt-0.5 text-[11px] text-stone-600">
      Shared project directories and shared roots, with files, tabs, and persistent terminals.
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-sm border-2 border-amber-300 bg-[#fffdf5] text-stone-800 shadow-[3px_3px_0_0_rgba(180,120,32,0.12)] hover:bg-[#fff1a9]"
            onClick={onExitResources}
          >
            <ArrowLeftIcon className="mr-1.5 size-3" />
            Exit Workspace
          </Button>
        </div>
      </div>

      {workbenchError ? (
        <div className="border-b-2 border-[#d77a7a] bg-[#fff1f1] px-4 py-2 text-sm text-[#a11d1d]">
          {workbenchError}
        </div>
      ) : null}
      {!workbenchError && workbenchNotice ? (
        <div className="border-b-2 border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          {workbenchNotice}
        </div>
      ) : null}

      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId="workspace-shell-layout"
        className="min-h-0 flex-1"
      >
        <ResizablePanel defaultSize={18} minSize={14} maxSize={28}>
          <div className="flex h-full min-h-0 flex-col border-r-2 border-amber-300/80 bg-[#fff9d0]">
            <div className="flex items-center justify-between gap-2 border-b-2 border-amber-300/80 bg-[#ffd54a] px-3 py-2">
              <div className="min-w-0 text-[10px] font-semibold uppercase tracking-[0.24em] text-stone-800">
                Workspaces
              </div>
              <div className="flex items-center gap-1">
                {selectedRootIsSplitCapable && selectedRoot && paneCount > 1 ? (
                  <ToolbarIconButton
                    label="Close focused pane"
                    className="size-7 border-amber-300 bg-[#fff3b3] text-stone-800 hover:bg-[#fff1a9]"
                    onClick={() => closeLayoutPane(
                      selectedRoot.workbenchRootId,
                      focusedPaneId,
                      { splitCapable: true },
                    )}
                  >
                    <XIcon className="size-3.5" />
                  </ToolbarIconButton>
                ) : null}
                {selectedRoot?.terminalSupported ? (
                  <ToolbarIconButton
                    label="New terminal"
                    className="size-7 border-amber-300 bg-[#fff3b3] text-stone-800 hover:bg-[#fff1a9]"
                    onClick={() => void handleCreateTerminal(lastLaunchCwdByRoot[selectedRoot.workbenchRootId] ?? "")}
                  >
                    <TerminalIcon className="size-3.5" />
                  </ToolbarIconButton>
                ) : null}
                {selectedRoot?.kind === "agent_workspace" && selectedRoot.agentId ? (
                  <ToolbarIconButton
                    label="Open agent in workspace"
                    className="size-7 border-amber-300 bg-[#fff3b3] text-stone-800 hover:bg-[#fff1a9]"
                    onClick={() => void handleOpenWorkspaceAgentTab(selectedRoot)}
                  >
                    <BotIcon className="size-3.5" />
                  </ToolbarIconButton>
                ) : null}
                {selectedRoot?.kind === "project_space" && selectedRootSupportsChanges ? (
                  <div className="relative">
                    <ToolbarIconButton
                      label="Git actions"
                      className="size-7 border-amber-300 bg-[#fff3b3] text-stone-800 hover:bg-[#fff1a9]"
                      onClick={() => setShowGitActionsMenu((current) => !current)}
                    >
                      <GitBranchIcon className={cn("size-3.5", currentGitAction ? "animate-pulse" : "")} />
                    </ToolbarIconButton>
                    {showGitActionsMenu ? (
                      <div className="absolute right-0 z-20 mt-2 min-w-[180px] rounded-sm border-2 border-amber-300 bg-[#fffdf5] p-1.5 shadow-[6px_6px_0_0_rgba(180,120,32,0.16)]">
                        <ToolbarMenuButton
                          label={currentGitAction === "fetch" ? "Fetching..." : "Fetch"}
                          disabled={!!currentGitAction}
                          onClick={() => {
                            setShowGitActionsMenu(false);
                            void executeGitAction(selectedRoot, "fetch");
                          }}
                        />
                        <ToolbarMenuButton
                          label={currentGitAction === "pull_ff_only" ? "Pulling..." : "Pull"}
                          disabled={!!currentGitAction || !hasGitRemote}
                          title={hasGitRemote ? "Pull with --ff-only" : "No remote configured for this checkout"}
                          onClick={() => {
                            setShowGitActionsMenu(false);
                            void executeGitAction(selectedRoot, "pull_ff_only");
                          }}
                        />
                        <ToolbarMenuButton
                          label="Commit all"
                          disabled={!!currentGitAction}
                          onClick={() => {
                            setShowGitActionsMenu(false);
                            setShowCommitDialog(true);
                          }}
                        />
                        <ToolbarMenuButton
                          label={currentGitAction === "push" ? "Pushing..." : "Push"}
                          disabled={!!currentGitAction || !hasGitRemote}
                          title={hasGitRemote ? "Push current branch" : "No remote configured for this checkout"}
                          onClick={() => {
                            setShowGitActionsMenu(false);
                            void executeGitAction(selectedRoot, "push");
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {loadingRoots ? <span className="ml-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-amber-700">Loading...</span> : null}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="space-y-4 bg-[#fff9d0] p-2">
                <ProjectSection
                  title="Recent Projects"
                  emptyText="Open a project to pin it here."
                  projects={recentProjects}
                  selectedRootId={selectedRootId}
                  expandedProjectIds={expandedProjects}
                  onSelectProject={handleSelectProject}
                  onSelectWorkspace={handleSelectWorkspace}
                  onToggleProject={toggleProjectExpanded}
                />
                <ProjectSection
                  title="Projects"
                  emptyText="No shared projects yet. Set a Project Directory on an agent first."
                  projects={projects}
                  selectedRootId={selectedRootId}
                  expandedProjectIds={expandedProjects}
                  onSelectProject={handleSelectProject}
                  onSelectWorkspace={handleSelectWorkspace}
                  onToggleProject={toggleProjectExpanded}
                />
                <RootSection
                  title="Shared Resources"
                  emptyText="No resource spaces yet."
                  roots={resourceRoots}
                  selectedRootId={selectedRootId}
                  onSelectRoot={setSelectedRootId}
                />
              </div>
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle showHandleOnHover />

        <ResizablePanel defaultSize={explorerCollapsed ? 82 : 58} minSize={34}>
          <div className={cn(
            "flex h-full min-h-0 flex-col bg-[#fffdf5]",
            explorerCollapsed ? "" : "border-r-2 border-amber-300/80",
          )}>
            <div className="border-b-2 border-amber-300/80 bg-[#fffdf5] px-4 py-3">
              <div className="space-y-3">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-stone-600 xl:flex-nowrap">
                      <div className="min-w-0 shrink-0 text-sm font-semibold leading-5 text-stone-900 xl:max-w-[280px] xl:truncate">
                        {selectedProject?.displayName ?? (selectedRoot ? selectedRoot.rootPath : "Workspace")}
                      </div>
                      {selectedProject ? (
                        <span className="shrink-0 rounded-sm border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-stone-700">{selectedProject.projectKind}</span>
                      ) : null}
                      {selectedRoot ? (
                        <span className="shrink-0 rounded-sm border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">{selectedRoot.sourceLabel}</span>
                      ) : null}
                      {selectedRoot?.kind === "resource_space" && selectedRoot.resourceType ? (
                        <span className="shrink-0 rounded-sm border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-stone-700">{selectedRoot.resourceType}</span>
                      ) : null}
                      {selectedRoot?.kind === "resource_space" && selectedRoot.backendType ? (
                        <span className="shrink-0 rounded-sm border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-stone-700">{selectedRoot.backendType}</span>
                      ) : null}
                      {selectedRoot?.nodeId ? (
                        <span className="shrink-0 rounded-sm border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-stone-700">
                          Node: {machineNameById.get(selectedRoot.nodeId) ?? selectedRoot.nodeId}
                        </span>
                      ) : null}
                      {selectedRoot ? (
                        <div className="min-w-0 flex-1 font-mono text-[11px] leading-4 text-stone-600 xl:truncate">
                          {selectedRoot.rootPath}
                        </div>
                      ) : null}
                    </div>

                    <div className="mt-2 min-h-7">
                      {selectedRoot?.kind === "project_space" && selectedProjectAgents.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {selectedProjectAgents.map((agent) => (
                            <Button
                              key={agent.agentId}
                              size="sm"
                              variant="outline"
                              className="h-7 rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-2 text-[11px] text-stone-800 shadow-[3px_3px_0_0_rgba(180,120,32,0.12)] hover:bg-[#fff1a9]"
                              onClick={() => onOpenAgentThread(agent.agentId)}
                            >
                              <MessageSquareIcon className="mr-1.5 size-3.5" />
                              {agent.name}
                            </Button>
                          ))}
                        </div>
                      ) : (
                        <div className="text-[11px] text-stone-600">
                          {selectedRoot
                            ? "Use the workspace chrome to inspect this root, open terminals, or jump back to chat."
                            : "Select a workspace root to inspect its files, changes, and terminals."}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                    {selectedRoot?.kind === "agent_workspace" && selectedRoot.agentId ? (
                      <ToolbarIconButton
                        label="Open chat"
                        onClick={() => onOpenAgentThread(selectedRoot.agentId!)}
                      >
                        <MessageSquareIcon className="size-3.5" />
                      </ToolbarIconButton>
                    ) : null}
                    <ToolbarIconButton
                      label={explorerCollapsed ? "Show explorer" : "Hide explorer"}
                      onClick={() => {
                        if (!selectedRoot) return;
                        setStoredExplorerCollapsed(selectedRoot.workbenchRootId, !explorerCollapsed);
                      }}
                    >
                      <FolderSearchIcon className="size-3.5" />
                    </ToolbarIconButton>
                    {isAdmin && selectedResourceSpace ? (
                      <ToolbarIconButton
                        label="Delete resource space"
                        className="border-[#b94c4c] bg-[#fff1f1] text-[#a11d1d] hover:bg-[#ffe4e4]"
                        onClick={() => setShowDeleteDialog(true)}
                      >
                        <Trash2Icon className="size-3" />
                      </ToolbarIconButton>
                    ) : null}
                    {isAdmin ? (
                      <ToolbarIconButton
                        label="Create resource space"
                        className="border-zinc-900 bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]"
                        onClick={() => setShowCreateDialog(true)}
                      >
                        <PlusIcon className="size-3" />
                      </ToolbarIconButton>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1">
                {!selectedRoot ? (
                  <div className="flex h-full items-center justify-center px-6 text-sm text-stone-600">
                    Choose a project or shared resource to open this workspace.
                  </div>
                ) : (
                  renderPaneNode(selectedRootLayout!.root)
                )}
              </div>
            </div>
          </div>
        </ResizablePanel>

        {!explorerCollapsed ? (
          <>
            <ResizableHandle withHandle showHandleOnHover />

            <ResizablePanel defaultSize={24} minSize={18} maxSize={32}>
              <div className="flex h-full min-h-0 flex-col bg-[#fff9d0]">
                <div className="flex items-center justify-between gap-2 border-b-2 border-amber-300/80 bg-[#fff3b3] px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-stone-900">Explorer</div>
                    <div className="mt-1 text-[11px] text-stone-600">
                      {selectedRootSupportsChanges
                        ? "Inspect git changes or browse files in the current project root."
                        : "Browse the current root and open files into workspace tabs."}
                    </div>
                    {selectedRootSupportsChanges ? (
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          className={cn(
                            "rounded-sm border px-2 py-1 text-[11px] font-semibold",
                            selectedExplorerTab === "changes"
                              ? "border-zinc-900 bg-[#ffd54a] text-zinc-950"
                              : "border-amber-300 bg-[#fffdf5] text-stone-700 hover:bg-[#fff1a9]",
                          )}
                          onClick={() => selectedRoot && setExplorerTab(selectedRoot.workbenchRootId, "changes")}
                        >
                          Changes
                        </button>
                        <button
                          type="button"
                          className={cn(
                            "rounded-sm border px-2 py-1 text-[11px] font-semibold",
                            selectedExplorerTab === "files"
                              ? "border-zinc-900 bg-[#ffd54a] text-zinc-950"
                              : "border-amber-300 bg-[#fffdf5] text-stone-700 hover:bg-[#fff1a9]",
                          )}
                          onClick={() => selectedRoot && setExplorerTab(selectedRoot.workbenchRootId, "files")}
                        >
                          Files
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <Button
                    size="icon-xs"
                    variant="outline"
                    className="rounded-sm border-2 border-amber-300 bg-[#fffdf5] text-stone-800 hover:bg-[#fff1a9]"
                    onClick={() => void handleRefresh()}
                    disabled={!selectedRoot}
                    title="Refresh"
                  >
                    <RefreshCwIcon className="size-3" />
                  </Button>
                </div>
                <div className="border-b-2 border-amber-300/80 bg-[#fff8d8] px-3 py-2 text-xs text-stone-700">
                  <div className="truncate font-mono text-[11px]">
                    {selectedRoot ? selectedRoot.rootPath : "Select a root"}
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <div className="p-2">
                    {!selectedRoot ? (
                      <EmptyNotice>Select a workspace root first.</EmptyNotice>
                    ) : selectedExplorerTab === "changes" && selectedRootSupportsChanges ? (
                      <WorkspaceChangesPane
                        status={selectedGitStatus}
                        diff={selectedGitDiff}
                        loadingStatus={loadingGitStatus.has(selectedRoot.workbenchRootId)}
                        loadingDiff={selectedGitDiffKey ? loadingGitDiff.has(selectedGitDiffKey) : false}
                        diffMode={selectedDiffMode}
                        onChangeMode={(mode) => {
                          setGitDiffModeByRoot((prev) => ({ ...prev, [selectedRoot.workbenchRootId]: mode }));
                        }}
                        onRefresh={() => void handleRefresh()}
                        onOpenDiff={(resourcePath, mode) => {
                          if (!selectedRoot) return;
                          openDiffTab(selectedRoot, resourcePath, mode, { paneId: focusedPaneId });
                        }}
                        onOpenFile={(resourcePath) => {
                          if (!selectedRoot) return;
                          void openFileTab(selectedRoot, resourcePath, { paneId: focusedPaneId });
                        }}
                      />
                    ) : selectedRoot && loadingDirectories.has(buildDirectoryCacheKey(selectedRoot.workbenchRootId, "")) && rootEntries.length === 0 ? (
                      <div className="px-2 py-3 text-sm text-stone-600">Loading files...</div>
                    ) : rootEntries.length === 0 ? (
                      <EmptyNotice>This workspace root is empty.</EmptyNotice>
                    ) : (
                      <WorkbenchTree
                        rootId={selectedRoot.workbenchRootId}
                        parentPath=""
                        directories={directories}
                        expanded={expanded}
                        activeFilePath={activeFilePath}
                        loadingDirectories={loadingDirectories}
                        onToggleDirectory={handleToggleDirectory}
                        onSelectFile={(resourcePath) => {
                          if (!selectedRoot) return;
                          void openFileTab(selectedRoot, resourcePath, { paneId: focusedPaneId });
                        }}
                        onDragFileEnd={() => setPaneDropTarget(null)}
                      />
                    )}
                  </div>
                </div>

                {selectedRoot ? (
                  <div className="border-t-2 border-amber-300/80 bg-[#fff3b3] p-3">
                    {selectedRoot.kind === "resource_space" ? (
                      <div className="space-y-3 rounded-sm border-2 border-amber-300/80 bg-[#fffdf5] p-3 shadow-[4px_4px_0_0_rgba(180,120,32,0.12)]">
                        <div className="flex items-center gap-2">
                          <BotIcon className="size-4 text-stone-700" />
                          <div className="text-sm font-semibold text-stone-900">Ask Agent</div>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-semibold uppercase tracking-[0.24em] text-stone-700">
                            Agent
                          </label>
                          <select
                            className="w-full rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-2 py-2 text-sm text-stone-900"
                            value={selectedAgentId}
                            onChange={(event) => setSelectedAgentId(event.target.value)}
                          >
                            {agents.map((agent) => (
                              <option key={agent.agentId} value={agent.agentId}>
                                {agent.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-semibold uppercase tracking-[0.24em] text-stone-700">
                            Current file
                          </label>
                          <div className="rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-2 py-2 text-xs text-stone-700">
                            {activeFilePath ?? "Select a text file first"}
                          </div>
                          {activeFile && !activeFileSupportsAnalysis ? (
                            <div className="text-[11px] text-stone-600">
                              `Analyze` currently supports text files only.
                            </div>
                          ) : null}
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-semibold uppercase tracking-[0.24em] text-stone-700">
                            Question
                          </label>
                          <textarea
                            value={question}
                            onChange={(event) => setQuestion(event.target.value)}
                            className="min-h-[120px] w-full resize-none rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400"
                            placeholder="Ask for summary, review, comparison, diagnosis, or next steps."
                          />
                        </div>
                        <Button
                          className="w-full rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-zinc-950 shadow-[4px_4px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
                          onClick={() => void handleAnalyze()}
                          disabled={!selectedResourceSpace || !activeFilePath || !selectedAgentId || !question.trim() || askingAgent || !activeFileSupportsAnalysis}
                        >
                          <SendIcon className="mr-1.5 size-4" />
                          {askingAgent ? "Sending..." : "Analyze In Private Thread"}
                        </Button>
                      </div>
                    ) : selectedRoot.terminalSupported ? (
                      <div className="space-y-2">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-stone-700">
                          Recent Terminal Dirs
                        </div>
                        {(recentTerminalDirsByRoot[selectedRoot.workbenchRootId] ?? []).length === 0 ? (
                          <div className="rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-3 py-3 text-xs text-stone-600">
                            Launch a terminal to remember common working directories.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {(recentTerminalDirsByRoot[selectedRoot.workbenchRootId] ?? []).map((cwd) => (
                              <button
                                key={cwd || "(root)"}
                                type="button"
                                className="w-full rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-3 py-2 text-left text-xs text-stone-900 shadow-[4px_4px_0_0_rgba(180,120,32,0.12)] hover:bg-[#fff1a9]"
                                onClick={() => void handleCreateTerminal(cwd)}
                              >
                                <div className="font-semibold text-stone-900">{cwd || "."}</div>
                                <div className="mt-1 text-[11px] text-stone-600">Launch terminal in this directory</div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>

      <CreateDialog
        isOpen={showCreateDialog}
        title="New Resource Space"
        onClose={() => setShowCreateDialog(false)}
      >
        <ResourceSpaceCreatePanel
          channels={channels}
          machines={machines}
          onClose={() => setShowCreateDialog(false)}
          onCreate={async (req) => {
            const resourceSpace = await onCreateResourceSpace(req);
            await refreshRoots();
            setSelectedRootId(buildResourceRootId(resourceSpace.resourceSpaceId));
            setShowCreateDialog(false);
            return resourceSpace;
          }}
        />
      </CreateDialog>

      <CreateDialog
        isOpen={showCommitDialog}
        title="Commit All Changes"
        onClose={() => {
          if (!currentGitAction) {
            setShowCommitDialog(false);
          }
        }}
      >
        <div className="space-y-3">
          <div className="text-sm text-stone-700">
            Stage all current project changes and create a commit in the selected project root.
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-semibold uppercase tracking-[0.24em] text-stone-700">
              Commit message
            </label>
            <textarea
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              className="min-h-[120px] w-full resize-none rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400"
              placeholder="Describe the change..."
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-3 text-[11px] text-stone-800 shadow-[3px_3px_0_0_rgba(180,120,32,0.12)] hover:bg-[#fff1a9]"
              onClick={() => setShowCommitDialog(false)}
              disabled={!!currentGitAction}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-8 rounded-sm border-2 border-zinc-900 bg-[#ffd54a] px-3 text-[11px] text-zinc-950 shadow-[3px_3px_0_0_rgba(180,120,32,0.16)] hover:bg-[#f7ca2e]"
              onClick={() => void handleSubmitCommit()}
              disabled={!!currentGitAction || !commitMessage.trim()}
            >
              {currentGitAction === "commit_all" ? "Committing..." : "Commit All"}
            </Button>
          </div>
        </div>
      </CreateDialog>

      <ConfirmDialog
        isOpen={showDeleteDialog}
        title="Delete Resource Space"
        message={selectedResourceSpace
          ? `Delete resource space "${selectedResourceSpace.name}"?\n\nThis only removes the resource-space entry from the platform. Files under ${selectedResourceSpace.rootPath} will stay on disk.`
          : "Delete this resource space?"}
        confirmText={deletingResourceSpace ? "Deleting..." : "Delete Space"}
        cancelText="Cancel"
        variant="danger"
        onCancel={() => {
          if (!deletingResourceSpace) {
            setShowDeleteDialog(false);
          }
        }}
        onConfirm={() => void handleDeleteResourceSpace()}
      />
    </div>
  );
}

type RootSectionProps = {
  title: string;
  emptyText: string;
  roots: WorkbenchRootInfo[];
  selectedRootId: string | null;
  onSelectRoot: (rootId: string) => void;
};

type ProjectSectionProps = {
  title: string;
  emptyText: string;
  projects: WorkbenchProjectInfo[];
  selectedRootId: string | null;
  expandedProjectIds: Set<string>;
  onSelectProject: (project: WorkbenchProjectInfo) => void;
  onSelectWorkspace: (project: WorkbenchProjectInfo, workspace: WorkbenchWorkspaceInfo) => void;
  onToggleProject: (projectId: string) => void;
};

function ProjectSection({
  title,
  emptyText,
  projects,
  selectedRootId,
  expandedProjectIds,
  onSelectProject,
  onSelectWorkspace,
  onToggleProject,
}: ProjectSectionProps) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-stone-700">{title}</div>
      {projects.length === 0 ? (
        <div className="rounded-sm border-2 border-dashed border-amber-300 bg-[#fffdf5] px-3 py-4 text-center text-xs text-stone-600">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-2">
          {projects.map((project) => {
            const expanded = project.workspaces.length > 1 && expandedProjectIds.has(project.projectId);
            const selected = project.workspaces.some((workspace) => workspace.workbenchRootId === selectedRootId);
            const linkedAgentCount = project.workspaces.reduce(
              (total, workspace) => total + (workspace.agentIds?.length ?? (workspace.agentId ? 1 : 0)),
              0,
            );
            return (
              <div key={project.projectId} className="space-y-1">
                <button
                  type="button"
                  onClick={() => {
                    if (project.workspaces.length > 1) {
                      onToggleProject(project.projectId);
                    }
                    onSelectProject(project);
                  }}
                  className={cn(
                    "w-full rounded-sm border-2 px-3 py-2.5 text-left shadow-[4px_4px_0_0_rgba(180,120,32,0.12)] transition-colors",
                    selected
                      ? "border-[#8b7be8] bg-[#c4b5fd] text-zinc-950"
                      : "border-amber-300 bg-[#fffdf5] text-stone-900 hover:bg-[#fff1a9]",
                  )}
                >
                  <div className="flex items-start gap-2">
                    {project.workspaces.length > 1 ? (
                      expanded ? <ChevronDownIcon className="mt-0.5 size-3 shrink-0 text-current" /> : <ChevronRightIcon className="mt-0.5 size-3 shrink-0 text-current" />
                    ) : (
                      <FolderIcon className="mt-0.5 size-3.5 shrink-0 text-current" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold leading-4 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">
                        {project.displayName}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <span className={cn(
                          "rounded border px-1.5 py-0.5 text-[10px]",
                          selected
                            ? "border-zinc-700 bg-[rgba(255,255,255,0.28)] text-zinc-950"
                            : "border-amber-300 bg-amber-50 text-stone-700",
                        )}>
                          {project.projectKind}
                        </span>
                        <span className={cn(
                          "rounded border px-1.5 py-0.5 text-[10px]",
                          selected
                            ? "border-zinc-700 bg-[rgba(255,255,255,0.28)] text-zinc-950"
                            : "border-emerald-200 bg-emerald-50 text-emerald-700",
                        )}>
                          {linkedAgentCount} agent{linkedAgentCount === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className={cn(
                        "mt-1 font-mono text-[10px] leading-4 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden [overflow-wrap:anywhere]",
                        selected ? "text-violet-950" : "text-stone-600",
                      )}>
                        {project.primaryRootPath ?? project.remoteUrl ?? "No primary path"}
                      </div>
                    </div>
                  </div>
                </button>
                {expanded ? (
                  <div className="ml-2.5 space-y-1 border-l-2 border-amber-200 pl-2">
                    {project.workspaces.map((workspace) => {
                      const workspaceSelected = workspace.workbenchRootId === selectedRootId;
                      return (
                        <button
                          key={workspace.workspaceId}
                          type="button"
                          onClick={() => onSelectWorkspace(project, workspace)}
                          className={cn(
                            "w-full rounded-sm border px-2.5 py-2 text-left text-xs transition-colors",
                            workspaceSelected
                              ? "border-[#8b7be8] bg-[#c4b5fd] text-zinc-950"
                              : "border-amber-300 bg-[#fffdf5] text-stone-900 hover:bg-[#fff1a9]",
                          )}
                        >
                          <div className="font-semibold leading-4 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">
                            {workspace.displayName}
                          </div>
                          <div className={cn(
                            "mt-1 flex flex-wrap gap-1 text-[10px]",
                            workspaceSelected ? "text-violet-950" : "text-stone-600",
                          )}>
                            <span>{workspace.workspaceKind}</span>
                            {workspace.branchName ? <span>{workspace.branchName}</span> : null}
                          </div>
                          <div className={cn(
                            "mt-1 font-mono text-[10px] leading-4 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden [overflow-wrap:anywhere]",
                            workspaceSelected ? "text-violet-950" : "text-stone-600",
                          )}>{workspace.rootPath}</div>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RootSection({ title, emptyText, roots, selectedRootId, onSelectRoot }: RootSectionProps) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-stone-700">{title}</div>
      {roots.length === 0 ? (
        <div className="rounded-sm border-2 border-dashed border-amber-300 bg-[#fffdf5] px-3 py-4 text-center text-xs text-stone-600">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-2">
          {roots.map((root) => {
            const selected = selectedRootId === root.workbenchRootId;
            return (
              <button
                key={root.workbenchRootId}
                type="button"
                onClick={() => onSelectRoot(root.workbenchRootId)}
                className={cn(
                  "w-full rounded-sm border-2 px-3 py-2.5 text-left shadow-[4px_4px_0_0_rgba(180,120,32,0.12)] transition-colors",
                  selected
                    ? "border-[#8b7be8] bg-[#c4b5fd] text-zinc-950"
                    : "border-amber-300 bg-[#fffdf5] text-stone-900 hover:bg-[#fff1a9]",
                )}
              >
                <div className="text-xs font-semibold leading-4 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">
                  {root.displayName}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <span className={cn(
                    "rounded border px-1.5 py-0.5 text-[10px]",
                    selected
                      ? "border-zinc-700 bg-[rgba(255,255,255,0.28)] text-zinc-950"
                      : "border-emerald-200 bg-emerald-50 text-emerald-700",
                  )}>
                    {root.sourceLabel}
                  </span>
                  {root.kind === "resource_space" && root.backendType ? (
                    <span className={cn(
                    "rounded border px-1.5 py-0.5 text-[10px]",
                    selected
                      ? "border-zinc-700 bg-[rgba(255,255,255,0.28)] text-zinc-950"
                      : "border-amber-300 bg-amber-50 text-stone-700",
                    )}>
                      {root.backendType}
                    </span>
                  ) : null}
                </div>
                <div className={cn(
                  "mt-1 font-mono text-[10px] leading-4 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden [overflow-wrap:anywhere]",
                  selected ? "text-violet-950" : "text-stone-600",
                )}>{root.rootPath}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmptyNotice({ children }: { children: string }) {
  return (
    <div className="rounded-sm border-2 border-dashed border-amber-300 bg-[#fffdf5] px-3 py-4 text-center text-xs text-stone-600">
      {children}
    </div>
  );
}

function ToolbarIconButton({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; children: ReactNode }) {
  return (
    <Button
      size="icon-sm"
      variant="outline"
      className={cn(
        "rounded-sm border-2 border-amber-300 bg-[#fffdf5] text-stone-800 shadow-[3px_3px_0_0_rgba(180,120,32,0.12)] hover:bg-[#fff1a9]",
        className,
      )}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </Button>
  );
}

function ToolbarMenuButton({
  label,
  className,
  ...props
}: React.ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs text-stone-800 hover:bg-[#fff1a9] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {label}
    </button>
  );
}

type WorkbenchTreeProps = {
  rootId: string;
  parentPath: string;
  directories: DirectoryState;
  expanded: Set<string>;
  activeFilePath: string | null;
  loadingDirectories: Set<string>;
  onToggleDirectory: (resourcePath: string) => void;
  onSelectFile: (resourcePath: string) => void;
  onDragFileEnd: () => void;
};

function WorkbenchTree({
  rootId,
  parentPath,
  directories,
  expanded,
  activeFilePath,
  loadingDirectories,
  onToggleDirectory,
  onSelectFile,
  onDragFileEnd,
}: WorkbenchTreeProps) {
  const entries = directories[buildDirectoryCacheKey(rootId, parentPath)] ?? [];

  return (
    <div className="space-y-1">
      {entries.map((entry) => {
        const isDirectory = entry.kind === "directory";
        const isExpanded = expanded.has(entry.path);
        const isSelected = !isDirectory && activeFilePath === entry.path;
        return (
          <div key={entry.path}>
            <div className={cn(
              "flex items-center gap-1 rounded-sm px-2 py-1.5 text-left text-xs text-stone-800 transition-colors",
              isSelected ? "bg-[#c4b5fd] text-zinc-950" : "hover:bg-[#fff1a9]",
            )}>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                draggable={!isDirectory}
                onClick={() => {
                  if (isDirectory) {
                    onToggleDirectory(entry.path);
                    return;
                  }
                  onSelectFile(entry.path);
                }}
                onDragStart={(event) => {
                  if (isDirectory) return;
                  event.dataTransfer.effectAllowed = "copy";
                  event.dataTransfer.setData(
                    WORKBENCH_FILE_DRAG_MIME,
                    serializeWorkbenchFileDropPayload({ rootId, path: entry.path }),
                  );
                }}
                onDragEnd={onDragFileEnd}
              >
                {isDirectory ? (
                  isExpanded ? <ChevronDownIcon className="size-3 shrink-0 text-amber-500" /> : <ChevronRightIcon className="size-3 shrink-0 text-amber-500" />
                ) : (
                  <span className="size-3 shrink-0" />
                )}
                {isDirectory ? (
                  <FolderIcon className="size-3.5 shrink-0 text-stone-700" />
                ) : isMarkdownPreviewName(entry.name) ? (
                  <FileTextIcon className="size-3.5 shrink-0 text-emerald-700" />
                ) : (
                  <FileIcon className="size-3.5 shrink-0 text-amber-600" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
            </div>
            {isDirectory && isExpanded ? (
              <div className="ml-2.5 border-l-2 border-amber-200 pl-1.5">
                {loadingDirectories.has(buildDirectoryCacheKey(rootId, entry.path)) && !(directories[buildDirectoryCacheKey(rootId, entry.path)]?.length) ? (
                  <div className="px-2 py-1 text-[11px] text-stone-600">Loading...</div>
                ) : (
                  <WorkbenchTree
                    rootId={rootId}
                    parentPath={entry.path}
                    directories={directories}
                    expanded={expanded}
                    activeFilePath={activeFilePath}
                    loadingDirectories={loadingDirectories}
                    onToggleDirectory={onToggleDirectory}
                    onSelectFile={onSelectFile}
                    onDragFileEnd={onDragFileEnd}
                  />
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function WorkbenchTerminalPane({
  rootId,
  terminalId,
}: {
  rootId: string;
  terminalId: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [terminalState, setTerminalState] = useState<"connecting" | "ready" | "error">("connecting");
  const [terminalError, setTerminalError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return undefined;

    setTerminalState("connecting");
    setTerminalError(null);

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      theme: {
        background: "#fff8e8",
        foreground: "#78350f",
        cursor: "#92400e",
        selectionBackground: "#f9d8e5",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    terminal.focus();

    const token = localStorage.getItem("auth_token") ?? "";
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/workbench/terminals/${encodeURIComponent(terminalId)}/stream?token=${encodeURIComponent(token)}&rootId=${encodeURIComponent(rootId)}`;
    const socket = new WebSocket(wsUrl);
    let receivedTerminalOutput = false;
    let disposed = false;

    let resizeFrame = 0;
    const sendResize = () => {
      if (!containerRef.current) return;
      fitAddon.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const scheduleResize = () => {
      if (resizeFrame) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = window.requestAnimationFrame(() => {
          sendResize();
          terminal.focus();
        });
      });
    };

    const observer = new ResizeObserver(() => {
      scheduleResize();
    });
    observer.observe(containerRef.current);

    const onDataDisposable = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    socket.addEventListener("open", () => {
      scheduleResize();
    });

    socket.addEventListener("message", (event) => {
      if (disposed) return;
      const message = JSON.parse(String(event.data)) as
        | { type: "snapshot"; buffer: string }
        | { type: "output"; data: string }
        | { type: "exit"; exitCode?: number | null; signal?: string | null }
        | { type: "error"; message: string }
        | { type: "pong" };

      if (message.type === "snapshot") {
        receivedTerminalOutput = true;
        terminal.reset();
        if (message.buffer) {
          terminal.write(message.buffer);
        }
        setTerminalState("ready");
        setTerminalError(null);
        scheduleResize();
        return;
      }
      if (message.type === "output") {
        receivedTerminalOutput = true;
        setTerminalState("ready");
        terminal.write(message.data);
        return;
      }
      if (message.type === "exit") {
        receivedTerminalOutput = true;
        setTerminalState("ready");
        const exitLabel = message.exitCode != null
          ? `exit ${message.exitCode}`
          : message.signal
            ? `signal ${message.signal}`
            : "done";
        terminal.writeln(`\r\n[terminal ${exitLabel}]`);
        return;
      }
      if (message.type === "error") {
        setTerminalState("error");
        setTerminalError(message.message);
        terminal.writeln(`\r\n[error] ${message.message}`);
      }
    });

    socket.addEventListener("close", () => {
      if (disposed) return;
      if (!receivedTerminalOutput) {
        setTerminalState("error");
        setTerminalError((current) => current ?? "Terminal connection closed before any output was received.");
      }
    });

    return () => {
      disposed = true;
      if (resizeFrame) {
        window.cancelAnimationFrame(resizeFrame);
      }
      observer.disconnect();
      onDataDisposable.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [rootId, terminalId]);

  return (
    <div className="relative flex h-full min-h-0 w-full bg-[#fff9d0] p-2">
      <div
        ref={containerRef}
        className="h-full min-h-0 w-full overflow-hidden rounded-sm border-2 border-amber-300/80 bg-[#fffdf5]"
      />
      {terminalState !== "ready" ? (
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-sm border-2 border-dashed border-amber-300 bg-[#fff9d0]/90 px-4 text-sm text-stone-600">
          {terminalState === "error"
            ? (terminalError ?? "Terminal connection failed.")
            : "Connecting terminal..."}
        </div>
      ) : null}
    </div>
  );
}

function WorkbenchFilePreview({
  file,
  filePath,
}: {
  file: WorkbenchFileResult;
  filePath: string;
}) {
  if (file.mimeType === "text/markdown" && shouldRenderMarkdownPreview(filePath)) {
    return (
      <div className="rounded-sm border-2 border-amber-300/80 bg-[#fffdf5] px-4 py-4 shadow-[4px_4px_0_0_rgba(180,120,32,0.12)] [&_.prose]:max-w-none [&_.prose]:text-stone-800 [&_.prose_a]:text-[#c85a83] [&_.prose_code]:text-stone-700 [&_.prose_h1]:text-stone-900 [&_.prose_h2]:text-stone-900 [&_.prose_h3]:text-stone-900 [&_.prose_li]:text-stone-700 [&_.prose_p]:text-stone-700">
        <FileMarkdownResponse>{file.content}</FileMarkdownResponse>
      </div>
    );
  }

  if (file.mimeType.startsWith("image/")) {
    return (
      <div className="flex justify-center rounded-sm border-2 border-amber-300/80 bg-[#fffdf5] p-3 shadow-[4px_4px_0_0_rgba(180,120,32,0.12)]">
        <img
          src={file.content}
          alt={filePath}
          className="max-h-[70vh] max-w-full rounded-sm object-contain"
        />
      </div>
    );
  }

  return (
    <CodeBlock
      code={file.content}
      language={inferCodeLanguageFromPath(filePath)}
      showLineNumbers
      className="shadow-[4px_4px_0_0_rgba(92,126,182,0.14)]"
    />
  );
}

function filterVisibleWorkbenchEntries(
  root: WorkbenchRootInfo,
  resourcePath: string,
  entries: AgentWorkspaceEntry[],
): AgentWorkspaceEntry[] {
  if (root.kind !== "resource_space" || resourcePath !== "") return entries;
  return entries.filter((entry) => {
    if (entry.kind === "file" && entry.name === "MEMORY.md") return false;
    if (entry.kind === "directory" && entry.name === "notes") return false;
    return true;
  });
}

function pickDefaultWorkbenchEntry(
  root: WorkbenchRootInfo,
  entries: AgentWorkspaceEntry[],
): AgentWorkspaceEntry | null {
  if (root.kind === "agent_workspace") {
    return entries.find((entry) => entry.kind === "file" && entry.name === "MEMORY.md") ?? null;
  }

  if (root.kind === "project_space") {
    return null;
  }

  const preferred = KEY_DEFAULT_FILE_NAMES
    .map((name) => entries.find((entry) => entry.kind === "file" && entry.name === name))
    .find(Boolean);
  if (preferred) return preferred ?? null;

  if (root.resourceType === "docs") {
    return entries.find(
      (entry) =>
        entry.kind === "file"
        && isMarkdownPreviewName(entry.name)
        && entry.name !== "MEMORY.md",
    ) ?? null;
  }

  return null;
}

function buildFileTabId(resourcePath: string): string {
  return `file:${resourcePath}`;
}

function buildDiffTabId(resourcePath: string, mode: WorkbenchGitDiffMode): string {
  return `diff:${mode}:${resourcePath}`;
}

function buildAgentTabId(agentId: string): string {
  return `agent:${agentId}`;
}

function buildTerminalTabId(terminalId: string): string {
  return `terminal:${terminalId}`;
}

function buildFileCacheKey(rootId: string, resourcePath: string): string {
  return `${rootId}:${resourcePath}`;
}

function buildDirectoryCacheKey(rootId: string, resourcePath: string): string {
  return `${rootId}:${resourcePath}`;
}

function buildGitDiffCacheKey(rootId: string, mode: WorkbenchGitDiffMode): string {
  return `${rootId}:${mode}`;
}

const WORKBENCH_FILE_DRAG_MIME = "application/x-agent-collab-workbench-file";

function serializeWorkbenchFileDropPayload(payload: { rootId: string; path: string }): string {
  return JSON.stringify(payload);
}

function parseWorkbenchFileDropPayload(
  value: string | null | undefined,
): { rootId: string; path: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<{ rootId: string; path: string }>;
    if (typeof parsed.rootId !== "string" || !parsed.rootId.trim()) return null;
    if (typeof parsed.path !== "string" || !parsed.path.trim()) return null;
    return { rootId: parsed.rootId, path: parsed.path };
  } catch {
    return null;
  }
}

function buildResourceRootId(resourceSpaceId: string): string {
  return `resource:${resourceSpaceId}`;
}

function normalizeLaunchCwd(cwd: string | null | undefined): string {
  return cwd?.trim() ? cwd.trim().replace(/^\/+/, "") : "";
}

function mergeRecentTerminalDirs(current: string[], cwd: string): string[] {
  const normalized = normalizeLaunchCwd(cwd);
  return [normalized, ...current.filter((item) => item !== normalized)].slice(0, 5);
}

function formatGitActionNotice(result: WorkbenchGitActionApiResult): string {
  const actionLabel = result.action === "pull_ff_only"
    ? "Pull"
    : result.action === "commit_all"
      ? "Commit"
      : result.action.charAt(0).toUpperCase() + result.action.slice(1);
  const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean)[0] ?? "";
  if (!detail) return `${actionLabel} completed.`;
  const singleLine = detail.split(/\r?\n/).find((line: string) => line.trim())?.trim() ?? detail.trim();
  return `${actionLabel} completed: ${singleLine}`;
}

function clearDirectoryEntriesForRoot(
  directories: DirectoryState,
  rootId: string,
): DirectoryState {
  const next: DirectoryState = {};
  const prefix = `${rootId}:`;
  for (const [key, value] of Object.entries(directories)) {
    if (!key.startsWith(prefix)) {
      next[key] = value;
    }
  }
  return next;
}

function isMarkdownPreviewName(fileName: string): boolean {
  const normalized = fileName.trim().toLowerCase();
  return normalized.endsWith(".md")
    || normalized.endsWith(".mdx")
    || normalized.endsWith(".markdown")
    || normalized.endsWith(".mdown")
    || normalized.endsWith(".mkd");
}


type ResourceSpaceCreatePanelProps = {
  channels: ChannelInfo[];
  machines: MachineInfo[];
  onClose: () => void;
  onCreate: (req: CreateResourceSpaceRequest) => Promise<ResourceSpaceInfo>;
};

function ResourceSpaceCreatePanel({
  channels,
  machines,
  onClose,
  onCreate,
}: ResourceSpaceCreatePanelProps) {
  const [name, setName] = useState("");
  const [resourceType, setResourceType] = useState<ResourceSpaceInfo["resourceType"]>("docs");
  const [backendType, setBackendType] = useState<ResourceSpaceInfo["backendType"]>("shared_mount");
  const [nodeId, setNodeId] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [channelId, setChannelId] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    if (!name.trim() || !rootPath.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        resourceType,
        backendType,
        rootPath: rootPath.trim(),
        ...(nodeId.trim() ? { nodeId: nodeId.trim() } : {}),
        ...(channelId ? { channelId } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setCreating(false);
    }
  }, [backendType, channelId, description, name, nodeId, onCreate, resourceType, rootPath]);

  return (
    <div className="space-y-3">
      {error ? (
        <div className="rounded-sm border-2 border-[#d77a7a] bg-[#fff1f1] px-3 py-2 text-xs text-[#a11d1d]">
          {error}
        </div>
      ) : null}

      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-[0.2em] text-stone-700">Name</label>
        <div className="flex items-center gap-1 rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-1.5 py-1">
          <FolderIcon className="size-3 text-stone-700" />
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full bg-transparent text-xs text-stone-900 outline-none placeholder:text-stone-400"
            placeholder="shared-docs"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-[0.2em] text-stone-700">Resource Type</label>
          <select
            className="w-full rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-2 py-2 text-xs text-stone-900"
            value={resourceType}
            onChange={(event) => setResourceType(event.target.value as ResourceSpaceInfo["resourceType"])}
          >
            <option value="docs">docs</option>
            <option value="experiments">experiments</option>
            <option value="mixed">mixed</option>
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-[0.2em] text-stone-700">Backend</label>
          <select
            className="w-full rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-2 py-2 text-xs text-stone-900"
            value={backendType}
            onChange={(event) => setBackendType(event.target.value as ResourceSpaceInfo["backendType"])}
          >
            <option value="shared_mount">shared_mount</option>
            <option value="node_path">node_path</option>
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-[0.2em] text-stone-700">
          {backendType === "node_path" ? "Node" : "Preferred Node (optional)"}
        </label>
        <select
          className="w-full rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-2 py-2 text-xs text-stone-900"
          value={nodeId}
          onChange={(event) => setNodeId(event.target.value)}
        >
          <option value="">{backendType === "node_path" ? "Select a node" : "Auto-select any online node"}</option>
          {machines.map((machine) => (
            <option key={machine.nodeId} value={machine.nodeId}>
              {machine.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-[0.2em] text-stone-700">Root Path</label>
        <input
          value={rootPath}
          onChange={(event) => setRootPath(event.target.value)}
          className="w-full rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-2 py-2 text-xs text-stone-900 outline-none placeholder:text-stone-400"
          placeholder="/shared/docs"
        />
      </div>

      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-[0.2em] text-stone-700">Related Channel (optional)</label>
        <div className="flex items-center gap-1 rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-1.5 py-1">
          <HashIcon className="size-3 text-emerald-700" />
          <select
            className="w-full bg-transparent text-xs text-stone-900 outline-none"
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
          >
            <option value="">No related channel</option>
            {channels.map((channel) => (
              <option key={channel.channelId} value={channel.channelId}>
                #{channel.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-[0.2em] text-stone-700">Description</label>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="min-h-[72px] w-full resize-none rounded-sm border-2 border-amber-300 bg-[#fffdf5] px-2 py-2 text-xs text-stone-900 outline-none placeholder:text-stone-400"
          placeholder="What this resource space is for..."
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          className="rounded-sm border-2 border-amber-300 bg-[#fffdf5] text-stone-800 hover:bg-[#fff1a9]"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-zinc-950 shadow-[4px_4px_0_0_rgba(180,120,32,0.16)] hover:bg-[#f7ca2e]"
          onClick={() => void handleCreate()}
          disabled={creating || !name.trim() || !rootPath.trim() || (backendType === "node_path" && !nodeId.trim())}
        >
          {creating ? "Creating..." : "Create"}
        </Button>
      </div>
    </div>
  );
}
