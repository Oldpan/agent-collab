import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, HashIcon, MenuIcon, SendIcon, UsersIcon, MessageSquareIcon, Settings2Icon, MessageSquareOffIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChannelInfo, AgentInfo } from "@agent-collab/protocol";
import type { ChannelMessage } from "@/lib/api";
import { clearChannelChat } from "@/lib/api";
import { useChannelStream, type ChannelNotice } from "@/hooks/useChannelStream";
import { ThreadPanel } from "./ThreadPanel";
import { Streamdown } from "streamdown";
import {
  safeRehypePlugins,
  safeRemarkPlugins,
  streamdownComponents,
  streamdownRootClass,
  escapeHtmlOutsideCodeBlocks,
} from "@/components/ai-elements/streamdown";
import { TasksTab } from "./TasksTab";
import { ChatAvatar } from "@/features/chat/ChatAvatar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type ChannelPanelProps = {
  channel: ChannelInfo;
  agents: AgentInfo[];
  onOpenSidebar?: () => void;
  onSeenSeq?: (seq: number) => void;
};

const messageTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatTime(createdAt: string): string {
  try {
    return messageTimeFormatter.format(new Date(createdAt));
  } catch {
    return "";
  }
}

function renderContent(content: string) {
  const parts = content.split(/(@[a-zA-Z0-9_-]+)/g);
  return parts.map((part, i) =>
    /^@[a-zA-Z0-9_-]+$/.test(part) ? (
      <span key={i} className="rounded px-0.5 font-semibold text-purple-700">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function MessageRow({
  message,
  onReply,
  agents,
}: {
  message: ChannelMessage;
  onReply: (message: ChannelMessage) => void;
  agents: AgentInfo[];
}) {
  const isSystem = message.senderType === "system";
  const isUser = message.senderType === "user";
  const replyCount = message.replyCount ?? 0;

  if (isSystem) {
    return (
      <div className="px-4 py-2">
        <div className="rounded-md border border-zinc-300 bg-white/70 px-3 py-2 text-xs text-zinc-600 shadow-[2px_2px_0_0_rgba(0,0,0,0.06)]">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold uppercase tracking-wide text-zinc-500">System</span>
            <span className="text-[10px] text-zinc-400">{formatTime(message.createdAt)}</span>
          </div>
          <div className="mt-1 whitespace-pre-wrap break-words">{message.content}</div>
        </div>
      </div>
    );
  }

  const agent = agents.find((a) => a.name === message.senderName);

  return (
    <div
      className={cn(
        "group relative flex gap-2.5 px-4 py-2",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      {/* Avatar - use ChatAvatar for agents, initials for user */}
      {isUser ? (
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-sm border-2 border-zinc-900 bg-[#d8efff] text-[10px] font-bold text-blue-800 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]"
          title={message.senderName}
        >
          {message.senderName.slice(0, 2).toUpperCase()}
        </div>
      ) : (
        <ChatAvatar
          role="assistant"
          agent={agent}
          size={32}
          className="shrink-0"
        />
      )}

      {/* Content wrapper with relative positioning for reply button */}
      <div className={cn("relative min-w-0", isUser ? "flex items-end flex-col" : "flex items-start flex-col")}>
        {/* Reply button - positioned at the top of the bubble, away from avatar */}
        <button
          type="button"
          onClick={() => onReply(message)}
          className={cn(
            "absolute top-0 z-10 hidden rounded border-2 border-zinc-900 bg-[#fff9d8] px-2 py-0.5 text-[11px] font-medium text-zinc-700 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)] hover:bg-[#ffd54a] group-hover:flex items-center gap-1",
            isUser ? "left-0 -translate-x-full mr-2" : "right-0 translate-x-full ml-2"
          )}
          aria-label="Reply in thread"
        >
          <MessageSquareIcon className="size-3" />
          Reply
        </button>

        <div className="flex items-baseline gap-1.5">
          <span className="text-[11px] font-semibold text-zinc-700">{message.senderName}</span>
          <span className="text-[10px] text-zinc-400">{formatTime(message.createdAt)}</span>
        </div>
        <div
          className={cn(
            "mt-0.5 rounded-md border-2 px-3 py-2 text-sm transition-shadow",
            isUser
              ? "bg-[#d8efff] text-zinc-900 border-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)] group-hover:shadow-[4px_4px_0_0_rgba(0,0,0,0.8)]"
              : "bg-[#d8f8c8] text-zinc-900 border-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)] group-hover:shadow-[4px_4px_0_0_rgba(0,0,0,0.8)]",
          )}
        >
          {isUser ? (
            <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {renderContent(message.content)}
            </span>
          ) : (
            <Streamdown
              className={cn("text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", streamdownRootClass)}
              components={streamdownComponents}
              rehypePlugins={safeRehypePlugins}
              remarkPlugins={safeRemarkPlugins}
            >
              {escapeHtmlOutsideCodeBlocks(message.content)}
            </Streamdown>
          )}
        </div>

        {/* Thread reply count badge */}
        {replyCount > 0 && (
          <button
            type="button"
            onClick={() => onReply(message)}
            className="mt-1 flex items-center gap-1 rounded border border-zinc-300 bg-white/60 px-2 py-0.5 text-[11px] text-blue-600 hover:bg-white hover:border-blue-300 transition-colors"
          >
            <MessageSquareIcon className="size-3" />
            {replyCount} {replyCount === 1 ? "reply" : "replies"}
          </button>
        )}
      </div>
    </div>
  );
}

function ChannelComposer({
  onSend,
  channelMembers,
}: {
  onSend: (text: string) => void;
  channelMembers: AgentInfo[];
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    return channelMembers
      .filter((a) => a.name.toLowerCase().startsWith(mentionQuery.toLowerCase()))
      .slice(0, 5);
  }, [mentionQuery, channelMembers]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionCandidates.length]);

  const selectMention = useCallback(
    (agentName: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const cursor = ta.selectionStart ?? text.length;
      const before = text.slice(0, cursor);
      const after = text.slice(cursor);
      const atMatch = /@([a-zA-Z0-9_-]*)$/.exec(before);
      if (!atMatch) return;
      const newBefore = before.slice(0, atMatch.index) + `@${agentName} `;
      const newText = newBefore + after;
      setText(newText);
      setMentionQuery(null);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(newBefore.length, newBefore.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    [text],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    const cursor = e.target.selectionStart ?? val.length;
    const atMatch = /@([a-zA-Z0-9_-]*)$/.exec(val.slice(0, cursor));
    setMentionQuery(atMatch ? (atMatch[1] ?? "") : null);
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setText("");
    setMentionQuery(null);
    const ta = textareaRef.current;
    if (ta) ta.style.height = "auto";
    try {
      await onSend(trimmed);
    } finally {
      setSending(false);
    }
  }, [text, onSend, sending]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionQuery !== null && mentionCandidates.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((i) => Math.min(i + 1, mentionCandidates.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const candidate = mentionCandidates[mentionIndex] ?? mentionCandidates[0];
          if (candidate) selectMention(candidate.name);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionQuery(null);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [mentionQuery, mentionCandidates, mentionIndex, selectMention, handleSubmit],
  );

  return (
    <div className="relative border-t-2 border-black bg-[#fff5c2] px-4 py-3 shadow-[0_-2px_0_0_rgba(0,0,0,0.08)]">
      {mentionQuery !== null && mentionCandidates.length > 0 && (
        <div className="absolute bottom-full left-4 right-4 mb-1 overflow-hidden rounded-md border-2 border-zinc-900 bg-[#fffdf4] shadow-[3px_3px_0_0_rgba(0,0,0,0.2)]">
          <div className="px-2 py-1 text-[10px] uppercase tracking-widest text-zinc-400">
            Members
          </div>
          {mentionCandidates.map((agent, i) => (
            <button
              key={agent.agentId}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                selectMention(agent.name);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[#fff1a9]",
                i === mentionIndex && "bg-[#ffd54a]",
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-zinc-900 bg-[#d8f8c8] text-[9px] font-bold text-green-800">
                {agent.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="font-medium text-zinc-900">@{agent.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-sm border-2 border-black bg-[#fffdf4] p-2 shadow-[4px_4px_0_0_rgba(0,0,0,0.2)]">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          className={cn(
            "min-h-[40px] max-h-[200px] flex-1 resize-none rounded-sm border border-transparent bg-transparent px-3 py-2 text-sm text-zinc-900",
            "placeholder:text-zinc-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          )}
          placeholder="Send a message... (@ to mention, Shift+Enter for newline)"
          disabled={sending}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <Button
          size="icon"
          onClick={() => void handleSubmit()}
          className="shrink-0 rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
          title="Send"
          disabled={sending}
        >
          <SendIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function ChannelStatusBar({
  notices,
}: {
  notices: ChannelNotice[];
}) {
  const [expanded, setExpanded] = useState(false);

  const latest = notices[notices.length - 1];
  if (!latest) return null;

  return (
    <div className="border-b border-zinc-200/80 bg-[#fffbe6] text-xs">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-[#fff8cc] transition-colors"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
        <span className="flex-1 truncate text-zinc-500">{latest.message}</span>
        {notices.length > 1 && (
          <span className="shrink-0 rounded-sm bg-amber-200/70 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
            {notices.length}
          </span>
        )}
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 text-zinc-400 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-zinc-200/60 px-4 py-2 space-y-1.5">
          {[...notices].reverse().map((n, i) => (
            <div key={i} className="flex items-baseline gap-2 text-zinc-500">
              <span className="shrink-0 text-[10px] text-zinc-400">{formatTime(n.createdAt)}</span>
              <span>{n.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MembersTab({ members }: { members: AgentInfo[] }) {
  return (
    <div className="flex-1 overflow-y-auto p-4">
      {members.length === 0 ? (
        <p className="rounded-md border-2 border-dashed border-zinc-900/40 bg-[#fff8d8] px-3 py-4 text-center text-xs text-zinc-500">
          No agents assigned to this channel yet
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {members.map((agent) => (
            <div
              key={agent.agentId}
              className="flex items-center gap-2.5 rounded-md border-2 border-zinc-900 bg-[#fff8d8] px-3 py-2 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)]"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-zinc-900 bg-[#d8f8c8] text-[11px] font-bold text-green-800 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)]">
                {agent.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold text-zinc-900">{agent.name}</div>
                <div className="text-[10px] text-zinc-500">
                  {agent.agentType === "claude_acp" ? "Claude" : "Codex"}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsTab({
  channel,
  onClearChat,
}: {
  channel: ChannelInfo;
  onClearChat: () => Promise<void>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const handleConfirm = useCallback(async () => {
    setClearing(true);
    try {
      await onClearChat();
      setNotice("Channel chat history cleared.");
      setDialogOpen(false);
    } finally {
      setClearing(false);
    }
  }, [onClearChat]);

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4">
          <section className="rounded-md border-2 border-zinc-900 bg-[#fff8d8] px-4 py-4 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Channel</div>
            <div className="mt-2 text-sm font-semibold text-zinc-900">#{channel.name}</div>
            {channel.description ? (
              <div className="mt-1 text-xs text-zinc-600">{channel.description}</div>
            ) : (
              <div className="mt-1 text-xs text-zinc-500">No description</div>
            )}
          </section>

          <section className="rounded-md border-2 border-zinc-900 bg-[#fff0d0] px-4 py-4 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Danger Zone</div>
            <div className="mt-2 text-sm font-semibold text-zinc-900">Clear chat history</div>
            <p className="mt-1 text-xs leading-5 text-zinc-700">
              This removes the channel timeline and thread replies, and resets branch conversation activity for this channel.
              It keeps the channel itself, members, and tasks.
            </p>
            {notice ? (
              <div className="mt-3 rounded-sm border border-zinc-900/20 bg-white/70 px-3 py-2 text-xs text-zinc-700">
                {notice}
              </div>
            ) : null}
            <Button
              size="sm"
              className="mt-3 rounded-sm border-2 border-zinc-900 bg-[#ffd8d8] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#ffc6c6]"
              onClick={() => setDialogOpen(true)}
              disabled={clearing}
            >
              <MessageSquareOffIcon className="mr-1.5 size-3.5" />
              Clear chat history
            </Button>
          </section>
        </div>
      </div>

      <ConfirmDialog
        isOpen={dialogOpen}
        title="Clear Channel Chat History"
        message={`Clear chat history for #${channel.name}?\n\nThis will remove channel messages and thread replies, and reset branch conversation activity for this channel. Members and tasks will be kept.`}
        confirmText={clearing ? "Clearing..." : "Clear"}
        cancelText="Cancel"
        variant="warning"
        onConfirm={handleConfirm}
        onCancel={() => {
          if (!clearing) setDialogOpen(false);
        }}
      />
    </>
  );
}

export function ChannelPanel({ channel, agents, onOpenSidebar, onSeenSeq }: ChannelPanelProps) {
  const [activeTab, setActiveTab] = useState<"chat" | "tasks" | "members" | "settings">("chat");
  const { messages, notices, sendMessage, loadMore, hasMore, resetVersion } = useChannelStream({
    channelId: channel.channelId,
    onSeenSeq,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const channelMembers = useMemo(
    () => agents.filter((a) => a.channelIds?.includes(channel.channelId) ?? false),
    [agents, channel.channelId],
  );
  const [openThread, setOpenThread] = useState<ChannelMessage | null>(null);

  // Auto-scroll main channel to bottom
  useEffect(() => {
    if (activeTab !== "chat" || openThread) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeTab, openThread]);

  // Reset tabs/thread on channel change
  useEffect(() => {
    setActiveTab("chat");
    setOpenThread(null);
  }, [channel.channelId]);

  useEffect(() => {
    setOpenThread(null);
  }, [resetVersion]);

  const handleClearChat = useCallback(async () => {
    await clearChannelChat(channel.channelId);
  }, [channel.channelId]);

  return (
    <div className="flex h-full flex-col bg-[#fff9d0]">
      {/* Header */}
      <div className="border-b-2 border-black bg-[#fffdf5] px-4 py-3 shadow-[0_2px_0_0_rgba(0,0,0,0.1)]">
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
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <HashIcon className="size-4 shrink-0 text-zinc-600" />
              <h2 className="truncate text-sm font-semibold tracking-tight text-zinc-950">
                {channel.name}
              </h2>
            </div>
            {channel.description ? (
              <div className="mt-0.5 text-[11px] text-zinc-500 truncate">{channel.description}</div>
            ) : (
              <div className="mt-0.5 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                {channelMembers.length === 0
                  ? "No agents"
                  : channelMembers.length === 1
                  ? "1 agent"
                  : `${channelMembers.length} agents`}
              </div>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            className={cn(
              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              activeTab === "chat"
                ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]"
                : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("chat")}
          >
            <MessageSquareIcon className="mr-1.5 size-3" />
            Chat
          </Button>
          <Button
            size="sm"
            className={cn(
              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              activeTab === "tasks"
                ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]"
                : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("tasks")}
          >
            Tasks
          </Button>
          <Button
            size="sm"
            className={cn(
              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              activeTab === "members"
                ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]"
                : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("members")}
          >
            <UsersIcon className="mr-1.5 size-3" />
            Members
          </Button>
          <Button
            size="sm"
            className={cn(
              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              activeTab === "settings"
                ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]"
                : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("settings")}
          >
            <Settings2Icon className="mr-1.5 size-3" />
            Settings
          </Button>
        </div>
      </div>

      {/* Content */}
      {activeTab === "tasks" ? (
        <TasksTab channelId={channel.channelId} />
      ) : activeTab === "members" ? (
        <MembersTab members={channelMembers} />
      ) : activeTab === "settings" ? (
        <SettingsTab channel={channel} onClearChat={handleClearChat} />
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Main channel messages */}
          <div className={cn("flex flex-col overflow-hidden", openThread ? "flex-1" : "w-full")}>
            <ChannelStatusBar key={channel.channelId} notices={notices} />
            <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fff8d8] px-6 py-5 text-center shadow-[2px_2px_0_0_rgba(0,0,0,0.06)]">
                    <HashIcon className="mx-auto mb-2 size-6 text-zinc-400" />
                    <p className="text-sm font-medium text-zinc-600">No messages yet</p>
                    <p className="mt-1 text-xs text-zinc-400">
                      Send the first message to <span className="font-mono">#{channel.name}</span>
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {hasMore && (
                    <div className="flex justify-center py-2">
                      <button
                        type="button"
                        onClick={() => void loadMore()}
                        className="rounded border border-zinc-300 px-3 py-1 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-600"
                      >
                        Load earlier messages
                      </button>
                    </div>
                  )}
                  {messages.map((message) => (
                    <MessageRow
                      key={message.id}
                      message={message}
                      onReply={setOpenThread}
                      agents={channelMembers}
                    />
                  ))}
                </>
              )}
            </div>
            <ChannelComposer onSend={sendMessage} channelMembers={channelMembers} />
          </div>

          {/* Thread panel (slide-in from right) */}
          {openThread && (
            <div className="w-80 shrink-0 overflow-hidden">
              <ThreadPanel
                channelId={channel.channelId}
                channelName={channel.name}
                rootMessage={openThread}
                channelMembers={channelMembers}
                onClose={() => setOpenThread(null)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
