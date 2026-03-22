import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  PlusIcon, TrashIcon, XIcon, ChevronRightIcon, ChevronDownIcon, PencilIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  AgentInfo, MachineInfo,
  AgentType, CreateAgentRequest, CreateConversationRequest,
  UpdateAgentRequest, CreateMachineRequest, ConversationInfo,
} from "@agent-collab/protocol";
import { AgentDetailPanel } from "./AgentDetailPanel";
import { MachineCreatePanel } from "./MachineCreatePanel";
import defaultSystemPrompt from "@/prompts/default-system-prompt.md?raw";

const EXPANDED_MACHINES_STORAGE_KEY = "agent-collab:expanded-machines";
const EXPANDED_AGENTS_STORAGE_KEY = "agent-collab:expanded-agents";

function readStoredSet(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function writeStoredSet(storageKey: string, value: Set<string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey, JSON.stringify([...value]));
}

type SidebarProps = {
  machines: MachineInfo[];
  agents: AgentInfo[];
  conversations: ConversationInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateMachine: (req: CreateMachineRequest) => Promise<MachineInfo>;
  onDeleteMachine: (id: string) => void;
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

function StatusDot({ status }: { status: MachineInfo["status"] }) {
  return (
    <span
      className={cn("inline-block size-1.5 rounded-full shrink-0", {
        "bg-green-500": status === "online",
        "bg-yellow-400": status === "pending",
        "bg-muted-foreground/40": status === "offline",
      })}
      title={status}
    />
  );
}

export function Sidebar({
  machines, agents, conversations, selectedId,
  onSelect, onCreateMachine, onDeleteMachine,
  onCreateAgent, onUpdateAgent, onDeleteAgent,
  onCreateConversation, onDeleteConversation,
}: SidebarProps) {
  const [expandedMachines, setExpandedMachines] = useState<Set<string>>(
    () => readStoredSet(EXPANDED_MACHINES_STORAGE_KEY),
  );
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(
    () => readStoredSet(EXPANDED_AGENTS_STORAGE_KEY),
  );
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [showCreateMachine, setShowCreateMachine] = useState(false);

  // Create agent form state (keyed by machineNodeId)
  const [createAgentInMachine, setCreateAgentInMachine] = useState<string | null>(null);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentType, setNewAgentType] = useState<AgentType>("claude_acp");
  const [newAgentSystemPrompt, setNewAgentSystemPrompt] = useState(defaultSystemPrompt);

  const toggleMachine = (nodeId: string) => {
    setExpandedMachines((prev) => {
      const next = new Set(prev);
      next.has(nodeId) ? next.delete(nodeId) : next.add(nodeId);
      writeStoredSet(EXPANDED_MACHINES_STORAGE_KEY, next);
      return next;
    });
  };

  const toggleAgent = (agentId: string) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      next.has(agentId) ? next.delete(agentId) : next.add(agentId);
      writeStoredSet(EXPANDED_AGENTS_STORAGE_KEY, next);
      return next;
    });
  };

  const handleCreateAgent = useCallback(() => {
    if (!newAgentName.trim() || !createAgentInMachine) return;
    onCreateAgent({
      name: newAgentName.trim(),
      agentType: newAgentType,
      systemPrompt: newAgentSystemPrompt.trim() || undefined,
      nodeId: createAgentInMachine,
    });
    setCreateAgentInMachine(null);
    setNewAgentName("");
    setNewAgentSystemPrompt(defaultSystemPrompt);
  }, [newAgentName, newAgentType, newAgentSystemPrompt, createAgentInMachine, onCreateAgent]);

  const handleCreateConversation = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId);
    if (!agent) return;
    onCreateConversation({
      agentId,
      agentType: agent.agentType,
      nodeId: agent.nodeId ?? undefined,
      workspacePath: agent.workspacePath ?? undefined,
    });
  }, [agents, onCreateConversation]);

  const openCreateAgentForm = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCreateAgentInMachine(nodeId);
    setNewAgentName("");
    setNewAgentSystemPrompt(defaultSystemPrompt);
    setExpandedMachines((prev) => {
      const next = new Set(prev).add(nodeId);
      writeStoredSet(EXPANDED_MACHINES_STORAGE_KEY, next);
      return next;
    });
  };

  useEffect(() => {
    if (!selectedId) return;

    const selectedConversation = conversations.find((conversation) => conversation.id === selectedId);
    if (!selectedConversation?.agentId) return;

    const selectedAgent = agents.find((agent) => agent.agentId === selectedConversation.agentId);
    if (!selectedAgent) return;

    setExpandedAgents((prev) => {
      if (prev.has(selectedAgent.agentId)) return prev;
      const next = new Set(prev).add(selectedAgent.agentId);
      writeStoredSet(EXPANDED_AGENTS_STORAGE_KEY, next);
      return next;
    });

    if (selectedAgent.nodeId) {
      setExpandedMachines((prev) => {
        if (prev.has(selectedAgent.nodeId!)) return prev;
        const next = new Set(prev).add(selectedAgent.nodeId!);
        writeStoredSet(EXPANDED_MACHINES_STORAGE_KEY, next);
        return next;
      });
    }
  }, [agents, conversations, selectedId]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-3">
        <h1 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Machines &amp; Agents
        </h1>
        <Button
          size="icon-xs"
          variant="ghost"
          title="Add machine"
          onClick={() => setShowCreateMachine((v) => !v)}
        >
          <PlusIcon className="size-3" />
        </Button>
      </div>

      {/* Create machine panel */}
      {showCreateMachine && (
        <MachineCreatePanel
          onClose={() => setShowCreateMachine(false)}
          onCreate={async (req) => {
            const m = await onCreateMachine(req);
            setExpandedMachines((prev) => new Set(prev).add(m.nodeId));
            return m;
          }}
        />
      )}

      <ScrollArea className="flex-1">
        <div className="flex flex-col p-1.5 gap-0.5">
          {machines.length === 0 && (
            <p className="px-3 py-4 text-[10px] text-muted-foreground text-center">
              No machines yet — click + to add one
            </p>
          )}

          {machines.map((machine) => {
            const machineAgents = agents.filter((a) => a.nodeId === machine.nodeId);
            const isExpanded = expandedMachines.has(machine.nodeId);

            return (
              <div key={machine.nodeId}>
                {/* Machine row */}
                <button
                  type="button"
                  className="group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-accent/50 cursor-pointer"
                  onClick={() => toggleMachine(machine.nodeId)}
                >
                  {isExpanded
                    ? <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
                    : <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
                  }
                  <StatusDot status={machine.status} />
                  <span className="flex-1 text-xs font-medium truncate">{machine.name}</span>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                    <button
                      type="button"
                      className="p-0.5 rounded hover:bg-accent cursor-pointer"
                      title="Add agent to this machine"
                      onClick={(e) => openCreateAgentForm(machine.nodeId, e)}
                    >
                      <PlusIcon className="size-3 text-muted-foreground" />
                    </button>
                    <button
                      type="button"
                      className="p-0.5 rounded hover:bg-accent cursor-pointer"
                      title="Delete machine"
                      onClick={(e) => { e.stopPropagation(); onDeleteMachine(machine.nodeId); }}
                    >
                      <TrashIcon className="size-3 text-muted-foreground hover:text-destructive" />
                    </button>
                  </div>
                </button>

                {/* Machine content */}
                {isExpanded && (
                  <div className="ml-3 flex flex-col gap-0.5">
                    {/* Create agent form */}
                    {createAgentInMachine === machine.nodeId && (
                      <div className="border border-sidebar-border rounded p-2 space-y-1.5 my-1 bg-sidebar-accent/20">
                        <input
                          autoFocus
                          className="w-full rounded border border-input bg-background px-1.5 py-0.5 text-xs placeholder:text-muted-foreground"
                          placeholder="Agent name"
                          value={newAgentName}
                          onChange={(e) => setNewAgentName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleCreateAgent();
                            if (e.key === "Escape") setCreateAgentInMachine(null);
                          }}
                        />
                        <div className="flex gap-1">
                          {(["claude_acp", "codex_acp"] as AgentType[]).map((t) => (
                            <button
                              key={t}
                              type="button"
                              className={cn(
                                "flex-1 rounded px-1 py-0.5 text-[10px] border cursor-pointer",
                                newAgentType === t
                                  ? "bg-primary text-primary-foreground border-primary"
                                  : "border-input hover:bg-accent",
                              )}
                              onClick={() => setNewAgentType(t)}
                            >
                              {t === "claude_acp" ? "Claude" : "Codex"}
                            </button>
                          ))}
                        </div>
                        <textarea
                          className="w-full rounded border border-input bg-background px-1.5 py-0.5 text-xs resize-none min-h-[40px] placeholder:text-muted-foreground"
                          placeholder="System prompt (optional)"
                          value={newAgentSystemPrompt}
                          onChange={(e) => setNewAgentSystemPrompt(e.target.value)}
                        />
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            className="flex-1 text-xs h-6"
                            onClick={handleCreateAgent}
                            disabled={!newAgentName.trim()}
                          >
                            Create
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-xs h-6 px-2"
                            onClick={() => setCreateAgentInMachine(null)}
                          >
                            <XIcon className="size-3" />
                          </Button>
                        </div>
                      </div>
                    )}

                    {machineAgents.length === 0 && createAgentInMachine !== machine.nodeId && (
                      <p className="px-2 py-2 text-[10px] text-muted-foreground">
                        No agents — click + to create one
                      </p>
                    )}

                    {machineAgents.map((agent) => {
                      const agentConvs = conversations.filter((c) => c.agentId === agent.agentId);
                      const isAgentExpanded = expandedAgents.has(agent.agentId);
                      const isEditing = editingAgentId === agent.agentId;

                      return (
                        <div key={agent.agentId}>
                          <AgentRow
                            agent={agent}
                            conversationCount={agentConvs.length}
                            isExpanded={isAgentExpanded}
                            isEditing={isEditing}
                            onToggle={() => toggleAgent(agent.agentId)}
                            onEdit={() => setEditingAgentId(isEditing ? null : agent.agentId)}
                            onDelete={() => onDeleteAgent(agent.agentId)}
                          />

                          {isEditing && (
                            <AgentDetailPanel
                              agent={agent}
                              onUpdate={(req) => onUpdateAgent(agent.agentId, req)}
                              onClose={() => setEditingAgentId(null)}
                            />
                          )}

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
                                <p className="text-[10px] text-muted-foreground px-2 py-1">
                                  No threads yet
                                </p>
                              )}
                              <button
                                type="button"
                                className="text-left text-[10px] text-muted-foreground px-2 py-0.5 rounded hover:bg-accent/50 cursor-pointer"
                                onClick={() => handleCreateConversation(agent.agentId)}
                              >
                                + New Thread
                              </button>
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
