import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { XIcon, SendIcon, MessageSquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo } from "@agent-collab/protocol";
import type { ChannelMessage } from "@/lib/api";
import { useThreadStream } from "@/hooks/useThreadStream";
import { Streamdown } from "streamdown";
import {
  safeRehypePlugins,
  safeRemarkPlugins,
  streamdownComponents,
  streamdownRootClass,
  escapeHtmlOutsideCodeBlocks,
} from "@/components/ai-elements/streamdown";

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatTime(createdAt: string): string {
  try { return timeFormatter.format(new Date(createdAt)); } catch { return ""; }
}

function renderContent(content: string) {
  const parts = content.split(/(@[a-zA-Z0-9_-]+)/g);
  return parts.map((part, i) =>
    /^@[a-zA-Z0-9_-]+$/.test(part) ? (
      <span key={i} className="rounded px-0.5 font-semibold text-purple-700">{part}</span>
    ) : part,
  );
}

function ThreadMessage({ message }: { message: ChannelMessage }) {
  const isUser = message.senderType === "user";
  return (
    <div className="flex gap-2.5 px-4 py-2">
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-zinc-900 text-[10px] font-bold shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
          isUser ? "bg-[#d8efff] text-blue-800" : "bg-[#d8f8c8] text-green-800",
        )}
        title={message.senderName}
      >
        {message.senderName.slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[11px] font-semibold text-zinc-700">{message.senderName}</span>
          <span className="text-[10px] text-zinc-400">{formatTime(message.createdAt)}</span>
        </div>
        <div
          className={cn(
            "mt-0.5 rounded-md border-2 border-zinc-900 px-3 py-2 text-sm shadow-[2px_2px_0_0_rgba(0,0,0,0.1)]",
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

function ThreadComposer({
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

  useEffect(() => { setMentionIndex(0); }, [mentionCandidates.length]);

  const selectMention = useCallback((agentName: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? text.length;
    const before = text.slice(0, cursor);
    const after = text.slice(cursor);
    const atMatch = /@([a-zA-Z0-9_-]*)$/.exec(before);
    if (!atMatch) return;
    const newBefore = before.slice(0, atMatch.index) + `@${agentName} `;
    setText(newBefore + after);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(newBefore.length, newBefore.length);
    });
  }, [text]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    const cursor = e.target.selectionStart ?? val.length;
    const atMatch = /@([a-zA-Z0-9_-]*)$/.exec(val.slice(0, cursor));
    setMentionQuery(atMatch ? (atMatch[1] ?? "") : null);
    const ta = textareaRef.current;
    if (ta) { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; }
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setText("");
    setMentionQuery(null);
    const ta = textareaRef.current;
    if (ta) ta.style.height = "auto";
    try { await onSend(trimmed); } finally { setSending(false); }
  }, [text, onSend, sending]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIndex(i => Math.min(i + 1, mentionCandidates.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const c = mentionCandidates[mentionIndex] ?? mentionCandidates[0];
        if (c) selectMention(c.name);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setMentionQuery(null); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSubmit(); }
  }, [mentionQuery, mentionCandidates, mentionIndex, selectMention, handleSubmit]);

  return (
    <div className="relative border-t-2 border-black bg-[#fff5c2] px-3 py-2.5 shadow-[0_-2px_0_0_rgba(0,0,0,0.08)]">
      {mentionQuery !== null && mentionCandidates.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-md border-2 border-zinc-900 bg-[#fffdf4] shadow-[3px_3px_0_0_rgba(0,0,0,0.2)]">
          <div className="px-2 py-1 text-[10px] uppercase tracking-widest text-zinc-400">Members</div>
          {mentionCandidates.map((agent, i) => (
            <button
              key={agent.agentId}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); selectMention(agent.name); }}
              className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[#fff1a9]", i === mentionIndex && "bg-[#ffd54a]")}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-zinc-900 bg-[#d8f8c8] text-[9px] font-bold text-green-800">
                {agent.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="font-medium text-zinc-900">@{agent.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-sm border-2 border-black bg-[#fffdf4] p-2 shadow-[3px_3px_0_0_rgba(0,0,0,0.15)]">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          className={cn(
            "min-h-[36px] max-h-[160px] flex-1 resize-none rounded-sm border border-transparent bg-transparent px-2 py-1.5 text-sm text-zinc-900",
            "placeholder:text-zinc-400 focus:outline-none disabled:opacity-50",
          )}
          placeholder="Reply in thread..."
          disabled={sending}
          rows={1}
        />
        <Button
          size="icon"
          onClick={() => void handleSubmit()}
          className="shrink-0 size-8 rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
          disabled={sending}
        >
          <SendIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

type ThreadPanelProps = {
  channelId: string;
  channelName: string;
  rootMessage: ChannelMessage;
  channelMembers: AgentInfo[];
  onClose: () => void;
};

export function ThreadPanel({ channelId, channelName, rootMessage, channelMembers, onClose }: ThreadPanelProps) {
  const threadRootId = rootMessage.id.slice(0, 8);
  const { messages, sendMessage } = useThreadStream(channelId, threadRootId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isRootUser = rootMessage.senderType === "user";

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="flex h-full flex-col border-l-2 border-zinc-900 bg-[#fefce8]">
      {/* Header */}
      <div className="flex items-center justify-between border-b-2 border-zinc-900 bg-[#fffdf5] px-4 py-3 shadow-[0_2px_0_0_rgba(0,0,0,0.08)]">
        <div className="flex items-center gap-2">
          <MessageSquareIcon className="size-4 text-zinc-600" />
          <span className="text-sm font-semibold text-zinc-900">Thread</span>
          <span className="text-xs text-zinc-400">in #{channelName}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border-2 border-zinc-900 bg-[#fff9d8] p-1 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)] hover:bg-[#fff1a9] cursor-pointer"
          aria-label="Close thread"
        >
          <XIcon className="size-3.5 text-zinc-700" />
        </button>
      </div>

      {/* Root message */}
      <div className="border-b-2 border-dashed border-zinc-300 bg-[#fffdf5]">
        <div className="flex gap-2.5 px-4 py-3">
          <div
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-zinc-900 text-[10px] font-bold shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              isRootUser ? "bg-[#d8efff] text-blue-800" : "bg-[#d8f8c8] text-green-800",
            )}
          >
            {rootMessage.senderName.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[11px] font-semibold text-zinc-700">{rootMessage.senderName}</span>
              <span className="text-[10px] text-zinc-400">{formatTime(rootMessage.createdAt)}</span>
            </div>
            <div className="mt-0.5 text-sm text-zinc-800" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {renderContent(rootMessage.content)}
            </div>
          </div>
        </div>
        {messages.length > 0 && (
          <div className="px-4 pb-2 text-[11px] text-zinc-500">
            {messages.length} {messages.length === 1 ? "reply" : "replies"}
          </div>
        )}
      </div>

      {/* Thread replies */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
        {messages.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-zinc-400">
            No replies yet. Be the first to reply!
          </div>
        ) : (
          messages.map((msg) => <ThreadMessage key={msg.id} message={msg} />)
        )}
      </div>

      <ThreadComposer onSend={sendMessage} channelMembers={channelMembers} />
    </div>
  );
}
