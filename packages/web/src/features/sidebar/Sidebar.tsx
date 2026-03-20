import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { PlusIcon, TrashIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";
import type { ConversationInfo, AgentType, CreateConversationRequest } from "@agent-collab/wire-types";

type SidebarProps = {
  conversations: ConversationInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (req: CreateConversationRequest) => void;
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
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [agentType, setAgentType] = useState<AgentType>("claude_acp");
  // 环境变量列表，每项为 [key, value]
  const [envPairs, setEnvPairs] = useState<[string, string][]>([]);

  const addEnvPair = useCallback(() => {
    setEnvPairs((prev) => [...prev, ["", ""]]);
  }, []);

  const removeEnvPair = useCallback((index: number) => {
    setEnvPairs((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateEnvPair = useCallback(
    (index: number, field: 0 | 1, value: string) => {
      setEnvPairs((prev) => {
        const next = [...prev];
        next[index] = [...next[index]] as [string, string];
        next[index][field] = value;
        return next;
      });
    },
    [],
  );

  const handleCreate = useCallback(() => {
    // 将非空 key 的 env pairs 转为 Record
    const envVars: Record<string, string> = {};
    for (const [k, v] of envPairs) {
      const key = k.trim();
      if (key) envVars[key] = v;
    }
    onCreate({
      agentType,
      envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    // 重置表单
    setShowCreateForm(false);
    setEnvPairs([]);
  }, [agentType, envPairs, onCreate]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-3">
        <h1 className="text-sm font-semibold">Conversations</h1>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => setShowCreateForm(!showCreateForm)}
          title="New conversation"
        >
          <PlusIcon className="size-4" />
        </Button>
      </div>

      {/* 创建会话表单 */}
      {showCreateForm && (
        <div className="border-b border-sidebar-border px-3 py-2 space-y-2">
          {/* Agent 类型选择 */}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={agentType === "claude_acp" ? "default" : "outline"}
              className="flex-1 text-xs"
              onClick={() => setAgentType("claude_acp")}
            >
              Claude ACP
            </Button>
            <Button
              size="sm"
              variant={agentType === "codex_acp" ? "default" : "outline"}
              className="flex-1 text-xs"
              onClick={() => setAgentType("codex_acp")}
            >
              Codex ACP
            </Button>
          </div>

          {/* 环境变量编辑 */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Env Vars</span>
              <Button size="icon-xs" variant="ghost" onClick={addEnvPair} title="Add env var">
                <PlusIcon className="size-3" />
              </Button>
            </div>
            {envPairs.map(([k, v], i) => (
              <div key={i} className="flex items-center gap-1">
                <input
                  className="flex-1 min-w-0 rounded border border-input bg-background px-1.5 py-0.5 text-xs placeholder:text-muted-foreground"
                  placeholder="KEY"
                  value={k}
                  onChange={(e) => updateEnvPair(i, 0, e.target.value)}
                />
                <span className="text-xs text-muted-foreground">=</span>
                <input
                  className="flex-1 min-w-0 rounded border border-input bg-background px-1.5 py-0.5 text-xs placeholder:text-muted-foreground"
                  placeholder="value"
                  value={v}
                  onChange={(e) => updateEnvPair(i, 1, e.target.value)}
                />
                <button
                  type="button"
                  className="shrink-0 p-0.5 text-muted-foreground hover:text-destructive cursor-pointer"
                  onClick={() => removeEnvPair(i)}
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
          </div>

          {/* 创建按钮 */}
          <Button size="sm" className="w-full text-xs" onClick={handleCreate}>
            Create
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
