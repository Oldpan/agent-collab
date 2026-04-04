import { Badge } from "@/components/ui/badge";
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
    <div className="flex h-full flex-col overflow-hidden bg-[#fff9d0]">
      {/* 紧凑 header */}
      <div className="shrink-0 border-b-2 border-black bg-[#fff5b8] px-3 py-2 shadow-[0_2px_0_0_rgba(0,0,0,0.1)]">
        <div className="flex items-center gap-2">
          {onOpenSidebar && (
            <button
              type="button"
              className="shrink-0 rounded border border-zinc-900 bg-[#fff9d8] p-0.5 shadow-[1px_1px_0_0_rgba(0,0,0,0.12)] hover:bg-[#fff1a9] cursor-pointer"
              onClick={onOpenSidebar}
              aria-label="Open sidebar"
            >
              <MenuIcon className="size-3.5 text-zinc-700" />
            </button>
          )}
          <h2 className="text-xs font-semibold">Session Manager</h2>
          {/* 状态统计 inline badges */}
          <div className="ml-auto flex items-center gap-1 flex-wrap">
            <StatBadge label="Agents" value={groups.length} />
            <StatBadge label="Idle" value={statusCounts.idle ?? 0} tone="emerald" />
            <StatBadge label="Active" value={statusCounts.active ?? 0} tone="amber" />
            <StatBadge label="Queued" value={statusCounts.queued ?? 0} tone="blue" />
            {(statusCounts.recovering ?? 0) > 0 && (
              <StatBadge label="Recovering" value={statusCounts.recovering ?? 0} tone="sky" />
            )}
          </div>
        </div>
      </div>

      {/* 可滚动内容区 */}
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-2 p-2">
          {groups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              No sessions yet. Start chatting with an agent to create one.
            </div>
          ) : (
            groups.map(({ agent, sessions }) => (
              <section key={agent.agentId} className="rounded-lg border border-border bg-card/40">
                {/* agent 标题行 */}
                <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                  <span className="truncate text-xs font-medium">{agent.name}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {agent.agentType === "claude_acp" ? "Claude" : "Codex"}
                  </span>
                  {agent.workspacePath && (
                    <Badge variant="outline" className="ml-auto text-[9px] px-1 py-0">ws</Badge>
                  )}
                </div>
                {/* session 行 */}
                <div className="divide-y divide-border">
                  {sessions.map((conversation) => {
                    const owner = conversation.agentId ? agentMap.get(conversation.agentId) : null;
                    return (
                      <button
                        key={conversation.id}
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors cursor-pointer",
                          selectedId === conversation.id ? "bg-accent/60" : "hover:bg-accent/30",
                        )}
                        onClick={() => onOpenSession(conversation.id)}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-xs font-medium">Private chat</span>
                            <span className="font-mono text-[9px] text-muted-foreground">{conversation.id.slice(0, 6)}</span>
                          </div>
                          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <span>{owner?.name ?? "—"}</span>
                            <span>·</span>
                            <span>{formatRelativeTime(conversation.updatedAt)}</span>
                          </div>
                        </div>
                        <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium capitalize", statusTone(conversation.status))}>
                          {conversation.status}
                        </span>
                        <span className="shrink-0 rounded border border-border px-2 py-0.5 text-[10px] font-medium text-foreground">
                          Open
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const toneMap: Record<string, string> = {
  emerald: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  amber: "bg-amber-500/10 text-amber-700 border-amber-500/20",
  blue: "bg-blue-500/10 text-blue-700 border-blue-500/20",
  sky: "bg-sky-500/10 text-sky-700 border-sky-500/20",
};

function StatBadge({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const cls = tone ? toneMap[tone] : "bg-muted text-muted-foreground border-border";
  return (
    <span className={cn("rounded border px-1.5 py-0.5 text-[9px] font-medium", cls)}>
      {label} {value}
    </span>
  );
}
