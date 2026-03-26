import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HashIcon, MenuIcon, SendIcon, UsersIcon, MessageSquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChannelInfo, AgentInfo } from "@agent-collab/protocol";
import type { ChannelMessage } from "@/lib/api";
import { useChannelStream } from "@/hooks/useChannelStream";
import { Streamdown } from "streamdown";
import {
  safeRehypePlugins,
  safeRemarkPlugins,
  streamdownComponents,
  streamdownRootClass,
  escapeHtmlOutsideCodeBlocks,
} from "@/components/ai-elements/streamdown";

type ChannelPanelProps = {
  channel: ChannelInfo;
  agents: AgentInfo[];
  onOpenSidebar?: () => void;
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

/** Render message content with @mention highlighting */
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

function MessageRow({ message }: { message: ChannelMessage }) {
  const isUser = message.senderType === "user";
  return (
    <div className={cn("flex gap-2.5 px-4 py-2", isUser ? "flex-row-reverse" : "flex-row")}>
      {/* Avatar circle */}
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-zinc-900 text-[10px] font-bold shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
          isUser ? "bg-[#d8efff] text-blue-800" : "bg-[#d8f8c8] text-green-800",
        )}
        title={message.senderName}
      >
        {message.senderName.slice(0, 2).toUpperCase()}
      </div>

      {/* Bubble */}
      <div className={cn("flex max-w-[72%] flex-col gap-0.5", isUser ? "items-end" : "items-start")}>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[11px] font-semibold text-zinc-700">{message.senderName}</span>
          <span className="text-[10px] text-zinc-400">{formatTime(message.createdAt)}</span>
        </div>
        <div
          className={cn(
            "rounded-md border-2 border-zinc-900 px-3 py-2 text-sm shadow-[2px_2px_0_0_rgba(0,0,0,0.1)]",
            isUser ? "bg-[#d8efff] text-zinc-900" : "bg-[#d8f8c8] text-zinc-900",
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

  // Reset selection index when candidates change
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
    const before = val.slice(0, cursor);
    const atMatch = /@([a-zA-Z0-9_-]*)$/.exec(before);
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
      {/* @mention dropdown */}
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

export function ChannelPanel({ channel, agents, onOpenSidebar }: ChannelPanelProps) {
  const [activeTab, setActiveTab] = useState<"chat" | "members">("chat");
  const { messages, sendMessage } = useChannelStream(channel.channelId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const channelMembers = useMemo(
    () => agents.filter((a) => a.channelId === channel.channelId),
    [agents, channel.channelId],
  );

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (activeTab !== "chat") return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeTab]);

  // Reset to chat tab when channel changes
  useEffect(() => {
    setActiveTab("chat");
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
            <div className="mt-0.5 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
              {channelMembers.length === 0
                ? "No agents"
                : channelMembers.length === 1
                ? "1 agent"
                : `${channelMembers.length} agents`}
            </div>
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
              activeTab === "members"
                ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]"
                : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("members")}
          >
            <UsersIcon className="mr-1.5 size-3" />
            Members
          </Button>
        </div>
      </div>

      {/* Content */}
      {activeTab === "members" ? (
        <MembersTab members={channelMembers} />
      ) : (
        <>
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
              messages.map((message) => <MessageRow key={message.id} message={message} />)
            )}
          </div>
          <ChannelComposer onSend={sendMessage} channelMembers={channelMembers} />
        </>
      )}
    </div>
  );
}
