import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CreateDialog } from "@/components/ui/create-dialog";
import { cn } from "@/lib/utils";
import {
  PlusIcon, TrashIcon, ChevronRightIcon, ChevronDownIcon, Rows3Icon, HashIcon, LogOutIcon, LinkIcon, SettingsIcon, UserIcon, ShieldIcon, SearchIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  AgentInfo, MachineInfo, ChannelInfo,
  CreateAgentRequest,
  CreateMachineRequest, ConversationInfo, ConversationStatus,
} from "@agent-collab/protocol";
import type { User } from "@/lib/auth-api";
import { useUsers } from "@/hooks/useUsers";
import { MachineCreatePanel } from "./MachineCreatePanel";
import { ChannelCreatePanel } from "./ChannelCreatePanel";
import { AgentCreateDialog } from "./AgentCreateDialog";
import { ChatAvatar } from "../chat/ChatAvatar";
import { InviteGenerateDialog } from "../auth/InviteGenerateDialog";
import { UserSettingsPanel } from "../auth/UserSettingsPanel";
import { HumanProfilePanel } from "../auth/HumanProfilePanel";

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
  channels: ChannelInfo[];
  agentUnreadCounts: Record<string, number>;
  channelUnreadCounts: Record<string, number>;
  selectedId: string | null;
  selectedChannelId: string | null;
  selectedView: "chat" | "sessions" | "search";
  currentUser?: User | null;
  onOpenSessions: () => void;
  onCreateMachine: (req: CreateMachineRequest) => Promise<MachineInfo>;
  onDeleteMachine: (id: string) => void;
  onCreateAgent: (req: CreateAgentRequest) => void;
  onDeleteAgent: (id: string) => void;
  onOpenSearch: () => void;
  onOpenAgentThread: (agentId: string) => void;
  onSelectChannel: (channelId: string) => void;
  onCreateChannel: (req: { name: string; description?: string; agentIds?: string[]; workspacePath?: string }) => Promise<ChannelInfo>;
  onLogout?: () => void;
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

function AgentStatusDot({
  machineStatus,
  conversationStatus,
}: {
  machineStatus: MachineInfo["status"] | null;
  conversationStatus: ConversationStatus | null;
}) {
  let color: string;
  let label: string;

  if (!machineStatus || machineStatus === "offline") {
    color = "bg-zinc-300";
    label = "offline";
  } else if (machineStatus === "pending") {
    color = "bg-yellow-400";
    label = "connecting";
  } else if (conversationStatus === "active") {
    color = "bg-orange-400";
    label = "running";
  } else if (conversationStatus === "queued") {
    color = "bg-blue-400";
    label = "queued";
  } else {
    color = "bg-green-500";
    label = "online";
  }

  return (
    <span
      className={cn("inline-block size-1.5 rounded-full shrink-0", color)}
      title={label}
    />
  );
}

export function Sidebar({
  machines, agents, conversations, channels, agentUnreadCounts, channelUnreadCounts, selectedId, selectedChannelId,
  selectedView,
  currentUser,
  onCreateMachine, onDeleteMachine,
  onOpenSearch,
  onOpenSessions,
  onCreateAgent, onDeleteAgent,
  onOpenAgentThread,
  onSelectChannel, onCreateChannel,
  onLogout,
}: SidebarProps) {
  const isAdmin = currentUser?.isAdmin ?? false;

  const [expandedMachines, setExpandedMachines] = useState<Set<string>>(
    () => readStoredSet(EXPANDED_MACHINES_STORAGE_KEY),
  );
  const [showCreateMachine, setShowCreateMachine] = useState(false);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [createAgentMachineId, setCreateAgentMachineId] = useState<string | null>(null);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [showUserSettings, setShowUserSettings] = useState(false);
  const [profileUser, setProfileUser] = useState<User | null>(null);
  const { users } = useUsers();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [agentToDelete, setAgentToDelete] = useState<AgentInfo | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [deleteMachineDialogOpen, setDeleteMachineDialogOpen] = useState(false);
  const [machineToDelete, setMachineToDelete] = useState<MachineInfo | null>(null);

  const toggleMachine = (nodeId: string) => {
    setExpandedMachines((prev) => {
      const next = new Set(prev);
      next.has(nodeId) ? next.delete(nodeId) : next.add(nodeId);
      writeStoredSet(EXPANDED_MACHINES_STORAGE_KEY, next);
      return next;
    });
  };

  const handleOpenDeleteDialog = useCallback((agent: AgentInfo) => {
    setAgentToDelete(agent);
    setDeleteDialogOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!agentToDelete) return;
    setIsDeleting(true);
    try {
      await onDeleteAgent(agentToDelete.agentId);
      setDeleteDialogOpen(false);
      setAgentToDelete(null);
    } finally {
      setIsDeleting(false);
    }
  }, [agentToDelete, onDeleteAgent]);

  const handleCancelDelete = useCallback(() => {
    setDeleteDialogOpen(false);
    setAgentToDelete(null);
  }, []);

  const handleOpenDeleteMachineDialog = useCallback((machine: MachineInfo) => {
    setMachineToDelete(machine);
    setDeleteMachineDialogOpen(true);
  }, []);

  const handleConfirmDeleteMachine = useCallback(async () => {
    if (!machineToDelete) return;
    setIsDeleting(true);
    try {
      await onDeleteMachine(machineToDelete.nodeId);
      setDeleteMachineDialogOpen(false);
      setMachineToDelete(null);
    } finally {
      setIsDeleting(false);
    }
  }, [machineToDelete, onDeleteMachine]);

  const handleCancelDeleteMachine = useCallback(() => {
    setDeleteMachineDialogOpen(false);
    setMachineToDelete(null);
  }, []);

  const handleCreateAgent = useCallback((req: CreateAgentRequest) => {
    onCreateAgent(req);
    setShowCreateAgent(false);
    setCreateAgentMachineId(null);
  }, [onCreateAgent]);

  const openCreateAgentDialog = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCreateAgentMachineId(nodeId);
    setShowCreateAgent(true);
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
    <div className="flex h-full flex-col bg-[#ffe135]">
      {/* Header */}
      <div className="flex items-center justify-between border-b-2 border-black bg-[#ffd700] px-3 py-3 shadow-[0_2px_0_0_rgba(0,0,0,0.15)]">
        <h1 className="text-xs font-semibold uppercase tracking-wider text-zinc-800">
          Machines &amp; Agents
        </h1>
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="outline"
            className={cn(
              "rounded-sm border-2 border-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              selectedView === "search"
                ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]"
                : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            title="Search messages"
            onClick={onOpenSearch}
          >
            <SearchIcon className="size-3" />
          </Button>
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
          {isAdmin && (
            <Button
              size="icon-xs"
              variant="outline"
              className="rounded-sm border-2 border-zinc-900 bg-[#fff9d8] text-zinc-700 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#fff1a9]"
              title="Add machine"
              onClick={() => setShowCreateMachine(true)}
            >
              <PlusIcon className="size-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Create machine dialog */}
      <CreateDialog
        isOpen={showCreateMachine}
        title="New Machine"
        onClose={() => setShowCreateMachine(false)}
      >
        <MachineCreatePanel
          onClose={() => setShowCreateMachine(false)}
          onCreate={async (req) => {
            const m = await onCreateMachine(req);
            setExpandedMachines((prev) => new Set(prev).add(m.nodeId));
            return m;
          }}
        />
      </CreateDialog>

      {/* Create agent dialog */}
      <CreateDialog
        isOpen={showCreateAgent}
        title="New Agent"
        onClose={() => {
          setShowCreateAgent(false);
          setCreateAgentMachineId(null);
        }}
      >
        {createAgentMachineId && (
          <AgentCreateDialog
            machineNodeId={createAgentMachineId}
            onClose={() => {
              setShowCreateAgent(false);
              setCreateAgentMachineId(null);
            }}
            onCreate={handleCreateAgent}
          />
        )}
      </CreateDialog>

      {/* Create channel dialog */}
      <CreateDialog
        isOpen={showCreateChannel}
        title="New Channel"
        onClose={() => setShowCreateChannel(false)}
      >
        <ChannelCreatePanel
          agents={agents}
          onClose={() => setShowCreateChannel(false)}
          onCreate={onCreateChannel}
          onCreated={(channel) => onSelectChannel(channel.channelId)}
        />
      </CreateDialog>

      <ScrollArea className="flex-1 h-full overflow-hidden bg-[#ffe135]">
        <div className="flex flex-col items-start gap-2 p-3">
          {machines.length === 0 && channels.length === 0 && (
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
            const selectedAgentId = selectedConversation?.threadKind === "direct"
              ? (selectedConversation.agentId ?? null)
              : null;

            return (
              <div key={machine.nodeId}>
                {/* Machine row */}
                <button
                  type="button"
                  className="group flex w-full max-w-full items-center gap-1.5 rounded-md border-2 border-zinc-900 bg-[#fff8d8] px-2.5 py-1.5 text-left shadow-[3px_3px_0_0_rgba(0,0,0,0.1)] transition-colors hover:bg-[#fff1a9] cursor-pointer"
                  onClick={() => toggleMachine(machine.nodeId)}
                >
                  {isExpanded
                    ? <ChevronDownIcon className="size-3 shrink-0 text-zinc-500" />
                    : <ChevronRightIcon className="size-3 shrink-0 text-zinc-500" />
                  }
                  <span className="flex items-center"><StatusDot status={machine.status} /></span>
                  <span className="min-w-0 flex-1 break-words text-xs font-medium leading-tight">{machine.name}</span>
                  {isAdmin && (
                    <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
                      <button
                        type="button"
                        className="rounded-sm p-0.5 hover:bg-[#ffe27a] cursor-pointer"
                        title="Add agent to this machine"
                        onClick={(e) => openCreateAgentDialog(machine.nodeId, e)}
                      >
                        <PlusIcon className="size-3 text-zinc-500" />
                      </button>
                      <button
                        type="button"
                        className="rounded-sm p-0.5 hover:bg-[#ffe27a] cursor-pointer"
                        title="Delete machine"
                        onClick={(e) => { e.stopPropagation(); handleOpenDeleteMachineDialog(machine); }}
                      >
                        <TrashIcon className="size-3 text-zinc-500 hover:text-destructive" />
                      </button>
                    </div>
                  )}
                </button>

                {/* Machine content */}
                {isExpanded && (
                  <div className="ml-3 mt-1 flex flex-col items-start gap-1">
                    {machineAgents.length === 0 && (
                      <p className="rounded-md border-2 border-dashed border-zinc-900/40 bg-[#fff8d8] px-2 py-2 text-[10px] text-zinc-500">
                        {isAdmin ? "No agents — click + to create one" : "No agents available"}
                      </p>
                    )}

                    {machineAgents.map((agent) => {
                      const primaryConversation = conversations.find(
                        (conversation) => conversation.agentId === agent.agentId && conversation.isPrimaryThread,
                      );

                      return (
                        <AgentRow
                          key={agent.agentId}
                          agent={agent}
                          isSelected={selectedAgentId === agent.agentId}
                          updatedAt={primaryConversation?.updatedAt ?? agent.updatedAt}
                          unreadCount={agentUnreadCounts[agent.agentId] ?? 0}
                          machineStatus={machine.status}
                          conversationStatus={primaryConversation?.status ?? null}
                          isAdmin={isAdmin}
                          onOpen={() => onOpenAgentThread(agent.agentId)}
                          onDelete={() => handleOpenDeleteDialog(agent)}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {/* Channels section */}
          <div className="mt-2 w-full">
            <div className="flex items-center justify-between px-0.5 py-2">
              <span className="text-xs font-bold uppercase tracking-wider text-zinc-800">
                Channels
              </span>
              {isAdmin && (
                <button
                  type="button"
                  className="rounded-sm border-2 border-zinc-900 bg-[#fff9d8] p-1 text-zinc-700 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#fff1a9] cursor-pointer transition-colors"
                  title="Create channel"
                  onClick={() => { setShowCreateChannel(true); }}
                >
                  <PlusIcon className="size-3" />
                </button>
              )}
            </div>

            {channels.length === 0 && (
              <p className="rounded-md border-2 border-dashed border-zinc-900/40 bg-[#fff8d8] px-2 py-2 text-[10px] text-zinc-500">
                {isAdmin ? "No channels — click + to create one" : "No channels available"}
              </p>
            )}

            {channels.map((channel) => (
              <div key={channel.channelId} className="mb-1 w-full">
                <ChannelRow
                  channel={channel}
                  isSelected={selectedChannelId === channel.channelId}
                  unreadCount={channelUnreadCounts[channel.channelId] ?? 0}
                  onSelect={() => onSelectChannel(channel.channelId)}
                />
              </div>
            ))}
          </div>

          {/* Humans section */}
          {users.length > 0 && (
            <div className="mt-2 w-full">
              <div className="px-0.5 py-2">
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-800">
                  Humans
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                {users.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setProfileUser(u)}
                    className="group flex w-full items-center gap-2 rounded-sm px-1.5 py-1.5 text-left text-xs text-zinc-700 transition-colors hover:bg-[#fff1a9] cursor-pointer"
                  >
                    <div className={[
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border',
                      u.id === currentUser?.id
                        ? 'border-zinc-700 bg-[#ffd54a] text-zinc-700'
                        : 'border-zinc-400 bg-zinc-100 text-zinc-500',
                    ].join(' ')}>
                      {u.isAdmin
                        ? <ShieldIcon className="size-2.5" />
                        : <UserIcon className="size-2.5" />
                      }
                    </div>
                    <span className="flex-1 truncate font-medium">{u.username}</span>
                    {u.id === currentUser?.id && (
                      <span className="shrink-0 text-[10px] text-zinc-400">you</span>
                    )}
                    {u.isAdmin && u.id !== currentUser?.id && (
                      <span className="shrink-0 text-[10px] text-zinc-400">admin</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <ConfirmDialog
        isOpen={deleteDialogOpen}
        title="Delete Agent"
        message={
          agentToDelete
            ? `Are you sure you want to delete "${agentToDelete.name}"? This will permanently delete all conversations, chat history, and session data associated with this agent. This action cannot be undone.`
            : ""
        }
        confirmText={isDeleting ? "Deleting..." : "Delete"}
        cancelText="Cancel"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />

      <ConfirmDialog
        isOpen={deleteMachineDialogOpen}
        title="Delete Machine"
        message={
          machineToDelete
            ? `Are you sure you want to delete the machine "${machineToDelete.name}"? This action cannot be undone and will disconnect the node.`
            : ""
        }
        confirmText={isDeleting ? "Deleting..." : "Delete"}
        cancelText="Cancel"
        variant="danger"
        onConfirm={handleConfirmDeleteMachine}
        onCancel={handleCancelDeleteMachine}
      />

      {/* User footer */}
      {currentUser && (
        <div className="flex items-center justify-between border-t-2 border-black bg-[#ffd700] px-3 py-2">
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            title="User settings"
            onClick={() => setShowUserSettings(true)}
          >
            <span className="truncate text-xs font-medium text-zinc-700">
              {currentUser.username}
              {currentUser.isAdmin && (
                <span className="ml-1 text-[10px] text-zinc-500">(admin)</span>
              )}
            </span>
          </button>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              className="p-1 rounded text-zinc-500 hover:text-zinc-800 transition-colors cursor-pointer"
              title="Settings"
              onClick={() => setShowUserSettings(true)}
            >
              <SettingsIcon className="size-3" />
            </button>
            {currentUser.isAdmin && (
              <button
                type="button"
                className="p-1 rounded text-zinc-500 hover:text-zinc-800 transition-colors cursor-pointer"
                title="Generate invite link"
                onClick={() => setShowInviteDialog(true)}
              >
                <LinkIcon className="size-3" />
              </button>
            )}
            {onLogout && (
              <button
                type="button"
                className="p-1 rounded text-zinc-500 hover:text-red-600 transition-colors cursor-pointer"
                title="Sign out"
                onClick={onLogout}
              >
                <LogOutIcon className="size-3" />
              </button>
            )}
          </div>
        </div>
      )}

      <InviteGenerateDialog
        isOpen={showInviteDialog}
        onClose={() => setShowInviteDialog(false)}
      />

      {currentUser && showUserSettings && (
        <UserSettingsPanel
          user={currentUser}
          onClose={() => setShowUserSettings(false)}
        />
      )}

      {profileUser && currentUser && (
        <HumanProfilePanel
          user={profileUser}
          currentUser={currentUser}
          onClose={() => setProfileUser(null)}
        />
      )}
    </div>
  );
}

// ─── AgentRow ───

type AgentRowProps = {
  agent: AgentInfo;
  isSelected: boolean;
  updatedAt: number;
  unreadCount: number;
  machineStatus: MachineInfo["status"] | null;
  conversationStatus: ConversationStatus | null;
  isAdmin: boolean;
  onOpen: () => void;
  onDelete: () => void;
};

// ─── ChannelRow ───

type ChannelRowProps = {
  channel: ChannelInfo;
  isSelected: boolean;
  unreadCount: number;
  onSelect: () => void;
};

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-sm border-2 border-zinc-900 bg-[#e85d75] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]">
      {count > 99 ? "99+" : count}
    </span>
  );
}

function ChannelRow({ channel, isSelected, unreadCount, onSelect }: ChannelRowProps) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md border-2 border-zinc-900 px-2.5 py-1.5 text-left shadow-[3px_3px_0_0_rgba(0,0,0,0.1)] transition-colors cursor-pointer",
        isSelected ? "bg-[#c4b5fd] text-zinc-950" : "bg-[#fff8d8] hover:bg-[#fff1a9]",
      )}
      onClick={onSelect}
    >
      <HashIcon className="size-3 shrink-0 text-zinc-500" />
      <span className="flex-1 break-words text-xs font-medium">{channel.name}</span>
      <UnreadBadge count={unreadCount} />
    </button>
  );
}

// ─── AgentRow ───

function AgentRow({ agent, isSelected, updatedAt, unreadCount, machineStatus, conversationStatus, isAdmin, onOpen, onDelete }: AgentRowProps) {
  return (
    <div className={cn(
      "group flex w-full items-center gap-1.5 rounded-md border-2 border-zinc-900 px-2 py-1.5 shadow-[3px_3px_0_0_rgba(0,0,0,0.1)]",
      isSelected ? "bg-[#c4b5fd] text-zinc-950" : "bg-[#fff8d8] hover:bg-[#fff1a9]",
    )}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left cursor-pointer"
        onClick={onOpen}
        title="Open private chat"
      >
        <AgentStatusDot machineStatus={machineStatus} conversationStatus={conversationStatus} />
        <ChatAvatar role="assistant" agent={agent} size={24} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <div className="min-w-0 truncate text-xs font-medium">{agent.name}</div>
            <div className="shrink-0 text-[10px] text-zinc-400">{formatRelativeTime(updatedAt)}</div>
          </div>
          {agent.description && (
            <div className="truncate text-[10px] text-zinc-500">{agent.description}</div>
          )}
        </div>
      </button>
      <div className="flex items-center gap-1 shrink-0">
        <UnreadBadge count={unreadCount} />
        {isAdmin && (
          <button
            type="button"
            className={cn(
              "p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer",
              "text-zinc-500 hover:text-red-600",
            )}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete agent"
          >
            <TrashIcon className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}
