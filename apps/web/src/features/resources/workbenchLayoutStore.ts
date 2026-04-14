import { create } from "zustand";
import {
  findWorkbenchPane,
  getFirstWorkbenchPaneId,
  getOtherWorkbenchPaneId,
  normalizeWorkbenchRootLayout,
  type WorkbenchPaneId,
  type WorkbenchPaneLeaf,
  type WorkbenchPaneNode,
  type WorkbenchPaneSplit,
  type WorkbenchPaneSplitDirection,
  type WorkbenchRootLayoutState,
} from "./workbenchTypes";

type WorkbenchLayoutOptions = { splitCapable?: boolean };
type WorkbenchPaneSplitPlacement = "before" | "after";

type WorkbenchLayoutState = {
  layoutByRoot: Record<string, WorkbenchRootLayoutState>;
  hydrate: (layoutByRoot: Record<string, WorkbenchRootLayoutState>) => void;
  syncRoot: (rootId: string, tabIds: string[], options?: WorkbenchLayoutOptions) => void;
  openTab: (
    rootId: string,
    tabId: string,
    options?: WorkbenchLayoutOptions & {
      paneId?: WorkbenchPaneId;
      location?: "focused" | "other";
      splitDirection?: WorkbenchPaneSplitDirection;
    },
  ) => void;
  focusTab: (rootId: string, paneId: WorkbenchPaneId, tabId: string, options?: WorkbenchLayoutOptions) => void;
  focusPane: (rootId: string, paneId: WorkbenchPaneId, options?: WorkbenchLayoutOptions) => void;
  splitPane: (
    rootId: string,
    paneId: WorkbenchPaneId,
    direction: WorkbenchPaneSplitDirection,
    options?: WorkbenchLayoutOptions & { placement?: WorkbenchPaneSplitPlacement },
  ) => WorkbenchPaneId;
  closePane: (rootId: string, paneId: WorkbenchPaneId, options?: WorkbenchLayoutOptions) => void;
  closeTab: (rootId: string, tabId: string, tabIds: string[], options?: WorkbenchLayoutOptions) => void;
  moveTabToOtherPane: (
    rootId: string,
    tabId: string,
    sourcePaneId: WorkbenchPaneId,
    options?: WorkbenchLayoutOptions & { splitDirection?: WorkbenchPaneSplitDirection },
  ) => void;
  reorderPaneTabs: (
    rootId: string,
    paneId: WorkbenchPaneId,
    orderedTabIds: string[],
    options?: WorkbenchLayoutOptions,
  ) => void;
  setSplitSizes: (
    rootId: string,
    splitId: string,
    sizes: [number, number],
    options?: WorkbenchLayoutOptions,
  ) => void;
};

export const useWorkbenchLayoutStore = create<WorkbenchLayoutState>((set) => ({
  layoutByRoot: {},
  hydrate: (layoutByRoot) => set({ layoutByRoot }),
  syncRoot: (rootId, tabIds, options) =>
    set((state) => {
      const nextLayout = normalizeWorkbenchRootLayout(state.layoutByRoot[rootId], tabIds, options);
      if (areLayoutsEquivalent(state.layoutByRoot[rootId], nextLayout)) {
        return state;
      }
      return {
        layoutByRoot: {
          ...state.layoutByRoot,
          [rootId]: nextLayout,
        },
      };
    }),
  openTab: (rootId, tabId, options) =>
    set((state) => {
      let layout = normalizeWorkbenchRootLayout(
        state.layoutByRoot[rootId],
        [...collectTabIds(state.layoutByRoot[rootId]?.root), tabId],
        options,
      );
      const splitCapable = options?.splitCapable !== false;
      let targetPaneId = options?.paneId ?? layout.focusedPaneId;

      if (options?.location === "other" && splitCapable) {
        const otherPaneId = getOtherWorkbenchPaneId(layout.root, options.paneId ?? layout.focusedPaneId);
        if (otherPaneId) {
          targetPaneId = otherPaneId;
        } else {
          layout = splitWorkbenchPane(
            layout,
            options?.paneId ?? layout.focusedPaneId,
            options?.splitDirection ?? "horizontal",
          );
          targetPaneId = layout.focusedPaneId;
        }
      }

      layout = insertTabIntoPane(removeTabFromLayout(layout, tabId), targetPaneId, tabId, {
        focus: true,
      });
      return {
        layoutByRoot: {
          ...state.layoutByRoot,
          [rootId]: normalizeWorkbenchRootLayout(layout, collectTabIds(layout.root), options),
        },
      };
    }),
  focusTab: (rootId, paneId, tabId, options) =>
    set((state) => {
      const current = normalizeWorkbenchRootLayout(
        state.layoutByRoot[rootId],
        collectTabIds(state.layoutByRoot[rootId]?.root),
        options,
      );
      const next = withUpdatedPane(current, paneId, (pane) => ({
        ...pane,
        activeTabId: pane.tabIds.includes(tabId) ? tabId : pane.activeTabId,
      }));
      return {
        layoutByRoot: {
          ...state.layoutByRoot,
          [rootId]: normalizeWorkbenchRootLayout({ ...next, focusedPaneId: paneId }, collectTabIds(next.root), options),
        },
      };
    }),
  focusPane: (rootId, paneId, options) =>
    set((state) => {
      const current = normalizeWorkbenchRootLayout(
        state.layoutByRoot[rootId],
        collectTabIds(state.layoutByRoot[rootId]?.root),
        options,
      );
      return {
        layoutByRoot: {
          ...state.layoutByRoot,
          [rootId]: normalizeWorkbenchRootLayout({ ...current, focusedPaneId: paneId }, collectTabIds(current.root), options),
        },
      };
    }),
  splitPane: (rootId, paneId, direction, options) => {
    let nextPaneId: WorkbenchPaneId = paneId;
    set((state) => {
      const current = normalizeWorkbenchRootLayout(
        state.layoutByRoot[rootId],
        collectTabIds(state.layoutByRoot[rootId]?.root),
        options,
      );
      const next = options?.splitCapable === false
        ? current
        : splitWorkbenchPane(current, paneId, direction, options?.placement, (createdPaneId) => {
          nextPaneId = createdPaneId;
        });
      return {
        layoutByRoot: {
          ...state.layoutByRoot,
          [rootId]: normalizeWorkbenchRootLayout(next, collectTabIds(next.root), options),
        },
      };
    });
    return nextPaneId;
  },
  closePane: (rootId, paneId, options) =>
    set((state) => {
      const current = normalizeWorkbenchRootLayout(
        state.layoutByRoot[rootId],
        collectTabIds(state.layoutByRoot[rootId]?.root),
        options,
      );
      const next = options?.splitCapable === false ? current : closeWorkbenchPane(current, paneId);
      return {
        layoutByRoot: {
          ...state.layoutByRoot,
          [rootId]: normalizeWorkbenchRootLayout(next, collectTabIds(next.root), options),
        },
      };
    }),
  closeTab: (rootId, tabId, tabIds, options) =>
    set((state) => {
      const current = normalizeWorkbenchRootLayout(state.layoutByRoot[rootId], tabIds, options);
      const next = removeTabFromLayout(current, tabId);
      return {
        layoutByRoot: {
          ...state.layoutByRoot,
          [rootId]: normalizeWorkbenchRootLayout(next, tabIds, options),
        },
      };
    }),
  moveTabToOtherPane: (rootId, tabId, sourcePaneId, options) =>
    set((state) => {
      let layout = normalizeWorkbenchRootLayout(
        state.layoutByRoot[rootId],
        collectTabIds(state.layoutByRoot[rootId]?.root),
        options,
      );
      const splitCapable = options?.splitCapable !== false;
      if (!splitCapable) {
        return { layoutByRoot: { ...state.layoutByRoot, [rootId]: layout } };
      }
      let targetPaneId = getOtherWorkbenchPaneId(layout.root, sourcePaneId);
      if (!targetPaneId) {
        layout = splitWorkbenchPane(layout, sourcePaneId, options?.splitDirection ?? "horizontal");
        targetPaneId = layout.focusedPaneId;
      }
      layout = insertTabIntoPane(removeTabFromLayout(layout, tabId), targetPaneId, tabId, {
        focus: true,
      });
      return {
        layoutByRoot: {
          ...state.layoutByRoot,
          [rootId]: normalizeWorkbenchRootLayout(layout, collectTabIds(layout.root), options),
        },
      };
    }),
  reorderPaneTabs: (rootId, paneId, orderedTabIds, options) =>
    set((state) => {
      const current = normalizeWorkbenchRootLayout(
        state.layoutByRoot[rootId],
        collectTabIds(state.layoutByRoot[rootId]?.root),
        options,
      );
      const next = withUpdatedPane(current, paneId, (pane) => {
        const currentSet = new Set(pane.tabIds);
        const nextTabIds = [
          ...orderedTabIds.filter((tabId) => currentSet.has(tabId)),
          ...pane.tabIds.filter((tabId) => !orderedTabIds.includes(tabId)),
        ];
        return {
          ...pane,
          tabIds: nextTabIds,
          activeTabId: nextTabIds.includes(pane.activeTabId ?? "") ? pane.activeTabId : nextTabIds[0] ?? null,
        };
      });
      return {
        layoutByRoot: {
          ...state.layoutByRoot,
          [rootId]: normalizeWorkbenchRootLayout(next, collectTabIds(next.root), options),
        },
      };
    }),
  setSplitSizes: (rootId, splitId, sizes, options) =>
    set((state) => {
      const current = normalizeWorkbenchRootLayout(
        state.layoutByRoot[rootId],
        collectTabIds(state.layoutByRoot[rootId]?.root),
        options,
      );
      const normalizedSizes = normalizeSizes(sizes);
      const currentSplit = findWorkbenchSplit(current.root, splitId);
      if (currentSplit && areSplitSizesEqual(currentSplit.sizes, normalizedSizes)) {
        return state;
      }
      const next = {
        ...current,
        root: updateSplitById(current.root, splitId, (split) => ({
          ...split,
          sizes: normalizedSizes,
        })),
      };
      return {
        layoutByRoot: {
          ...state.layoutByRoot,
          [rootId]: normalizeWorkbenchRootLayout(next, collectTabIds(next.root), options),
        },
      };
    }),
}));

function splitWorkbenchPane(
  layout: WorkbenchRootLayoutState,
  paneId: WorkbenchPaneId,
  direction: WorkbenchPaneSplitDirection,
  placement: WorkbenchPaneSplitPlacement = "after",
  onCreatePaneId?: (paneId: WorkbenchPaneId) => void,
): WorkbenchRootLayoutState {
  const targetPane = findWorkbenchPane(layout.root, paneId)
    ?? findWorkbenchPane(layout.root, layout.focusedPaneId)
    ?? findWorkbenchPane(layout.root, getFirstWorkbenchPaneId(layout.root));
  if (!targetPane) return layout;

  const nextPaneId = `pane-${layout.nextPaneNumber}`;
  const nextSplitId = `split-${layout.nextSplitNumber}`;
  onCreatePaneId?.(nextPaneId);
  const originalPane = clonePaneNode(targetPane);
  const createdPane: WorkbenchPaneLeaf = {
    kind: "pane",
    id: nextPaneId,
    tabIds: [],
    activeTabId: null,
  };
  const nextRoot = replacePaneById(layout.root, targetPane.id, () => ({
    kind: "split",
    id: nextSplitId,
    direction,
    sizes: [50, 50],
    first: placement === "before" ? createdPane : originalPane,
    second: placement === "before" ? originalPane : createdPane,
  }));
  return {
    ...layout,
    focusedPaneId: nextPaneId,
    nextPaneNumber: layout.nextPaneNumber + 1,
    nextSplitNumber: layout.nextSplitNumber + 1,
    root: nextRoot,
  };
}

function closeWorkbenchPane(
  layout: WorkbenchRootLayoutState,
  paneId: WorkbenchPaneId,
): WorkbenchRootLayoutState {
  const leaves = collectPaneLeaves(layout.root);
  if (leaves.length <= 1) return layout;
  const result = collapsePane(layout.root, paneId);
  if (!result) return layout;
  return {
    ...layout,
    focusedPaneId: result.focusPaneId ?? getFirstWorkbenchPaneId(result.node),
    root: result.node,
  };
}

function removeTabFromLayout(
  layout: WorkbenchRootLayoutState,
  tabId: string,
): WorkbenchRootLayoutState {
  return {
    ...layout,
    root: removeTabFromNode(layout.root, tabId),
  };
}

function insertTabIntoPane(
  layout: WorkbenchRootLayoutState,
  paneId: WorkbenchPaneId,
  tabId: string,
  options?: { focus?: boolean },
): WorkbenchRootLayoutState {
  return {
    ...layout,
    focusedPaneId: options?.focus ? paneId : layout.focusedPaneId,
    root: withPaneNode(layout.root, paneId, (pane) => {
      const tabIds = pane.tabIds.includes(tabId) ? pane.tabIds : [...pane.tabIds, tabId];
      return {
        ...pane,
        tabIds,
        activeTabId: tabId,
      };
    }),
  };
}

function withUpdatedPane(
  layout: WorkbenchRootLayoutState,
  paneId: WorkbenchPaneId,
  updater: (pane: WorkbenchPaneLeaf) => WorkbenchPaneLeaf,
): WorkbenchRootLayoutState {
  return {
    ...layout,
    root: withPaneNode(layout.root, paneId, updater),
  };
}

function withPaneNode(
  node: WorkbenchPaneNode,
  paneId: WorkbenchPaneId,
  updater: (pane: WorkbenchPaneLeaf) => WorkbenchPaneLeaf,
): WorkbenchPaneNode {
  if (node.kind === "pane") {
    return node.id === paneId ? updater(node) : node;
  }
  return {
    ...node,
    first: withPaneNode(node.first, paneId, updater),
    second: withPaneNode(node.second, paneId, updater),
  };
}

function replacePaneById(
  node: WorkbenchPaneNode,
  paneId: WorkbenchPaneId,
  replacer: (pane: WorkbenchPaneLeaf) => WorkbenchPaneNode,
): WorkbenchPaneNode {
  if (node.kind === "pane") {
    return node.id === paneId ? replacer(node) : node;
  }
  return {
    ...node,
    first: replacePaneById(node.first, paneId, replacer),
    second: replacePaneById(node.second, paneId, replacer),
  };
}

function removeTabFromNode(node: WorkbenchPaneNode, tabId: string): WorkbenchPaneNode {
  if (node.kind === "pane") {
    const tabIds = node.tabIds.filter((id) => id !== tabId);
    return {
      ...node,
      tabIds,
      activeTabId: tabIds.includes(node.activeTabId ?? "") ? node.activeTabId : tabIds[0] ?? null,
    };
  }
  return {
    ...node,
    first: removeTabFromNode(node.first, tabId),
    second: removeTabFromNode(node.second, tabId),
  };
}

function collapsePane(
  node: WorkbenchPaneNode,
  paneId: WorkbenchPaneId,
): { node: WorkbenchPaneNode; focusPaneId: string | null } | null {
  if (node.kind === "pane") {
    return null;
  }

  if (node.first.kind === "pane" && node.first.id === paneId) {
    return {
      node: insertTabsIntoFirstPane(
        clonePaneNode(node.second),
        node.first.tabIds,
        node.first.activeTabId,
      ),
      focusPaneId: getFirstWorkbenchPaneId(node.second),
    };
  }
  if (node.second.kind === "pane" && node.second.id === paneId) {
    return {
      node: insertTabsIntoFirstPane(
        clonePaneNode(node.first),
        node.second.tabIds,
        node.second.activeTabId,
      ),
      focusPaneId: getFirstWorkbenchPaneId(node.first),
    };
  }

  const firstResult = collapsePane(node.first, paneId);
  if (firstResult) {
    return {
      node: {
        ...node,
        first: firstResult.node,
      },
      focusPaneId: firstResult.focusPaneId,
    };
  }
  const secondResult = collapsePane(node.second, paneId);
  if (secondResult) {
    return {
      node: {
        ...node,
        second: secondResult.node,
      },
      focusPaneId: secondResult.focusPaneId,
    };
  }
  return null;
}

function insertTabsIntoFirstPane(
  node: WorkbenchPaneNode,
  tabIds: string[],
  preferredActiveTabId: string | null,
): WorkbenchPaneNode {
  if (node.kind === "pane") {
    const nextTabIds = uniqueIds([...node.tabIds, ...tabIds]);
    return {
      ...node,
      tabIds: nextTabIds,
      activeTabId: nextTabIds.includes(preferredActiveTabId ?? "")
        ? preferredActiveTabId
        : node.activeTabId ?? nextTabIds[0] ?? null,
    };
  }
  return {
    ...node,
    first: insertTabsIntoFirstPane(node.first, tabIds, preferredActiveTabId),
  };
}

function updateSplitById(
  node: WorkbenchPaneNode,
  splitId: string,
  updater: (split: WorkbenchPaneSplit) => WorkbenchPaneSplit,
): WorkbenchPaneNode {
  if (node.kind === "pane") {
    return node;
  }
  if (node.id === splitId) {
    return updater(node);
  }
  return {
    ...node,
    first: updateSplitById(node.first, splitId, updater),
    second: updateSplitById(node.second, splitId, updater),
  };
}

function findWorkbenchSplit(
  node: WorkbenchPaneNode,
  splitId: string,
): WorkbenchPaneSplit | null {
  if (node.kind === "pane") {
    return null;
  }
  if (node.id === splitId) {
    return node;
  }
  return findWorkbenchSplit(node.first, splitId) ?? findWorkbenchSplit(node.second, splitId);
}

function clonePaneNode(node: WorkbenchPaneNode): WorkbenchPaneNode {
  if (node.kind === "pane") {
    return {
      ...node,
      tabIds: [...node.tabIds],
    };
  }
  return {
    ...node,
    sizes: [...node.sizes] as [number, number],
    first: clonePaneNode(node.first),
    second: clonePaneNode(node.second),
  };
}

function collectPaneLeaves(node: WorkbenchPaneNode): WorkbenchPaneLeaf[] {
  if (node.kind === "pane") return [node];
  return [...collectPaneLeaves(node.first), ...collectPaneLeaves(node.second)];
}

function collectTabIds(node: WorkbenchPaneNode | undefined): string[] {
  if (!node) return [];
  return uniqueIds(collectPaneLeaves(node).flatMap((pane) => pane.tabIds));
}

function normalizeSizes(sizes: [number, number]): [number, number] {
  const first = Math.max(10, sizes[0]);
  const second = Math.max(10, sizes[1]);
  const total = first + second;
  return [(first / total) * 100, (second / total) * 100];
}

function areSplitSizesEqual(
  left: [number, number],
  right: [number, number],
): boolean {
  return Math.abs(left[0] - right[0]) < 0.25 && Math.abs(left[1] - right[1]) < 0.25;
}

function uniqueIds(ids: string[]): string[] {
  return ids.filter((id, index) => typeof id === "string" && id && ids.indexOf(id) === index);
}

function areLayoutsEquivalent(
  left: WorkbenchRootLayoutState | undefined,
  right: WorkbenchRootLayoutState,
): boolean {
  if (!left) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}
