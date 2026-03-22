import { useCallback, useEffect } from "react";
import { create } from "zustand";
import type { MachineInfo, CreateMachineRequest } from "@agent-collab/protocol";
import * as api from "@/lib/api";

type MachinesState = {
  machines: MachineInfo[];
  loading: boolean;
  setMachines: (machines: MachineInfo[]) => void;
  addMachine: (machine: MachineInfo) => void;
  removeMachine: (id: string) => void;
  setLoading: (loading: boolean) => void;
};

const useMachinesStore = create<MachinesState>((set) => ({
  machines: [],
  loading: false,
  setMachines: (machines) => set({ machines }),
  addMachine: (machine) => set((state) => ({ machines: [machine, ...state.machines] })),
  removeMachine: (id) =>
    set((state) => ({ machines: state.machines.filter((m) => m.nodeId !== id) })),
  setLoading: (loading) => set({ loading }),
}));

export function useMachines() {
  const store = useMachinesStore();

  useEffect(() => {
    let cancelled = false;
    store.setLoading(true);
    api
      .listMachines()
      .then((machines) => { if (!cancelled) { store.setMachines(machines); store.setLoading(false); } })
      .catch(() => { if (!cancelled) store.setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createMachine = useCallback(async (req: CreateMachineRequest) => {
    const machine = await api.createMachine(req);
    store.addMachine(machine);
    return machine;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deleteMachine = useCallback(async (id: string) => {
    await api.deleteMachine(id);
    store.removeMachine(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    machines: store.machines,
    loading: store.loading,
    createMachine,
    deleteMachine,
  };
}
