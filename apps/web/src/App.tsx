import { useMemo, useCallback } from "react";
import { useConversations } from "@/hooks/useConversations";
import { useAgents } from "@/hooks/useAgents";
import { useMachines } from "@/hooks/useMachines";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { ChatPanel } from "@/features/chat/ChatPanel";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import type {
  CreateConversationRequest,
  CreateAgentRequest,
  UpdateAgentRequest,
} from "@agent-collab/protocol";

export function App() {
  const {
    conversations,
    selectedId,
    loading,
    createConversation,
    deleteConversation,
    selectConversation,
  } = useConversations();

  const { agents, createAgent, updateAgent, deleteAgent } = useAgents();
  const { machines, createMachine, deleteMachine } = useMachines();

  const selectedConversation = useMemo(
    () => conversations.find((c) => c.id === selectedId),
    [conversations, selectedId],
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

  const handleCreateConversation = useCallback(
    (req: CreateConversationRequest) => {
      createConversation(req);
    },
    [createConversation],
  );

  const handleDeleteConversation = useCallback(
    (id: string) => {
      deleteConversation(id);
    },
    [deleteConversation],
  );

  return (
    <div className="flex h-full bg-background text-foreground">
      <ResizablePanelGroup direction="horizontal" className="h-full">
        {/* Sidebar */}
        <ResizablePanel
          defaultSize={25}
          minSize={15}
          maxSize={40}
          className="bg-sidebar text-sidebar-foreground"
        >
          <Sidebar
            machines={machines}
            agents={agents}
            conversations={conversations}
            selectedId={selectedId}
            onSelect={selectConversation}
            onCreateMachine={createMachine}
            onDeleteMachine={deleteMachine}
            onCreateAgent={handleCreateAgent}
            onUpdateAgent={handleUpdateAgent}
            onDeleteAgent={handleDeleteAgent}
            onCreateConversation={handleCreateConversation}
            onDeleteConversation={handleDeleteConversation}
          />
        </ResizablePanel>

        <ResizableHandle />

        {/* Chat area */}
        <ResizablePanel defaultSize={75} minSize={50}>
          {selectedConversation ? (
            <ChatPanel conversation={selectedConversation} />
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
