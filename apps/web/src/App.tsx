import { useMemo, useCallback } from "react";
import { useConversations } from "@/hooks/useConversations";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { ChatPanel } from "@/features/chat/ChatPanel";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import type { CreateConversationRequest } from "@agent-collab/protocol";

export function App() {
  const {
    conversations,
    selectedId,
    loading,
    createConversation,
    deleteConversation,
    selectConversation,
  } = useConversations();

  const selectedConversation = useMemo(
    () => conversations.find((c) => c.id === selectedId),
    [conversations, selectedId],
  );

  const handleCreate = useCallback(
    (req: CreateConversationRequest) => {
      createConversation(req);
    },
    [createConversation],
  );

  const handleDelete = useCallback(
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
            conversations={conversations}
            selectedId={selectedId}
            onSelect={selectConversation}
            onCreate={handleCreate}
            onDelete={handleDelete}
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
                    Use the + button in the sidebar to start
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
