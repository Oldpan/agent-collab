import { useMemo, useCallback, useState, useEffect } from "react";
import { useConversations } from "@/hooks/useConversations";
import { useAgents } from "@/hooks/useAgents";
import { useMachines } from "@/hooks/useMachines";
import { useChannels } from "@/hooks/useChannels";
import { useResourceSpaces } from "@/hooks/useResourceSpaces";
import { useUnreadBadges } from "@/hooks/useUnreadBadges";
import { useRecentMessages } from "@/hooks/useRecentMessages";
import { useAuth } from "@/hooks/useAuth";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { ChannelPanel } from "@/features/channel/ChannelPanel";
import { SessionManagerPanel } from "@/features/sessions/SessionManagerPanel";
import { SearchPanel } from "@/features/search/SearchPanel";
import { ResourcesPanel } from "@/features/resources/ResourcesPanel";
import { RecentMessagesPanel } from "@/features/recent/RecentMessagesPanel";
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
  RecentMessageSourceItem,
} from "@agent-collab/protocol";
import * as api from "@/lib/api";
import type { AgentTask, SearchMessageHit } from "@/lib/api";
import { cn } from "@/lib/utils";

type SearchFocusTarget = {
  channelId: string;
  messageId: string;
  threadRootId: string | null;
  requestId: number;
};

type ChannelTaskContextAgent = {
  agentId: string;
  name: string;
};

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
  const [viewMode, setViewMode] = useState<"chat" | "recent" | "sessions" | "search" | "resources">("chat");
  const [lastNonResourceView, setLastNonResourceView] = useState<"chat" | "recent" | "sessions" | "search">("chat");
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
    openAgentChannelSession,
    selectConversation,
    upsertConversation,
    refreshConversations,
  } = useConversations(user?.id);

  const { agents, createAgent, updateAgent, deleteAgent, refreshAgents } = useAgents();
  const { machines, createMachine, deleteMachine } = useMachines();
  const { channels, createChannel, updateChannel: updateChannelInStore } = useChannels();
  const { resourceSpaces, createResourceSpace, deleteResourceSpace } = useResourceSpaces();
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [searchFocusTarget, setSearchFocusTarget] = useState<SearchFocusTarget | null>(null);
  const [channelTaskContextAgent, setChannelTaskContextAgent] = useState<ChannelTaskContextAgent | null>(null);

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
    if (viewMode !== "resources") {
      setLastNonResourceView(viewMode);
    }
  }, [viewMode]);

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

  const handleRestartConversation = useCallback(
    async (conversationId: string) => {
      const result = await api.restartConversation(conversationId);
      upsertConversation(result.conversation, { select: selectedId === conversationId });
    },
    [selectedId, upsertConversation],
  );

  const handleClearConversationChat = useCallback(
    async (conversationId: string) => {
      const result = await api.clearConversationChat(conversationId);
      upsertConversation(result.conversation, { select: selectedId === conversationId });
      setViewMode("chat");
    },
    [selectedId, upsertConversation],
  );

  const handleResetAgent = useCallback(
    async (agentId: string) => {
      const result = await api.resetAgent(agentId);
      for (const conversation of result.conversations) {
        upsertConversation(conversation);
      }
      await refreshConversations();
      setViewMode("chat");
    },
    [refreshConversations, upsertConversation],
  );

  const handleOpenAgentThread = useCallback(
    (agentId: string) => {
      const existingDirectConversation = conversations.find(
        (conversation) => conversation.agentId === agentId && conversation.threadKind === "direct" && conversation.isPrimaryThread,
      ) ?? null;
      selectConversation(existingDirectConversation?.id ?? null);
      void openAgentThread(agentId);
      setSelectedChannelId(null);
      setSearchFocusTarget(null);
      setChannelTaskContextAgent(null);
      setViewMode("chat");
    },
    [conversations, openAgentThread, selectConversation],
  );

  const handleEnsureAgentConversation = useCallback(
    async (agentId: string) => {
      const previousSelectedId = selectedId;
      const conversation = await openAgentThread(agentId);
      selectConversation(previousSelectedId);
      return conversation;
    },
    [openAgentThread, selectConversation, selectedId],
  );

  const handleOpenAgentChannelSession = useCallback(
    async (agentId: string, channelId: string, threadRootId?: string | null) => {
      const previousSelectedId = selectedId;
      const conversation = await openAgentChannelSession(agentId, channelId, threadRootId);
      selectConversation(previousSelectedId);
      setSelectedChannelId(channelId);
      setSearchFocusTarget(null);
      setChannelTaskContextAgent({ agentId, name: agents.find((item) => item.agentId === agentId)?.name ?? "Agent" });
      setViewMode("chat");
      return conversation;
    },
    [agents, openAgentChannelSession, selectConversation, selectedId],
  );

  const handleSelectConversation = useCallback(
    (id: string) => {
      selectConversation(id);
      setSelectedChannelId(null);
      setSearchFocusTarget(null);
      setChannelTaskContextAgent(null);
      setViewMode("chat");
    },
    [selectConversation],
  );

  const handleSelectChannel = useCallback(
    (channelId: string) => {
      setSelectedChannelId(channelId);
      selectConversation(null);
      setSearchFocusTarget(null);
      setChannelTaskContextAgent(null);
      setViewMode("chat");
    },
    [selectConversation],
  );

  const handleOpenSearch = useCallback(() => {
    setViewMode("search");
    setMobileSidebarOpen(false);
  }, []);

  const handleOpenRecent = useCallback(() => {
    setViewMode("recent");
    setMobileSidebarOpen(false);
  }, []);

  const handleOpenResources = useCallback(() => {
    setViewMode("resources");
    setMobileSidebarOpen(false);
  }, []);

  const handleExitResources = useCallback(() => {
    setViewMode(lastNonResourceView);
    setMobileSidebarOpen(false);
  }, [lastNonResourceView]);

  const handleOpenSessions = useCallback(() => {
    setViewMode("sessions");
  }, []);

  const handleOpenSearchResult = useCallback((result: SearchMessageHit) => {
    setSearchFocusTarget({
      channelId: result.channelId,
      messageId: result.messageId,
      threadRootId: result.threadRootId ?? null,
      requestId: Date.now(),
    });
    setSelectedChannelId(result.channelId);
    selectConversation(null);
    setChannelTaskContextAgent(null);
    setViewMode("chat");
    setMobileSidebarOpen(false);
  }, [selectConversation]);

  const handleOpenAgentTask = useCallback((agent: { agentId: string; name: string }, task: AgentTask) => {
    if (task.sourceType === "dm") {
      const existingDirectConversation = conversations.find(
        (conversation) => conversation.agentId === agent.agentId && conversation.threadKind === "direct" && conversation.isPrimaryThread,
      ) ?? null;
      selectConversation(existingDirectConversation?.id ?? null);
      void openAgentThread(agent.agentId);
      setSelectedChannelId(null);
      setSearchFocusTarget(null);
      setChannelTaskContextAgent(null);
      setViewMode("chat");
      setMobileSidebarOpen(false);
      return;
    }

    setSelectedChannelId(task.channelId);
    selectConversation(null);
    setChannelTaskContextAgent({ agentId: agent.agentId, name: agent.name });
    setSearchFocusTarget(task.messageId ? {
      channelId: task.channelId,
      messageId: task.messageId,
      threadRootId: task.linkedThreadShortId ?? null,
      requestId: Date.now(),
    } : null);
    setViewMode("chat");
    setMobileSidebarOpen(false);
  }, [conversations, openAgentThread, selectConversation]);

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

  const {
    items: recentItems,
    totalUnreadCount: recentUnreadCount,
    refresh: refreshRecentMessages,
    markSourceReadUpTo,
  } = useRecentMessages({
    markAgentReadUpTo,
    markChannelReadUpTo,
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
    recentUnreadCount,
    selectedId,
    selectedChannelId,
    selectedView: viewMode,
    currentUser: user,
    onOpenRecent: handleOpenRecent,
    onOpenSearch: handleOpenSearch,
    onOpenResources: handleOpenResources,
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

  const handleOpenRecentOriginal = useCallback(async (source: RecentMessageSourceItem) => {
    if (source.sourceType === "dm" && source.agentId) {
      await openAgentThread(source.agentId);
      setSelectedChannelId(null);
      setSearchFocusTarget(null);
      setChannelTaskContextAgent(null);
      setViewMode("chat");
      setMobileSidebarOpen(false);
      return;
    }

    if ((source.sourceType === "thread" || source.sourceType === "task") && source.channelId.startsWith("dm:") && source.agentId && source.threadRootId) {
      const primaryConversation = await openAgentThread(source.agentId);
      const threadConversation = await api.openConversationThread(primaryConversation.id, {
        threadRootId: source.threadRootId,
      });
      upsertConversation(threadConversation, { select: true });
      setSelectedChannelId(null);
      setSearchFocusTarget(null);
      setChannelTaskContextAgent(null);
      setViewMode("chat");
      setMobileSidebarOpen(false);
      return;
    }

    if (source.sourceType === "channel") {
      setSelectedChannelId(source.channelId);
      selectConversation(null);
      setSearchFocusTarget(null);
      setChannelTaskContextAgent(null);
      setViewMode("chat");
      setMobileSidebarOpen(false);
      return;
    }

    if ((source.sourceType === "thread" || source.sourceType === "task") && source.threadRootId) {
      setSelectedChannelId(source.channelId);
      selectConversation(null);
      setSearchFocusTarget({
        channelId: source.channelId,
        messageId: source.latestMessageId,
        threadRootId: source.threadRootId,
        requestId: Date.now(),
      });
      setChannelTaskContextAgent(null);
      setViewMode("chat");
      setMobileSidebarOpen(false);
    }
  }, [openAgentThread, selectConversation, upsertConversation]);

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

  const mainContent = viewMode === "recent" ? (
    <RecentMessagesPanel
      items={recentItems}
      totalUnreadCount={recentUnreadCount}
      onRefresh={refreshRecentMessages}
      onMarkSourceRead={markSourceReadUpTo}
      onOpenOriginal={handleOpenRecentOriginal}
      onOpenSidebar={isMobile ? () => setMobileSidebarOpen(true) : undefined}
    />
  ) : viewMode === "sessions" ? (
    <SessionManagerPanel
      conversations={visibleConversations}
      agents={agents}
      selectedId={selectedId}
      onOpenSession={handleSelectConversation}
      onOpenSidebar={isMobile ? () => setMobileSidebarOpen(true) : undefined}
    />
  ) : viewMode === "search" ? (
    <SearchPanel
      onOpenResult={handleOpenSearchResult}
      onClose={() => setViewMode("chat")}
      onOpenSidebar={isMobile ? () => setMobileSidebarOpen(true) : undefined}
    />
  ) : viewMode === "resources" ? (
    <ResourcesPanel
      resourceSpaces={resourceSpaces}
      channels={channels}
      agents={agents}
      conversations={visibleConversations}
      machines={machines}
      isAdmin={user?.isAdmin ?? false}
      onToggleSidebar={isMobile ? () => setMobileSidebarOpen(true) : undefined}
      onExitResources={handleExitResources}
      onCreateResourceSpace={createResourceSpace}
      onDeleteResourceSpace={deleteResourceSpace}
      onOpenAgentThread={handleOpenAgentThread}
      onEnsureAgentConversation={handleEnsureAgentConversation}
      onOpenConversation={(conversation) => {
        upsertConversation(conversation, { select: true });
        setSelectedChannelId(null);
        setSearchFocusTarget(null);
        setChannelTaskContextAgent(null);
        setViewMode("chat");
      }}
    />
  ) : selectedChannel ? (
    <ChannelPanel
      channel={selectedChannel}
      agents={agents}
      isAdmin={user?.isAdmin ?? false}
      onAgentsUpdated={refreshAgents}
      onOpenAgentSession={handleOpenAgentChannelSession}
      onRestartConversation={handleRestartConversation}
      onClearConversationChat={handleClearConversationChat}
      onSeenSeq={handleChannelSeenSeq}
      onChannelUpdated={updateChannelInStore}
      onOpenSidebar={isMobile ? () => setMobileSidebarOpen(true) : undefined}
      focusMessageId={searchFocusTarget?.channelId === selectedChannel.channelId ? searchFocusTarget.messageId : null}
      focusRequestId={searchFocusTarget?.channelId === selectedChannel.channelId ? searchFocusTarget.requestId : null}
      initialThreadRootId={searchFocusTarget?.channelId === selectedChannel.channelId ? searchFocusTarget.threadRootId : null}
      currentTaskAgentId={channelTaskContextAgent?.agentId ?? null}
      currentTaskAgentName={channelTaskContextAgent?.name ?? null}
    />
  ) : selectedConversation ? (
    <ChatPanel
      conversation={selectedConversation}
      agent={selectedAgent}
      isAdmin={user?.isAdmin ?? false}
      onSeenSeq={handleConversationSeenSeq}
      onOpenSidebar={isMobile ? () => setMobileSidebarOpen(true) : undefined}
      onUpdateAgent={handleUpdateAgent}
      onRestartConversation={handleRestartConversation}
      onClearConversationChat={handleClearConversationChat}
      onResetAgent={handleResetAgent}
      onOpenTask={(task) => {
        if (!selectedAgent) return;
        handleOpenAgentTask(selectedAgent, task);
      }}
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
  );

  const showDesktopSidebar = !isMobile && viewMode !== "resources";

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

      {showDesktopSidebar ? (
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel
            defaultSize={18}
            minSize={14}
            maxSize={20}
            className="min-w-0 overflow-hidden bg-[#ffe135] text-zinc-950 shadow-[4px_0_0_0_rgba(0,0,0,0.3)]"
          >
            <Sidebar {...sidebarProps} />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={75} minSize={50} className="min-w-0 overflow-hidden">
            {mainContent}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="min-w-0 flex-1">
          {mainContent}
        </div>
      )}
    </div>
  );
}
