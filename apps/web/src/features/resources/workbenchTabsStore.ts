import { create } from "zustand";
import type { WorkbenchTab } from "./workbenchTypes";

type WorkbenchTabsState = {
  tabsByRoot: Record<string, WorkbenchTab[]>;
  hydrate: (tabsByRoot: Record<string, WorkbenchTab[]>) => void;
  upsertTab: (rootId: string, tab: WorkbenchTab) => void;
  replaceTabs: (rootId: string, tabs: WorkbenchTab[]) => void;
  removeTab: (rootId: string, tabId: string) => void;
};

export const useWorkbenchTabsStore = create<WorkbenchTabsState>((set) => ({
  tabsByRoot: {},
  hydrate: (tabsByRoot) => set({ tabsByRoot }),
  upsertTab: (rootId, tab) =>
    set((state) => {
      const current = state.tabsByRoot[rootId] ?? [];
      const existingIndex = current.findIndex((item) => item.id === tab.id);
      if (existingIndex < 0) {
        return {
          tabsByRoot: {
            ...state.tabsByRoot,
            [rootId]: [...current, tab],
          },
        };
      }
      const next = current.slice();
      next[existingIndex] = tab;
      return {
        tabsByRoot: {
          ...state.tabsByRoot,
          [rootId]: next,
        },
      };
    }),
  replaceTabs: (rootId, tabs) =>
    set((state) => ({
      tabsByRoot: {
        ...state.tabsByRoot,
        [rootId]: tabs,
      },
    })),
  removeTab: (rootId, tabId) =>
    set((state) => ({
      tabsByRoot: {
        ...state.tabsByRoot,
        [rootId]: (state.tabsByRoot[rootId] ?? []).filter((tab) => tab.id !== tabId),
      },
    })),
}));
