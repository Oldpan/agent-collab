import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Confirmation } from "@/components/ai-elements/confirmation";
import { Loader } from "@/components/ai-elements/loader";
import {
  Message,
  MessageContent,
  MessageResponse,
  UserMessageContent,
  MessageActions,
  MessageCopyButton,
} from "@/components/ai-elements/message";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
  type ToolState,
} from "@/components/ai-elements/tool";
import { useConversationStream } from "@/hooks/useConversationStream";
import { ChevronRightIcon, ListTodoIcon, MenuIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

function AttachmentImage({ attachmentId }: { attachmentId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const token = localStorage.getItem("auth_token") ?? "";
    fetch(`/api/attachments/${attachmentId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.blob())
      .then((blob) => setSrc(URL.createObjectURL(blob)))
      .catch(() => {});
  }, [attachmentId]);
  if (!src) return null;
  return <img src={src} alt="attachment" className="mt-1.5 max-h-64 max-w-full rounded border border-zinc-200 object-contain" />;
}
import { PromptComposer } from "./PromptComposer";
import { AgentWorkspacePanel } from "./AgentWorkspacePanel";
import { AgentSkillsPanel } from "./AgentSkillsPanel";
import { AgentProfilePanel } from "./AgentProfilePanel";
import { AgentActivityPanel } from "./AgentActivityPanel";
import { AgentTasksPanel } from "./AgentTasksPanel";
import { CodexDebugPanel } from "./CodexDebugPanel";
import { DmTaskThreadPanel } from "./DmTaskThreadPanel";
import { ChatAvatar, readStoredUserIdentity } from "./ChatAvatar";
import { AgentSettingsPanel } from "./AgentSettingsPanel";
import type { AgentInfo, ConversationInfo, UpdateAgentRequest } from "@agent-collab/protocol";
import { openConversationThread, type AgentTask } from "@/lib/api";
import type { LiveMessage, LiveToolCall } from "@/hooks/types";
import { cn } from "@/lib/utils";
import { MessageSourceBadge } from "@/components/MessageSourceBadge";

type ChatPanelProps = {
  conversation: ConversationInfo;
  agent: AgentInfo | null;
  isAdmin?: boolean;
  onOpenSidebar?: () => void;
  onSeenSeq?: (seq: number) => void;
  onUpdateAgent?: (id: string, req: UpdateAgentRequest) => Promise<void>;
  onRestartConversation?: (id: string) => Promise<void>;
  onClearConversationChat?: (id: string) => Promise<void>;
  onResetAgent?: (id: string) => Promise<void>;
  onOpenTask?: (task: AgentTask) => void;
};

/** Determine tool display state from LiveToolCall */
function getToolState(tc: LiveToolCall): ToolState {
  if (tc.status === "cancelled") return "cancelled";
  if (tc.status === "failed" || tc.error) return "error";
  if (tc.status === "completed" || tc.completed || tc.output !== undefined) return "result";
  return "calling";
}

const messageTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const taskLifecycleTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

const taskLifecycleDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
});

const taskLifecycleYearFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
});

type TaskLifecycleKind = "started" | "in_review" | "done" | "handoff_failed" | "unknown";

function getTaskLifecycleKind(message: LiveMessage): TaskLifecycleKind {
  const normalized = message.text.toLowerCase();
  if (normalized.includes("could not start its task thread automatically")) return "handoff_failed";
  if (normalized.includes("moved to in review")) return "in_review";
  if (normalized.includes("marked done")) return "done";
  if (normalized.startsWith("started ")) return "started";
  if (message.taskStatus === "in_review") return "in_review";
  if (message.taskStatus === "done") return "done";
  if (message.taskStatus === "in_progress") return "started";
  return "unknown";
}

function getTaskLifecycleTitle(message: LiveMessage): { taskNumber: number | null; title: string | null } {
  const matched = message.text.match(/#(\d+)\s+"([^"]+)"/);
  if (!matched) {
    return {
      taskNumber: message.taskNumber ?? null,
      title: null,
    };
  }
  return {
    taskNumber: Number(matched[1]),
    title: matched[2] ?? null,
  };
}

function formatTaskLifecyclePrimaryText(message: LiveMessage): string {
  const { taskNumber, title } = getTaskLifecycleTitle(message);
  const taskLabel = title
    ? `Task #${taskNumber ?? "?"} "${title}"`
    : taskNumber != null
      ? `Task #${taskNumber}`
      : "Task";

  switch (getTaskLifecycleKind(message)) {
    case "started":
      return `${taskLabel} started`;
    case "in_review":
      return `${taskLabel} moved to in review`;
    case "done":
      return `${taskLabel} marked done`;
    case "handoff_failed":
      return `${taskLabel} failed to start its task thread`;
    default:
      return message.text;
  }
}

function getTaskLifecycleLead(message: LiveMessage, actorName: string | null): string {
  const { taskNumber, title } = getTaskLifecycleTitle(message);
  const taskLabel = title
    ? `#${taskNumber ?? "?"} "${title}"`
    : taskNumber != null
      ? `#${taskNumber}`
      : "task";
  const actor = actorName ?? "System";

  switch (getTaskLifecycleKind(message)) {
    case "started":
      return `🚀 ${actor} started ${taskLabel}`;
    case "in_review":
      return `👀 ${actor} moved ${taskLabel} to In Review`;
    case "done":
      return `✅ ${actor} moved ${taskLabel} to Done`;
    case "handoff_failed":
      return `⚠️ ${actor} failed to start ${taskLabel}`;
    default:
      return formatTaskLifecyclePrimaryText(message);
  }
}

function getShanghaiDayStamp(timestamp: number): number {
  const parts = taskLifecycleDateFormatter.formatToParts(timestamp);
  const year = Number(taskLifecycleYearFormatter.format(timestamp));
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "1");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "1");
  return Date.UTC(year, month - 1, day);
}

function formatTaskLifecycleTimestamp(timestamp: number): string {
  const now = Date.now();
  const dayDiff = Math.round((getShanghaiDayStamp(now) - getShanghaiDayStamp(timestamp)) / 86_400_000);
  const timeText = taskLifecycleTimeFormatter.format(timestamp);
  if (dayDiff === 0) return `Today ${timeText}`;
  if (dayDiff === 1) return `Yesterday ${timeText}`;
  return `${taskLifecycleDateFormatter.format(timestamp)} ${timeText}`;
}

function isDispatchFailureError(error?: string): boolean {
  return error === "Node not connected" || error === "Node disconnected during dispatch";
}

/** Main chat panel: header + messages + composer */
export function ChatPanel({
  conversation,
  agent,
  isAdmin = false,
  onOpenSidebar,
  onSeenSeq,
  onUpdateAgent,
  onRestartConversation,
  onClearConversationChat,
  onResetAgent,
  onOpenTask,
}: ChatPanelProps) {
  const [activeTab, setActiveTab] = useState<"chat" | "activity" | "task" | "debug" | "workspace" | "skills" | "profile" | "setting">("chat");
  const [dmThreadConversation, setDmThreadConversation] = useState<ConversationInfo | null>(null);
  const [dmThreadRootMessage, setDmThreadRootMessage] = useState<LiveMessage | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [openingThreadMessageId, setOpeningThreadMessageId] = useState<string | null>(null);
  const userIdentity = useMemo(() => readStoredUserIdentity(), []);
  const {
    messages,
    pendingMessages,
    runs,
    status,
    connectionReady,
    hasActiveRun,
    pendingApproval,
    sendPrompt,
    respondApproval,
    cancel,
  } = useConversationStream({
    conversationId: conversation.id,
    conversationAgentId: conversation.agentId,
    onSeenSeq,
  });

  const hasAssistantReply = messages.some(
    (message) => message.role === "assistant" && message.text.trim().length > 0,
  );
  const latestRun = runs.at(-1);
  const hasDispatchFailure = Boolean(latestRun?.error && isDispatchFailureError(latestRun.error));
  const hasPendingActivity =
    hasActiveRun ||
    status === "submitted" ||
    status === "queued" ||
    status === "streaming" ||
    status === "recovering" ||
    status === "awaiting_approval";
  const shouldShowCancel =
    hasActiveRun ||
    status === "submitted" ||
    status === "streaming" ||
    status === "recovering" ||
    status === "awaiting_approval";
  const shouldDisableInput = false;
  const canShowCodexDebug = isAdmin && (conversation.agentType === "codex_acp" || conversation.agentType === "claude_acp");
  const isPrimaryDirectConversation = conversation.threadKind === "direct" && Boolean(conversation.isPrimaryThread);

  const displayStatus =
    hasDispatchFailure && status !== "submitted" && status !== "streaming"
      ? "unavailable"
      : status === "submitted" || status === "streaming"
      ? "active"
      : status === "queued"
        ? "queued"
      : status === "recovering"
        ? "recovering"
      : status === "awaiting_approval"
        ? "awaiting_approval"
        : status === "error"
          ? hasAssistantReply
            ? "idle"
            : "failed"
          : conversation.status === "failed" && hasAssistantReply
            ? "idle"
            : conversation.status;

  useEffect(() => {
    setActiveTab("chat");
    setDmThreadConversation(null);
    setDmThreadRootMessage(null);
    setThreadError(null);
    setOpeningThreadMessageId(null);
  }, [conversation.id]);

  const handleOpenDmTaskThread = useCallback(async (message: LiveMessage, threadRootId?: string | null) => {
    if (!isPrimaryDirectConversation) return;
    setOpeningThreadMessageId(message.id);
    setThreadError(null);
    try {
      const thread = await openConversationThread(
        conversation.id,
        threadRootId
          ? { threadRootId }
          : { messageId: message.id },
      );
      setDmThreadConversation(thread);
      setDmThreadRootMessage(message);
    } catch (error) {
      setThreadError(String((error as Error)?.message ?? error));
    } finally {
      setOpeningThreadMessageId(null);
    }
  }, [conversation.id, isPrimaryDirectConversation]);

  const handleTaskOpen = useCallback((task: AgentTask) => {
    if (task.sourceType === "dm" && isPrimaryDirectConversation && task.messageId) {
      setActiveTab("chat");
      setThreadError(null);
      const existing = messages.find((message) => message.id === task.messageId);
      const rootMessage: LiveMessage = existing ?? {
        id: task.messageId,
        role: "user",
        text: task.title,
        createdAt: task.createdAt,
        isStreaming: false,
        taskNumber: task.taskNumber,
        taskStatus: task.status,
        taskAssigneeName: task.assigneeName ?? null,
      };
      void handleOpenDmTaskThread(rootMessage, task.linkedThreadShortId ?? null);
      return;
    }
    onOpenTask?.(task);
  }, [handleOpenDmTaskThread, isPrimaryDirectConversation, messages, onOpenTask]);

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
              <StatusDot status={displayStatus} />
              <h2 className="truncate text-sm font-semibold tracking-tight text-zinc-950">
                {agent?.name ?? "Agent"}
              </h2>
            </div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
              {conversation.isPrimaryThread ? "Private chat" : "Channel branch"}
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant={activeTab === "chat" ? "default" : "outline"}
            className={cn(
              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              activeTab === "chat" ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]" : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("chat")}
          >
            Chat
          </Button>
          <Button
            size="sm"
            variant={activeTab === "activity" ? "default" : "outline"}
            className={cn(
              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              activeTab === "activity" ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]" : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("activity")}
          >
            Activity
            {hasPendingActivity && (
              <span className="ml-1.5 size-1.5 rounded-full bg-amber-500 animate-pulse inline-block" />
            )}
          </Button>
          <Button
            size="sm"
            variant={activeTab === "task" ? "default" : "outline"}
            className={cn(
              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              activeTab === "task" ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]" : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("task")}
          >
            <ListTodoIcon className="mr-1.5 size-3" />
            Task
          </Button>
          {canShowCodexDebug && (
            <Button
              size="sm"
              variant={activeTab === "debug" ? "default" : "outline"}
              className={cn(
                "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
                activeTab === "debug" ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]" : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
              )}
              onClick={() => setActiveTab("debug")}
            >
              Debug
            </Button>
          )}
          <Button
            size="sm"
            variant={activeTab === "workspace" ? "default" : "outline"}
            className={cn(
              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              activeTab === "workspace" ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]" : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("workspace")}
          >
            Workspace
          </Button>
          <Button
            size="sm"
            variant={activeTab === "skills" ? "default" : "outline"}
            className={cn(
              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              activeTab === "skills" ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]" : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("skills")}
          >
            Skills
          </Button>
          <Button
            size="sm"
            variant={activeTab === "profile" ? "default" : "outline"}
            className={cn(
              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              activeTab === "profile" ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]" : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("profile")}
          >
            Profile
          </Button>
          <Button
            size="sm"
            variant={activeTab === "setting" ? "default" : "outline"}
            className={cn(
              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              activeTab === "setting" ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]" : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("setting")}
          >
            Setting
          </Button>
        </div>
      </div>

      {activeTab === "workspace" ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <AgentWorkspacePanel agent={agent} />
        </div>
      ) : activeTab === "skills" ? (
        agent ? (
          <div className="flex flex-1 flex-col overflow-hidden">
            <AgentSkillsPanel
              agent={agent}
              isAdmin={isAdmin}
              onUpdate={(req) => onUpdateAgent?.(agent.agentId, req) ?? Promise.resolve()}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Agent skills unavailable.
          </div>
        )
      ) : activeTab === "profile" ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <AgentProfilePanel agent={agent} />
        </div>
      ) : activeTab === "setting" ? (
        agent ? (
          <div className="flex flex-1 flex-col overflow-hidden">
            <AgentSettingsPanel
              agent={agent}
              isAdmin={isAdmin}
              onUpdate={(req) => onUpdateAgent?.(agent.agentId, req) ?? Promise.resolve()}
              onRestart={() => onRestartConversation?.(conversation.id) ?? Promise.resolve()}
              onClearChat={() => onClearConversationChat?.(conversation.id) ?? Promise.resolve()}
              onReset={() => onResetAgent?.(agent.agentId) ?? Promise.resolve()}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Agent settings unavailable.
          </div>
        )
      ) : activeTab === "activity" ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <AgentActivityPanel runs={runs} />
        </div>
      ) : activeTab === "task" ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <AgentTasksPanel
            agent={agent}
            conversation={conversation}
            onOpenTask={handleTaskOpen}
          />
        </div>
      ) : activeTab === "debug" ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          {isPrimaryDirectConversation ? (
            <div className="mx-4 mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              This debug view shows the main DM conversation run. If a task was handed off to a task thread, detailed work and debug appear in that thread.
            </div>
          ) : null}
          <CodexDebugPanel conversationId={conversation.id} />
        </div>
      ) : (
        dmThreadConversation && dmThreadRootMessage ? (
          <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
            <ResizablePanel defaultSize={72} minSize={45}>
              <div className="min-w-0 flex h-full flex-col">
                <Conversation className="min-h-0 flex-1 bg-[#fff9d0]">
                  <ConversationContent className="px-3 py-4">
                    {threadError ? (
                      <div className="mx-1 mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
                        {threadError}
                      </div>
                    ) : null}
                    {messages.length === 0 && pendingMessages.length === 0 ? (
                      <ConversationEmptyState
                        title="Start the conversation"
                        description="Send a message to begin"
                      />
                    ) : (
                      messages.map((msg) => (
                        <MessageRow
                          key={msg.id}
                          message={msg}
                          agent={agent}
                          userName={userIdentity.name}
                          userIdentity={userIdentity}
                          onOpenThread={isPrimaryDirectConversation ? () => void handleOpenDmTaskThread(msg) : undefined}
                          openingThread={openingThreadMessageId === msg.id}
                        />
                      ))
                    )}

                    {pendingApproval && (
                      <div className="mx-1 mt-2 mb-3 rounded-md border-2 border-zinc-900 bg-[#fff7d1] p-3 shadow-[4px_4px_0_0_rgba(0,0,0,0.12)]">
                        <Confirmation
                          toolName={pendingApproval.toolName}
                          toolArgs={pendingApproval.toolArgs}
                          onAllow={() => respondApproval(pendingApproval.requestId, "allow")}
                          onDeny={() => respondApproval(pendingApproval.requestId, "deny")}
                        />
                      </div>
                    )}

                    {(status === "queued" || status === "recovering" || status === "awaiting_approval") && (
                      <div className="mx-1 mt-2 mb-3 flex items-center gap-2 rounded-md border-2 border-zinc-900 bg-[#fffce8] px-3 py-2 text-sm text-zinc-600 shadow-[4px_4px_0_0_rgba(0,0,0,0.1)]">
                        <Loader size={14} />
                        <span>
                          {status === "queued"
                            ? "Waiting for the current conversation to finish..."
                            : status === "recovering"
                              ? "Recovering session..."
                            : "Waiting for approval..."}
                        </span>
                      </div>
                    )}

                    {pendingMessages.map((msg) => (
                      <PendingMessageRow
                        key={msg.id}
                        text={msg.text}
                        createdAt={msg.createdAt}
                        attachmentIds={msg.attachmentIds}
                        userName={userIdentity.name}
                        userIdentity={userIdentity}
                        agent={agent}
                      />
                    ))}
                  </ConversationContent>
                  <ConversationScrollButton />
                </Conversation>

                <PromptComposer
                  status={status}
                  ready={connectionReady}
                  showCancel={shouldShowCancel}
                  disableInput={shouldDisableInput}
                  onSend={sendPrompt}
                  onCancel={cancel}
                />
              </div>
            </ResizablePanel>

            <ResizableHandle />

            <ResizablePanel defaultSize={28} minSize={22} maxSize={55}>
              <div className="h-full border-l-2 border-black bg-[#fff5c2]">
                <DmTaskThreadPanel
                  conversation={dmThreadConversation}
                  agent={agent}
                  rootMessage={dmThreadRootMessage}
                  isAdmin={isAdmin}
                  onClose={() => {
                    setDmThreadConversation(null);
                    setDmThreadRootMessage(null);
                    setThreadError(null);
                  }}
                />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <div className="min-h-0 flex flex-1">
            <div className="min-w-0 flex flex-1 flex-col">
              <Conversation className="min-h-0 flex-1 bg-[#fff9d0]">
                <ConversationContent className="px-3 py-4">
                  {threadError ? (
                    <div className="mx-1 mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
                      {threadError}
                    </div>
                  ) : null}
                  {messages.length === 0 && pendingMessages.length === 0 ? (
                    <ConversationEmptyState
                      title="Start the conversation"
                      description="Send a message to begin"
                    />
                  ) : (
                    messages.map((msg) => (
                      <MessageRow
                        key={msg.id}
                        message={msg}
                        agent={agent}
                        userName={userIdentity.name}
                        userIdentity={userIdentity}
                        onOpenThread={isPrimaryDirectConversation ? () => void handleOpenDmTaskThread(msg) : undefined}
                        openingThread={openingThreadMessageId === msg.id}
                      />
                    ))
                  )}

                  {pendingApproval && (
                    <div className="mx-1 mt-2 mb-3 rounded-md border-2 border-zinc-900 bg-[#fff7d1] p-3 shadow-[4px_4px_0_0_rgba(0,0,0,0.12)]">
                      <Confirmation
                        toolName={pendingApproval.toolName}
                        toolArgs={pendingApproval.toolArgs}
                        onAllow={() => respondApproval(pendingApproval.requestId, "allow")}
                        onDeny={() => respondApproval(pendingApproval.requestId, "deny")}
                      />
                    </div>
                  )}

                  {(status === "queued" || status === "recovering" || status === "awaiting_approval") && (
                    <div className="mx-1 mt-2 mb-3 flex items-center gap-2 rounded-md border-2 border-zinc-900 bg-[#fffce8] px-3 py-2 text-sm text-zinc-600 shadow-[4px_4px_0_0_rgba(0,0,0,0.1)]">
                      <Loader size={14} />
                      <span>
                        {status === "queued"
                          ? "Waiting for the current conversation to finish..."
                          : status === "recovering"
                            ? "Recovering session..."
                          : "Waiting for approval..."}
                      </span>
                    </div>
                  )}

                  {pendingMessages.map((msg) => (
                    <PendingMessageRow
                      key={msg.id}
                      text={msg.text}
                      createdAt={msg.createdAt}
                      attachmentIds={msg.attachmentIds}
                      userName={userIdentity.name}
                      userIdentity={userIdentity}
                      agent={agent}
                    />
                  ))}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>

              <PromptComposer
                status={status}
                ready={connectionReady}
                showCancel={shouldShowCancel}
                disableInput={shouldDisableInput}
                onSend={sendPrompt}
                onCancel={cancel}
              />
            </div>
          </div>
        )
      )}
    </div>
  );
}

/** Render a single user, assistant, or system message */
function MessageRow({
  message,
  agent,
  userName,
  userIdentity,
  onOpenThread,
  openingThread = false,
}: {
  message: LiveMessage;
  agent: AgentInfo | null;
  userName: string;
  userIdentity: { name: string; avatarUrl: string | null };
  onOpenThread?: () => void;
  openingThread?: boolean;
}) {
  if (message.messageSource === "task_lifecycle") {
    const agentLabel = message.taskAssigneeName ?? agent?.name ?? null;
    return (
      <div className="px-1 py-2">
        <div className="mx-auto w-fit max-w-[720px] text-center text-[12px] font-normal text-zinc-500">
          {`${formatTaskLifecycleTimestamp(message.createdAt)} · ${getTaskLifecycleLead(message, agentLabel)}`}
        </div>
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <div className="flex items-center gap-2 py-2 px-1">
        <div className="h-px flex-1 bg-zinc-900/10" />
        <span className="shrink-0 rounded-sm border border-zinc-900/20 bg-[#fffce8] px-2 py-0.5 text-[11px] text-zinc-500">
          {message.text}
        </span>
        <div className="h-px flex-1 bg-zinc-900/10" />
      </div>
    );
  }

  const isUser = message.role === "user";
  const hasThreadSurface = Boolean(onOpenThread && (message.taskNumber != null || (message.replyCount ?? 0) > 0));
  const displayName = isUser ? userName : (agent?.name ?? "Agent");
  const displayRole = isUser ? "Owner" : "Agent";
  const cardTone = isUser
    ? "border-zinc-900 bg-[#d8efff] text-zinc-950 shadow-[4px_4px_0_0_rgba(47,116,193,0.18)]"
    : "border-zinc-900 bg-[#d8f8c8] text-zinc-950 shadow-[4px_4px_0_0_rgba(51,128,44,0.18)]";
  const rowAlign = isUser ? "justify-end" : "justify-start";
  const contentAlign = "items-start text-left";
  const metaAlign = isUser ? "justify-end" : "justify-between";
  const infoAlign = isUser ? "justify-end" : "justify-start";
  const showFallbackBadge = message.messageSource === "delta_fallback";
  const statusTone = message.taskStatus === "done"
    ? "bg-[#d8f8c8] text-green-800"
    : message.taskStatus === "in_review"
      ? "bg-[#ffe8c7] text-amber-800"
      : message.taskStatus === "in_progress"
        ? "bg-[#d8efff] text-blue-800"
        : "bg-[#fff8d8] text-zinc-700";
  const threadLabel = (message.replyCount ?? 0) > 0
    ? `${message.replyCount} ${(message.replyCount ?? 0) === 1 ? "reply" : "replies"}`
    : "Open thread";

  const body = isUser ? (
    <UserMessageContent className={cn("w-fit min-w-[20px] max-w-full self-end rounded-md border-2 px-3 py-2.5", cardTone)}>
      {message.text}
      {message.attachmentIds?.map((id) => <AttachmentImage key={id} attachmentId={id} />)}
    </UserMessageContent>
  ) : (
    <MessageContent className={cn("relative w-fit min-w-[80px] rounded-md border-2 px-3 py-2.5", cardTone)}>
      {showFallbackBadge ? (
        <div className="absolute -top-2.5 right-1.5 z-10">
          <MessageSourceBadge messageSource={message.messageSource} />
        </div>
      ) : null}
      {/* Thinking */}
      {message.thinking && <ThinkingDisclosure thinking={message.thinking} />}

      {/* Tool calls */}
      {message.toolCalls?.map((tc) => (
        <ToolCallRow key={tc.id} toolCall={tc} />
      ))}

      {/* Text content */}
      {message.text && <MessageResponse>{message.text}</MessageResponse>}
    </MessageContent>
  );

  if (hasThreadSurface) {
    return (
      <div className="px-1 py-2.5">
        <div className="rounded-sm border-2 border-zinc-900 bg-[#fffdf4] px-3 py-3 shadow-[4px_4px_0_0_rgba(0,0,0,0.1)]">
          <div className="flex items-start gap-3">
            {!isUser ? (
              <ChatAvatar role={message.role} agent={agent} user={userIdentity} size={38} className="mt-0.5 shrink-0" />
            ) : (
              <ChatAvatar role={message.role} agent={agent} user={userIdentity} size={38} className="mt-0.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-semibold tracking-tight text-zinc-950">{displayName}</span>
                <span className="rounded-sm border border-zinc-900 bg-[#fffce8]/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                  {message.taskNumber != null ? "Task" : "Thread"}
                </span>
                {message.taskNumber != null ? (
                  <span className="rounded-sm border border-zinc-900 bg-[#d8f8c8] px-1.5 py-0.5 text-[10px] font-semibold text-zinc-900">
                    #{message.taskNumber}
                  </span>
                ) : null}
                {message.taskStatus ? (
                  <span className={cn("rounded-sm border border-zinc-900 px-1.5 py-0.5 text-[10px] font-semibold", statusTone)}>
                    {message.taskStatus.replace("_", " ")}
                  </span>
                ) : null}
                {message.taskAssigneeName ? (
                  <span className="rounded-sm border border-zinc-300 bg-[#fff8d8] px-1.5 py-0.5 text-[10px] text-zinc-700">
                    @{message.taskAssigneeName}
                  </span>
                ) : null}
                <span className="text-[11px] font-medium text-zinc-500">
                  {messageTimeFormatter.format(message.createdAt)}
                </span>
              </div>

              {body}

              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={onOpenThread}
                  className="rounded border-2 border-zinc-900 bg-[#fff9d8] px-2.5 py-1 text-[11px] font-medium text-zinc-700 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)] hover:bg-[#ffd54a]"
                >
                  {openingThread ? "Opening..." : threadLabel}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Message
      from={message.role}
      className="bg-transparent px-1 py-2.5"
    >
      <div className={cn("flex items-start gap-2.5", rowAlign)}>
        {!isUser && (
          <ChatAvatar role={message.role} agent={agent} user={userIdentity} size={38} className="mt-0.5" />
        )}
        <div className={cn("flex min-w-0 max-w-[min(760px,82%)] flex-col", contentAlign)}>
          <div className={cn("mb-1.5 flex w-full items-start gap-3", metaAlign)}>
            <div className={cn("min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1", infoAlign)}>
              <span className="text-[15px] font-semibold tracking-tight text-zinc-950">{displayName}</span>
              <span className="rounded-sm border border-zinc-900 bg-[#fffce8]/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                {displayRole}
              </span>
              {!isUser && agent && (
                <span className="text-[11px] font-medium text-zinc-500">
                  {agent.agentType === "claude_acp" ? "Claude Code" : "Codex"}
                </span>
              )}
              <span className="text-[11px] font-medium text-zinc-500">
                {messageTimeFormatter.format(message.createdAt)}
              </span>
            </div>

            {!message.isStreaming && message.text && (
              <MessageActions className="ml-0 shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                <MessageCopyButton content={message.text} />
              </MessageActions>
            )}
          </div>

          {body}
        </div>
        {isUser && (
          <ChatAvatar role={message.role} agent={agent} user={userIdentity} size={38} className="mt-0.5" />
        )}
      </div>
    </Message>
  );
}

function PendingMessageRow({
  text,
  createdAt,
  attachmentIds,
  userName,
  userIdentity,
  agent,
}: {
  text: string;
  createdAt: number;
  attachmentIds?: string[];
  userName: string;
  userIdentity: { name: string; avatarUrl: string | null };
  agent: AgentInfo | null;
}) {
  return (
    <Message from="user" className="bg-transparent px-1 py-2.5">
      <div className="flex items-start justify-end gap-2.5">
        <div className="flex min-w-0 max-w-[min(760px,82%)] flex-col items-end text-left">
          <div className="mb-1.5 flex w-full items-start justify-end gap-3">
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
              <span className="text-[15px] font-semibold tracking-tight text-zinc-950">{userName}</span>
              <span className="rounded-sm border border-zinc-900 bg-[#fffce8]/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                Owner
              </span>
              <span className="rounded-sm border border-zinc-900 border-dashed bg-[#fff8d8] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                Pending
              </span>
              <span className="text-[11px] font-medium text-zinc-500">
                {messageTimeFormatter.format(createdAt)}
              </span>
            </div>
          </div>

          <UserMessageContent className="w-fit min-w-[20px] max-w-full self-end rounded-md border-2 border-dashed border-zinc-900 bg-[#eef7ff] px-3 py-2.5 text-zinc-950 opacity-85 shadow-[4px_4px_0_0_rgba(47,116,193,0.1)]">
            {text}
            {attachmentIds?.map((id) => <AttachmentImage key={id} attachmentId={id} />)}
          </UserMessageContent>
        </div>
        <ChatAvatar role="user" agent={agent} user={userIdentity} size={38} className="mt-0.5" />
      </div>
    </Message>
  );
}

function ThinkingDisclosure({ thinking }: { thinking: string }) {
  return (
    <Collapsible className="mb-2 rounded-md border-2 border-zinc-900 bg-[#fff6cc]">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-medium text-zinc-600 transition-colors hover:bg-[#ffefad] data-[state=open]:border-b-2 data-[state=open]:border-zinc-900">
        <ChevronRightIcon className="size-3 shrink-0 transition-transform data-[state=open]:rotate-90" />
        <span>Reasoning</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2.5 py-2">
        <div className="border-l-2 border-zinc-900 pl-2.5 text-xs italic text-zinc-600 whitespace-pre-wrap break-words">
          {thinking}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Render a single tool call */
function ToolCallRow({ toolCall }: { toolCall: LiveToolCall }) {
  const state = getToolState(toolCall);

  return (
    <Tool className="mb-1">
      <ToolHeader name={toolCall.name} state={state} input={toolCall.input} />
      <ToolContent>
        <ToolInput input={toolCall.input} />
        <ToolOutput output={toolCall.output} isError={toolCall.error} />
      </ToolContent>
    </Tool>
  );
}

/** Small colored dot for conversation status */
function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "size-2 rounded-full shrink-0",
        status === "idle" && "bg-success",
        status === "unavailable" && "bg-zinc-400",
        status === "queued" && "bg-blue-500",
        status === "active" && "bg-warning",
        status === "recovering" && "bg-sky-500",
        status === "awaiting_approval" && "bg-amber-500",
        status === "failed" && "bg-destructive",
      )}
      title={status}
    />
  );
}
