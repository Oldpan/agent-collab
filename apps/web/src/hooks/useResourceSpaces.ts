import { useCallback, useEffect } from "react";
import { create } from "zustand";
import type {
  CreateResourceSpaceRequest,
  ResourceSpaceInfo,
  UpdateResourceSpaceRequest,
} from "@agent-collab/protocol";
import * as api from "@/lib/api";

type ResourceSpacesState = {
  resourceSpaces: ResourceSpaceInfo[];
  loading: boolean;
  setResourceSpaces: (resourceSpaces: ResourceSpaceInfo[]) => void;
  setLoading: (loading: boolean) => void;
  addResourceSpace: (resourceSpace: ResourceSpaceInfo) => void;
  replaceResourceSpace: (resourceSpace: ResourceSpaceInfo) => void;
};

const useResourceSpacesStore = create<ResourceSpacesState>((set) => ({
  resourceSpaces: [],
  loading: false,
  setResourceSpaces: (resourceSpaces) => set({ resourceSpaces }),
  setLoading: (loading) => set({ loading }),
  addResourceSpace: (resourceSpace) =>
    set((state) => ({ resourceSpaces: [...state.resourceSpaces, resourceSpace] })),
  replaceResourceSpace: (resourceSpace) =>
    set((state) => ({
      resourceSpaces: state.resourceSpaces.map((item) =>
        item.resourceSpaceId === resourceSpace.resourceSpaceId ? resourceSpace : item,
      ),
    })),
}));

export function useResourceSpaces() {
  const {
    resourceSpaces,
    loading,
    setResourceSpaces,
    setLoading,
    addResourceSpace,
    replaceResourceSpace,
  } = useResourceSpacesStore();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.listResourceSpaces()
      .then((data) => {
        if (!cancelled) {
          setResourceSpaces(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const createResourceSpace = useCallback(async (req: CreateResourceSpaceRequest) => {
    const resourceSpace = await api.createResourceSpace(req);
    addResourceSpace(resourceSpace);
    return resourceSpace;
  }, [addResourceSpace]);

  const updateResourceSpace = useCallback(async (
    resourceSpaceId: string,
    req: UpdateResourceSpaceRequest,
  ) => {
    const resourceSpace = await api.updateResourceSpace(resourceSpaceId, req);
    replaceResourceSpace(resourceSpace);
    return resourceSpace;
  }, [replaceResourceSpace]);

  const refreshResourceSpaces = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.listResourceSpaces();
      setResourceSpaces(next);
      return next;
    } finally {
      setLoading(false);
    }
  }, [setLoading, setResourceSpaces]);

  return {
    resourceSpaces,
    loading,
    createResourceSpace,
    updateResourceSpace,
    refreshResourceSpaces,
  };
}
