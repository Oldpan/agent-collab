import type {
  ConversationInfo,
  CreateConversationRequest,
  ServerEvent,
  NodeInfoRest,
  AgentInfo,
  CreateAgentRequest,
  UpdateAgentRequest,
  ChannelInfo,
  MachineInfo,
  CreateMachineRequest,
  AgentWorkspaceListResult,
  AgentWorkspaceFileResult,
} from "@agent-collab/protocol";

const API_BASE = "/api";

export async function listConversations(): Promise<ConversationInfo[]> {
  const res = await fetch(`${API_BASE}/conversations`);
  if (!res.ok) throw new Error(`Failed to list conversations: ${res.statusText}`);
  return res.json();
}

export async function createConversation(
  req: CreateConversationRequest,
): Promise<ConversationInfo> {
  const res = await fetch(`${API_BASE}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Failed to create conversation: ${res.statusText}`);
  return res.json();
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/conversations/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete conversation: ${res.statusText}`);
}

export async function getHistory(id: string): Promise<ServerEvent[]> {
  const res = await fetch(`${API_BASE}/conversations/${id}/history`);
  if (!res.ok) throw new Error(`Failed to get history: ${res.statusText}`);
  return res.json();
}

export async function listChannels(): Promise<ChannelInfo[]> {
  const res = await fetch(`${API_BASE}/channels`);
  if (!res.ok) throw new Error(`Failed to list channels: ${res.statusText}`);
  return res.json();
}

export async function listNodes(): Promise<NodeInfoRest[]> {
  const res = await fetch(`${API_BASE}/nodes`);
  if (!res.ok) throw new Error(`Failed to list nodes: ${res.statusText}`);
  return res.json();
}

// ─── Machine API ───

export async function listMachines(): Promise<MachineInfo[]> {
  const res = await fetch(`${API_BASE}/machines`);
  if (!res.ok) throw new Error(`Failed to list machines: ${res.statusText}`);
  return res.json();
}

export async function createMachine(req: CreateMachineRequest): Promise<MachineInfo> {
  const res = await fetch(`${API_BASE}/machines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Failed to create machine: ${res.statusText}`);
  return res.json();
}

export async function deleteMachine(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/machines/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete machine: ${res.statusText}`);
}

// ─── Agent API ───

export async function listAgents(): Promise<AgentInfo[]> {
  const res = await fetch(`${API_BASE}/agents`);
  if (!res.ok) throw new Error(`Failed to list agents: ${res.statusText}`);
  return res.json();
}

export async function createAgent(req: CreateAgentRequest): Promise<AgentInfo> {
  const res = await fetch(`${API_BASE}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Failed to create agent: ${res.statusText}`);
  return res.json();
}

export async function updateAgent(id: string, req: UpdateAgentRequest): Promise<AgentInfo> {
  const res = await fetch(`${API_BASE}/agents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Failed to update agent: ${res.statusText}`);
  return res.json();
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/agents/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete agent: ${res.statusText}`);
}

export async function listAgentConversations(agentId: string): Promise<ConversationInfo[]> {
  const res = await fetch(`${API_BASE}/agents/${agentId}/conversations`);
  if (!res.ok) throw new Error(`Failed to list agent conversations: ${res.statusText}`);
  return res.json();
}

export async function openAgentThread(agentId: string): Promise<ConversationInfo> {
  const res = await fetch(`${API_BASE}/agents/${agentId}/open-thread`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to open agent thread: ${res.statusText}`);
  return res.json();
}

export async function restartAgent(
  agentId: string,
): Promise<{ ok: boolean; conversations: ConversationInfo[] }> {
  const res = await fetch(`${API_BASE}/agents/${agentId}/restart`, { method: "POST" });
  if (!res.ok) {
    const body = await safeReadErrorBody(res);
    throw new Error(body ?? `Failed to restart agent: ${res.statusText}`);
  }
  return res.json();
}

export async function clearAgentChat(
  agentId: string,
): Promise<{ ok: boolean; conversations: ConversationInfo[] }> {
  const res = await fetch(`${API_BASE}/agents/${agentId}/clear-chat`, { method: "POST" });
  if (!res.ok) {
    const body = await safeReadErrorBody(res);
    throw new Error(body ?? `Failed to clear agent chat: ${res.statusText}`);
  }
  return res.json();
}

export async function resetAgent(
  agentId: string,
): Promise<{ ok: boolean; conversations: ConversationInfo[] }> {
  const res = await fetch(`${API_BASE}/agents/${agentId}/reset`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await safeReadErrorBody(res);
    throw new Error(body ?? `Failed to reset agent: ${res.statusText}`);
  }
  return res.json();
}

export async function listAgentWorkspace(
  agentId: string,
  relativePath = "",
): Promise<AgentWorkspaceListResult> {
  const params = new URLSearchParams();
  if (relativePath) params.set("path", relativePath);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`${API_BASE}/agents/${agentId}/workspace${suffix}`);
  if (!res.ok) {
    const body = await safeReadErrorBody(res);
    throw new Error(body ?? `Failed to list workspace: ${res.statusText}`);
  }
  return res.json();
}

export async function readAgentWorkspaceFile(
  agentId: string,
  relativePath: string,
): Promise<AgentWorkspaceFileResult> {
  const params = new URLSearchParams();
  params.set("path", relativePath);
  const res = await fetch(`${API_BASE}/agents/${agentId}/workspace/file?${params.toString()}`);
  if (!res.ok) {
    const body = await safeReadErrorBody(res);
    throw new Error(body ?? `Failed to read workspace file: ${res.statusText}`);
  }
  return res.json();
}

async function safeReadErrorBody(res: Response): Promise<string | null> {
  try {
    const body = await res.json() as { error?: string };
    return body.error ?? null;
  } catch {
    return null;
  }
}
