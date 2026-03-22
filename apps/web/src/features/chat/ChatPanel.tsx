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
import { useEffect, useState } from "react";
import { PromptComposer } from "./PromptComposer";
import { AgentWorkspacePanel } from "./AgentWorkspacePanel";
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
  if (tc.output !== undefined) return "result";
  return "calling";
}

/** Main chat panel: header + messages + composer */
export function ChatPanel({ conversation, agent }: ChatPanelProps) {
  const [activeTab, setActiveTab] = useState<"chat" | "workspace">("chat");
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
              {conversation.title || "Current thread"}
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
          <Conversation className="flex-1 min-h-0">
            <ConversationContent>
              {messages.length === 0 ? (
                <ConversationEmptyState
                  title="Start the conversation"
                  description="Send a message to begin"
                />
              ) : (
                messages.map((msg) => (
                  <MessageRow key={msg.id} message={msg} />
                ))
              )}

              {pendingApproval && (
                <div className="mt-2">
                  <Confirmation
                    toolName={pendingApproval.toolName}
                    toolArgs={pendingApproval.toolArgs}
                    onAllow={() => respondApproval(pendingApproval.requestId, "allow")}
                    onDeny={() => respondApproval(pendingApproval.requestId, "deny")}
                  />
                </div>
              )}

              {(status === "submitted" || status === "streaming" || status === "recovering" || status === "awaiting_approval") && (
                <div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
                  <Loader size={14} />
                  <span>
                    {status === "submitted"
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
function MessageRow({ message }: { message: LiveMessage }) {
  if (message.role === "user") {
    return (
      <Message from="user" className="mb-4">
        <UserMessageContent>{message.text}</UserMessageContent>
      </Message>
    );
  }

  return (
    <Message from="assistant" className="mb-4">
      <MessageContent>
        {/* Thinking */}
        {message.thinking && (
          <div className="text-xs text-muted-foreground italic mb-2 border-l-2 border-muted pl-3">
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

      {/* Actions */}
      {!message.isStreaming && message.text && (
        <MessageActions>
          <MessageCopyButton content={message.text} />
        </MessageActions>
      )}
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
        status === "active" && "bg-warning",
        status === "recovering" && "bg-sky-500",
        status === "awaiting_approval" && "bg-amber-500",
        status === "failed" && "bg-destructive",
      )}
      title={status}
    />
  );
}
