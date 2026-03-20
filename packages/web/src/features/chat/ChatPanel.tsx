import { Badge } from "@/components/ui/badge";
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
import { PromptComposer } from "./PromptComposer";
import type { ConversationInfo } from "@agent-collab/wire-types";
import type { LiveMessage, LiveToolCall } from "@/hooks/types";
import { cn } from "@/lib/utils";

type ChatPanelProps = {
  conversation: ConversationInfo;
};

/** Determine tool display state from LiveToolCall */
function getToolState(tc: LiveToolCall): ToolState {
  if (tc.error) return "error";
  if (tc.output !== undefined) return "result";
  return "calling";
}

/** Main chat panel: header + messages + composer */
export function ChatPanel({ conversation }: ChatPanelProps) {
  const {
    messages,
    status,
    pendingApproval,
    sendPrompt,
    respondApproval,
    cancel,
  } = useConversationStream({ conversationId: conversation.id });

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold truncate flex-1">
          {conversation.title || "Untitled"}
        </h2>
        <Badge variant="secondary" className="text-[11px]">
          {conversation.agentType === "claude_acp" ? "Claude" : "Codex"}
        </Badge>
        <StatusDot status={conversation.status} />
      </div>

      {/* Messages */}
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

          {/* Pending approval */}
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

          {/* Streaming indicator */}
          {(status === "submitted" || status === "streaming") && (
            <div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
              <Loader size={14} />
              <span>{status === "submitted" ? "Thinking..." : "Streaming..."}</span>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Composer */}
      <PromptComposer status={status} onSend={sendPrompt} onCancel={cancel} />
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
        status === "busy" && "bg-warning",
        status === "error" && "bg-destructive",
      )}
      title={status}
    />
  );
}
