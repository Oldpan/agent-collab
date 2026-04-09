import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { XIcon, SendIcon, MessageSquareIcon, ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildThreadShortId, type AgentInfo } from "@agent-collab/protocol";
import {
  type ChannelMessage,
  type ThreadCollaborationSummary,
  updateChannelTaskDetails,
} from "@/lib/api";
import { useThreadStream } from "@/hooks/useThreadStream";
import { Streamdown } from "streamdown";
import {
  safeRehypePlugins,
  safeRemarkPlugins,
  streamdownComponents,
  streamdownRootClass,
  escapeHtmlOutsideCodeBlocks,
} from "@/components/ai-elements/streamdown";
import { MessageSourceBadge } from "@/components/MessageSourceBadge";
import { TaskEditorDialog, type TaskEditorValues } from "./TaskEditorDialog";

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

function hasTaskBrief(description?: string | null): boolean {
  return Boolean(description?.trim());
}

function ThreadMessage({
  message,
  agent,
  channelId,
  threadRootId,
  highlighted = false,
  onOpenAgentSession,
}: {
  message: ChannelMessage;
  agent?: AgentInfo;
  channelId: string;
  threadRootId: string;
  highlighted?: boolean;
  onOpenAgentSession?: (agentId: string, channelId: string, threadRootId?: string | null) => Promise<void> | void;
}) {
  const isUser = message.senderType === "user";
  const showFallbackBadge = message.messageSource === "delta_fallback" && !isUser;
  return (
    <div
      data-message-id={message.id}
      className={cn(
        "flex gap-2.5 px-4 py-2 transition-colors",
        isUser ? "flex-row-reverse" : "flex-row",
        highlighted && "bg-[#fff1a9]",
      )}
    >
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-zinc-900 text-[10px] font-bold shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
          isUser ? "bg-[#d8efff] text-blue-800" : "bg-[#d8f8c8] text-green-800",
        )}
        title={message.senderName}
      >
        {message.senderName.slice(0, 2).toUpperCase()}
      </div>
      <div className={cn("min-w-0 flex flex-col", isUser ? "items-end text-left" : "items-start text-left")}>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[11px] font-semibold text-zinc-700">{message.senderName}</span>
          <span className="text-[10px] text-zinc-400">{formatTime(message.createdAt)}</span>
        </div>
        {!isUser && agent && onOpenAgentSession && (
          <div className="mt-1">
            <Button
              size="sm"
              variant="outline"
              className="h-6 rounded-sm border-2 border-zinc-900 bg-[#fffdf4] px-2 text-[10px] text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#fff1a9]"
              onClick={() => void onOpenAgentSession(agent.agentId, channelId, threadRootId)}
            >
              Inspect branch
            </Button>
          </div>
        )}
        <div
          className={cn(
            "relative mt-0.5 w-fit min-w-[20px] rounded-md border-2 border-zinc-900 px-3 py-2 text-sm shadow-[2px_2px_0_0_rgba(0,0,0,0.1)]",
            isUser ? "bg-[#d8efff] text-zinc-900" : "bg-[#d8f8c8] text-zinc-900",
          )}
        >
          {showFallbackBadge && (
            <div className="absolute -top-2.5 right-1.5 z-10">
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
      </div>
    </div>
  );
}

function ThreadSummaryCard({
  summary,
  onEditTask,
}: {
  summary?: ThreadCollaborationSummary | null;
  onEditTask?: () => void;
}) {
  const participants = summary?.participants ?? [];
  const hasBoundTask = Boolean(summary?.boundTask);
  const brief = summary?.boundTask?.description?.trim();

  return (
    <div className="shrink-0 max-h-48 overflow-y-auto border-b-2 border-zinc-300 bg-[#fff7cc] px-4 py-3">
      <div className="grid gap-2 md:grid-cols-3">
        <div className="rounded-md border-2 border-zinc-900 bg-[#fffdf4] px-3 py-2 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Bound task-message</div>
            {hasBoundTask && onEditTask && (
              <Button
                size="sm"
                className="h-6 rounded-sm border-2 border-zinc-900 bg-[#d8efff] px-2 text-[10px] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#b8e0ff]"
                onClick={onEditTask}
              >
                Edit
              </Button>
            )}
          </div>
          <div className="mt-1 text-sm font-medium text-zinc-900">
            {hasBoundTask ? `#${summary?.boundTask?.taskNumber} ${summary?.boundTask?.title}` : "Not a task thread"}
          </div>
          {hasBoundTask && (
            <div className={cn(
              "mt-2 rounded-sm border px-2 py-1.5 text-[11px]",
              hasTaskBrief(summary?.boundTask?.description)
                ? "border-zinc-300 bg-white text-zinc-700"
                : "border-amber-300 bg-amber-50 text-amber-800",
            )}>
              {brief ?? "Task brief missing. Add the goal and done criteria so this thread has a concrete target."}
            </div>
          )}
          <div className="mt-1 text-[11px] text-zinc-500">
            {summary?.boundTask?.linkedThreadShortId
              ? `Task thread ${summary.boundTask.linkedThreadShortId}`
              : "No linked task thread"}
          </div>
          <div className="mt-3 text-[11px] text-zinc-500">
            {hasBoundTask
              ? "Task threads are fixed to their task-message root."
              : "This thread is not a task thread."}
          </div>
        </div>

        <div className="rounded-md border-2 border-zinc-900 bg-[#fffdf4] px-3 py-2 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Owner</div>
          <div className="mt-1 text-sm font-medium text-zinc-900">{summary?.ownerName ? `@${summary.ownerName}` : "No owner"}</div>
          <div className="mt-1 text-[11px] text-zinc-500">
            {summary?.boundTask ? "Owner follows the current task-message assignee while work is active." : "Ownership appears when work happens in this thread."}
          </div>
        </div>

        <div className="rounded-md border-2 border-zinc-900 bg-[#fffdf4] px-3 py-2 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Participants</div>
          {participants.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {participants.map((name) => (
                <span
                  key={name}
                  className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-[11px] text-zinc-700"
                >
                  @{name}
                </span>
              ))}
            </div>
          ) : (
            <div className="mt-1 text-sm font-medium text-zinc-900">No participants yet</div>
          )}
          <div className="mt-1 text-[11px] text-zinc-500">
            Agents who have recently worked in this task thread appear here.
          </div>
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
    if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); void handleSubmit(); }
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
          placeholder="Reply in thread... (Enter for newline, Shift+Enter to send)"
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
  taskVersion?: number;
  focusMessageId?: string | null;
  focusRequestId?: number | null;
  onOpenAgentSession?: (agentId: string, channelId: string, threadRootId?: string | null) => Promise<void> | void;
  onClose: () => void;
  className?: string;
};

export function ThreadPanel({
  channelId,
  channelName,
  rootMessage,
  channelMembers,
  taskVersion = 0,
  focusMessageId,
  focusRequestId,
  onOpenAgentSession,
  onClose,
  className,
}: ThreadPanelProps) {
  const threadRootId = buildThreadShortId(rootMessage.id);
  const { messages, summary, sendMessage, loadMore, hasMore } = useThreadStream(
    channelId,
    threadRootId,
    focusMessageId,
    focusRequestId,
    taskVersion,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const isRootUser = rootMessage.senderType === "user";
  const rootAgent = useMemo(
    () => channelMembers.find((agent) => agent.name === rootMessage.senderName),
    [channelMembers, rootMessage.senderName],
  );
  const [showSummary, setShowSummary] = useState(false);
  const [summaryState, setSummaryState] = useState<ThreadCollaborationSummary | null>(null);
  const [isEditingTask, setIsEditingTask] = useState(false);
  const [editingTaskError, setEditingTaskError] = useState<string | null>(null);
  const [savingTaskDetails, setSavingTaskDetails] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [consumedFocusRequestId, setConsumedFocusRequestId] = useState<number | null>(null);

  useEffect(() => {
    setSummaryState(summary);
  }, [summary]);

  useEffect(() => {
    if (summaryState?.boundTask) return;
    setIsEditingTask(false);
    setEditingTaskError(null);
  }, [summaryState?.boundTask]);

  useEffect(() => {
    if (focusMessageId && focusRequestId != null && focusRequestId !== consumedFocusRequestId) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [consumedFocusRequestId, focusMessageId, focusRequestId, messages]);

  useEffect(() => {
    if (!focusMessageId || focusRequestId == null || focusRequestId === consumedFocusRequestId) return;
    const container = scrollRef.current;
    if (!container) return;
    const node = container.querySelector<HTMLElement>(`[data-message-id="${focusMessageId}"]`);
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightedMessageId(focusMessageId);
    setConsumedFocusRequestId(focusRequestId);
    const timer = window.setTimeout(() => {
      setHighlightedMessageId((current) => (current === focusMessageId ? null : current));
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [consumedFocusRequestId, focusMessageId, focusRequestId, messages]);

  const handleTaskEditSubmit = useCallback(async ({ title, description }: TaskEditorValues) => {
    const boundTask = summaryState?.boundTask;
    if (!boundTask || savingTaskDetails) return;
    setSavingTaskDetails(true);
    setEditingTaskError(null);
    try {
      const updated = await updateChannelTaskDetails(channelId, boundTask.taskNumber, title, description);
      setSummaryState((prev) => {
        if (!prev?.boundTask) return prev;
        return {
          ...prev,
          boundTask: {
            ...prev.boundTask,
            ...updated,
          },
        };
      });
      setIsEditingTask(false);
    } catch (err) {
      setEditingTaskError(String((err as Error)?.message ?? err));
    } finally {
      setSavingTaskDetails(false);
    }
  }, [channelId, savingTaskDetails, summaryState?.boundTask]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col border-l-2 border-zinc-900 bg-[#fefce8]", className)}>
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b-2 border-zinc-900 bg-[#fffdf5] px-4 py-3 shadow-[0_2px_0_0_rgba(0,0,0,0.08)]">
        <div className="flex items-center gap-2">
          <MessageSquareIcon className="size-4 text-zinc-600" />
          <span className="text-sm font-semibold text-zinc-900">{rootMessage.taskNumber != null ? `Task thread #${rootMessage.taskNumber}` : "Thread"}</span>
          <span className="text-xs text-zinc-400">in #{channelName}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowSummary((v) => !v)}
            className="flex items-center gap-1 rounded-md border-2 border-zinc-900 bg-[#fff9d8] px-2 py-1 text-[11px] text-zinc-600 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)] hover:bg-[#fff1a9] cursor-pointer"
            aria-label="Toggle summary"
            title="Toggle task/member summary"
          >
            Info
            <ChevronDownIcon className={cn("size-3 transition-transform", showSummary && "rotate-180")} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border-2 border-zinc-900 bg-[#fff9d8] p-1 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)] hover:bg-[#fff1a9] cursor-pointer"
            aria-label="Close thread"
          >
            <XIcon className="size-3.5 text-zinc-700" />
          </button>
        </div>
      </div>

      {/* Root message */}
      <div className="shrink-0 border-b-2 border-dashed border-zinc-300 bg-[#fffdf5]">
        <div className={cn("flex gap-2.5 px-4 py-3", isRootUser ? "flex-row-reverse" : "flex-row")}>
          <div
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-zinc-900 text-[10px] font-bold shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              isRootUser ? "bg-[#d8efff] text-blue-800" : "bg-[#d8f8c8] text-green-800",
            )}
          >
            {rootMessage.senderName.slice(0, 2).toUpperCase()}
          </div>
          <div className={cn("min-w-0 flex flex-col", isRootUser ? "items-end text-left" : "items-start text-left")}>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[11px] font-semibold text-zinc-700">{rootMessage.senderName}</span>
              <span className="text-[10px] text-zinc-400">{formatTime(rootMessage.createdAt)}</span>
            </div>
            {!isRootUser && rootAgent && onOpenAgentSession && (
              <div className="mt-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 rounded-sm border-2 border-zinc-900 bg-[#fffdf4] px-2 text-[10px] text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#fff1a9]"
                  onClick={() => void onOpenAgentSession(rootAgent.agentId, channelId, threadRootId)}
                >
                  Open agent session
                </Button>
              </div>
            )}
            <div
              className={cn(
                "mt-0.5 w-fit min-w-[20px] rounded-md border-2 border-zinc-900 px-3 py-2 text-sm shadow-[2px_2px_0_0_rgba(0,0,0,0.1)]",
                isRootUser ? "bg-[#d8efff] text-zinc-900" : "bg-[#d8f8c8] text-zinc-900",
              )}
            >
              {isRootUser ? (
                <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {renderContent(rootMessage.content)}
                </span>
              ) : (
                <Streamdown
                  className={cn("text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", streamdownRootClass)}
                  components={streamdownComponents}
                  rehypePlugins={safeRehypePlugins}
                  remarkPlugins={safeRemarkPlugins}
                >
                  {escapeHtmlOutsideCodeBlocks(rootMessage.content)}
                </Streamdown>
              )}
            </div>
          </div>
        </div>
        {messages.length > 0 && (
          <div className="px-4 pb-2 text-[11px] text-zinc-500">
            {messages.length} {messages.length === 1 ? "reply" : "replies"}
          </div>
        )}
      </div>

      {showSummary && (
        <ThreadSummaryCard
          summary={summaryState}
          onEditTask={summaryState?.boundTask ? () => {
            setEditingTaskError(null);
            setIsEditingTask(true);
          } : undefined}
        />
      )}

      {/* Thread replies */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-2">
        {messages.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-zinc-400">
            No replies yet. Be the first to reply!
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
                  Load earlier replies
                </button>
              </div>
            )}
            {messages.map((msg) => (
              <ThreadMessage
                key={msg.id}
                message={msg}
                agent={channelMembers.find((agent) => agent.name === msg.senderName)}
                channelId={channelId}
                threadRootId={threadRootId}
                highlighted={highlightedMessageId === msg.id}
                onOpenAgentSession={onOpenAgentSession}
              />
            ))}
          </>
        )}
      </div>

      <ThreadComposer onSend={sendMessage} channelMembers={channelMembers} />
      <TaskEditorDialog
        isOpen={isEditingTask && Boolean(summaryState?.boundTask)}
        dialogTitle={summaryState?.boundTask ? `Edit Task #${summaryState.boundTask.taskNumber}` : "Edit task"}
        submitLabel="Save changes"
        initialTitle={summaryState?.boundTask?.title ?? ""}
        initialDescription={summaryState?.boundTask?.description ?? ""}
        saving={savingTaskDetails}
        error={editingTaskError}
        onClose={() => {
          if (savingTaskDetails) return;
          setIsEditingTask(false);
          setEditingTaskError(null);
        }}
        onSubmit={handleTaskEditSubmit}
      />
    </div>
  );
}
