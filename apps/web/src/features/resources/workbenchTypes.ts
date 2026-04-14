import type { WorkbenchGitDiffMode } from "@agent-collab/protocol";

export type ExplorerTab = "changes" | "files";

export type WorkbenchPaneId = string;
export type WorkbenchSplitId = string;
export type WorkbenchPaneSplitDirection = "horizontal" | "vertical";

export type WorkbenchTab =
  | { id: string; kind: "file"; path: string; title: string }
  | { id: string; kind: "diff"; path: string; mode: WorkbenchGitDiffMode; title: string }
  | { id: string; kind: "terminal"; terminalId: string; title: string }
  | { id: string; kind: "agent"; agentId: string; conversationId: string; title: string };

export type WorkbenchPaneLeaf = {
  kind: "pane";
  id: WorkbenchPaneId;
  tabIds: string[];
  activeTabId: string | null;
};

export type WorkbenchPaneSplit = {
  kind: "split";
  id: WorkbenchSplitId;
  direction: WorkbenchPaneSplitDirection;
  sizes: [number, number];
  first: WorkbenchPaneNode;
  second: WorkbenchPaneNode;
};

export type WorkbenchPaneNode = WorkbenchPaneLeaf | WorkbenchPaneSplit;

export type WorkbenchRootLayoutState = {
  version: 2;
  focusedPaneId: WorkbenchPaneId;
  nextPaneNumber: number;
  nextSplitNumber: number;
  root: WorkbenchPaneNode;
};

export function createDefaultWorkbenchRootLayout(
  tabIds: string[] = [],
  activeTabId?: string | null,
): WorkbenchRootLayoutState {
  const uniqueTabIds = uniqueIds(tabIds);
  return {
    version: 2,
    focusedPaneId: "pane-1",
    nextPaneNumber: 2,
    nextSplitNumber: 2,
    root: {
      kind: "pane",
      id: "pane-1",
      tabIds: uniqueTabIds,
      activeTabId: pickActiveTabId(uniqueTabIds, activeTabId),
    },
  };
}

export function normalizeWorkbenchRootLayout(
  layout: Partial<WorkbenchRootLayoutState> | null | undefined,
  availableTabIds: string[],
  options?: { splitCapable?: boolean },
): WorkbenchRootLayoutState {
  const splitCapable = options?.splitCapable !== false;
  const available = uniqueIds(availableTabIds);

  if (!layout?.root || !splitCapable) {
    const preferredActiveTabId = splitCapable
      ? getPreferredActiveTabId(layout?.root)
      : getPreferredActiveTabId(layout?.root) ?? getLegacyPrimaryActiveTabId(layout);
    return createDefaultWorkbenchRootLayout(available, preferredActiveTabId);
  }

  const seen = new Set<string>();
  const usedPaneIds = new Set<string>();
  const usedSplitIds = new Set<string>();
  const sanitizedRoot = sanitizeWorkbenchPaneNode(layout.root, available, seen, usedPaneIds, usedSplitIds)
    ?? createDefaultWorkbenchRootLayout().root;
  const sanitizedLeaves = listWorkbenchPaneLeaves(sanitizedRoot);

  if (sanitizedLeaves.length === 0) {
    return createDefaultWorkbenchRootLayout(available, getPreferredActiveTabId(layout.root));
  }

  const unassignedTabIds = available.filter((tabId) => !seen.has(tabId));
  if (unassignedTabIds.length > 0) {
    const fallbackPaneId = sanitizedLeaves.find((pane) => pane.id === layout.focusedPaneId)?.id
      ?? sanitizedLeaves[0]?.id
      ?? "pane-1";
    appendTabsToPane(sanitizedRoot, fallbackPaneId, unassignedTabIds);
  }

  const leaves = listWorkbenchPaneLeaves(sanitizedRoot);
  const focusedPaneId = leaves.some((pane) => pane.id === layout.focusedPaneId)
    ? layout.focusedPaneId!
    : leaves[0]!.id;

  return {
    version: 2,
    focusedPaneId,
    nextPaneNumber: Math.max(
      2,
      sanitizeCounter(layout.nextPaneNumber),
      getMaxPaneNumber(sanitizedRoot) + 1,
    ),
    nextSplitNumber: Math.max(
      2,
      sanitizeCounter(layout.nextSplitNumber),
      getMaxSplitNumber(sanitizedRoot) + 1,
    ),
    root: sanitizedRoot,
  };
}

export function listWorkbenchPaneLeaves(root: WorkbenchPaneNode): WorkbenchPaneLeaf[] {
  if (root.kind === "pane") {
    return [root];
  }
  return [...listWorkbenchPaneLeaves(root.first), ...listWorkbenchPaneLeaves(root.second)];
}

export function findWorkbenchPane(
  root: WorkbenchPaneNode,
  paneId: WorkbenchPaneId,
): WorkbenchPaneLeaf | null {
  if (root.kind === "pane") {
    return root.id === paneId ? root : null;
  }
  return findWorkbenchPane(root.first, paneId) ?? findWorkbenchPane(root.second, paneId);
}

export function getFirstWorkbenchPaneId(root: WorkbenchPaneNode): WorkbenchPaneId {
  return listWorkbenchPaneLeaves(root)[0]?.id ?? "pane-1";
}

export function getOtherWorkbenchPaneId(
  root: WorkbenchPaneNode,
  paneId: WorkbenchPaneId,
): WorkbenchPaneId | null {
  const leaves = listWorkbenchPaneLeaves(root);
  if (leaves.length < 2) return null;
  const currentIndex = leaves.findIndex((pane) => pane.id === paneId);
  if (currentIndex < 0) return leaves[0]!.id;
  return leaves[(currentIndex + 1) % leaves.length]!.id;
}

function sanitizeWorkbenchPaneNode(
  node: unknown,
  availableTabIds: string[],
  seen: Set<string>,
  usedPaneIds: Set<string>,
  usedSplitIds: Set<string>,
): WorkbenchPaneNode | null {
  if (!isRecord(node)) {
    return null;
  }

  if (node.kind === "pane") {
    const rawTabIds = Array.isArray(node.tabIds) ? node.tabIds : [];
    const tabIds = uniqueIds(
      rawTabIds.filter((tabId) => {
        if (!availableTabIds.includes(tabId) || seen.has(tabId)) return false;
        seen.add(tabId);
        return true;
      }),
    );
    return {
      kind: "pane",
      id: ensureUniqueLayoutId(
        sanitizePaneId(typeof node.id === "string" ? node.id : undefined),
        "pane-",
        usedPaneIds,
      ),
      tabIds,
      activeTabId: pickActiveTabId(tabIds, typeof node.activeTabId === "string" ? node.activeTabId : null),
    };
  }

  const first = sanitizeWorkbenchPaneNode(node.first, availableTabIds, seen, usedPaneIds, usedSplitIds);
  const second = sanitizeWorkbenchPaneNode(node.second, availableTabIds, seen, usedPaneIds, usedSplitIds);
  if (!first && !second) {
    return null;
  }
  if (!first) return second;
  if (!second) return first;
  return {
    kind: "split",
    id: ensureUniqueLayoutId(
      sanitizeSplitId(typeof node.id === "string" ? node.id : undefined),
      "split-",
      usedSplitIds,
    ),
    direction: node.direction === "vertical" ? "vertical" : "horizontal",
    sizes: normalizeSplitSizes(node.sizes),
    first,
    second,
  };
}

function appendTabsToPane(
  node: WorkbenchPaneNode,
  paneId: WorkbenchPaneId,
  tabIds: string[],
): void {
  if (node.kind === "pane") {
    if (node.id !== paneId) return;
    node.tabIds = uniqueIds([...node.tabIds, ...tabIds]);
    node.activeTabId = pickActiveTabId(node.tabIds, node.activeTabId ?? tabIds[tabIds.length - 1] ?? null);
    return;
  }
  appendTabsToPane(node.first, paneId, tabIds);
  appendTabsToPane(node.second, paneId, tabIds);
}

function getPreferredActiveTabId(root: unknown): string | null {
  if (!isRecord(root)) return null;
  if (root.kind === "pane") {
    const firstTabId = Array.isArray(root.tabIds) && typeof root.tabIds[0] === "string" ? root.tabIds[0] : null;
    return typeof root.activeTabId === "string" ? root.activeTabId : firstTabId;
  }
  return getPreferredActiveTabId(root.first) ?? getPreferredActiveTabId(root.second);
}

function getLegacyPrimaryActiveTabId(layout: Partial<WorkbenchRootLayoutState> | null | undefined): string | null {
  const maybeLegacy = layout as Partial<{
    activeTabIdByPane: { primary?: string };
    primaryTabIds: string[];
  }>;
  return maybeLegacy.activeTabIdByPane?.primary ?? maybeLegacy.primaryTabIds?.[0] ?? null;
}

function getMaxPaneNumber(node: WorkbenchPaneNode): number {
  if (node.kind === "pane") {
    return parseTrailingNumber(node.id, "pane-");
  }
  return Math.max(getMaxPaneNumber(node.first), getMaxPaneNumber(node.second));
}

function getMaxSplitNumber(node: WorkbenchPaneNode): number {
  if (node.kind === "pane") {
    return 1;
  }
  return Math.max(
    parseTrailingNumber(node.id, "split-"),
    getMaxSplitNumber(node.first),
    getMaxSplitNumber(node.second),
  );
}

function parseTrailingNumber(value: string, prefix: string): number {
  if (!value.startsWith(prefix)) return 1;
  const parsed = Number.parseInt(value.slice(prefix.length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function sanitizeCounter(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 1 ? Number(value) : 2;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function sanitizePaneId(value: string | undefined): WorkbenchPaneId {
  const trimmed = value?.trim() ?? "";
  return /^pane-\d+$/.test(trimmed) ? trimmed : "pane-1";
}

function sanitizeSplitId(value: string | undefined): WorkbenchSplitId {
  const trimmed = value?.trim() ?? "";
  return /^split-\d+$/.test(trimmed) ? trimmed : "split-1";
}

function normalizeSplitSizes(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    return [50, 50];
  }
  const first = Number(value[0]);
  const second = Number(value[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 0 || second <= 0) {
    return [50, 50];
  }
  const total = first + second;
  if (total <= 0) {
    return [50, 50];
  }
  return [Math.max(10, (first / total) * 100), Math.max(10, (second / total) * 100)];
}

function pickActiveTabId(tabIds: string[], preferredTabId?: string | null): string | null {
  if (preferredTabId && tabIds.includes(preferredTabId)) {
    return preferredTabId;
  }
  return tabIds[0] ?? null;
}

function uniqueIds(ids: string[]): string[] {
  return ids.filter((tabId, index) => typeof tabId === "string" && tabId && ids.indexOf(tabId) === index);
}

function ensureUniqueLayoutId<T extends string>(
  value: T,
  prefix: "pane-" | "split-",
  used: Set<string>,
): T {
  let nextNumber = parseTrailingNumber(value, prefix);
  let candidate = `${prefix}${nextNumber}`;
  while (used.has(candidate)) {
    nextNumber += 1;
    candidate = `${prefix}${nextNumber}`;
  }
  used.add(candidate);
  return candidate as T;
}
