import { useMemo, useCallback, useState } from "react";
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

export function App() {
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

  return (
    <div className="flex h-full bg-[linear-gradient(180deg,#fff4a0_0%,#ffe07a_100%)] text-foreground">
      <ResizablePanelGroup direction="horizontal" className="h-full">
        {/* Sidebar */}
        <ResizablePanel
          defaultSize={25}
          minSize={15}
          maxSize={40}
          className="bg-[linear-gradient(180deg,#ffe98d_0%,#ffd45e_100%)] text-zinc-950"
        >
          <Sidebar
            machines={machines}
            agents={agents}
            conversations={conversations}
            selectedId={selectedId}
            selectedView={viewMode}
            onOpenSessions={handleOpenSessions}
            onCreateMachine={createMachine}
            onDeleteMachine={deleteMachine}
            onCreateAgent={handleCreateAgent}
            onUpdateAgent={handleUpdateAgent}
            onDeleteAgent={handleDeleteAgent}
            onOpenAgentThread={handleOpenAgentThread}
          />
        </ResizablePanel>

        <ResizableHandle />

        {/* Chat area */}
        <ResizablePanel defaultSize={75} minSize={50}>
          {viewMode === "sessions" ? (
            <SessionManagerPanel
              conversations={conversations}
              agents={agents}
              selectedId={selectedId}
              onOpenSession={handleSelectConversation}
            />
          ) : selectedConversation ? (
            <ChatPanel conversation={selectedConversation} agent={selectedAgent} />
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
