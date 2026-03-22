import type {
  ConversationInfo,
  CreateConversationRequest,
  ServerEvent,
  NodeInfoRest,
  AgentInfo,
  CreateAgentRequest,
  UpdateAgentRequest,
  ChannelInfo,
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
