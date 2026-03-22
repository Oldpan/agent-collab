import { useCallback, useEffect } from "react";
import { create } from "zustand";
import type { AgentInfo, CreateAgentRequest, UpdateAgentRequest } from "@agent-collab/protocol";
import * as api from "@/lib/api";

type AgentsState = {
  agents: AgentInfo[];
  loading: boolean;
  setAgents: (agents: AgentInfo[]) => void;
  addAgent: (agent: AgentInfo) => void;
  updateAgentInList: (agent: AgentInfo) => void;
  removeAgent: (id: string) => void;
  setLoading: (loading: boolean) => void;
};

const useAgentsStore = create<AgentsState>((set) => ({
  agents: [],
  loading: false,
  setAgents: (agents) => set({ agents }),
  addAgent: (agent) => set((state) => ({ agents: [agent, ...state.agents] })),
  updateAgentInList: (agent) =>
    set((state) => ({
      agents: state.agents.map((a) => (a.agentId === agent.agentId ? agent : a)),
    })),
  removeAgent: (id) =>
    set((state) => ({ agents: state.agents.filter((a) => a.agentId !== id) })),
  setLoading: (loading) => set({ loading }),
}));

export function useAgents() {
  const store = useAgentsStore();

  useEffect(() => {
    let cancelled = false;
    store.setLoading(true);
    api
      .listAgents()
      .then((agents) => { if (!cancelled) { store.setAgents(agents); store.setLoading(false); } })
      .catch(() => { if (!cancelled) store.setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createAgent = useCallback(async (req: CreateAgentRequest) => {
    const agent = await api.createAgent(req);
    store.addAgent(agent);
    return agent;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateAgent = useCallback(async (id: string, req: UpdateAgentRequest) => {
    const agent = await api.updateAgent(id, req);
    store.updateAgentInList(agent);
    return agent;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deleteAgent = useCallback(async (id: string) => {
    await api.deleteAgent(id);
    store.removeAgent(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    agents: store.agents,
    loading: store.loading,
    createAgent,
    updateAgent,
    deleteAgent,
  };
}
