import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderSearchIcon,
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
  WorkbenchFileResult,
  WorkbenchProjectInfo,
  WorkbenchRootInfo,
  WorkbenchTerminalInfo,
  WorkbenchWorkspaceInfo,
} from "@agent-collab/protocol";
import { FileMarkdownResponse } from "@/components/ai-elements/message";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  listWorkbenchProjects,
  listWorkbenchRoots,
  listWorkbenchTerminals,
  listWorkbenchTree,
  readWorkbenchFile,
} from "@/lib/api";
import {
  loadWorkbenchPersistenceState,
  saveWorkbenchPersistenceState,
  type PersistedWorkbenchTab,
} from "./workbenchPersistence";
import { WorkspaceAgentPane } from "./WorkspaceAgentPane";

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

type WorkbenchTab = PersistedWorkbenchTab;

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
  const [tabsByRoot, setTabsByRoot] = useState<Record<string, WorkbenchTab[]>>(persistedState.tabsByWorkspaceId);
  const [activeTabIdByRoot, setActiveTabIdByRoot] = useState<Record<string, string>>(persistedState.focusedTabIdByWorkspaceId);
  const [fileCache, setFileCache] = useState<Record<string, WorkbenchFileResult>>({});
  const [loadingFileKey, setLoadingFileKey] = useState<string | null>(null);
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
  const [explorerCollapsed, setExplorerCollapsed] = useState(true);
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
    setTabsByRoot(state.tabsByWorkspaceId);
    setActiveTabIdByRoot(state.focusedTabIdByWorkspaceId);
    setRecentTerminalDirsByRoot(state.recentTerminalDirsByWorkspaceId);
    setLastLaunchCwdByRoot(state.lastLaunchCwdByWorkspaceId);
    hydratedPersistenceUserIdRef.current = user.id;
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id || hydratedPersistenceUserIdRef.current !== user.id) return;
    saveWorkbenchPersistenceState(user.id, {
      recentProjectIds,
      lastWorkspaceIdByProject,
      tabsByWorkspaceId: tabsByRoot,
      focusedTabIdByWorkspaceId: activeTabIdByRoot,
      recentTerminalDirsByWorkspaceId: recentTerminalDirsByRoot,
      lastLaunchCwdByWorkspaceId: lastLaunchCwdByRoot,
    });
  }, [
    activeTabIdByRoot,
    lastLaunchCwdByRoot,
    lastWorkspaceIdByProject,
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
  const currentTabs = selectedRoot ? (tabsByRoot[selectedRoot.workbenchRootId] ?? []) : [];
  const activeTabId = selectedRoot ? activeTabIdByRoot[selectedRoot.workbenchRootId] ?? currentTabs[0]?.id ?? null : null;
  const activeTab = currentTabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeFile = selectedRoot && activeTab?.kind === "file"
    ? fileCache[buildFileCacheKey(selectedRoot.workbenchRootId, activeTab.path)] ?? null
    : null;
  const activeAgentConversation = activeTab?.kind === "agent"
    ? conversationById.get(activeTab.conversationId) ?? directConversationByAgentId.get(activeTab.agentId) ?? null
    : null;
  const activeFilePath = activeTab?.kind === "file" ? activeTab.path : null;
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
    setQuestion("");
    initializedRootIdRef.current = null;
  }, [selectedRootId]);

  const rememberProjectSelection = useCallback((projectId: string, workspaceId: string) => {
    setRecentProjectIds((prev) => [projectId, ...prev.filter((item) => item !== projectId)].slice(0, 6));
    setLastWorkspaceIdByProject((prev) => ({ ...prev, [projectId]: workspaceId }));
  }, []);

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

  const focusTab = useCallback((rootId: string, tabId: string) => {
    setActiveTabIdByRoot((prev) => ({ ...prev, [rootId]: tabId }));
  }, []);

  const openFileTab = useCallback(async (root: WorkbenchRootInfo, resourcePath: string) => {
    const title = (resourcePath.split("/").filter(Boolean).pop() ?? resourcePath) || "Root";
    const tabId = buildFileTabId(resourcePath);
    setTabsByRoot((prev) => {
      const current = prev[root.workbenchRootId] ?? [];
      if (current.some((tab) => tab.id === tabId)) return prev;
      return {
        ...prev,
        [root.workbenchRootId]: [...current, { id: tabId, kind: "file", path: resourcePath, title }],
      };
    });
    focusTab(root.workbenchRootId, tabId);
    const cacheKey = buildFileCacheKey(root.workbenchRootId, resourcePath);
    if (!fileCache[cacheKey]) {
      await loadFile(root, resourcePath);
    }
  }, [fileCache, focusTab, loadFile]);

  const openTerminalTab = useCallback((root: WorkbenchRootInfo, terminal: WorkbenchTerminalInfo) => {
    const tabId = buildTerminalTabId(terminal.terminalId);
    setTabsByRoot((prev) => {
      const current = prev[root.workbenchRootId] ?? [];
      if (current.some((tab) => tab.id === tabId)) {
        return {
          ...prev,
          [root.workbenchRootId]: current.map((tab) => (
            tab.id === tabId ? { ...tab, title: terminal.name } : tab
          )),
        };
      }
      return {
        ...prev,
        [root.workbenchRootId]: [...current, { id: tabId, kind: "terminal", terminalId: terminal.terminalId, title: terminal.name }],
      };
    });
    focusTab(root.workbenchRootId, tabId);
  }, [focusTab]);

  const openAgentTab = useCallback((root: WorkbenchRootInfo, agentId: string, conversation: ConversationInfo, title: string) => {
    const tabId = buildAgentTabId(agentId);
    setTabsByRoot((prev) => {
      const current = prev[root.workbenchRootId] ?? [];
      if (current.some((tab) => tab.id === tabId)) {
        return {
          ...prev,
          [root.workbenchRootId]: current.map((tab) => (
            tab.id === tabId
              ? { ...tab, conversationId: conversation.id, title }
              : tab
          )),
        };
      }
      return {
        ...prev,
        [root.workbenchRootId]: [
          ...current,
          { id: tabId, kind: "agent", agentId, conversationId: conversation.id, title },
        ],
      };
    });
    focusTab(root.workbenchRootId, tabId);
  }, [focusTab]);

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
    setTabsByRoot((prev) => {
      return {
        ...prev,
        [root.workbenchRootId]: nextTabs,
      };
    });
    setActiveTabIdByRoot((prev) => {
      if (prev[root.workbenchRootId] !== tabId) return prev;
      return {
        ...prev,
        [root.workbenchRootId]: nextTabs[nextTabs.length - 1]?.id ?? "",
      };
    });
  }, []);

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
      setTabsByRoot((prev) => {
        if (nextTabs.length === currentTabsForRoot.length) return prev;
        return {
          ...prev,
          [root.workbenchRootId]: nextTabs,
        };
      });
      setActiveTabIdByRoot((prev) => {
        const currentActiveTabId = prev[root.workbenchRootId];
        if (!currentActiveTabId) return prev;
        const isStillValid = nextTabs.some((tab) => tab.id === currentActiveTabId);
        if (isStillValid) return prev;
        const fallbackTabId = nextTabs.at(-1)?.id ?? "";
        return {
          ...prev,
          [root.workbenchRootId]: fallbackTabId,
        };
      });
      return result.terminals;
    } catch (error) {
      setWorkbenchError(String((error as Error)?.message ?? error));
      return [];
    }
  }, [terminalsByRoot]);

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
      openTerminalTab(selectedRoot, terminal);
    } catch (error) {
      setWorkbenchError(String((error as Error)?.message ?? error));
    }
  }, [openTerminalTab, selectedRoot]);

  useEffect(() => {
    if (!selectedRoot) return;
    const existingTabs = tabsByRoot[selectedRoot.workbenchRootId] ?? [];
    if (existingTabs.length > 0) {
      if (!activeTabIdByRoot[selectedRoot.workbenchRootId]) {
        focusTab(selectedRoot.workbenchRootId, existingTabs[0]?.id ?? "");
      }
      return;
    }
    if (initializedRootIdRef.current === selectedRoot.workbenchRootId) return;
    initializedRootIdRef.current = selectedRoot.workbenchRootId;

    if (selectedRoot.kind === "agent_workspace" && selectedRoot.agentId) {
      void handleOpenWorkspaceAgentTab(selectedRoot);
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
    activeTabIdByRoot,
    directories,
    focusTab,
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

  const handleRefresh = useCallback(async () => {
    if (!selectedRoot) return;
    await refreshRoots();
    setDirectories((prev) => clearDirectoryEntriesForRoot(prev, selectedRoot.workbenchRootId));
    setExpanded(new Set());
    setWorkbenchError(null);
    const entries = await loadDirectory(selectedRoot, "", { force: true });
    if (activeTab?.kind === "file") {
      await loadFile(selectedRoot, activeTab.path);
    } else if (!activeTab && entries) {
      const defaultEntry = pickDefaultWorkbenchEntry(selectedRoot, entries);
      if (defaultEntry?.kind === "file") {
        await openFileTab(selectedRoot, defaultEntry.path);
      }
    }
    if (selectedRoot.terminalSupported) {
      await loadTerminals(selectedRoot, { force: true });
    }
  }, [activeTab, loadDirectory, loadFile, loadTerminals, openFileTab, refreshRoots, selectedRoot]);

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

  return (
    <div className="flex h-full flex-col bg-white text-slate-900">
      <div className="border-b-2 border-slate-200 bg-white px-4 py-3 shadow-[0_4px_0_0_rgba(15,23,42,0.05)]">
        <div className="flex items-center gap-3">
          {onToggleSidebar ? (
            <button
              type="button"
              className="cursor-pointer shrink-0 rounded-sm border-2 border-slate-300 bg-white p-1 shadow-[3px_3px_0_0_rgba(15,23,42,0.08)] hover:bg-slate-50"
              onClick={onToggleSidebar}
              title="Open sidebar"
              aria-label="Open sidebar"
            >
              <MenuIcon className="size-4 text-slate-700" />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FolderSearchIcon className="size-4 shrink-0 text-slate-700" />
              <h2 className="truncate text-sm font-semibold tracking-tight text-slate-950">Workspace</h2>
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">
      Shared project directories and shared roots, with files, tabs, and persistent terminals.
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-sm border-2 border-slate-300 bg-white text-slate-900 shadow-[3px_3px_0_0_rgba(15,23,42,0.08)] hover:bg-slate-50"
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

      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId="workspace-shell-layout"
        className="min-h-0 flex-1"
      >
        <ResizablePanel defaultSize={18} minSize={14} maxSize={28}>
          <div className="flex h-full min-h-0 flex-col border-r-2 border-slate-200 bg-white">
            <div className="flex items-center justify-between gap-2 border-b-2 border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500">
              Workspaces
              {loadingRoots ? <span className="text-[9px] text-slate-400">Loading...</span> : null}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-4 p-2">
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
            </ScrollArea>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle showHandleOnHover />

        <ResizablePanel defaultSize={explorerCollapsed ? 82 : 58} minSize={34}>
          <div className={cn(
            "flex h-full min-h-0 flex-col bg-white",
            explorerCollapsed ? "" : "border-r-2 border-slate-200",
          )}>
            <div className="border-b-2 border-slate-200 bg-white px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-950">
                    {selectedProject?.displayName ?? (selectedRoot ? selectedRoot.rootPath : "Workspace")}
                  </div>
                  {selectedRoot ? (
                    <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
                      {selectedProject ? (
                        <span className="rounded-sm border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-700">{selectedProject.projectKind}</span>
                      ) : null}
                      <span className="rounded-sm border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">{selectedRoot.sourceLabel}</span>
                      {selectedRoot.kind === "resource_space" && selectedRoot.resourceType ? (
                        <span className="rounded-sm border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-600">{selectedRoot.resourceType}</span>
                      ) : null}
                      {selectedRoot.kind === "resource_space" && selectedRoot.backendType ? (
                        <span className="rounded-sm border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-600">{selectedRoot.backendType}</span>
                      ) : null}
                      {selectedRoot.nodeId ? (
                        <span className="rounded-sm border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700">Node: {machineNameById.get(selectedRoot.nodeId) ?? selectedRoot.nodeId}</span>
                      ) : null}
                    </div>
                  ) : null}
                  {selectedRoot ? (
                    <div className="mt-2 truncate font-mono text-[11px] text-slate-500">
                      {selectedRoot.rootPath}
                    </div>
                  ) : null}
                  {selectedRoot?.kind === "project_space" && selectedProjectAgents.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedProjectAgents.map((agent) => (
                        <Button
                          key={agent.agentId}
                          size="sm"
                          variant="outline"
                          className="h-7 rounded-sm border-2 border-slate-300 bg-white px-2 text-[11px] text-slate-900 shadow-[3px_3px_0_0_rgba(15,23,42,0.08)] hover:bg-slate-50"
                          onClick={() => onOpenAgentThread(agent.agentId)}
                        >
                          <MessageSquareIcon className="mr-1.5 size-3.5" />
                          {agent.name}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  {selectedRoot?.kind === "agent_workspace" && selectedRoot.agentId ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 rounded-sm border-2 border-slate-300 bg-white px-2 text-[11px] text-slate-900 shadow-[3px_3px_0_0_rgba(15,23,42,0.08)] hover:bg-slate-50"
                      onClick={() => onOpenAgentThread(selectedRoot.agentId!)}
                    >
                      <MessageSquareIcon className="mr-1.5 size-3.5" />
                      Open Chat
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-sm border-2 border-slate-300 bg-white px-2 text-[11px] text-slate-900 shadow-[3px_3px_0_0_rgba(15,23,42,0.08)] hover:bg-slate-50"
                    onClick={() => setExplorerCollapsed((current) => !current)}
                  >
                    {explorerCollapsed ? "Show Explorer" : "Hide Explorer"}
                  </Button>
                  {isAdmin && selectedResourceSpace ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 rounded-sm border-2 border-[#b94c4c] bg-[#fff1f1] text-[#a11d1d] shadow-[3px_3px_0_0_rgba(185,76,76,0.16)] hover:bg-[#ffe4e4]"
                      onClick={() => setShowDeleteDialog(true)}
                    >
                      <Trash2Icon className="mr-1.5 size-3" />
                      Delete Space
                    </Button>
                  ) : null}
                  {isAdmin ? (
                    <Button
                      size="sm"
                      className="h-8 rounded-sm border-2 border-slate-950 bg-slate-950 text-white shadow-[3px_3px_0_0_rgba(15,23,42,0.12)] hover:bg-slate-800"
                      onClick={() => setShowCreateDialog(true)}
                    >
                      <PlusIcon className="mr-1.5 size-3" />
                      New Space
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between gap-3 border-b-2 border-slate-200 bg-slate-50 px-2 py-1.5">
                <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                  {currentTabs.length === 0 ? (
                    <div className="px-2 text-xs text-slate-500">Open a file or terminal tab to start.</div>
                  ) : currentTabs.map((tab) => {
                    const isActive = activeTab?.id === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        className={cn(
                          "group flex shrink-0 items-center gap-2 rounded-sm border-2 px-2 py-1 text-xs shadow-[3px_3px_0_0_rgba(15,23,42,0.08)]",
                          isActive
                            ? "border-slate-950 bg-slate-950 text-white"
                            : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                        )}
                        onClick={() => selectedRoot && focusTab(selectedRoot.workbenchRootId, tab.id)}
                      >
                        {tab.kind === "terminal" ? (
                          <TerminalIcon className="size-3.5" />
                        ) : tab.kind === "agent" ? (
                          <BotIcon className="size-3.5" />
                        ) : (
                          <FileTextIcon className="size-3.5" />
                        )}
                        <span className="max-w-[180px] truncate">{tab.title}</span>
                        <span
                          className="rounded-sm p-0.5 hover:bg-slate-900/10"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!selectedRoot) return;
                            void closeTab(selectedRoot, tab.id);
                          }}
                        >
                          <XIcon className="size-3" />
                        </span>
                      </button>
                    );
                  })}
                </div>
                {selectedRoot ? (
                  <div className="flex shrink-0 items-center gap-2">
                    {selectedRoot.kind === "agent_workspace" && selectedRoot.agentId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 rounded-sm border-2 border-slate-300 bg-white px-2 text-[11px] text-slate-900 shadow-[3px_3px_0_0_rgba(15,23,42,0.08)] hover:bg-slate-50"
                        onClick={() => void handleOpenWorkspaceAgentTab(selectedRoot)}
                      >
                        <BotIcon className="mr-1.5 size-3.5" />
                        Open Agent
                      </Button>
                    ) : null}
                    {selectedRoot.terminalSupported ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 rounded-sm border-2 border-slate-300 bg-white px-2 text-[11px] text-slate-900 shadow-[3px_3px_0_0_rgba(15,23,42,0.08)] hover:bg-slate-50"
                        onClick={() => void handleCreateTerminal(lastLaunchCwdByRoot[selectedRoot.workbenchRootId] ?? "")}
                      >
                        <TerminalIcon className="mr-1.5 size-3.5" />
                        New Terminal
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="min-h-0 flex-1">
                {!selectedRoot ? (
                  <div className="flex h-full items-center justify-center px-6 text-sm text-slate-500">
                    Choose a project or shared resource to open this workspace.
                  </div>
                ) : !activeTab ? (
                  <div className="flex h-full items-center justify-center px-6 text-sm text-slate-500">
                    Open a file or terminal from this workspace.
                  </div>
                ) : activeTab.kind === "agent" ? (
                  <WorkspaceAgentPane
                    conversation={activeAgentConversation}
                    agent={selectedAgent}
                    onOpenChat={selectedRoot.agentId ? () => onOpenAgentThread(selectedRoot.agentId!) : undefined}
                  />
                ) : activeTab.kind === "file" ? (
                  <ScrollArea className="h-full">
                    <div className="px-4 py-4">
                      {loadingFileKey === buildFileCacheKey(selectedRoot.workbenchRootId, activeTab.path) ? (
                        <div className="text-sm text-slate-500">Loading file...</div>
                      ) : activeFile ? (
                        <WorkbenchFilePreview file={activeFile} filePath={activeTab.path} />
                      ) : (
                        <div className="text-sm text-slate-500">File preview unavailable.</div>
                      )}
                    </div>
                  </ScrollArea>
                ) : (
                  <WorkbenchTerminalPane
                    rootId={selectedRoot.workbenchRootId}
                    terminalId={activeTab.terminalId}
                  />
                )}
              </div>
            </div>
          </div>
        </ResizablePanel>

        {!explorerCollapsed ? (
          <>
            <ResizableHandle withHandle showHandleOnHover />

            <ResizablePanel defaultSize={24} minSize={18} maxSize={32}>
              <div className="flex h-full min-h-0 flex-col bg-white">
                <div className="flex items-center justify-between gap-2 border-b-2 border-slate-200 bg-slate-50 px-4 py-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-950">Explorer</div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      Browse the current root and open files into workspace tabs.
                    </div>
                  </div>
                  <Button
                    size="icon-xs"
                    variant="outline"
                    className="rounded-sm border-2 border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
                    onClick={() => void handleRefresh()}
                    disabled={!selectedRoot}
                    title="Refresh"
                  >
                    <RefreshCwIcon className="size-3" />
                  </Button>
                </div>
                <div className="border-b-2 border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                  <div className="truncate font-mono text-[11px]">
                    {selectedRoot ? selectedRoot.rootPath : "Select a root"}
                  </div>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="p-2">
                    {!selectedRoot ? (
                      <EmptyNotice>Select a workspace root first.</EmptyNotice>
                    ) : selectedRoot && loadingDirectories.has(buildDirectoryCacheKey(selectedRoot.workbenchRootId, "")) && rootEntries.length === 0 ? (
                      <div className="px-2 py-3 text-sm text-slate-500">Loading files...</div>
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
                          void openFileTab(selectedRoot, resourcePath);
                        }}
                      />
                    )}
                  </div>
                </ScrollArea>

                {selectedRoot ? (
                  <div className="border-t-2 border-slate-200 bg-slate-50 p-3">
                    {selectedRoot.kind === "resource_space" ? (
                      <div className="space-y-3 rounded-sm border-2 border-slate-200 bg-white p-3 shadow-[4px_4px_0_0_rgba(15,23,42,0.08)]">
                        <div className="flex items-center gap-2">
                          <BotIcon className="size-4 text-slate-700" />
                          <div className="text-sm font-semibold text-slate-950">Ask Agent</div>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                            Agent
                          </label>
                          <select
                            className="w-full rounded-sm border-2 border-slate-300 bg-white px-2 py-2 text-sm text-slate-900"
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
                          <label className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                            Current file
                          </label>
                          <div className="rounded-sm border-2 border-slate-300 bg-white px-2 py-2 text-xs text-slate-600">
                            {activeFilePath ?? "Select a text file first"}
                          </div>
                          {activeFile && !activeFileSupportsAnalysis ? (
                            <div className="text-[11px] text-slate-500">
                              `Analyze` currently supports text files only.
                            </div>
                          ) : null}
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                            Question
                          </label>
                          <textarea
                            value={question}
                            onChange={(event) => setQuestion(event.target.value)}
                            className="min-h-[120px] w-full resize-none rounded-sm border-2 border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
                            placeholder="Ask for summary, review, comparison, diagnosis, or next steps."
                          />
                        </div>
                        <Button
                          className="w-full rounded-sm border-2 border-slate-950 bg-slate-950 text-white shadow-[4px_4px_0_0_rgba(15,23,42,0.12)] hover:bg-slate-800"
                          onClick={() => void handleAnalyze()}
                          disabled={!selectedResourceSpace || !activeFilePath || !selectedAgentId || !question.trim() || askingAgent || !activeFileSupportsAnalysis}
                        >
                          <SendIcon className="mr-1.5 size-4" />
                          {askingAgent ? "Sending..." : "Analyze In Private Thread"}
                        </Button>
                      </div>
                    ) : selectedRoot.terminalSupported ? (
                      <div className="space-y-2">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                          Recent Terminal Dirs
                        </div>
                        {(recentTerminalDirsByRoot[selectedRoot.workbenchRootId] ?? []).length === 0 ? (
                          <div className="rounded-sm border-2 border-slate-300 bg-white px-3 py-3 text-xs text-slate-500">
                            Launch a terminal to remember common working directories.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {(recentTerminalDirsByRoot[selectedRoot.workbenchRootId] ?? []).map((cwd) => (
                              <button
                                key={cwd || "(root)"}
                                type="button"
                                className="w-full rounded-sm border-2 border-slate-300 bg-white px-3 py-2 text-left text-xs text-slate-900 shadow-[4px_4px_0_0_rgba(15,23,42,0.08)] hover:bg-slate-50"
                                onClick={() => void handleCreateTerminal(cwd)}
                              >
                                <div className="font-semibold text-slate-950">{cwd || "."}</div>
                                <div className="mt-1 text-[11px] text-slate-500">Launch terminal in this directory</div>
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
      <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500">{title}</div>
      {projects.length === 0 ? (
        <div className="rounded-sm border-2 border-dashed border-slate-300 bg-white px-3 py-4 text-center text-xs text-slate-500">
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
                    "w-full rounded-sm border-2 px-3 py-2 text-left shadow-[4px_4px_0_0_rgba(15,23,42,0.08)] transition-colors",
                    selected
                      ? "border-slate-950 bg-slate-950 text-white"
                      : "border-slate-300 bg-white text-slate-900 hover:bg-slate-50",
                  )}
                >
                  <div className="flex items-center gap-2">
                    {project.workspaces.length > 1 ? (
                      expanded ? <ChevronDownIcon className="size-3 shrink-0 text-current" /> : <ChevronRightIcon className="size-3 shrink-0 text-current" />
                    ) : (
                      <FolderIcon className="size-3.5 shrink-0 text-current" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold">{project.displayName}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <span className={cn(
                          "rounded border px-1.5 py-0.5 text-[10px]",
                          selected
                            ? "border-white/30 bg-white/10 text-white"
                            : "border-slate-300 bg-slate-50 text-slate-700",
                        )}>
                          {project.projectKind}
                        </span>
                        <span className={cn(
                          "rounded border px-1.5 py-0.5 text-[10px]",
                          selected
                            ? "border-white/30 bg-white/10 text-white"
                            : "border-emerald-200 bg-emerald-50 text-emerald-700",
                        )}>
                          {linkedAgentCount} agent{linkedAgentCount === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className={cn(
                        "mt-1 truncate text-[10px]",
                        selected ? "text-slate-800" : "text-slate-500",
                      )}>
                        {project.primaryRootPath ?? project.remoteUrl ?? "No primary path"}
                      </div>
                    </div>
                  </div>
                </button>
                {expanded ? (
                  <div className="ml-4 space-y-1 border-l-2 border-slate-200 pl-2">
                    {project.workspaces.map((workspace) => {
                      const workspaceSelected = workspace.workbenchRootId === selectedRootId;
                      return (
                        <button
                          key={workspace.workspaceId}
                          type="button"
                          onClick={() => onSelectWorkspace(project, workspace)}
                          className={cn(
                            "w-full rounded-sm border px-2 py-2 text-left text-xs transition-colors",
                            workspaceSelected
                              ? "border-slate-400 bg-slate-100 text-slate-950"
                              : "border-slate-300 bg-white text-slate-900 hover:bg-slate-50",
                          )}
                        >
                          <div className="truncate font-semibold">{workspace.displayName}</div>
                          <div className={cn(
                            "mt-1 flex flex-wrap gap-1 text-[10px]",
                            workspaceSelected ? "text-slate-700" : "text-slate-500",
                          )}>
                            <span>{workspace.workspaceKind}</span>
                            {workspace.branchName ? <span>{workspace.branchName}</span> : null}
                          </div>
                          <div className={cn(
                            "mt-1 truncate text-[10px]",
                            workspaceSelected ? "text-slate-700" : "text-slate-500",
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
      <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500">{title}</div>
      {roots.length === 0 ? (
        <div className="rounded-sm border-2 border-dashed border-slate-300 bg-white px-3 py-4 text-center text-xs text-slate-500">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-2">
          {roots.map((root) => (
            <button
              key={root.workbenchRootId}
              type="button"
              onClick={() => onSelectRoot(root.workbenchRootId)}
              className={cn(
                "w-full rounded-sm border-2 px-3 py-2 text-left shadow-[4px_4px_0_0_rgba(15,23,42,0.08)] transition-colors",
                selectedRootId === root.workbenchRootId
                  ? "border-slate-950 bg-slate-950 text-white"
                  : "border-slate-300 bg-white text-slate-900 hover:bg-slate-50",
              )}
            >
              <div className="truncate text-xs font-semibold">{root.displayName}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
                  {root.sourceLabel}
                </span>
                {root.kind === "resource_space" && root.backendType ? (
                  <span className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-700">
                    {root.backendType}
                  </span>
                ) : null}
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-slate-500">{root.rootPath}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyNotice({ children }: { children: string }) {
  return (
    <div className="rounded-sm border-2 border-dashed border-slate-300 bg-white px-3 py-4 text-center text-xs text-slate-500">
      {children}
    </div>
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
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-slate-800 transition-colors",
                isSelected ? "bg-slate-100 text-slate-950" : "hover:bg-slate-50",
              )}
              onClick={() => {
                if (isDirectory) {
                  onToggleDirectory(entry.path);
                  return;
                }
                onSelectFile(entry.path);
              }}
            >
              {isDirectory ? (
                isExpanded ? <ChevronDownIcon className="size-3 shrink-0 text-slate-400" /> : <ChevronRightIcon className="size-3 shrink-0 text-slate-400" />
              ) : (
                <span className="size-3 shrink-0" />
              )}
              {isDirectory ? (
                <FolderIcon className="size-3.5 shrink-0 text-slate-700" />
              ) : isMarkdownPreviewName(entry.name) ? (
                <FileTextIcon className="size-3.5 shrink-0 text-emerald-700" />
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-slate-500" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
            {isDirectory && isExpanded ? (
              <div className="ml-2.5 border-l-2 border-slate-200 pl-1.5">
                {loadingDirectories.has(buildDirectoryCacheKey(rootId, entry.path)) && !(directories[buildDirectoryCacheKey(rootId, entry.path)]?.length) ? (
                  <div className="px-2 py-1 text-[11px] text-slate-500">Loading...</div>
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

  useEffect(() => {
    if (!containerRef.current) return undefined;

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      theme: {
        background: "#ffffff",
        foreground: "#1f2937",
        cursor: "#111827",
        selectionBackground: "#e5e7eb",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    const token = localStorage.getItem("auth_token") ?? "";
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/workbench/terminals/${encodeURIComponent(terminalId)}/stream?token=${encodeURIComponent(token)}&rootId=${encodeURIComponent(rootId)}`;
    const socket = new WebSocket(wsUrl);

    const sendResize = () => {
      fitAddon.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };

    const observer = new ResizeObserver(() => {
      sendResize();
    });
    observer.observe(containerRef.current);

    const onDataDisposable = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    socket.addEventListener("open", () => {
      sendResize();
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as
        | { type: "snapshot"; buffer: string }
        | { type: "output"; data: string }
        | { type: "exit"; exitCode?: number | null; signal?: string | null }
        | { type: "error"; message: string }
        | { type: "pong" };

      if (message.type === "snapshot") {
        terminal.reset();
        if (message.buffer) {
          terminal.write(message.buffer);
        }
        sendResize();
        return;
      }
      if (message.type === "output") {
        terminal.write(message.data);
        return;
      }
      if (message.type === "exit") {
        const exitLabel = message.exitCode != null
          ? `exit ${message.exitCode}`
          : message.signal
            ? `signal ${message.signal}`
            : "done";
        terminal.writeln(`\r\n[terminal ${exitLabel}]`);
        return;
      }
      if (message.type === "error") {
        terminal.writeln(`\r\n[error] ${message.message}`);
      }
    });

    return () => {
      observer.disconnect();
      onDataDisposable.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [rootId, terminalId]);

  return <div ref={containerRef} className="h-full w-full bg-white px-2 py-2" />;
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
      <div className="rounded-sm border-2 border-slate-200 bg-white px-4 py-4 shadow-[4px_4px_0_0_rgba(15,23,42,0.08)] [&_.prose]:max-w-none [&_.prose]:text-slate-800 [&_.prose_a]:text-slate-900 [&_.prose_code]:text-slate-700 [&_.prose_h1]:text-slate-950 [&_.prose_h2]:text-slate-950 [&_.prose_h3]:text-slate-950 [&_.prose_li]:text-slate-700 [&_.prose_p]:text-slate-700">
        <FileMarkdownResponse>{file.content}</FileMarkdownResponse>
      </div>
    );
  }

  if (file.mimeType.startsWith("image/")) {
    return (
      <div className="flex justify-center rounded-sm border-2 border-slate-200 bg-white p-3 shadow-[4px_4px_0_0_rgba(15,23,42,0.08)]">
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
        <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Name</label>
        <div className="flex items-center gap-1 rounded-sm border-2 border-slate-300 bg-white px-1.5 py-1">
          <FolderIcon className="size-3 text-slate-700" />
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full bg-transparent text-xs text-slate-900 outline-none placeholder:text-slate-400"
            placeholder="shared-docs"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Resource Type</label>
          <select
            className="w-full rounded-sm border-2 border-slate-300 bg-white px-2 py-2 text-xs text-slate-900"
            value={resourceType}
            onChange={(event) => setResourceType(event.target.value as ResourceSpaceInfo["resourceType"])}
          >
            <option value="docs">docs</option>
            <option value="experiments">experiments</option>
            <option value="mixed">mixed</option>
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Backend</label>
          <select
            className="w-full rounded-sm border-2 border-slate-300 bg-white px-2 py-2 text-xs text-slate-900"
            value={backendType}
            onChange={(event) => setBackendType(event.target.value as ResourceSpaceInfo["backendType"])}
          >
            <option value="shared_mount">shared_mount</option>
            <option value="node_path">node_path</option>
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">
          {backendType === "node_path" ? "Node" : "Preferred Node (optional)"}
        </label>
        <select
          className="w-full rounded-sm border-2 border-slate-300 bg-white px-2 py-2 text-xs text-slate-900"
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
        <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Root Path</label>
        <input
          value={rootPath}
          onChange={(event) => setRootPath(event.target.value)}
          className="w-full rounded-sm border-2 border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none placeholder:text-slate-400"
          placeholder="/shared/docs"
        />
      </div>

      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Related Channel (optional)</label>
        <div className="flex items-center gap-1 rounded-sm border-2 border-slate-300 bg-white px-1.5 py-1">
          <HashIcon className="size-3 text-emerald-700" />
          <select
            className="w-full bg-transparent text-xs text-slate-900 outline-none"
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
        <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Description</label>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="min-h-[72px] w-full resize-none rounded-sm border-2 border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none placeholder:text-slate-400"
          placeholder="What this resource space is for..."
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          className="rounded-sm border-2 border-slate-300 bg-white text-slate-900 hover:bg-slate-50"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="rounded-sm border-2 border-slate-950 bg-slate-950 text-white shadow-[4px_4px_0_0_rgba(15,23,42,0.12)] hover:bg-slate-800"
          onClick={() => void handleCreate()}
          disabled={creating || !name.trim() || !rootPath.trim() || (backendType === "node_path" && !nodeId.trim())}
        >
          {creating ? "Creating..." : "Create"}
        </Button>
      </div>
    </div>
  );
}
