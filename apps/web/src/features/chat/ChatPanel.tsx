import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { useEffect, useMemo, useState } from "react";
import { PromptComposer } from "./PromptComposer";
import { AgentWorkspacePanel } from "./AgentWorkspacePanel";
import { ChatAvatar, readStoredUserIdentity } from "./ChatAvatar";
import type { AgentInfo, ConversationInfo } from "@agent-collab/protocol";
import type { LiveMessage, LiveToolCall } from "@/hooks/types";
import { cn } from "@/lib/utils";

type ChatPanelProps = {
  conversation: ConversationInfo;
  agent: AgentInfo | null;
};

/** Determine tool display state from LiveToolCall */
function getToolState(tc: LiveToolCall): ToolState {
  if (tc.error) return "error";
  if (tc.completed || tc.output !== undefined) return "result";
  return "calling";
}

const messageTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Main chat panel: header + messages + composer */
export function ChatPanel({ conversation, agent }: ChatPanelProps) {
  const [activeTab, setActiveTab] = useState<"chat" | "workspace">("chat");
  const userIdentity = useMemo(() => readStoredUserIdentity(), []);
  const {
    messages,
    status,
    pendingApproval,
    sendPrompt,
    respondApproval,
    cancel,
  } = useConversationStream({ conversationId: conversation.id });

  const displayStatus =
    status === "submitted" || status === "streaming"
      ? "active"
      : status === "queued"
        ? "queued"
      : status === "recovering"
        ? "recovering"
      : status === "awaiting_approval"
        ? "awaiting_approval"
        : status === "error"
          ? "failed"
          : conversation.status;

  useEffect(() => {
    setActiveTab("chat");
  }, [conversation.id]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">
              {agent?.name ?? conversation.title ?? "Untitled"}
            </h2>
            <div className="mt-1 text-xs text-muted-foreground">
              {conversation.isPrimaryThread ? "Main thread" : (conversation.title || "Branch thread")}
            </div>
          </div>
          <Badge variant="secondary" className="text-[11px]">
            {conversation.agentType === "claude_acp" ? "Claude" : "Codex"}
          </Badge>
          <StatusDot status={displayStatus} />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            variant={activeTab === "chat" ? "default" : "outline"}
            className="h-8 text-xs"
            onClick={() => setActiveTab("chat")}
          >
            Chat
          </Button>
          <Button
            size="sm"
            variant={activeTab === "workspace" ? "default" : "outline"}
            className="h-8 text-xs"
            onClick={() => setActiveTab("workspace")}
          >
            Workspace
          </Button>
        </div>
      </div>

      {activeTab === "workspace" ? (
        <AgentWorkspacePanel agent={agent} />
      ) : (
        <>
          <Conversation className="min-h-0 flex-1 bg-[linear-gradient(180deg,rgba(255,253,247,0.96)_0%,rgba(255,249,236,0.92)_100%)]">
            <ConversationContent className="p-0">
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
                <div className="mx-4 mt-2 mb-4 rounded-xl border border-amber-200 bg-amber-50/90 p-3 shadow-sm">
                  <Confirmation
                    toolName={pendingApproval.toolName}
                    toolArgs={pendingApproval.toolArgs}
                    onAllow={() => respondApproval(pendingApproval.requestId, "allow")}
                    onDeny={() => respondApproval(pendingApproval.requestId, "deny")}
                  />
                </div>
              )}

              {(status === "queued" || status === "submitted" || status === "streaming" || status === "recovering" || status === "awaiting_approval") && (
                <div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
                  <Loader size={14} />
                  <span>
                    {status === "queued"
                      ? "Queued behind another thread..."
                      : status === "submitted"
                      ? "Thinking..."
                      : status === "recovering"
                        ? "Recovering session..."
                      : status === "awaiting_approval"
                        ? "Waiting for approval..."
                        : "Streaming..."}
                  </span>
                </div>
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <PromptComposer status={status} onSend={sendPrompt} onCancel={cancel} />
        </>
      )}
    </div>
  );
}

/** Render a single user or assistant message */
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
  const isUser = message.role === "user";
  const displayName = isUser ? userName : (agent?.name ?? "Agent");
  const displayRole = isUser ? "Owner" : "Agent";
  const cardTone = isUser
    ? "bg-white/90 border-violet-200/80"
    : "bg-[#fffdf7]/92 border-amber-200/80";

  const body = isUser ? (
    <UserMessageContent className="rounded-lg border border-violet-200/80 bg-violet-50/85 px-3 py-2.5 shadow-sm">
      {message.text}
    </UserMessageContent>
  ) : (
    <MessageContent className={cn("rounded-lg border px-3 py-2.5 shadow-sm", cardTone)}>
      {/* Thinking */}
      {message.thinking && (
        <div className="mb-1.5 border-l-2 border-amber-300 pl-2.5 text-xs italic text-muted-foreground">
          {message.thinking}
        </div>
      )}

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
      className="border-b border-stone-300/80 bg-white/55 px-4 py-3 last:border-b-0"
    >
      <div className="flex items-start gap-2.5">
        <ChatAvatar role={message.role} agent={agent} user={userIdentity} size={36} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-start justify-between gap-3">
            <div className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-semibold tracking-tight">{displayName}</span>
              <span className="rounded-sm border border-border/70 bg-background/75 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                {displayRole}
              </span>
              {!isUser && agent && (
                <span className="text-[11px] text-muted-foreground">
                  {agent.agentType === "claude_acp" ? "Claude" : "Codex"}
                </span>
              )}
              <span className="text-[11px] text-muted-foreground/90">
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
      </div>
    </Message>
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
