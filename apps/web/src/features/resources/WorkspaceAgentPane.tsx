import { useEffect, useState } from "react";
import type { AgentInfo, ConversationInfo } from "@agent-collab/protocol";
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
  MessageActions,
  MessageContent,
  MessageCopyButton,
  MessageResponse,
  UserMessageContent,
} from "@/components/ai-elements/message";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolState,
} from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { useConversationStream } from "@/hooks/useConversationStream";
import type { LiveMessage, LiveToolCall } from "@/hooks/types";
import { useStoredUserIdentity } from "@/lib/userIdentity";
import { cn } from "@/lib/utils";
import { ExternalLinkIcon } from "lucide-react";
import { ChatAvatar } from "@/features/chat/ChatAvatar";
import { PromptComposer } from "@/features/chat/PromptComposer";

type WorkspaceAgentPaneProps = {
  conversation: ConversationInfo | null;
  agent: AgentInfo | null;
  onOpenChat?: () => void;
};

const messageTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const STATUS_LABELS: Record<string, string> = {
  idle: "Idle",
  submitted: "Running",
  streaming: "Running",
  queued: "Queued",
  recovering: "Recovering",
  awaiting_approval: "Awaiting approval",
  error: "Failed",
};

function getToolState(toolCall: LiveToolCall): ToolState {
  if (toolCall.status === "cancelled") return "cancelled";
  if (toolCall.status === "failed" || toolCall.error) return "error";
  if (toolCall.status === "completed" || toolCall.completed || toolCall.output !== undefined) {
    return "result";
  }
  return "calling";
}

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
  return (
    <img
      src={src}
      alt="attachment"
      className="mt-2 max-h-72 max-w-full rounded-sm border border-slate-200 object-contain"
    />
  );
}

export function WorkspaceAgentPane({
  conversation,
  agent,
  onOpenChat,
}: WorkspaceAgentPaneProps) {
  const userIdentity = useStoredUserIdentity();
  const {
    messages,
    pendingMessages,
    status,
    connectionReady,
    hasActiveRun,
    pendingApproval,
    sendPrompt,
    respondApproval,
    cancel,
  } = useConversationStream({
    conversationId: conversation?.id ?? null,
    conversationAgentId: conversation?.agentId,
  });

  if (!conversation || !agent) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md rounded-sm border-2 border-slate-200 bg-white px-5 py-5 text-center shadow-[4px_4px_0_0_rgba(15,23,42,0.08)]">
          <div className="text-sm font-semibold text-slate-950">Agent conversation unavailable</div>
          <div className="mt-2 text-sm text-slate-500">
            Open the agent chat from the workspace header or switch back to the main chat view.
          </div>
          {onOpenChat ? (
            <Button
              className="mt-4 rounded-sm border-2 border-slate-950 bg-slate-950 text-white hover:bg-slate-800"
              onClick={onOpenChat}
            >
              <ExternalLinkIcon className="mr-1.5 size-4" />
              Open Chat
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const shouldShowCancel =
    hasActiveRun
    || status === "submitted"
    || status === "streaming"
    || status === "recovering"
    || status === "awaiting_approval";

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn(
                "size-2 rounded-full",
                status === "idle" && "bg-emerald-500",
                (status === "submitted" || status === "streaming") && "bg-orange-400",
                status === "queued" && "bg-sky-500",
                status === "recovering" && "bg-cyan-500",
                status === "awaiting_approval" && "bg-amber-500",
                status === "error" && "bg-rose-500",
              )} />
              <div className="truncate text-sm font-semibold text-slate-950">{agent.name}</div>
            </div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-slate-500">
              {STATUS_LABELS[status] ?? status}
            </div>
          </div>
          {onOpenChat ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-sm border-2 border-slate-300 bg-white text-slate-900 hover:bg-slate-50"
              onClick={onOpenChat}
            >
              <ExternalLinkIcon className="mr-1.5 size-3.5" />
              Open Chat
            </Button>
          ) : null}
        </div>
      </div>

      <Conversation className="min-h-0 flex-1 bg-transparent">
        <ConversationContent className="px-4 py-4">
          {messages.length === 0 && pendingMessages.length === 0 ? (
            <ConversationEmptyState
              title={`Start working with ${agent.name}`}
              description="Send a message to start from inside the workspace."
            />
          ) : (
            messages.map((message) => (
              <WorkspaceMessageRow
                key={message.id}
                message={message}
                agent={agent}
                userIdentity={userIdentity}
              />
            ))
          )}

          {pendingApproval ? (
            <div className="mx-1 mt-2 mb-3 rounded-sm border-2 border-slate-200 bg-white p-3 shadow-[4px_4px_0_0_rgba(15,23,42,0.08)]">
              <Confirmation
                toolName={pendingApproval.toolName}
                toolArgs={pendingApproval.toolArgs}
                onAllow={() => respondApproval(pendingApproval.requestId, "allow")}
                onDeny={() => respondApproval(pendingApproval.requestId, "deny")}
              />
            </div>
          ) : null}

          {(status === "queued" || status === "recovering" || status === "awaiting_approval") ? (
            <div className="mx-1 mt-2 mb-3 flex items-center gap-2 rounded-sm border-2 border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 shadow-[4px_4px_0_0_rgba(15,23,42,0.06)]">
              <Loader size={14} />
              <span>
                {status === "queued"
                  ? "Waiting for the agent to become available..."
                  : status === "recovering"
                    ? "Recovering the existing session..."
                    : "Waiting for approval..."}
              </span>
            </div>
          ) : null}

          {pendingMessages.map((message) => (
            <PendingWorkspaceMessageRow
              key={message.id}
              text={message.text}
              createdAt={message.createdAt}
              attachmentIds={message.attachmentIds}
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
        disableInput={false}
        draftKey={`workspace:${conversation.id}`}
        showSendAsTaskButton={conversation.threadKind === "direct" && Boolean(conversation.isPrimaryThread)}
        onSend={sendPrompt}
        onCancel={cancel}
      />
    </div>
  );
}

function WorkspaceMessageRow({
  message,
  agent,
  userIdentity,
}: {
  message: LiveMessage;
  agent: AgentInfo;
  userIdentity: { name: string; avatarUrl: string | null };
}) {
  if (message.role === "system") {
    return (
      <div className="flex items-center gap-2 py-2 px-1">
        <div className="h-px flex-1 bg-slate-200" />
        <span className="shrink-0 rounded-sm border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-500">
          {message.text}
        </span>
        <div className="h-px flex-1 bg-slate-200" />
      </div>
    );
  }

  const isUser = message.role === "user";
  const bubbleTone = isUser
    ? "border-slate-300 bg-slate-100 text-slate-950"
    : "border-emerald-200 bg-emerald-50 text-slate-950";

  const body = isUser ? (
    <UserMessageContent className={cn("w-fit min-w-[20px] max-w-full self-end rounded-md border-2 px-3 py-2.5 shadow-[4px_4px_0_0_rgba(15,23,42,0.06)]", bubbleTone)}>
      {message.text}
      {message.attachmentIds?.map((id) => <AttachmentImage key={id} attachmentId={id} />)}
    </UserMessageContent>
  ) : (
    <MessageContent className={cn("w-fit min-w-[80px] rounded-md border-2 px-3 py-2.5 shadow-[4px_4px_0_0_rgba(15,23,42,0.06)]", bubbleTone)}>
      {message.thinking ? (
        <div className="mb-2 rounded-sm border border-slate-300 bg-white/70 px-2 py-1 text-xs italic text-slate-600">
          {message.thinking}
        </div>
      ) : null}
      {message.toolCalls?.map((toolCall) => (
        <Tool key={toolCall.id} className="mb-2">
          <ToolHeader name={toolCall.name} state={getToolState(toolCall)} input={toolCall.input} />
          <ToolContent>
            <ToolInput input={toolCall.input} />
            <ToolOutput output={toolCall.output} isError={toolCall.error} />
          </ToolContent>
        </Tool>
      ))}
      {message.text ? <MessageResponse>{message.text}</MessageResponse> : null}
    </MessageContent>
  );

  return (
    <Message from={message.role} className="bg-transparent px-1 py-2.5">
      <div className={cn("flex items-start gap-2.5", isUser ? "justify-end" : "justify-start")}>
        {!isUser ? (
          <ChatAvatar role="assistant" agent={agent} user={userIdentity} size={36} className="mt-0.5" />
        ) : null}
        <div className={cn("flex min-w-0 max-w-[min(760px,84%)] flex-col", isUser ? "items-end" : "items-start")}>
          <div className={cn("mb-1.5 flex w-full items-start gap-3", isUser ? "justify-end" : "justify-between")}>
            <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", isUser ? "justify-end" : "justify-start")}>
              <span className="text-[14px] font-semibold tracking-tight text-slate-950">
                {isUser ? userIdentity.name : agent.name}
              </span>
              <span className="rounded-sm border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
                {isUser ? "Owner" : "Agent"}
              </span>
              <span className="text-[11px] font-medium text-slate-500">
                {messageTimeFormatter.format(message.createdAt)}
              </span>
            </div>
            {!message.isStreaming && message.text ? (
              <MessageActions className="ml-0 shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                <MessageCopyButton content={message.text} />
              </MessageActions>
            ) : null}
          </div>
          {body}
        </div>
        {isUser ? (
          <ChatAvatar role="user" agent={agent} user={userIdentity} size={36} className="mt-0.5" />
        ) : null}
      </div>
    </Message>
  );
}

function PendingWorkspaceMessageRow({
  text,
  createdAt,
  attachmentIds,
  userIdentity,
  agent,
}: {
  text: string;
  createdAt: number;
  attachmentIds?: string[];
  userIdentity: { name: string; avatarUrl: string | null };
  agent: AgentInfo;
}) {
  return (
    <Message from="user" className="bg-transparent px-1 py-2.5">
      <div className="flex items-start justify-end gap-2.5">
        <div className="flex min-w-0 max-w-[min(760px,84%)] flex-col items-end text-left">
          <div className="mb-1.5 flex w-full items-start justify-end gap-3">
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
              <span className="text-[14px] font-semibold tracking-tight text-slate-950">{userIdentity.name}</span>
              <span className="rounded-sm border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
                Owner
              </span>
              <span className="rounded-sm border border-dashed border-slate-400 bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600">
                Pending
              </span>
              <span className="text-[11px] font-medium text-slate-500">
                {messageTimeFormatter.format(createdAt)}
              </span>
            </div>
          </div>

          <UserMessageContent className="w-fit min-w-[20px] max-w-full self-end rounded-md border-2 border-dashed border-slate-300 bg-slate-100 px-3 py-2.5 text-slate-950 opacity-85 shadow-[4px_4px_0_0_rgba(15,23,42,0.06)]">
            {text}
            {attachmentIds?.map((id) => <AttachmentImage key={id} attachmentId={id} />)}
          </UserMessageContent>
        </div>
        <ChatAvatar role="user" agent={agent} user={userIdentity} size={36} className="mt-0.5" />
      </div>
    </Message>
  );
}
