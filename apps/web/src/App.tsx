import { useMemo, useCallback, useState, useEffect } from "react";
import { useConversations } from "@/hooks/useConversations";
import { useAgents } from "@/hooks/useAgents";
import { useMachines } from "@/hooks/useMachines";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { SessionManagerPanel } from "@/features/sessions/SessionManagerPanel";
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

export function App() {
  const isMobile = useIsMobile();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"chat" | "sessions">("chat");
  const {
    conversations,
    selectedId,
    loading,
    openAgentThread,
    selectConversation,
  } = useConversations();

  const { agents, createAgent, updateAgent, deleteAgent } = useAgents();
  const { machines, createMachine, deleteMachine } = useMachines();

  const selectedConversation = useMemo(
    () => conversations.find((c) => c.id === selectedId),
    [conversations, selectedId],
  );
  const selectedAgent = useMemo(
    () => {
      if (!selectedConversation?.agentId) return null;
      return agents.find((agent) => agent.agentId === selectedConversation.agentId) ?? null;
    },
    [agents, selectedConversation?.agentId],
  );

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
      setViewMode("chat");
    },
    [openAgentThread],
  );

  const handleSelectConversation = useCallback(
    (id: string) => {
      selectConversation(id);
      setViewMode("chat");
    },
    [selectConversation],
  );

  const handleOpenSessions = useCallback(() => {
    setViewMode("sessions");
  }, []);

  const sidebarProps = {
    machines,
    agents,
    conversations,
    selectedId,
    selectedView: viewMode,
    onOpenSessions: handleOpenSessions,
    onCreateMachine: createMachine,
    onDeleteMachine: deleteMachine,
    onCreateAgent: handleCreateAgent,
    onUpdateAgent: handleUpdateAgent,
    onRestartAgent: handleRestartAgent,
    onClearAgentChat: handleClearAgentChat,
    onResetAgent: handleResetAgent,
    onDeleteAgent: handleDeleteAgent,
    onOpenAgentThread: handleOpenAgentThread,
  };

  return (
    <div className="flex h-full bg-[linear-gradient(180deg,#fff4a0_0%,#ffe07a_100%)] text-foreground">
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
              minSize={15}
              maxSize={40}
              className="bg-[linear-gradient(180deg,#ffe06d_0%,#ffca43_100%)] text-zinc-950"
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
              conversations={conversations}
              agents={agents}
              selectedId={selectedId}
              onOpenSession={handleSelectConversation}
              onOpenSidebar={isMobile ? () => setMobileSidebarOpen(true) : undefined}
            />
          ) : selectedConversation ? (
            <ChatPanel
              conversation={selectedConversation}
              agent={selectedAgent}
              onOpenSidebar={isMobile ? () => setMobileSidebarOpen(true) : undefined}
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
