export type PersistedWorkbenchTab =
  | { id: string; kind: "file"; path: string; title: string }
  | { id: string; kind: "terminal"; terminalId: string; title: string }
  | { id: string; kind: "agent"; agentId: string; conversationId: string; title: string };

export type WorkbenchPersistenceState = {
  recentProjectIds: string[];
  lastWorkspaceIdByProject: Record<string, string>;
  tabsByWorkspaceId: Record<string, PersistedWorkbenchTab[]>;
  focusedTabIdByWorkspaceId: Record<string, string>;
  recentTerminalDirsByWorkspaceId: Record<string, string[]>;
  lastLaunchCwdByWorkspaceId: Record<string, string>;
};

const STORAGE_PREFIX = "agent-collab:workbench:v1";

export function createEmptyWorkbenchPersistenceState(): WorkbenchPersistenceState {
  return {
    recentProjectIds: [],
    lastWorkspaceIdByProject: {},
    tabsByWorkspaceId: {},
    focusedTabIdByWorkspaceId: {},
    recentTerminalDirsByWorkspaceId: {},
    lastLaunchCwdByWorkspaceId: {},
  };
}

export function loadWorkbenchPersistenceState(userId: string | null | undefined): WorkbenchPersistenceState {
  if (!userId || typeof window === "undefined") {
    return createEmptyWorkbenchPersistenceState();
  }

  try {
    const raw = window.localStorage.getItem(buildStorageKey(userId));
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

function sanitizeWorkbenchPersistenceState(input: Partial<WorkbenchPersistenceState>): WorkbenchPersistenceState {
  return {
    recentProjectIds: sanitizeStringArray(input.recentProjectIds, 6),
    lastWorkspaceIdByProject: sanitizeStringMap(input.lastWorkspaceIdByProject),
    tabsByWorkspaceId: sanitizeTabsByWorkspaceId(input.tabsByWorkspaceId),
    focusedTabIdByWorkspaceId: sanitizeStringMap(input.focusedTabIdByWorkspaceId),
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
