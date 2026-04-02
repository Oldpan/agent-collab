import { useMemo, useCallback, useState, useEffect } from "react";
import { useConversations } from "@/hooks/useConversations";
import { useAgents } from "@/hooks/useAgents";
import { useMachines } from "@/hooks/useMachines";
import { useChannels } from "@/hooks/useChannels";
import { useUnreadBadges } from "@/hooks/useUnreadBadges";
import { useAuth } from "@/hooks/useAuth";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { ChannelPanel } from "@/features/channel/ChannelPanel";
import { SessionManagerPanel } from "@/features/sessions/SessionManagerPanel";
import { LoginPanel } from "@/features/auth/LoginPanel";
import { SetupPanel } from "@/features/auth/SetupPanel";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import type {
  CreateAgentRequest,
  UpdateAgentRequest,
} from "@agent-collab/protocol";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 768,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isMobile;
}

// Extract invite token from URL query param
function getInviteTokenFromUrl(): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  return params.get('invite') ?? '';
}

export function App() {
  const isMobile = useIsMobile();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"chat" | "sessions">("chat");
  const { user, isAuthenticated, isLoading, hasAdmin, checkAuth, checkSetupStatus, doLogout } = useAuth();

  // On mount: check setup status and auth token
  useEffect(() => {
    checkSetupStatus().then(() => checkAuth());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // All hooks must be called unconditionally (Rules of Hooks)
  const {
    conversations,
    selectedId,
    loading,
    openAgentThread,
    selectConversation,
  } = useConversations(user?.id);

  const { agents, createAgent, updateAgent, deleteAgent, refreshAgents } = useAgents();
  const { machines, createMachine, deleteMachine } = useMachines();
  const { channels, createChannel, updateChannel: updateChannelInStore } = useChannels();
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  const visibleConversations = useMemo(() => {
    const agentIds = new Set(agents.map((agent) => agent.agentId));
    return conversations.filter(
      (conversation) => conversation.agentId && agentIds.has(conversation.agentId),
    );
  }, [agents, conversations]);

  const selectedConversation = useMemo(
    () => visibleConversations.find((c) => c.id === selectedId),
    [visibleConversations, selectedId],
  );
  const selectedAgent = useMemo(
    () => {
      if (!selectedConversation?.agentId) return null;
      return agents.find((agent) => agent.agentId === selectedConversation.agentId) ?? null;
    },
    [agents, selectedConversation?.agentId],
  );

  useEffect(() => {
    if (!selectedId) return;
    if (visibleConversations.some((conversation) => conversation.id === selectedId)) return;
    selectConversation(null);
  }, [selectConversation, selectedId, visibleConversations]);

  const handleCreateAgent = useCallback(
    (req: CreateAgentRequest) => {
      createAgent(req);
    },
    [createAgent],
  );

  const handleUpdateAgent = useCallback(
    async (id: string, req: UpdateAgentRequest) => {
      await updateAgent(id, req);
    },
    [updateAgent],
  );

  const handleDeleteAgent = useCallback(
    (id: string) => {
      deleteAgent(id);
    },
    [deleteAgent],
  );

  const handleRestartAgent = useCallback(
    async (agentId: string) => {
      await api.restartAgent(agentId);
    },
    [],
  );

  const handleClearAgentChat = useCallback(
    async (agentId: string) => {
      await api.clearAgentChat(agentId);
      await openAgentThread(agentId);
      setViewMode("chat");
    },
    [openAgentThread],
  );

  const handleResetAgent = useCallback(
    async (agentId: string) => {
      await api.resetAgent(agentId);
      await openAgentThread(agentId);
      setViewMode("chat");
    },
    [openAgentThread],
  );

  const handleOpenAgentThread = useCallback(
    (agentId: string) => {
      openAgentThread(agentId);
      setSelectedChannelId(null);
      setViewMode("chat");
    },
    [openAgentThread],
  );

  const handleSelectConversation = useCallback(
    (id: string) => {
      selectConversation(id);
      setSelectedChannelId(null);
      setViewMode("chat");
    },
    [selectConversation],
  );

  const handleSelectChannel = useCallback(
    (channelId: string) => {
      setSelectedChannelId(channelId);
      selectConversation(null);
      setViewMode("chat");
    },
    [selectConversation],
  );

  const handleOpenSessions = useCallback(() => {
    setViewMode("sessions");
  }, []);

  const selectedChannel = useMemo(
    () => channels.find((c) => c.channelId === selectedChannelId) ?? null,
    [channels, selectedChannelId],
  );

  const activeAgentId = viewMode === "chat" ? (selectedAgent?.agentId ?? null) : null;
  const activeChannelId = viewMode === "chat" ? selectedChannelId : null;
  const {
    agentUnreadCounts,
    channelUnreadCounts,
    markAgentReadUpTo,
    markChannelReadUpTo,
  } = useUnreadBadges({
    agents,
    channels,
    activeAgentId,
    activeChannelId,
  });

  const handleChannelSeenSeq = useCallback(
    (seq: number) => {
      if (!selectedChannel) return;
      markChannelReadUpTo(selectedChannel.channelId, seq);
    },
    [markChannelReadUpTo, selectedChannel],
  );

  const handleConversationSeenSeq = useCallback(
    (seq: number) => {
      if (!selectedAgent?.agentId) return;
      markAgentReadUpTo(selectedAgent.agentId, seq);
    },
    [markAgentReadUpTo, selectedAgent],
  );

  const sidebarProps = {
    machines,
    agents,
    conversations: visibleConversations,
    channels,
    agentUnreadCounts: viewMode === "chat" && selectedAgent?.agentId
      ? { ...agentUnreadCounts, [selectedAgent.agentId]: 0 }
      : agentUnreadCounts,
    channelUnreadCounts: viewMode === "chat" && selectedChannelId
      ? { ...channelUnreadCounts, [selectedChannelId]: 0 }
      : channelUnreadCounts,
    selectedId,
    selectedChannelId,
    selectedView: viewMode,
    currentUser: user,
    onOpenSessions: handleOpenSessions,
    onCreateMachine: createMachine,
    onDeleteMachine: deleteMachine,
    onCreateAgent: handleCreateAgent,
    onDeleteAgent: handleDeleteAgent,
    onOpenAgentThread: handleOpenAgentThread,
    onSelectChannel: handleSelectChannel,
    onCreateChannel: createChannel,
    onLogout: doLogout,
  };

  // Auth gates — placed after all hooks
  if (isLoading || hasAdmin === null) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-50">
        <div className="text-sm text-zinc-400">Loading...</div>
      </div>
    );
  }

  const inviteToken = getInviteTokenFromUrl();

  // First-time setup (no admin yet) OR invite link opened by unauthenticated user
  if (!hasAdmin || (inviteToken && !isAuthenticated)) {
    return <SetupPanel initialToken={inviteToken} />;
  }

  if (!isAuthenticated) {
    return <LoginPanel />;
  }

  return (
    <div className="flex h-full bg-[#e8dcc8] text-foreground">
      {/* Mobile: backdrop */}
      {isMobile && mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      {/* Mobile: sidebar drawer */}
      {isMobile && (
        <div
          className={cn(
            "fixed inset-y-0 left-0 z-50 w-72 transition-transform duration-300",
            mobileSidebarOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <Sidebar {...sidebarProps} />
        </div>
      )}

      <ResizablePanelGroup direction="horizontal" className="h-full">
        {/* Desktop sidebar */}
        {!isMobile && (
          <>
            <ResizablePanel
              defaultSize={25}
              minSize={14}
              maxSize={20}
              className="bg-[#ffe135] text-zinc-950 shadow-[4px_0_0_0_rgba(0,0,0,0.3)]"
            >
              <Sidebar {...sidebarProps} />
            </ResizablePanel>
            <ResizableHandle />
          </>
        )}

        {/* Chat area */}
        <ResizablePanel defaultSize={isMobile ? 100 : 75} minSize={50}>
          {viewMode === "sessions" ? (
            <SessionManagerPanel
              conversations={visibleConversations}
              agents={agents}
              selectedId={selectedId}
              onOpenSession={handleSelectConversation}
              onOpenSidebar={isMobile ? () => setMobileSidebarOpen(true) : undefined}
            />
          ) : selectedChannel ? (
            <ChannelPanel
              channel={selectedChannel}
              agents={agents}
              isAdmin={user?.isAdmin ?? false}
              onAgentsUpdated={refreshAgents}
              onSeenSeq={handleChannelSeenSeq}
              onChannelUpdated={updateChannelInStore}
              onOpenSidebar={isMobile ? () => setMobileSidebarOpen(true) : undefined}
            />
          ) : selectedConversation ? (
            <ChatPanel
              conversation={selectedConversation}
              agent={selectedAgent}
              isAdmin={user?.isAdmin ?? false}
              onSeenSeq={handleConversationSeenSeq}
              onOpenSidebar={isMobile ? () => setMobileSidebarOpen(true) : undefined}
              onUpdateAgent={handleUpdateAgent}
              onRestartAgent={handleRestartAgent}
              onClearAgentChat={handleClearAgentChat}
              onResetAgent={handleResetAgent}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <div className="text-center space-y-2">
                <p className="text-lg font-medium">
                  {loading ? "Loading..." : "Select or create a conversation"}
                </p>
                {!loading && (
                  <p className="text-sm">
                    Create an agent in the sidebar to get started
                  </p>
                )}
              </div>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
