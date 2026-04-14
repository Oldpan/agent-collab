import { create } from "zustand";
import type { ExplorerTab } from "./workbenchTypes";

type WorkbenchExplorerState = {
  explorerTabByRoot: Record<string, ExplorerTab>;
  explorerCollapsedByRoot: Record<string, boolean>;
  hydrate: (state: {
    explorerTabByRoot: Record<string, ExplorerTab>;
    explorerCollapsedByRoot: Record<string, boolean>;
  }) => void;
  setExplorerTab: (rootId: string, tab: ExplorerTab) => void;
  setExplorerCollapsed: (rootId: string, collapsed: boolean) => void;
};

export const useWorkbenchExplorerStore = create<WorkbenchExplorerState>((set) => ({
  explorerTabByRoot: {},
  explorerCollapsedByRoot: {},
  hydrate: ({ explorerTabByRoot, explorerCollapsedByRoot }) => set({
    explorerTabByRoot,
    explorerCollapsedByRoot,
  }),
  setExplorerTab: (rootId, tab) =>
    set((state) => ({
      explorerTabByRoot: {
        ...state.explorerTabByRoot,
        [rootId]: tab,
      },
    })),
  setExplorerCollapsed: (rootId, collapsed) =>
    set((state) => ({
      explorerCollapsedByRoot: {
        ...state.explorerCollapsedByRoot,
        [rootId]: collapsed,
      },
    })),
}));
