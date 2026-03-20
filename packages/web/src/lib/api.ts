import type { ConversationInfo, CreateConversationRequest, ServerEvent } from "@agent-collab/wire-types";

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
  const res = await fetch(`${API_BASE}/conversations/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete conversation: ${res.statusText}`);
}

export async function getHistory(id: string): Promise<ServerEvent[]> {
  const res = await fetch(`${API_BASE}/conversations/${id}/history`);
  if (!res.ok) throw new Error(`Failed to get history: ${res.statusText}`);
  return res.json();
}
