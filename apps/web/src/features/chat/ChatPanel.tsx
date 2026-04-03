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
import { ChevronRightIcon, MenuIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
import { CodexDebugPanel } from "./CodexDebugPanel";
import { ChatAvatar, readStoredUserIdentity } from "./ChatAvatar";
import { AgentSettingsPanel } from "./AgentSettingsPanel";
import type { AgentInfo, ConversationInfo, UpdateAgentRequest } from "@agent-collab/protocol";
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
}: ChatPanelProps) {
  const [activeTab, setActiveTab] = useState<"chat" | "activity" | "debug" | "workspace" | "skills" | "profile" | "setting">("chat");
  const userIdentity = useMemo(() => readStoredUserIdentity(), []);
  const {
    messages,
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
  const shouldDisableInput =
    status === "queued" ||
    status === "submitted" ||
    status === "streaming" ||
    status === "recovering" ||
    status === "awaiting_approval";
  const canShowCodexDebug = isAdmin && (conversation.agentType === "codex_acp" || conversation.agentType === "claude_acp");

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
  }, [conversation.id]);

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
      ) : activeTab === "debug" ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <CodexDebugPanel conversationId={conversation.id} />
        </div>
      ) : (
        <>
          <Conversation className="min-h-0 flex-1 bg-[#fff9d0]">
            <ConversationContent className="px-3 py-4">
              {messages.length === 0 ? (
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
                      ? "Queued behind another thread..."
                      : status === "recovering"
                        ? "Recovering session..."
                        : "Waiting for approval..."}
                  </span>
                </div>
              )}
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
        </>
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
}: {
  message: LiveMessage;
  agent: AgentInfo | null;
  userName: string;
  userIdentity: { name: string; avatarUrl: string | null };
}) {
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
  const displayName = isUser ? userName : (agent?.name ?? "Agent");
  const displayRole = isUser ? "Owner" : "Agent";
  const cardTone = isUser
    ? "border-zinc-900 bg-[#d8efff] text-zinc-950 shadow-[4px_4px_0_0_rgba(47,116,193,0.18)]"
    : "border-zinc-900 bg-[#d8f8c8] text-zinc-950 shadow-[4px_4px_0_0_rgba(51,128,44,0.18)]";
  const rowAlign = isUser ? "justify-end" : "justify-start";
  const contentAlign = isUser ? "items-end text-right" : "items-start text-left";
  const metaAlign = isUser ? "justify-end" : "justify-between";
  const infoAlign = isUser ? "justify-end" : "justify-start";
  const showFallbackBadge = message.messageSource === "delta_fallback";

  const body = isUser ? (
    <UserMessageContent className={cn("w-fit max-w-full self-end rounded-md border-2 px-3 py-2.5", cardTone)}>
      {message.text}
      {message.attachmentIds?.map((id) => <AttachmentImage key={id} attachmentId={id} />)}
    </UserMessageContent>
  ) : (
    <MessageContent className={cn("relative rounded-md border-2 px-3 py-2.5", cardTone)}>
      {showFallbackBadge ? (
        <div className="mb-2 flex items-start justify-end">
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
