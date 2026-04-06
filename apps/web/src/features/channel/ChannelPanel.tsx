import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, HashIcon, MenuIcon, SendIcon, UsersIcon, MessageSquareIcon, Settings2Icon, MessageSquareOffIcon, ListTodoIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChannelInfo, AgentInfo, ConversationInfo } from "@agent-collab/protocol";
import type { ChannelMessage } from "@/lib/api";
import { addAgentToChannel, clearChannelChat, removeAgentFromChannel, subscribeChannelAgent, unsubscribeChannelAgent, updateChannel, claimMessageAsTask, uploadAttachment } from "@/lib/api";
import { useChannelStream, type ChannelNotice } from "@/hooks/useChannelStream";
import { ThreadPanel } from "./ThreadPanel";
import { BranchInspectorPanel } from "./BranchInspectorPanel";
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
import { MessageSourceBadge } from "@/components/MessageSourceBadge";
import { TaskEditorDialog, type TaskEditorValues } from "./TaskEditorDialog";

type ChannelPanelInfo = ChannelInfo & {
  members?: Array<{
    agentId: string;
    name: string;
  }>;
};

type ChannelPanelProps = {
  channel: ChannelPanelInfo;
  agents: AgentInfo[];
  isAdmin?: boolean;
  onAgentsUpdated?: () => Promise<AgentInfo[]> | void;
  onOpenAgentSession?: (agentId: string, channelId: string, threadRootId?: string | null) => Promise<ConversationInfo | void> | ConversationInfo | void;
  onRestartConversation?: (conversationId: string) => Promise<void>;
  onClearConversationChat?: (conversationId: string) => Promise<void>;
  onOpenSidebar?: () => void;
  onSeenSeq?: (seq: number) => void;
  onChannelUpdated?: (channel: ChannelPanelInfo) => void;
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

function deriveTaskTitleFromMessage(message: ChannelMessage): string {
  const trimmed = message.content.trim();
  if (trimmed) return trimmed.slice(0, 120);
  return `Follow up on ${message.senderName}'s message`;
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

/** Fetches an attachment with auth and renders it as an inline image. */
function AttachmentImage({ attachmentId }: { attachmentId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("auth_token") ?? "";
    let objectUrl: string | null = null;
    fetch(`/api/attachments/${attachmentId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => setError(true));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachmentId]);

  if (error) return (
    <span className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-500">
      Failed to load image
    </span>
  );
  if (!src) return (
    <span className="inline-block h-24 w-24 animate-pulse rounded border-2 border-zinc-200 bg-zinc-100" />
  );
  return (
    <img
      src={src}
      alt="attachment"
      className="max-h-64 max-w-xs rounded border-2 border-zinc-900 object-contain shadow-[2px_2px_0_0_rgba(0,0,0,0.1)]"
    />
  );
}

function MessageRow({
  message,
  onReply,
  onMakeTask,
  agents,
}: {
  message: ChannelMessage;
  onReply: (message: ChannelMessage) => void;
  onMakeTask?: (message: ChannelMessage) => void;
  agents: AgentInfo[];
}) {
  const isSystem = message.senderType === "system";
  const isUser = message.senderType === "user";
  const replyCount = message.replyCount ?? 0;
  const showFallbackBadge = message.messageSource === "delta_fallback" && !isUser;
  const canMakeTask = !isSystem && message.taskNumber == null && onMakeTask != null;

  if (isSystem) {
    // Task message — render as a task card in the chat flow
    if (message.taskNumber != null) {
      const statusColors: Record<string, string> = {
        todo: 'bg-[#fff6b8] text-zinc-700 border-zinc-400',
        in_progress: 'bg-[#d8efff] text-blue-800 border-blue-400',
        in_review: 'bg-[#ffebd8] text-orange-800 border-orange-400',
        done: 'bg-[#d8f8c8] text-green-800 border-green-400',
      };
      const statusLabel: Record<string, string> = {
        todo: 'todo', in_progress: 'in progress', in_review: 'in review', done: 'done',
      };
      const status = message.taskStatus ?? 'todo';
      return (
        <div className="px-4 py-1.5">
          <div className="group relative flex items-start gap-2 rounded-md border-2 border-zinc-900 bg-[#fffdf0] px-3 py-2 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
            {/* Task number chip */}
            <span className="mt-0.5 shrink-0 rounded border border-zinc-400 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-bold text-zinc-500">
              #{message.taskNumber}
            </span>
            {/* Title */}
            <span className="flex-1 text-sm font-medium text-zinc-800 leading-snug">
              {message.content}
            </span>
            {/* Status badge */}
            <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold', statusColors[status] ?? statusColors.todo)}>
              {statusLabel[status] ?? status}
            </span>
            {/* Assignee */}
            {message.taskAssigneeName && (
              <span className="shrink-0 text-[10px] text-zinc-500">@{message.taskAssigneeName}</span>
            )}
            {/* Reply button */}
            <button
              type="button"
              onClick={() => onReply(message)}
              className="absolute right-2 top-2 hidden items-center gap-1 rounded border border-zinc-300 bg-white/80 px-2 py-0.5 text-[10px] text-zinc-600 hover:bg-white group-hover:flex"
              aria-label="Open task thread"
            >
              <MessageSquareIcon className="size-3" />
              {replyCount > 0 ? `${replyCount} replies` : 'Thread'}
            </button>
            {/* Time */}
            <span className="shrink-0 text-[10px] text-zinc-400">{formatTime(message.createdAt)}</span>
          </div>
        </div>
      );
    }

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
        <div
          className={cn(
            "absolute top-0 z-10 hidden group-hover:flex items-center gap-1",
            isUser ? "left-0 -translate-x-full mr-2 flex-row-reverse" : "right-0 translate-x-full ml-2",
          )}
        >
          <button
            type="button"
            onClick={() => onReply(message)}
            className="rounded border-2 border-zinc-900 bg-[#fff9d8] px-2 py-0.5 text-[11px] font-medium text-zinc-700 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)] hover:bg-[#ffd54a] flex items-center gap-1"
            aria-label="Reply in thread"
          >
            <MessageSquareIcon className="size-3" />
            Reply
          </button>
          {canMakeTask && (
            <button
              type="button"
              onClick={() => onMakeTask(message)}
              className="rounded border-2 border-zinc-900 bg-[#d8f8c8] px-2 py-0.5 text-[11px] font-medium text-zinc-700 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)] hover:bg-[#b8f0a8] flex items-center gap-1"
              aria-label="Promote to task"
              title="Promote this message into a task"
            >
              <ListTodoIcon className="size-3" />
              Promote
            </button>
          )}
        </div>

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
          {showFallbackBadge && (
            <div className="mb-2 flex items-start justify-end">
              <MessageSourceBadge messageSource={message.messageSource} />
            </div>
          )}
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

        {/* Attachment images */}
        {message.attachmentIds && message.attachmentIds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.attachmentIds.map((id) => (
              <AttachmentImage key={id} attachmentId={id} />
            ))}
          </div>
        )}

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
        {/* Task badge — shown when this message was promoted into the task workflow */}
        {message.taskNumber != null && (
          <div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-500">
            <span className="rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 font-bold">
              task-message #{message.taskNumber}
            </span>
            <span className="rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5">
              {message.taskStatus ?? 'todo'}
            </span>
            {message.taskAssigneeName && (
              <span>@{message.taskAssigneeName}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ChannelComposer({
  onSend,
  channelMembers,
}: {
  onSend: (text: string, attachmentIds?: string[]) => void;
  channelMembers: AgentInfo[];
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<Array<{ id: string; name: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    e.target.value = "";
    setUploading(true);
    try {
      const results = await Promise.all(files.map((f) => uploadAttachment(f)));
      setPendingFiles((prev) => [...prev, ...results.map((r) => ({ id: r.id, name: r.filename }))]);
    } catch (err) {
      alert(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  }, []);

  const removeFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if ((!trimmed && pendingFiles.length === 0) || sending) return;
    setSending(true);
    const ids = pendingFiles.map((f) => f.id);
    setText("");
    setPendingFiles([]);
    setMentionQuery(null);
    const ta = textareaRef.current;
    if (ta) ta.style.height = "auto";
    try {
      await onSend(trimmed, ids.length ? ids : undefined);
    } finally {
      setSending(false);
    }
  }, [text, pendingFiles, onSend, sending]);

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

      {/* Pending attachment chips */}
      {pendingFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pendingFiles.map((f) => (
            <span
              key={f.id}
              className="flex items-center gap-1 rounded-full border border-zinc-400 bg-[#d8efff] px-2 py-0.5 text-xs text-zinc-700"
            >
              <PaperclipIcon className="size-3 shrink-0" />
              <span className="max-w-[120px] truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => removeFile(f.id)}
                className="ml-0.5 text-zinc-500 hover:text-zinc-900"
                aria-label="Remove"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-sm border-2 border-black bg-[#fffdf4] p-2 shadow-[4px_4px_0_0_rgba(0,0,0,0.2)]">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={(e) => void handleFileChange(e)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending || uploading}
          className="shrink-0 rounded p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40"
          title="Attach image"
        >
          <PaperclipIcon className="size-4" />
        </button>
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
          disabled={sending || uploading}
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

function MembersTab({
  channelId,
  members,
  onOpenSession,
}: {
  channelId: string;
  members: AgentInfo[];
  onOpenSession?: (agentId: string, channelId: string, threadRootId?: string | null) => Promise<void> | void;
}) {
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
              {onOpenSession && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-sm border-2 border-zinc-900 bg-[#fffdf4] px-2 text-[11px] text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#fff1a9]"
                  onClick={() => void onOpenSession(agent.agentId, channelId, null)}
                >
                  Inspect branch
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsTab({
  channel,
  members,
  allAgents,
  isAdmin = false,
  onAgentsUpdated,
  onClearChat,
  onChannelUpdated,
}: {
  channel: ChannelPanelInfo;
  members: AgentInfo[];
  allAgents: AgentInfo[];
  isAdmin?: boolean;
  onAgentsUpdated?: () => Promise<AgentInfo[]> | void;
  onClearChat: () => Promise<{ warning?: string } | void>;
  onChannelUpdated?: (channel: ChannelPanelInfo) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const [submittingAgentId, setSubmittingAgentId] = useState<string | null>(null);
  const [membershipAgentId, setMembershipAgentId] = useState<string | null>(null);
  const [updatingMode, setUpdatingMode] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);

  const subscribedAgentIds = useMemo(
    () => new Set((channel.subscribedAgents ?? []).map((agent) => agent.agentId)),
    [channel.subscribedAgents],
  );
  const memberAgentIds = useMemo(
    () => new Set(members.map((agent) => agent.agentId)),
    [members],
  );
  const handleConfirm = useCallback(async () => {
    setClearing(true);
    setClearError(null);
    try {
      const result = await onClearChat();
      setNotice(result?.warning ?? "Channel chat history cleared.");
      setDialogOpen(false);
    } catch (err) {
      setClearError(String((err as Error)?.message ?? err));
    } finally {
      setClearing(false);
    }
  }, [onClearChat]);

  const handleSubscriptionToggle = useCallback(async (agentId: string, subscribe: boolean) => {
    setSubmittingAgentId(agentId);
    setSubscriptionError(null);
    try {
      const next = subscribe
        ? await subscribeChannelAgent(channel.channelId, agentId)
        : await unsubscribeChannelAgent(channel.channelId, agentId);
      onChannelUpdated?.(next);
    } catch (err) {
      setSubscriptionError(String((err as Error)?.message ?? err));
    } finally {
      setSubmittingAgentId(null);
    }
  }, [channel.channelId, onChannelUpdated]);

  const handleMembershipToggle = useCallback(async (agentId: string, join: boolean) => {
    setMembershipAgentId(agentId);
    setMembershipError(null);
    try {
      const next = join
        ? await addAgentToChannel(channel.channelId, agentId)
        : await removeAgentFromChannel(channel.channelId, agentId);
      onChannelUpdated?.(next);
      await onAgentsUpdated?.();
    } catch (err) {
      setMembershipError(String((err as Error)?.message ?? err));
    } finally {
      setMembershipAgentId(null);
    }
  }, [channel.channelId, onAgentsUpdated, onChannelUpdated]);

  const handleModeChange = useCallback(async (mode: ChannelPanelInfo["collaborationMode"]) => {
    if (mode === channel.collaborationMode) return;
    setUpdatingMode(true);
    setModeError(null);
    try {
      const next = await updateChannel(channel.channelId, { collaborationMode: mode });
      onChannelUpdated?.(next);
    } catch (err) {
      setModeError(String((err as Error)?.message ?? err));
    } finally {
      setUpdatingMode(false);
    }
  }, [channel.channelId, channel.collaborationMode, onChannelUpdated]);

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
            <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
              <span className="rounded-full border border-zinc-900/70 bg-white px-2 py-0.5 text-zinc-700">
                Mode: {channel.collaborationMode === "subscribed_agents" ? "subscribed agents" : "mention only"}
              </span>
              <span className="rounded-full border border-zinc-900/70 bg-white px-2 py-0.5 text-zinc-700">
                {channel.subscribedAgents?.length ?? 0} subscribed
              </span>
            </div>
            <div className="mt-4 border-t border-zinc-900/10 pt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Collaboration mode</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  disabled={updatingMode || !isAdmin}
                  onClick={() => void handleModeChange("mention_only")}
                  className={cn(
                    "h-auto min-h-16 flex-col items-start rounded-sm border-2 border-zinc-900 px-3 py-2 text-left shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
                    channel.collaborationMode === "mention_only"
                      ? "bg-[#d8efff] text-zinc-950 hover:bg-[#c9e7ff]"
                      : "bg-white text-zinc-700 hover:bg-zinc-50",
                  )}
                >
                  <span className="text-xs font-semibold uppercase tracking-wide">Mention only</span>
                  <span className="mt-1 text-[11px] font-normal leading-4">
                    Only explicit @mentions and thread replies wake agents.
                  </span>
                </Button>
                <Button
                  type="button"
                  disabled={updatingMode || !isAdmin}
                  onClick={() => void handleModeChange("subscribed_agents")}
                  className={cn(
                    "h-auto min-h-16 flex-col items-start rounded-sm border-2 border-zinc-900 px-3 py-2 text-left shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
                    channel.collaborationMode === "subscribed_agents"
                      ? "bg-[#d8f8c8] text-zinc-950 hover:bg-[#c8efb8]"
                      : "bg-white text-zinc-700 hover:bg-zinc-50",
                  )}
                >
                  <span className="text-xs font-semibold uppercase tracking-wide">Subscribed agents</span>
                  <span className="mt-1 text-[11px] font-normal leading-4">
                    Top-level channel activity can wake subscribed agents even without @mentions.
                  </span>
                </Button>
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                {!isAdmin
                  ? "Channel settings are read-only for non-admin users."
                  : updatingMode
                  ? "Saving collaboration mode..."
                  : channel.collaborationMode === "subscribed_agents"
                    ? "This channel can passively wake subscribed agents on non-thread top-level messages."
                    : "This channel only wakes agents when they are explicitly mentioned or already involved in a thread."}
              </div>
              {modeError ? (
                <div className="mt-2 rounded-sm border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700">
                  {modeError}
                </div>
              ) : null}
            </div>
            <div className="mt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Members</div>
              {members.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {members.map((agent) => (
                    <span
                      key={agent.agentId}
                      className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-[11px] text-zinc-700"
                    >
                      @{agent.name}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-xs text-zinc-500">No channel members yet.</div>
              )}
            </div>
            <div className="mt-4 border-t border-zinc-900/10 pt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Manage members</div>
              {isAdmin ? (
                <div className="mt-2 space-y-2">
                  {allAgents.length > 0 ? (
                    allAgents.map((agent) => {
                      const joined = memberAgentIds.has(agent.agentId);
                      const pending = membershipAgentId === agent.agentId;
                      return (
                        <div
                          key={agent.agentId}
                          className="flex items-center justify-between gap-3 rounded-sm border border-zinc-900/10 bg-white/70 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-zinc-900">@{agent.name}</div>
                            <div className="text-[11px] text-zinc-500">
                              {joined ? "Member of this channel" : "Not in this channel"}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            disabled={pending}
                            onClick={() => void handleMembershipToggle(agent.agentId, !joined)}
                            className={cn(
                              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
                              joined
                                ? "bg-[#fff0d0] text-zinc-950 hover:bg-[#ffe4b0]"
                                : "bg-[#d8f8c8] text-zinc-950 hover:bg-[#c8efb8]",
                            )}
                          >
                            {pending ? "Saving..." : joined ? "Remove" : "Add"}
                          </Button>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-xs text-zinc-500">No agents available.</div>
                  )}
                </div>
              ) : (
                <div className="mt-2 rounded-sm border border-zinc-900/10 bg-white/60 px-3 py-2 text-xs text-zinc-500">
                  Channel membership is managed by admins from this panel.
                </div>
              )}
              {membershipError ? (
                <div className="mt-2 rounded-sm border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700">
                  {membershipError}
                </div>
              ) : null}
            </div>
            <div className="mt-4 border-t border-zinc-900/10 pt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Subscribed agents</div>
              {channel.subscribedAgents && channel.subscribedAgents.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {channel.subscribedAgents.map((agent) => (
                    <span
                      key={agent.agentId}
                      className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-[11px] text-zinc-700"
                    >
                      @{agent.name}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-xs text-zinc-500">No subscribed agents.</div>
              )}
            </div>
            {channel.collaborationMode === "subscribed_agents" ? (
              <div className="mt-4 border-t border-zinc-900/10 pt-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Manage subscriptions</div>
                <div className="mt-2 space-y-2">
                  {members.length > 0 ? (
                    members.map((agent) => {
                      const subscribed = subscribedAgentIds.has(agent.agentId);
                      const pending = submittingAgentId === agent.agentId;
                      return (
                        <div
                          key={agent.agentId}
                          className="flex items-center justify-between gap-3 rounded-sm border border-zinc-900/10 bg-white/70 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-zinc-900">@{agent.name}</div>
                            <div className="text-[11px] text-zinc-500">
                              {subscribed ? "Subscribed to passive channel wakeups" : "Not subscribed"}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            disabled={pending || !isAdmin}
                            onClick={() => void handleSubscriptionToggle(agent.agentId, !subscribed)}
                            className={cn(
                              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
                              subscribed
                                ? "bg-[#ffd8d8] text-zinc-950 hover:bg-[#ffc6c6]"
                                : "bg-[#d8f8c8] text-zinc-950 hover:bg-[#c8efb8]",
                            )}
                          >
                            {pending ? "Saving..." : subscribed ? "Unsubscribe" : "Subscribe"}
                          </Button>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-xs text-zinc-500">No channel members available.</div>
                  )}
                </div>
                {subscriptionError ? (
                  <div className="mt-2 rounded-sm border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700">
                    {subscriptionError}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-4 rounded-sm border border-zinc-900/10 bg-white/60 px-3 py-2 text-xs text-zinc-500">
                Switch this channel to <span className="font-medium">subscribed agents</span> mode to manage passive wakeups here.
              </div>
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
            {clearError ? (
              <div className="mt-3 rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                {clearError}
              </div>
            ) : null}
            <Button
              size="sm"
              className="mt-3 rounded-sm border-2 border-zinc-900 bg-[#ffd8d8] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#ffc6c6]"
              onClick={() => setDialogOpen(true)}
              disabled={clearing || !isAdmin}
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
        message={`Clear chat history for #${channel.name}?\n\nThis will remove channel messages and thread replies, reset branch conversation activity for this channel, and clear this channel's task board.`}
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

export function ChannelPanel({
  channel,
  agents,
  isAdmin = false,
  onAgentsUpdated,
  onOpenAgentSession,
  onRestartConversation,
  onClearConversationChat,
  onOpenSidebar,
  onSeenSeq,
  onChannelUpdated,
}: ChannelPanelProps) {
  const [activeTab, setActiveTab] = useState<"chat" | "tasks" | "members" | "settings">("chat");
  const { messages, notices, sendMessage, loadMore, hasMore, resetVersion, taskVersion, resetHistory } = useChannelStream({
    channelId: channel.channelId,
    onSeenSeq,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const channelMemberIds = useMemo(
    () => new Set((channel.members ?? []).map((member) => member.agentId)),
    [channel.members],
  );
  const channelMembers = useMemo(
    () => channelMemberIds.size > 0
      ? agents.filter((agent) => channelMemberIds.has(agent.agentId))
      : agents.filter((agent) => agent.channelIds?.includes(channel.channelId) ?? false),
    [agents, channel.channelId, channelMemberIds],
  );
  const [openThread, setOpenThread] = useState<ChannelMessage | null>(null);
  const [branchInspectorConversation, setBranchInspectorConversation] = useState<ConversationInfo | null>(null);
  // Local task overrides: messageId → partial fields added after claim-message
  const [taskOverrides, setTaskOverrides] = useState<Map<string, Pick<ChannelMessage, 'taskNumber' | 'taskStatus' | 'taskAssigneeName'>>>(new Map());
  const [promoteMessage, setPromoteMessage] = useState<ChannelMessage | null>(null);
  const [promotingTask, setPromotingTask] = useState(false);
  const [promoteTaskError, setPromoteTaskError] = useState<string | null>(null);
  const branchInspectorAgent = useMemo(
    () => {
      if (!branchInspectorConversation?.agentId) return null;
      return agents.find((agent) => agent.agentId === branchInspectorConversation.agentId) ?? null;
    },
    [agents, branchInspectorConversation?.agentId],
  );

  const handleOpenTaskThread = useCallback((threadShortId: string) => {
    const msg = messages.find((m) => m.id.slice(0, 8) === threadShortId);
    if (msg) {
      setOpenThread(msg);
    }
    setActiveTab("chat");
  }, [messages]);

  const handleMakeTask = useCallback((message: ChannelMessage) => {
    setPromoteTaskError(null);
    setPromoteMessage(message);
  }, []);

  const handlePromoteTaskSubmit = useCallback(async ({ title, description }: TaskEditorValues) => {
    if (!promoteMessage || promotingTask) return;
    setPromotingTask(true);
    try {
      const task = await claimMessageAsTask(channel.channelId, promoteMessage.id, {
        title,
        description,
      });
      setTaskOverrides((prev) => {
        const next = new Map(prev);
        next.set(promoteMessage.id, {
          taskNumber: task.taskNumber,
          taskStatus: task.status,
          taskAssigneeName: task.assigneeName ?? null,
        });
        return next;
      });
      setPromoteMessage(null);
      setPromoteTaskError(null);
    } catch (err) {
      setPromoteTaskError(String((err as Error)?.message ?? err));
      console.error('[make-task]', err);
    } finally {
      setPromotingTask(false);
    }
  }, [channel.channelId, promoteMessage, promotingTask]);

  // Thread panel resize state
  const [threadPanelWidth, setThreadPanelWidth] = useState(320); // default 320px (w-80)
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  const MIN_THREAD_WIDTH = 280;
  const MAX_THREAD_WIDTH = 600;

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = threadPanelWidth;
  }, [threadPanelWidth]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = resizeStartX.current - e.clientX;
      const newWidth = Math.max(MIN_THREAD_WIDTH, Math.min(MAX_THREAD_WIDTH, resizeStartWidth.current + delta));
      setThreadPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

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
    setBranchInspectorConversation(null);
  }, [channel.channelId]);

  useEffect(() => {
    setOpenThread(null);
  }, [resetVersion]);

  useEffect(() => {
    if (!openThread) return;
    const nextRoot = messages.find((message) => message.id === openThread.id);
    if (nextRoot && nextRoot !== openThread) {
      setOpenThread(nextRoot);
    }
  }, [messages, openThread]);

  useEffect(() => {
    setTaskOverrides(new Map());
  }, [taskVersion]);

  const handleClearChat = useCallback(async () => {
    const result = await clearChannelChat(channel.channelId);
    await resetHistory();
    return result;
  }, [channel.channelId, resetHistory]);

  const handleOpenBranchInspector = useCallback(
    async (agentId: string, targetChannelId: string, threadRootId?: string | null) => {
      const conversation = await onOpenAgentSession?.(agentId, targetChannelId, threadRootId);
      if (conversation) {
        setBranchInspectorConversation(conversation);
        setActiveTab("chat");
      }
    },
    [onOpenAgentSession],
  );

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
        <TasksTab
          channelId={channel.channelId}
          channelAgents={channelMembers}
          onOpenThread={handleOpenTaskThread}
          taskVersion={taskVersion}
        />
      ) : activeTab === "members" ? (
        <MembersTab
          channelId={channel.channelId}
          members={channelMembers}
          onOpenSession={handleOpenBranchInspector}
        />
      ) : activeTab === "settings" ? (
        <SettingsTab
          channel={channel}
          members={channelMembers}
          allAgents={agents}
          isAdmin={isAdmin}
          onAgentsUpdated={onAgentsUpdated}
          onClearChat={handleClearChat}
          onChannelUpdated={onChannelUpdated}
        />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Main channel messages */}
          <div className={cn("flex min-h-0 flex-col overflow-hidden", openThread || branchInspectorConversation ? "flex-1" : "w-full")}>
            <ChannelStatusBar key={channel.channelId} notices={notices} />
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-2">
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fff8d8] px-6 py-5 text-center shadow-[2px_2px_0_0_rgba(0,0,0,0.06)]">
                    <HashIcon className="mx-auto mb-2 size-6 text-zinc-400" />
                    <p className="text-sm font-medium text-zinc-600">No messages yet</p>
                    <p className="mt-1 text-xs text-zinc-400">
                      Send the first message or create the first task-message in <span className="font-mono">#{channel.name}</span>
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
                  {messages.map((message) => {
                    const override = taskOverrides.get(message.id);
                    const merged = override ? { ...message, ...override } : message;
                    return (
                      <MessageRow
                        key={message.id}
                        message={merged}
                        onReply={setOpenThread}
                        onMakeTask={handleMakeTask}
                        agents={channelMembers}
                      />
                    );
                  })}
                </>
              )}
            </div>
            <ChannelComposer onSend={sendMessage} channelMembers={channelMembers} />
          </div>

          {branchInspectorConversation ? (
            <div className="flex h-full min-h-0 shrink-0 overflow-hidden">
              <div
                className={cn(
                  "w-1.5 cursor-col-resize bg-zinc-300 transition-colors hover:bg-zinc-400 active:bg-zinc-500",
                  isResizing && "bg-zinc-500"
                )}
                onMouseDown={handleResizeStart}
                title="Drag to resize"
              />
              <div className="h-full min-h-0 overflow-hidden" style={{ width: threadPanelWidth }}>
                <BranchInspectorPanel
                  conversation={branchInspectorConversation}
                  agent={branchInspectorAgent}
                  isAdmin={isAdmin}
                  onRestart={async (conversationId) => {
                    await onRestartConversation?.(conversationId);
                  }}
                  onClearChat={async (conversationId) => {
                    await onClearConversationChat?.(conversationId);
                  }}
                  onClose={() => setBranchInspectorConversation(null)}
                />
              </div>
            </div>
          ) : openThread ? (
            <div className="flex h-full min-h-0 shrink-0 overflow-hidden">
              {/* Resize handle */}
              <div
                className={cn(
                  "w-1.5 cursor-col-resize bg-zinc-300 transition-colors hover:bg-zinc-400 active:bg-zinc-500",
                  isResizing && "bg-zinc-500"
                )}
                onMouseDown={handleResizeStart}
                title="Drag to resize"
              />
              <div className="h-full min-h-0 overflow-hidden" style={{ width: threadPanelWidth }}>
                <ThreadPanel
                  channelId={channel.channelId}
                  channelName={channel.name}
                  rootMessage={openThread}
                  channelMembers={channelMembers}
                  taskVersion={taskVersion}
                  onOpenAgentSession={handleOpenBranchInspector}
                  onClose={() => setOpenThread(null)}
                  className="border-l-0"
                />
              </div>
            </div>
          ) : null}
        </div>
      )}
      <TaskEditorDialog
        isOpen={promoteMessage != null}
        dialogTitle="Promote Message To Task"
        submitLabel="Create task"
        initialTitle={promoteMessage ? deriveTaskTitleFromMessage(promoteMessage) : ""}
        initialDescription=""
        sourceMessage={promoteMessage ? {
          senderName: promoteMessage.senderName,
          content: promoteMessage.content,
        } : undefined}
        saving={promotingTask}
        error={promoteTaskError}
        onClose={() => {
          if (promotingTask) return;
          setPromoteMessage(null);
          setPromoteTaskError(null);
        }}
        onSubmit={handlePromoteTaskSubmit}
      />
    </div>
  );
}
