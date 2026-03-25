import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { MenuIcon } from "lucide-react";
import type { AgentInfo, ConversationInfo } from "@agent-collab/protocol";

type SessionManagerPanelProps = {
  conversations: ConversationInfo[];
  agents: AgentInfo[];
  selectedId: string | null;
  onOpenSession: (conversationId: string) => void;
  onOpenSidebar?: () => void;
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

function statusTone(status: ConversationInfo["status"]): string {
  switch (status) {
    case "idle":
      return "bg-emerald-500/12 text-emerald-700 border-emerald-500/20";
    case "queued":
      return "bg-blue-500/12 text-blue-700 border-blue-500/20";
    case "active":
      return "bg-amber-500/12 text-amber-700 border-amber-500/20";
    case "recovering":
      return "bg-sky-500/12 text-sky-700 border-sky-500/20";
    case "awaiting_approval":
      return "bg-orange-500/12 text-orange-700 border-orange-500/20";
    case "failed":
      return "bg-destructive/10 text-destructive border-destructive/20";
  }
}

export function SessionManagerPanel({
  conversations,
  agents,
  selectedId,
  onOpenSession,
  onOpenSidebar,
}: SessionManagerPanelProps) {
  const visibleConversations = conversations.filter((conversation) => conversation.isPrimaryThread);
  const sorted = [...visibleConversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const agentMap = new Map(agents.map((agent) => [agent.agentId, agent]));
  const groups = agents
    .map((agent) => ({
      agent,
      sessions: sorted.filter((conversation) => conversation.agentId === agent.agentId),
    }))
    .filter((group) => group.sessions.length > 0);

  const statusCounts = visibleConversations.reduce<Record<string, number>>((acc, conversation) => {
    acc[conversation.status] = (acc[conversation.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="flex h-full flex-col bg-[#fff9d0]">
      <div className="border-b-2 border-black bg-[#fff5b8] px-5 py-4 shadow-[0_2px_0_0_rgba(0,0,0,0.1)]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {onOpenSidebar && (
              <button
                type="button"
                className="shrink-0 rounded-md border-2 border-zinc-900 bg-[#fff9d8] p-1 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#fff1a9] cursor-pointer"
                onClick={onOpenSidebar}
                aria-label="Open sidebar"
              >
                <MenuIcon className="size-4 text-zinc-700" />
              </button>
            )}
            <div>
              <h2 className="text-sm font-semibold">Session Manager</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Inspect all current chat sessions and jump into any agent thread.
              </p>
            </div>
          </div>
          <Badge variant="secondary" className="text-xs">
            {visibleConversations.length} sessions
          </Badge>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <SummaryCard label="Agents" value={String(groups.length)} />
          <SummaryCard label="Idle" value={String(statusCounts.idle ?? 0)} />
          <SummaryCard label="Active" value={String(statusCounts.active ?? 0)} />
          <SummaryCard label="Queued" value={String(statusCounts.queued ?? 0)} />
          <SummaryCard label="Recovering" value={String(statusCounts.recovering ?? 0)} />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-5 p-5">
          {groups.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No sessions yet. Start chatting with an agent to create one.
            </div>
          ) : (
            groups.map(({ agent, sessions }) => (
              <section key={agent.agentId} className="rounded-xl border border-border bg-card/40">
                <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{agent.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {agent.agentType === "claude_acp" ? "Claude" : "Codex"} · private chat
                    </div>
                  </div>
                  <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                    {agent.workspacePath ? "Workspace bound" : "No workspace"}
                  </Badge>
                </div>
                <div className="divide-y divide-border">
                  {sessions.map((conversation) => {
                    const owner = conversation.agentId ? agentMap.get(conversation.agentId) : null;
                    return (
                      <button
                        key={conversation.id}
                        type="button"
                        className={cn(
                          "flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors cursor-pointer",
                          selectedId === conversation.id ? "bg-accent/60" : "hover:bg-accent/30",
                        )}
                        onClick={() => onOpenSession(conversation.id)}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">Private chat</span>
                            <Badge variant="outline" className="px-1 py-0 text-[8px] uppercase tracking-wide">
                              Main
                            </Badge>
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{owner?.name ?? "Unknown agent"}</span>
                            <span>·</span>
                            <span>{formatRelativeTime(conversation.updatedAt)}</span>
                            <span>·</span>
                            <span className="font-mono">{conversation.id.slice(0, 8)}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={cn("rounded-full border px-2 py-1 text-[10px] font-medium capitalize", statusTone(conversation.status))}>
                            {conversation.status}
                          </span>
                          <span className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground">
                            Open
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold">{value}</div>
    </div>
  );
}
