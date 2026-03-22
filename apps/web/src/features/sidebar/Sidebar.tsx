import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  PlusIcon, TrashIcon, XIcon, ChevronRightIcon, ChevronDownIcon, PencilIcon,
} from "lucide-react";
import { useCallback, useState, useEffect } from "react";
import type {
  ConversationInfo, AgentInfo, ChannelInfo,
  AgentType, CreateAgentRequest, CreateConversationRequest, NodeInfoRest, UpdateAgentRequest,
} from "@agent-collab/protocol";
import { listNodes } from "@/lib/api";
import { AgentDetailPanel } from "./AgentDetailPanel";
import defaultSystemPrompt from "@/prompts/default-system-prompt.md?raw";

type SidebarProps = {
  channels: ChannelInfo[];
  agents: AgentInfo[];
  conversations: ConversationInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateAgent: (req: CreateAgentRequest) => void;
  onUpdateAgent: (id: string, req: UpdateAgentRequest) => Promise<void>;
  onDeleteAgent: (id: string) => void;
  onCreateConversation: (req: CreateConversationRequest) => void;
  onDeleteConversation: (id: string) => void;
};

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function Sidebar({
  channels, agents, conversations, selectedId,
  onSelect, onCreateAgent, onUpdateAgent, onDeleteAgent,
  onCreateConversation, onDeleteConversation,
}: SidebarProps) {
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set(["default"]));
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);

  // Create agent form state
  const [createAgentInChannel, setCreateAgentInChannel] = useState<string | null>(null);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentType, setNewAgentType] = useState<AgentType>("claude_acp");
  const [newAgentSystemPrompt, setNewAgentSystemPrompt] = useState(defaultSystemPrompt);
  const [nodes, setNodes] = useState<NodeInfoRest[]>([]);
  const [newAgentNodeId, setNewAgentNodeId] = useState<string | undefined>(undefined);

  // Create conversation form state
  const [createConvInAgent, setCreateConvInAgent] = useState<string | null>(null);

  useEffect(() => {
    if (createAgentInChannel !== null) {
      listNodes().then(setNodes).catch(() => setNodes([]));
    }
  }, [createAgentInChannel]);

  const toggleChannel = (channelId: string) => {
    setExpandedChannels((prev) => {
      const next = new Set(prev);
      next.has(channelId) ? next.delete(channelId) : next.add(channelId);
      return next;
    });
  };

  const toggleAgent = (agentId: string) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      next.has(agentId) ? next.delete(agentId) : next.add(agentId);
      return next;
    });
  };

  const handleCreateAgent = useCallback(() => {
    if (!newAgentName.trim() || !createAgentInChannel) return;
    onCreateAgent({
      name: newAgentName.trim(),
      agentType: newAgentType,
      channelId: createAgentInChannel,
      systemPrompt: newAgentSystemPrompt.trim() || undefined,
      nodeId: newAgentNodeId,
    });
    setCreateAgentInChannel(null);
    setNewAgentName("");
    setNewAgentSystemPrompt(defaultSystemPrompt);
    setNewAgentNodeId(undefined);
  }, [newAgentName, newAgentType, newAgentSystemPrompt, newAgentNodeId, createAgentInChannel, onCreateAgent]);

  const handleCreateConversation = useCallback((agentId: string, channelId: string) => {
    const agent = agents.find((a) => a.agentId === agentId);
    if (!agent) return;
    onCreateConversation({
      agentId,
      channelId,
      agentType: agent.agentType,
      nodeId: agent.nodeId ?? undefined,
      workspacePath: agent.workspacePath ?? undefined,
    });
    setCreateConvInAgent(null);
  }, [agents, onCreateConversation]);

  const openCreateAgentForm = (channelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCreateAgentInChannel(channelId);
    setNewAgentName("");
    setNewAgentSystemPrompt(defaultSystemPrompt);
    setNewAgentNodeId(undefined);
    setExpandedChannels((prev) => new Set(prev).add(channelId));
  };

  // All channels — ensure "default" is always first
  const sortedChannels = [...channels].sort((a, b) =>
    a.channelId === "default" ? -1 : b.channelId === "default" ? 1 : 0,
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-3">
        <h1 className="text-sm font-semibold">Agents</h1>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col p-1.5 gap-0.5">
          {sortedChannels.map((channel) => {
            const channelAgents = agents.filter((a) => a.channelId === channel.channelId);
            const isExpanded = expandedChannels.has(channel.channelId);

            return (
              <div key={channel.channelId}>
                {/* Channel row */}
                <button
                  type="button"
                  className="group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-accent/50 cursor-pointer"
                  onClick={() => toggleChannel(channel.channelId)}
                >
                  {isExpanded
                    ? <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
                    : <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
                  }
                  <span className="flex-1 text-xs font-medium text-muted-foreground truncate">
                    {channel.name}
                  </span>
                  <button
                    type="button"
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent cursor-pointer"
                    title="New agent in this channel"
                    onClick={(e) => openCreateAgentForm(channel.channelId, e)}
                  >
                    <PlusIcon className="size-3 text-muted-foreground" />
                  </button>
                </button>

                {/* Channel content */}
                {isExpanded && (
                  <div className="ml-3 flex flex-col gap-0.5">
                    {/* Create agent form */}
                    {createAgentInChannel === channel.channelId && (
                      <div className="border border-sidebar-border rounded p-2 space-y-1.5 my-1 bg-sidebar-accent/20">
                        <input
                          autoFocus
                          className="w-full rounded border border-input bg-background px-1.5 py-0.5 text-xs placeholder:text-muted-foreground"
                          placeholder="Agent name"
                          value={newAgentName}
                          onChange={(e) => setNewAgentName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleCreateAgent(); if (e.key === "Escape") setCreateAgentInChannel(null); }}
                        />
                        {/* Agent type */}
                        <div className="flex gap-1">
                          {(["claude_acp", "codex_acp"] as AgentType[]).map((t) => (
                            <button
                              key={t}
                              type="button"
                              className={cn(
                                "flex-1 rounded px-1 py-0.5 text-[10px] border cursor-pointer",
                                newAgentType === t ? "bg-primary text-primary-foreground border-primary" : "border-input hover:bg-accent",
                              )}
                              onClick={() => setNewAgentType(t)}
                            >
                              {t === "claude_acp" ? "Claude" : "Codex"}
                            </button>
                          ))}
                        </div>
                        {/* System prompt (optional) */}
                        <textarea
                          className="w-full rounded border border-input bg-background px-1.5 py-0.5 text-xs resize-none min-h-[40px] placeholder:text-muted-foreground"
                          placeholder="System prompt (optional)"
                          value={newAgentSystemPrompt}
                          onChange={(e) => setNewAgentSystemPrompt(e.target.value)}
                        />
                        {/* Node selector */}
                        {nodes.length > 0 && (
                          <select
                            className="w-full rounded border border-input bg-background px-1.5 py-0.5 text-xs"
                            value={newAgentNodeId ?? ""}
                            onChange={(e) => setNewAgentNodeId(e.target.value || undefined)}
                          >
                            <option value="">Local</option>
                            {nodes.map((n) => (
                              <option key={n.nodeId} value={n.nodeId}>
                                {n.hostname} ({n.nodeId})
                              </option>
                            ))}
                          </select>
                        )}
                        <div className="flex gap-1">
                          <Button size="sm" className="flex-1 text-xs h-6" onClick={handleCreateAgent} disabled={!newAgentName.trim()}>
                            Create
                          </Button>
                          <Button size="sm" variant="ghost" className="text-xs h-6 px-2" onClick={() => setCreateAgentInChannel(null)}>
                            <XIcon className="size-3" />
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Agents in this channel */}
                    {channelAgents.length === 0 && createAgentInChannel !== channel.channelId && (
                      <p className="px-2 py-2 text-[10px] text-muted-foreground">
                        No agents — click + to create one
                      </p>
                    )}

                    {channelAgents.map((agent) => {
                      const agentConvs = conversations.filter((c) => c.agentId === agent.agentId);
                      const isAgentExpanded = expandedAgents.has(agent.agentId);
                      const isEditing = editingAgentId === agent.agentId;

                      return (
                        <div key={agent.agentId}>
                          {/* Agent row */}
                          <AgentRow
                            agent={agent}
                            conversationCount={agentConvs.length}
                            isExpanded={isAgentExpanded}
                            isEditing={isEditing}
                            onToggle={() => toggleAgent(agent.agentId)}
                            onEdit={() => setEditingAgentId(isEditing ? null : agent.agentId)}
                            onDelete={() => onDeleteAgent(agent.agentId)}
                          />

                          {/* Agent detail panel */}
                          {isEditing && (
                            <AgentDetailPanel
                              agent={agent}
                              onUpdate={(req) => onUpdateAgent(agent.agentId, req)}
                              onClose={() => setEditingAgentId(null)}
                            />
                          )}

                          {/* Conversations under agent */}
                          {isAgentExpanded && (
                            <div className="ml-3 flex flex-col gap-0.5 mt-0.5">
                              {agentConvs.map((conv) => (
                                <ConversationItem
                                  key={conv.id}
                                  conversation={conv}
                                  isSelected={conv.id === selectedId}
                                  onSelect={onSelect}
                                  onDelete={onDeleteConversation}
                                />
                              ))}
                              {agentConvs.length === 0 && (
                                <p className="text-[10px] text-muted-foreground px-2 py-1">No threads yet</p>
                              )}
                              {createConvInAgent === agent.agentId ? (
                                <div className="flex gap-1 mt-0.5">
                                  <Button size="sm" className="flex-1 text-xs h-6" onClick={() => handleCreateConversation(agent.agentId, channel.channelId)}>
                                    + New Thread
                                  </Button>
                                  <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => setCreateConvInAgent(null)}>
                                    <XIcon className="size-3" />
                                  </Button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  className="text-left text-[10px] text-muted-foreground px-2 py-0.5 rounded hover:bg-accent/50 cursor-pointer"
                                  onClick={() => handleCreateConversation(agent.agentId, channel.channelId)}
                                >
                                  + New Thread
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

// ─── AgentRow ───

type AgentRowProps = {
  agent: AgentInfo;
  conversationCount: number;
  isExpanded: boolean;
  isEditing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

function AgentRow({ agent, conversationCount, isExpanded, isEditing, onToggle, onEdit, onDelete }: AgentRowProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete();
    } else {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
    }
  };

  return (
    <button
      type="button"
      className="group flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left hover:bg-accent/50 cursor-pointer"
      onClick={onToggle}
    >
      {isExpanded
        ? <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
        : <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
      }
      <span className="flex-1 min-w-0 truncate text-xs font-medium">{agent.name}</span>
      <div className="flex items-center gap-1 shrink-0">
        <Badge variant="secondary" className="text-[9px] px-1 py-0">
          {agent.agentType === "claude_acp" ? "Claude" : "Codex"}
        </Badge>
        {agent.nodeId && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 hidden group-hover:flex">
            {agent.nodeId.slice(0, 8)}
          </Badge>
        )}
        <button
          type="button"
          className={cn(
            "p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer",
            isEditing ? "opacity-100 text-primary" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          title="Edit agent"
        >
          <PencilIcon className="size-3" />
        </button>
        <button
          type="button"
          className={cn(
            "p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer",
            confirmDelete ? "opacity-100 text-destructive" : "text-muted-foreground hover:text-destructive",
          )}
          onClick={handleDelete}
          title={confirmDelete ? "Click again to confirm" : "Delete agent"}
        >
          <TrashIcon className="size-3" />
        </button>
        {conversationCount > 0 && (
          <span className="text-[10px] text-muted-foreground">{conversationCount}</span>
        )}
      </div>
    </button>
  );
}

// ─── ConversationItem ───

type ConversationItemProps = {
  conversation: ConversationInfo;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
};

function ConversationItem({ conversation, isSelected, onSelect, onDelete }: ConversationItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete(conversation.id);
      setConfirmDelete(false);
    } else {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
    }
  }, [confirmDelete, conversation.id, onDelete]);

  return (
    <button
      type="button"
      className={cn(
        "group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left cursor-pointer transition-colors",
        isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      onClick={() => onSelect(conversation.id)}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="truncate text-xs">
            {conversation.title || "Untitled"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">
            {formatRelativeTime(conversation.updatedAt)}
          </span>
          <span className="font-mono text-[9px] text-muted-foreground/50" title={conversation.id}>
            {conversation.id.slice(0, 8)}
          </span>
        </div>
      </div>
      <button
        type="button"
        className={cn(
          "shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 cursor-pointer",
          confirmDelete ? "opacity-100 text-destructive" : "text-muted-foreground hover:text-destructive",
        )}
        onClick={handleDelete}
        title={confirmDelete ? "Click again to confirm" : "Delete"}
      >
        <TrashIcon className="size-3" />
      </button>
    </button>
  );
}
