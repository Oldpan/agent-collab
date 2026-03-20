import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { PlusIcon, TrashIcon } from "lucide-react";
import { useCallback, useState } from "react";
import type { ConversationInfo, AgentType } from "@agent-collab/wire-types";

type SidebarProps = {
  conversations: ConversationInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (agentType: AgentType) => void;
  onDelete: (id: string) => void;
};

/** Format timestamp to relative time string */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Sidebar with conversation list and create button */
export function Sidebar({
  conversations,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
}: SidebarProps) {
  const [showAgentPicker, setShowAgentPicker] = useState(false);

  const handleCreate = useCallback(
    (agentType: AgentType) => {
      onCreate(agentType);
      setShowAgentPicker(false);
    },
    [onCreate],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-3">
        <h1 className="text-sm font-semibold">Conversations</h1>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => setShowAgentPicker(!showAgentPicker)}
          title="New conversation"
        >
          <PlusIcon className="size-4" />
        </Button>
      </div>

      {/* Agent type picker */}
      {showAgentPicker && (
        <div className="flex gap-2 border-b border-sidebar-border px-3 py-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1 text-xs"
            onClick={() => handleCreate("claude_acp")}
          >
            Claude ACP
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1 text-xs"
            onClick={() => handleCreate("codex_acp")}
          >
            Codex ACP
          </Button>
        </div>
      )}

      {/* Conversation list */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-0.5 p-2">
          {conversations.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No conversations yet
            </p>
          ) : (
            conversations.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isSelected={conv.id === selectedId}
                onSelect={onSelect}
                onDelete={onDelete}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

type ConversationItemProps = {
  conversation: ConversationInfo;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
};

function ConversationItem({
  conversation,
  isSelected,
  onSelect,
  onDelete,
}: ConversationItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (confirmDelete) {
        onDelete(conversation.id);
        setConfirmDelete(false);
      } else {
        setConfirmDelete(true);
        // Auto-reset after 3 seconds
        setTimeout(() => setConfirmDelete(false), 3000);
      }
    },
    [confirmDelete, conversation.id, onDelete],
  );

  return (
    <button
      type="button"
      className={cn(
        "group flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors cursor-pointer",
        isSelected
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/50 text-foreground",
      )}
      onClick={() => onSelect(conversation.id)}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">
            {conversation.title || "Untitled"}
          </span>
          <Badge variant="secondary" className="text-[10px] px-1 py-0 shrink-0">
            {conversation.agentType === "claude_acp" ? "Claude" : "Codex"}
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground">
          {formatRelativeTime(conversation.updatedAt)}
        </span>
      </div>

      <button
        type="button"
        className={cn(
          "shrink-0 mt-0.5 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer",
          confirmDelete
            ? "text-destructive opacity-100"
            : "text-muted-foreground hover:text-destructive",
        )}
        onClick={handleDelete}
        title={confirmDelete ? "Click again to confirm" : "Delete"}
      >
        <TrashIcon className="size-3.5" />
      </button>
    </button>
  );
}
