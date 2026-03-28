import type {
  ConversationInfo,
  CreateConversationRequest,
  NodeInfoRest,
  AgentInfo,
  CreateAgentRequest,
  UpdateAgentRequest,
  ChannelInfo,
  TaskInfo,
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

export type ConversationRunSummary = {
  runId: string;
  promptText: string;
  startedAt: number;
  endedAt: number | null;
  stopReason: string | null;
  error: string | null;
  assistantText?: string;
  thinkingText?: string;
};

export async function getHistory(id: string): Promise<ConversationRunSummary[]> {
  const res = await fetch(`${API_BASE}/conversations/${id}/history`);
  if (!res.ok) throw new Error(`Failed to get history: ${res.statusText}`);
  return res.json();
}

export async function getConversationChannelMessages(
  id: string,
  limit = 100,
): Promise<{ messages: ChannelMessage[] }> {
  const res = await fetch(`${API_BASE}/conversations/${id}/channel-messages?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to get conversation channel messages: ${res.statusText}`);
  return res.json();
}

export async function listChannels(): Promise<ChannelInfo[]> {
  const res = await fetch(`${API_BASE}/channels`);
  if (!res.ok) throw new Error(`Failed to list channels: ${res.statusText}`);
  return res.json();
}

export type ChannelMessage = {
  id: string;
  senderName: string;
  senderType: 'user' | 'agent' | 'system';
  content: string;
  createdAt: string; // ISO string
  /** DB sequence number — used for pagination (before= param). */
  seq?: number;
  /** Present only for thread replies. First 8 chars of root message ID. */
  threadRootId?: string;
  /** Present only on top-level messages. Number of thread replies. */
  replyCount?: number;
};

export type ChannelTask = TaskInfo & {
  linkedThreadId?: string;
  linkedThreadShortId?: string;
};

export type ThreadCollaborationSummary = {
  boundTask?: ChannelTask;
  ownerName?: string;
  participants?: string[];
};

export async function createChannel(req: {
  name: string;
  workspacePath?: string;
  description?: string;
  collaborationMode?: 'mention_only' | 'subscribed_agents';
  agentIds?: string[];
}): Promise<ChannelInfo> {
  const res = await fetch(`${API_BASE}/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Failed to create channel: ${res.statusText}`);
  return res.json();
}

export type UnreadSummaryRequest = {
  agentIds: string[];
  channelIds: string[];
  agentDmReadSeqs: Record<string, number>;
  channelReadSeqs: Record<string, number>;
};

export type UnreadSummaryResponse = {
  agentDms: Record<string, { unreadCount: number; latestSeq: number }>;
  channels: Record<string, { unreadCount: number; latestSeq: number }>;
};

export async function getUnreadSummary(req: UnreadSummaryRequest): Promise<UnreadSummaryResponse> {
  const res = await fetch(`${API_BASE}/unread-summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Failed to get unread summary: ${res.statusText}`);
  return res.json();
}

export async function updateChannel(channelId: string, req: {
  description?: string;
  collaborationMode?: 'mention_only' | 'subscribed_agents';
}): Promise<ChannelInfo> {
  const res = await fetch(`${API_BASE}/channels/${encodeURIComponent(channelId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Failed to update channel: ${res.statusText}`);
  return res.json();
}

export async function clearChannelChat(channelId: string): Promise<{ ok: true; clearedConversationIds: string[] }> {
  const res = await fetch(`${API_BASE}/channels/${encodeURIComponent(channelId)}/clear-chat`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to clear channel chat: ${res.statusText}`);
  return res.json();
}

export async function getChannelTasks(
  channelId: string,
  status?: TaskInfo["status"] | "all",
): Promise<{ tasks: ChannelTask[] }> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const res = await fetch(`${API_BASE}/channels/${encodeURIComponent(channelId)}/tasks${suffix}`);
  if (!res.ok) throw new Error(`Failed to get channel tasks: ${res.statusText}`);
  return res.json();
}

export async function createChannelTask(
  channelId: string,
  title: string,
  description?: string,
): Promise<ChannelTask> {
  const res = await fetch(`${API_BASE}/channels/${encodeURIComponent(channelId)}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, ...(description ? { description } : {}) }),
  });
  if (!res.ok) throw new Error(`Failed to create channel task: ${res.statusText}`);
  return res.json();
}

export async function updateTaskStatus(
  channelId: string,
  taskNumber: number,
  status: TaskInfo["status"],
): Promise<ChannelTask> {
  const res = await fetch(`${API_BASE}/channels/${encodeURIComponent(channelId)}/tasks/${taskNumber}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`Failed to update task status: ${res.statusText}`);
  return res.json();
}

export async function joinAgentChannel(agentId: string, channelId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/agents/${agentId}/channels/${encodeURIComponent(channelId)}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to join channel: ${res.statusText}`);
}

export async function leaveAgentChannel(agentId: string, channelId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/agents/${agentId}/channels/${encodeURIComponent(channelId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to leave channel: ${res.statusText}`);
}

export async function getChannelMessages(
  channelId: string,
  limit = 50,
  before?: number,
): Promise<{ messages: ChannelMessage[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before !== undefined) params.set('before', String(before));
  const res = await fetch(`${API_BASE}/channels/${encodeURIComponent(channelId)}/messages?${params}`);
  if (!res.ok) throw new Error(`Failed to get channel messages: ${res.statusText}`);
  return res.json();
}

export async function sendChannelMessage(
  channelId: string,
  content: string,
  senderName?: string,
  replyTo?: string,
): Promise<{ messageId: string; seq: number }> {
  const res = await fetch(`${API_BASE}/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, senderName, ...(replyTo ? { replyTo } : {}) }),
  });
  if (!res.ok) throw new Error(`Failed to send channel message: ${res.statusText}`);
  return res.json();
}

export async function getThreadMessages(
  channelId: string,
  shortId: string,
  limit = 100,
  before?: number,
): Promise<{ messages: ChannelMessage[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before !== undefined) params.set('before', String(before));
  const res = await fetch(
    `${API_BASE}/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(shortId)}/messages?${params}`,
  );
  if (!res.ok) throw new Error(`Failed to get thread messages: ${res.statusText}`);
  return res.json();
}

export async function getThreadSummary(
  channelId: string,
  shortId: string,
): Promise<ThreadCollaborationSummary> {
  const res = await fetch(
    `${API_BASE}/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(shortId)}/summary`,
  );
  if (!res.ok) throw new Error(`Failed to get thread summary: ${res.statusText}`);
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
