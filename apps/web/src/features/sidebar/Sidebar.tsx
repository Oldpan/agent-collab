import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  PlusIcon, TrashIcon, XIcon, ChevronRightIcon, ChevronDownIcon, PencilIcon, Rows3Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  AgentInfo, MachineInfo,
  AgentType, CreateAgentRequest,
  UpdateAgentRequest, CreateMachineRequest, ConversationInfo,
} from "@agent-collab/protocol";
import { AgentDetailPanel } from "./AgentDetailPanel";
import { MachineCreatePanel } from "./MachineCreatePanel";
import { AgentEnvVarsEditor } from "./AgentEnvVarsEditor";
import { AgentPermissionSettings } from "./AgentPermissionSettings";
import defaultSystemPrompt from "@/prompts/default-system-prompt.md?raw";

const EXPANDED_MACHINES_STORAGE_KEY = "agent-collab:expanded-machines";

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
  selectedView: "chat" | "sessions";
  onOpenSessions: () => void;
  onCreateMachine: (req: CreateMachineRequest) => Promise<MachineInfo>;
  onDeleteMachine: (id: string) => void;
  onCreateAgent: (req: CreateAgentRequest) => void;
  onUpdateAgent: (id: string, req: UpdateAgentRequest) => Promise<void>;
  onResetAgent: (id: string) => Promise<void>;
  onDeleteAgent: (id: string) => void;
  onOpenAgentThread: (agentId: string) => void;
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
  selectedView,
  onCreateMachine, onDeleteMachine,
  onOpenSessions,
  onCreateAgent, onUpdateAgent, onDeleteAgent,
  onResetAgent,
  onOpenAgentThread,
}: SidebarProps) {
  const [expandedMachines, setExpandedMachines] = useState<Set<string>>(
    () => readStoredSet(EXPANDED_MACHINES_STORAGE_KEY),
  );
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [showCreateMachine, setShowCreateMachine] = useState(false);

  // Create agent form state (keyed by machineNodeId)
  const [createAgentInMachine, setCreateAgentInMachine] = useState<string | null>(null);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentType, setNewAgentType] = useState<AgentType>("claude_acp");
  const [newAgentSystemPrompt, setNewAgentSystemPrompt] = useState(defaultSystemPrompt);
  const [newAgentEnvVars, setNewAgentEnvVars] = useState<Record<string, string> | undefined>();
  const [newAgentDisabledToolKinds, setNewAgentDisabledToolKinds] = useState<CreateAgentRequest["disabledToolKinds"]>();

  const toggleMachine = (nodeId: string) => {
    setExpandedMachines((prev) => {
      const next = new Set(prev);
      next.has(nodeId) ? next.delete(nodeId) : next.add(nodeId);
      writeStoredSet(EXPANDED_MACHINES_STORAGE_KEY, next);
      return next;
    });
  };

  const handleCreateAgent = useCallback(() => {
    if (!newAgentName.trim() || !createAgentInMachine) return;
    onCreateAgent({
      name: newAgentName.trim(),
      agentType: newAgentType,
      systemPrompt: newAgentSystemPrompt.trim() || undefined,
      envVars: newAgentEnvVars,
      disabledToolKinds: newAgentDisabledToolKinds,
      nodeId: createAgentInMachine,
    });
    setCreateAgentInMachine(null);
    setNewAgentName("");
    setNewAgentSystemPrompt(defaultSystemPrompt);
    setNewAgentEnvVars(undefined);
    setNewAgentDisabledToolKinds(undefined);
  }, [newAgentName, newAgentType, newAgentSystemPrompt, newAgentEnvVars, newAgentDisabledToolKinds, createAgentInMachine, onCreateAgent]);

  const openCreateAgentForm = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCreateAgentInMachine(nodeId);
    setNewAgentName("");
    setNewAgentSystemPrompt(defaultSystemPrompt);
    setNewAgentEnvVars(undefined);
    setNewAgentDisabledToolKinds(undefined);
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
    <div className="flex h-full flex-col bg-[#ffd000]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-black/10 bg-[#ffd000] px-3 py-3 shadow-[0_10px_24px_-18px_rgba(0,0,0,0.45)]">
        <h1 className="text-xs font-semibold uppercase tracking-wider text-zinc-600">
          Machines &amp; Agents
        </h1>
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="outline"
            className={cn(
              "rounded-sm border-2 border-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              selectedView === "sessions"
                ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]"
                : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            title="Open session manager"
            onClick={onOpenSessions}
          >
            <Rows3Icon className="size-3" />
          </Button>
          <Button
            size="icon-xs"
            variant="outline"
            className="rounded-sm border-2 border-zinc-900 bg-[#fff9d8] text-zinc-700 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#fff1a9]"
            title="Add machine"
            onClick={() => setShowCreateMachine((v) => !v)}
          >
            <PlusIcon className="size-3" />
          </Button>
        </div>
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
        <div className="flex flex-col gap-1 p-2">
          {machines.length === 0 && (
            <p className="rounded-md border-2 border-zinc-900 bg-[#fff8d8] px-3 py-4 text-center text-[10px] text-zinc-500 shadow-[3px_3px_0_0_rgba(0,0,0,0.1)]">
              No machines yet — click + to add one
            </p>
          )}

          {machines.map((machine) => {
            const machineAgents = agents.filter((a) => a.nodeId === machine.nodeId);
            const isExpanded = expandedMachines.has(machine.nodeId);
            const selectedConversation = selectedId
              ? conversations.find((conversation) => conversation.id === selectedId)
              : null;
            const selectedAgentId = selectedConversation?.agentId ?? null;

            return (
              <div key={machine.nodeId}>
                {/* Machine row */}
                <button
                  type="button"
                  className="group flex w-full items-center gap-1.5 rounded-md border-2 border-zinc-900 bg-[#fff8d8] px-2.5 py-1.5 text-left shadow-[3px_3px_0_0_rgba(0,0,0,0.1)] transition-colors hover:bg-[#fff1a9] cursor-pointer"
                  onClick={() => toggleMachine(machine.nodeId)}
                >
                  {isExpanded
                    ? <ChevronDownIcon className="size-3 shrink-0 text-zinc-500" />
                    : <ChevronRightIcon className="size-3 shrink-0 text-zinc-500" />
                  }
                  <StatusDot status={machine.status} />
                  <span className="flex-1 truncate text-xs font-medium">{machine.name}</span>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                    <button
                      type="button"
                      className="rounded-sm p-0.5 hover:bg-[#ffe27a] cursor-pointer"
                      title="Add agent to this machine"
                      onClick={(e) => openCreateAgentForm(machine.nodeId, e)}
                    >
                      <PlusIcon className="size-3 text-zinc-500" />
                    </button>
                    <button
                      type="button"
                      className="rounded-sm p-0.5 hover:bg-[#ffe27a] cursor-pointer"
                      title="Delete machine"
                      onClick={(e) => { e.stopPropagation(); onDeleteMachine(machine.nodeId); }}
                    >
                      <TrashIcon className="size-3 text-zinc-500 hover:text-destructive" />
                    </button>
                  </div>
                </button>

                {/* Machine content */}
                {isExpanded && (
                  <div className="ml-3 mt-1 flex flex-col gap-1">
                    {/* Create agent form */}
                    {createAgentInMachine === machine.nodeId && (
                      <div className="my-1 space-y-1.5 rounded-md border-2 border-zinc-900 bg-[#fff8d8] p-2 shadow-[3px_3px_0_0_rgba(0,0,0,0.1)]">
                        <input
                          autoFocus
                          className="w-full rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1 text-xs placeholder:text-zinc-400"
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
                                "flex-1 rounded-sm border-2 px-1 py-0.5 text-[10px] cursor-pointer",
                                newAgentType === t
                                  ? "border-zinc-900 bg-[#ffd54a] text-zinc-950"
                                  : "border-zinc-900 bg-white text-zinc-700 hover:bg-[#fff1a9]",
                              )}
                              onClick={() => setNewAgentType(t)}
                            >
                              {t === "claude_acp" ? "Claude" : "Codex"}
                            </button>
                          ))}
                        </div>
                        <textarea
                          className="min-h-[40px] w-full resize-none rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1 text-xs placeholder:text-zinc-400"
                          placeholder="System prompt (optional)"
                          value={newAgentSystemPrompt}
                          onChange={(e) => setNewAgentSystemPrompt(e.target.value)}
                        />
                        <AgentEnvVarsEditor
                          editorKey={`${machine.nodeId}:${newAgentType}:${createAgentInMachine ?? "closed"}`}
                          value={newAgentEnvVars}
                          onChange={setNewAgentEnvVars}
                        />
                        <AgentPermissionSettings
                          value={newAgentDisabledToolKinds}
                          onChange={setNewAgentDisabledToolKinds}
                        />
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            className="h-6 flex-1 rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-xs text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
                            onClick={handleCreateAgent}
                            disabled={!newAgentName.trim()}
                          >
                            Create
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 rounded-sm border-2 border-zinc-900 bg-white px-2 text-xs text-zinc-700 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#fff1a9]"
                            onClick={() => {
                              setCreateAgentInMachine(null);
                              setNewAgentEnvVars(undefined);
                              setNewAgentDisabledToolKinds(undefined);
                            }}
                          >
                            <XIcon className="size-3" />
                          </Button>
                        </div>
                      </div>
                    )}

                    {machineAgents.length === 0 && createAgentInMachine !== machine.nodeId && (
                      <p className="rounded-md border-2 border-dashed border-zinc-900/40 bg-[#fff8d8] px-2 py-2 text-[10px] text-zinc-500">
                        No agents — click + to create one
                      </p>
                    )}

                    {machineAgents.map((agent) => {
                      const isEditing = editingAgentId === agent.agentId;
                      const primaryConversation = conversations.find(
                        (conversation) => conversation.agentId === agent.agentId && conversation.isPrimaryThread,
                      );

                      return (
                        <div key={agent.agentId}>
                          <AgentRow
                            agent={agent}
                            isEditing={isEditing}
                            isSelected={selectedAgentId === agent.agentId}
                            updatedAt={primaryConversation?.updatedAt ?? agent.updatedAt}
                            onOpen={() => onOpenAgentThread(agent.agentId)}
                            onEdit={() => setEditingAgentId(isEditing ? null : agent.agentId)}
                            onDelete={() => onDeleteAgent(agent.agentId)}
                          />

                          {isEditing && (
                            <AgentDetailPanel
                              agent={agent}
                              onUpdate={(req) => onUpdateAgent(agent.agentId, req)}
                              onReset={() => onResetAgent(agent.agentId)}
                              onClose={() => setEditingAgentId(null)}
                            />
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
  isEditing: boolean;
  isSelected: boolean;
  updatedAt: number;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

function AgentRow({ agent, isEditing, isSelected, updatedAt, onOpen, onEdit, onDelete }: AgentRowProps) {
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
    <div className={cn(
      "group flex items-center gap-1.5 rounded-md border-2 border-zinc-900 px-2 py-1.5 shadow-[3px_3px_0_0_rgba(0,0,0,0.1)]",
      isSelected ? "bg-[#ffd54a] text-zinc-950" : "bg-[#fff8d8] hover:bg-[#fff1a9]",
    )}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left cursor-pointer"
        onClick={onOpen}
        title="Open private chat"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{agent.name}</div>
          <div className="text-[10px] text-zinc-500">
            {formatRelativeTime(updatedAt)}
          </div>
        </div>
      </button>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          className={cn(
            "p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer",
            isEditing ? "opacity-100 text-zinc-950" : "text-zinc-500 hover:text-zinc-950",
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
            confirmDelete ? "opacity-100 text-destructive" : "text-zinc-500 hover:text-destructive",
          )}
          onClick={handleDelete}
          title={confirmDelete ? "Click again to confirm" : "Delete agent"}
        >
          <TrashIcon className="size-3" />
        </button>
      </div>
    </div>
  );
}
