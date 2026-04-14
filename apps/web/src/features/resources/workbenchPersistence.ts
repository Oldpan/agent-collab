import {
  createDefaultWorkbenchRootLayout,
  normalizeWorkbenchRootLayout,
  type ExplorerTab,
  type WorkbenchPaneSplitDirection,
  type WorkbenchRootLayoutState,
  type WorkbenchTab,
} from "./workbenchTypes";

export type PersistedWorkbenchTab = WorkbenchTab;

export type WorkbenchPersistenceState = {
  recentProjectIds: string[];
  lastWorkspaceIdByProject: Record<string, string>;
  tabsByWorkspaceId: Record<string, PersistedWorkbenchTab[]>;
  layoutByWorkspaceId: Record<string, WorkbenchRootLayoutState>;
  explorerTabByWorkspaceId: Record<string, ExplorerTab>;
  explorerCollapsedByWorkspaceId: Record<string, boolean>;
  recentTerminalDirsByWorkspaceId: Record<string, string[]>;
  lastLaunchCwdByWorkspaceId: Record<string, string>;
};

const STORAGE_PREFIX = "agent-collab:workbench:v3";
const LEGACY_STORAGE_PREFIX = "agent-collab:workbench:v1";

export function createEmptyWorkbenchPersistenceState(): WorkbenchPersistenceState {
  return {
    recentProjectIds: [],
    lastWorkspaceIdByProject: {},
    tabsByWorkspaceId: {},
    layoutByWorkspaceId: {},
    explorerTabByWorkspaceId: {},
    explorerCollapsedByWorkspaceId: {},
    recentTerminalDirsByWorkspaceId: {},
    lastLaunchCwdByWorkspaceId: {},
  };
}

export function loadWorkbenchPersistenceState(userId: string | null | undefined): WorkbenchPersistenceState {
  if (!userId || typeof window === "undefined") {
    return createEmptyWorkbenchPersistenceState();
  }

  try {
    const raw = window.localStorage.getItem(buildStorageKey(userId))
      ?? window.localStorage.getItem(buildLegacyStorageKey(userId));
    if (!raw) return createEmptyWorkbenchPersistenceState();
    const parsed = JSON.parse(raw) as Partial<WorkbenchPersistenceState>;
    return sanitizeWorkbenchPersistenceState(parsed);
  } catch {
    return createEmptyWorkbenchPersistenceState();
  }
}

export function saveWorkbenchPersistenceState(
  userId: string | null | undefined,
  state: WorkbenchPersistenceState,
): void {
  if (!userId || typeof window === "undefined") return;
  window.localStorage.setItem(buildStorageKey(userId), JSON.stringify(sanitizeWorkbenchPersistenceState(state)));
}

function buildStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}:${userId}`;
}

function buildLegacyStorageKey(userId: string): string {
  return `${LEGACY_STORAGE_PREFIX}:${userId}`;
}

function sanitizeWorkbenchPersistenceState(input: Partial<WorkbenchPersistenceState>): WorkbenchPersistenceState {
  const tabsByWorkspaceId = sanitizeTabsByWorkspaceId(input.tabsByWorkspaceId);
  return {
    recentProjectIds: sanitizeStringArray(input.recentProjectIds, 6),
    lastWorkspaceIdByProject: sanitizeStringMap(input.lastWorkspaceIdByProject),
    tabsByWorkspaceId,
    layoutByWorkspaceId: sanitizeLayoutByWorkspaceId(
      input.layoutByWorkspaceId,
      tabsByWorkspaceId,
      (input as Partial<{ focusedTabIdByWorkspaceId: Record<string, string> }>).focusedTabIdByWorkspaceId,
    ),
    explorerTabByWorkspaceId: sanitizeExplorerTabByWorkspaceId(input.explorerTabByWorkspaceId),
    explorerCollapsedByWorkspaceId: sanitizeBooleanMap(input.explorerCollapsedByWorkspaceId),
    recentTerminalDirsByWorkspaceId: sanitizeTerminalDirs(input.recentTerminalDirsByWorkspaceId),
    lastLaunchCwdByWorkspaceId: sanitizeStringMap(input.lastLaunchCwdByWorkspaceId),
  };
}

function sanitizeTabsByWorkspaceId(
  value: Partial<WorkbenchPersistenceState>["tabsByWorkspaceId"],
): Record<string, PersistedWorkbenchTab[]> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, PersistedWorkbenchTab[]> = {};
  for (const [workspaceId, tabs] of Object.entries(value)) {
    if (!Array.isArray(tabs)) continue;
    result[workspaceId] = tabs.reduce<PersistedWorkbenchTab[]>((acc, tab) => {
      if (!tab || typeof tab !== "object" || typeof tab.id !== "string" || typeof tab.kind !== "string" || typeof tab.title !== "string") {
        return acc;
      }
      if (tab.kind === "file" && typeof (tab as { path?: unknown }).path === "string") {
        acc.push({ id: tab.id, kind: "file", path: (tab as { path: string }).path, title: tab.title });
        return acc;
      }
      if (
        tab.kind === "diff"
        && typeof (tab as { path?: unknown }).path === "string"
        && (((tab as { mode?: unknown }).mode === "uncommitted") || ((tab as { mode?: unknown }).mode === "base"))
      ) {
        acc.push({
          id: tab.id,
          kind: "diff",
          path: (tab as { path: string }).path,
          mode: (tab as { mode: "uncommitted" | "base" }).mode,
          title: tab.title,
        });
        return acc;
      }
      if (tab.kind === "terminal" && typeof (tab as { terminalId?: unknown }).terminalId === "string") {
        acc.push({ id: tab.id, kind: "terminal", terminalId: (tab as { terminalId: string }).terminalId, title: tab.title });
        return acc;
      }
      if (
        tab.kind === "agent"
        && typeof (tab as { agentId?: unknown }).agentId === "string"
        && typeof (tab as { conversationId?: unknown }).conversationId === "string"
      ) {
        acc.push({
          id: tab.id,
          kind: "agent",
          agentId: (tab as { agentId: string }).agentId,
          conversationId: (tab as { conversationId: string }).conversationId,
          title: tab.title,
        });
        return acc;
      }
      return acc;
    }, []);
  }
  return result;
}

function sanitizeLayoutByWorkspaceId(
  value: Partial<WorkbenchPersistenceState>["layoutByWorkspaceId"],
  tabsByWorkspaceId: Record<string, PersistedWorkbenchTab[]>,
  legacyFocusedTabIdByWorkspaceId: Record<string, string> | undefined,
): Record<string, WorkbenchRootLayoutState> {
  const result: Record<string, WorkbenchRootLayoutState> = {};
  const workspaces = new Set<string>([
    ...Object.keys(tabsByWorkspaceId),
    ...Object.keys(value ?? {}),
    ...Object.keys(legacyFocusedTabIdByWorkspaceId ?? {}),
  ]);

  for (const workspaceId of workspaces) {
    const tabIds = (tabsByWorkspaceId[workspaceId] ?? []).map((tab) => tab.id);
    const rawLayout = value?.[workspaceId];
    const defaultLayout = createDefaultWorkbenchRootLayout(
      tabIds,
      legacyFocusedTabIdByWorkspaceId?.[workspaceId],
    );
    try {
      result[workspaceId] = normalizeWorkbenchRootLayout(
        migrateLegacyLayout(rawLayout, defaultLayout),
        tabIds,
      );
    } catch {
      result[workspaceId] = defaultLayout;
    }
  }

  return result;
}

function migrateLegacyLayout(
  value: WorkbenchRootLayoutState | Partial<WorkbenchRootLayoutState> | undefined,
  fallback: WorkbenchRootLayoutState,
): WorkbenchRootLayoutState | Partial<WorkbenchRootLayoutState> {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  if ("root" in value && value.root) {
    return value;
  }

  const legacy = value as Partial<{
    focusedPane: "primary" | "secondary";
    splitDirection: WorkbenchPaneSplitDirection;
    secondaryOpen: boolean;
    primaryTabIds: string[];
    secondaryTabIds: string[];
    activeTabIdByPane: { primary?: string; secondary?: string };
  }>;

  const primaryTabIds = Array.isArray(legacy.primaryTabIds) ? legacy.primaryTabIds : fallback.root.kind === "pane" ? fallback.root.tabIds : [];
  const secondaryTabIds = Array.isArray(legacy.secondaryTabIds) ? legacy.secondaryTabIds : [];
  if (!(legacy.secondaryOpen && secondaryTabIds.length > 0)) {
    return createDefaultWorkbenchRootLayout(
      [...primaryTabIds, ...secondaryTabIds],
      legacy.activeTabIdByPane?.primary ?? (fallback.root.kind === "pane" ? fallback.root.activeTabId : null),
    );
  }

  return {
    version: 2,
    focusedPaneId: legacy.focusedPane === "secondary" ? "pane-2" : "pane-1",
    nextPaneNumber: 3,
    nextSplitNumber: 2,
    root: {
      kind: "split",
      id: "split-1",
      direction: legacy.splitDirection === "vertical" ? "vertical" : "horizontal",
      sizes: [50, 50],
      first: {
        kind: "pane",
        id: "pane-1",
        tabIds: primaryTabIds,
        activeTabId: legacy.activeTabIdByPane?.primary ?? primaryTabIds[0] ?? null,
      },
      second: {
        kind: "pane",
        id: "pane-2",
        tabIds: secondaryTabIds,
        activeTabId: legacy.activeTabIdByPane?.secondary ?? secondaryTabIds[0] ?? null,
      },
    },
  };
}

function sanitizeTerminalDirs(
  value: Partial<WorkbenchPersistenceState>["recentTerminalDirsByWorkspaceId"],
): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, string[]> = {};
  for (const [workspaceId, dirs] of Object.entries(value)) {
    result[workspaceId] = sanitizeStringArray(dirs, 5);
  }
  return result;
}

function sanitizeExplorerTabByWorkspaceId(
  value: Partial<WorkbenchPersistenceState>["explorerTabByWorkspaceId"],
): Record<string, ExplorerTab> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, ExplorerTab> = {};
  for (const [workspaceId, tab] of Object.entries(value)) {
    if (tab === "changes" || tab === "files") {
      result[workspaceId] = tab;
    }
  }
  return result;
}

function sanitizeBooleanMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "boolean") {
      result[key] = item;
    }
  }
  return result;
}

function sanitizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && item.trim()) {
      result[key] = item;
    }
  }
  return result;
}

function sanitizeStringArray(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, maxLength);
}
