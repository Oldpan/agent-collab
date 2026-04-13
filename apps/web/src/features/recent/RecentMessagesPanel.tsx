import { useCallback } from "react";
import {
  formatBeijingMonthDayTime,
  type RecentMessageSourceItem,
} from "@agent-collab/protocol";
import { InboxIcon, MenuIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type RecentMessagesPanelProps = {
  items: RecentMessageSourceItem[];
  totalUnreadCount: number;
  onRefresh: () => void;
  onMarkSourceRead: (item: RecentMessageSourceItem) => void;
  onOpenOriginal: (item: RecentMessageSourceItem) => Promise<void> | void;
  onOpenSidebar?: () => void;
};

function formatAbsoluteTime(iso: string): string {
  const ts = new Date(iso).getTime();
  return Number.isFinite(ts) ? formatBeijingMonthDayTime(ts, { withSeconds: false }) : "";
}

function formatSourceLabel(source: RecentMessageSourceItem): string {
  if (source.sourceType === "dm") return source.agentName ? `DM · ${source.agentName}` : "DM";
  if (source.sourceType === "channel") return source.channelName ? `#${source.channelName}` : "Channel";
  if (source.sourceType === "thread") {
    return source.channelName ? `Thread · #${source.channelName}` : "Thread";
  }
  if (source.channelName) return `Task · #${source.channelName}`;
  return "Task";
}

function metaChips(source: RecentMessageSourceItem): string[] {
  const chips: string[] = [];
  if (source.sourceType === "dm") chips.push("DM");
  if (source.sourceType === "channel") chips.push("Channel");
  if (source.sourceType === "thread") chips.push("Thread");
  if (source.sourceType === "task") chips.push("Task");
  if (source.agentName) chips.push(`Agent: ${source.agentName}`);
  if (source.channelName) chips.push(`#${source.channelName}`);
  if (source.taskNumber != null) chips.push(`#t${source.taskNumber}`);
  if (source.taskRef) chips.push(source.taskRef);
  return chips;
}

export function RecentMessagesPanel({
  items,
  totalUnreadCount,
  onRefresh,
  onMarkSourceRead,
  onOpenOriginal,
  onOpenSidebar,
}: RecentMessagesPanelProps) {
  const handleOpenSource = useCallback((item: RecentMessageSourceItem) => {
    onMarkSourceRead(item);
    void onOpenOriginal(item);
  }, [onMarkSourceRead, onOpenOriginal]);

  return (
    <div className="flex h-full flex-col bg-[#f4efe2] text-zinc-950">
      <div className="border-b-2 border-black bg-[#fffdf5] px-3.5 py-2.5 shadow-[0_2px_0_0_rgba(0,0,0,0.08)]">
        <div className="flex items-center gap-2">
          {onOpenSidebar ? (
            <button
              type="button"
              className="shrink-0 rounded-md border-2 border-zinc-900 bg-[#fff9d8] p-1 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#fff1a9] cursor-pointer md:hidden"
              onClick={onOpenSidebar}
              aria-label="Open sidebar"
            >
              <MenuIcon className="size-4 text-zinc-700" />
            </button>
          ) : null}
          <div className="flex size-10 shrink-0 items-center justify-center border-2 border-zinc-900 bg-[#fff8d8] shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]">
            <InboxIcon className="size-4.5 text-zinc-900" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Recent messages</div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
              {totalUnreadCount} unread
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex size-8 items-center justify-center border-2 border-zinc-900 bg-[#fff9d8] text-zinc-900 hover:bg-[#fff1a9] cursor-pointer"
            aria-label="Refresh recent messages"
          >
            <RefreshCwIcon className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {items.length === 0 ? (
          <div className="rounded-md border-2 border-dashed border-zinc-900/25 bg-[#fff8d8] px-3 py-4 text-sm text-zinc-500">
            No unread messages.
          </div>
        ) : (
          <div className="space-y-2.5">
            {items.map((item) => (
              <button
                key={item.sourceKey}
                type="button"
                onClick={() => handleOpenSource(item)}
                className="w-full rounded-none border-2 border-zinc-900 bg-white px-3 py-3 text-left shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] transition-colors hover:bg-[#fff8d8] cursor-pointer"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-none border-2 border-zinc-900 bg-[#fff8d8] text-zinc-900">
                    <InboxIcon className="size-3.5" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                      <span className="rounded border border-zinc-400 bg-[#fff4bf] px-1.5 py-0.5 font-semibold text-zinc-700">
                        {item.sourceType}
                      </span>
                      <span className="truncate">{formatSourceLabel(item)}</span>
                      <span className="ml-auto shrink-0">{formatAbsoluteTime(item.latestCreatedAt)}</span>
                    </div>

                    <div className="mt-1 flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-zinc-900">
                          {item.taskTitle ?? item.agentName ?? item.channelName ?? "Recent message"}
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-600">
                          {item.latestSenderName}: {item.latestSnippet}
                        </div>
                      </div>
                      <span className="shrink-0 rounded border-2 border-zinc-900 bg-[#e85d75] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]">
                        {item.unreadCount > 99 ? "99+" : item.unreadCount}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {metaChips(item).map((chip) => (
                        <span
                          key={`${item.sourceKey}:${chip}`}
                          className={cn(
                            "rounded border border-zinc-400 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600",
                            chip.startsWith("Agent:") ? "bg-[#edf5ff]" : "bg-[#f7f0da]",
                          )}
                        >
                          {chip}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
