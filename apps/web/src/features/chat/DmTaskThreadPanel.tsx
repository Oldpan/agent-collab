import { useEffect, useMemo, useState } from "react";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";
import { MessageResponse, UserMessageContent } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { useConversationStream } from "@/hooks/useConversationStream";
import type { LiveMessage } from "@/hooks/types";
import type { AgentInfo, ConversationInfo } from "@agent-collab/protocol";
import { XIcon } from "lucide-react";
import { PromptComposer } from "./PromptComposer";
import { ChatAvatar, readStoredUserIdentity } from "./ChatAvatar";
import { cn } from "@/lib/utils";

const messageTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatPeerLabel(replyTarget?: string | null): string {
  const raw = (replyTarget ?? "").trim();
  if (!raw.startsWith("dm:@")) return "@User";
  const withoutPrefix = raw.slice("dm:".length);
  const [peer] = withoutPrefix.split(":");
  return peer || "@User";
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
  return <img src={src} alt="attachment" className="mt-1.5 max-h-64 max-w-full rounded border border-zinc-200 object-contain" />;
}

type DmTaskThreadPanelProps = {
  conversation: ConversationInfo;
  agent: AgentInfo | null;
  rootMessage: LiveMessage;
  onClose: () => void;
};

export function DmTaskThreadPanel({
  conversation,
  agent,
  rootMessage,
  onClose,
}: DmTaskThreadPanelProps) {
  const userIdentity = useMemo(() => readStoredUserIdentity(), []);
  const {
    messages,
    status,
    connectionReady,
    contextSnapshot,
    sendPrompt,
    cancel,
  } = useConversationStream({
    conversationId: conversation.id,
    conversationAgentId: conversation.agentId,
  });
  const peerLabel = formatPeerLabel(conversation.replyTarget);
  const threadMessages = useMemo(
    () => messages.filter((message) => message.id !== rootMessage.id),
    [messages, rootMessage.id],
  );
  const contextMessages = contextSnapshot?.messages ?? [];
  const rootIsTrigger = contextSnapshot?.triggerMessageId === rootMessage.id;
  const statusTone = rootMessage.taskStatus === "done"
    ? "bg-[#d8f8c8] text-green-800"
    : rootMessage.taskStatus === "in_review"
      ? "bg-[#ffe8c7] text-amber-800"
      : rootMessage.taskStatus === "in_progress"
        ? "bg-[#d8efff] text-blue-800"
        : "bg-[#fff8d8] text-zinc-700";

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#fff7cc]">
      <div className="border-b-2 border-black bg-[#fffdf5] px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold tracking-tight text-zinc-950">
              Thread — {peerLabel}
            </div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
              Task thread
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-sm border-2 border-zinc-900 bg-white text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#fff1a9]"
            onClick={onClose}
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      </div>

      <div className="border-b-2 border-black bg-[#fff3b3] px-4 py-3">
        <div className="rounded-sm border-2 border-zinc-900 bg-[#fffdf4] px-3 py-3 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            {rootMessage.taskNumber != null ? (
              <span className="rounded-sm border border-zinc-900 bg-[#d8f8c8] px-1.5 py-0.5 text-[10px] font-semibold text-zinc-900">
                #{rootMessage.taskNumber}
              </span>
            ) : null}
            {rootIsTrigger ? (
              <span className="rounded-sm border border-zinc-900 bg-[#fff3b3] px-1.5 py-0.5 text-[10px] font-semibold text-zinc-900">
                Trigger
              </span>
            ) : null}
            {rootMessage.taskStatus ? (
              <span className={cn("rounded-sm border border-zinc-900 px-1.5 py-0.5 text-[10px] font-semibold", statusTone)}>
                {rootMessage.taskStatus.replace("_", " ")}
              </span>
            ) : null}
            {rootMessage.taskAssigneeName ? (
              <span className="rounded-sm border border-zinc-300 bg-white px-1.5 py-0.5 text-[10px] text-zinc-700">
                @{rootMessage.taskAssigneeName}
              </span>
            ) : null}
          </div>
          <div className="whitespace-pre-wrap break-words text-sm text-zinc-900">
            {rootMessage.text}
          </div>
        </div>
      </div>

      {contextMessages.length > 0 ? (
        <div className="border-b-2 border-black bg-[#fff7d6] px-4 py-3">
          <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-zinc-600">
            Context from DM
          </div>
          <div className="space-y-2">
            {contextMessages.map((message) => {
              const isTrigger = contextSnapshot?.triggerMessageId === message.messageId;
              return (
                <div
                  key={message.messageId}
                  className="rounded-sm border border-zinc-300 bg-[#fffdf4] px-3 py-2 shadow-[2px_2px_0_0_rgba(0,0,0,0.05)]"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-semibold tracking-tight text-zinc-950">
                      @{message.senderName}
                    </span>
                    {isTrigger ? (
                      <span className="rounded-sm border border-zinc-900 bg-[#fff3b3] px-1.5 py-0.5 text-[10px] font-semibold text-zinc-900">
                        Trigger
                      </span>
                    ) : null}
                    <span className="text-[11px] text-zinc-500">
                      {messageTimeFormatter.format(new Date(message.createdAt))}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap break-words text-[13px] text-zinc-800">
                    {message.content}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {(status === "queued" || status === "recovering" || status === "awaiting_approval") && (
        <div className="mx-3 mt-3 flex items-center gap-2 rounded-md border-2 border-zinc-900 bg-[#fffce8] px-3 py-2 text-sm text-zinc-600 shadow-[4px_4px_0_0_rgba(0,0,0,0.1)]">
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

      <Conversation className="min-h-0 flex-1 bg-[#fff7cc]">
        <ConversationContent className="px-3 py-4">
          {threadMessages.length === 0 ? (
            <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fff8d8] px-4 py-6 text-center text-sm text-zinc-500">
              No thread replies yet.
            </div>
          ) : (
            threadMessages.map((message) => {
              const isUser = message.role === "user";
              const displayName = isUser ? userIdentity.name : (agent?.name ?? "Agent");
              const cardTone = isUser
                ? "border-zinc-900 bg-[#d8efff] text-zinc-950 shadow-[3px_3px_0_0_rgba(47,116,193,0.16)]"
                : "border-zinc-900 bg-[#d8f8c8] text-zinc-950 shadow-[3px_3px_0_0_rgba(51,128,44,0.16)]";

              return (
                <div key={message.id} className={cn("flex gap-2.5 px-1 py-2.5", isUser ? "flex-row-reverse" : "flex-row")}>
                  <ChatAvatar role={message.role === "user" ? "user" : "assistant"} agent={agent} user={userIdentity} size={34} className="mt-0.5 shrink-0" />
                  <div className={cn("flex min-w-0 max-w-[92%] flex-col", isUser ? "items-end text-left" : "items-start text-left")}>
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold tracking-tight text-zinc-950">{displayName}</span>
                      <span className="text-[11px] text-zinc-500">{messageTimeFormatter.format(message.createdAt)}</span>
                    </div>
                    {isUser ? (
                      <UserMessageContent className={cn("w-fit min-w-[20px] max-w-full rounded-md border-2 px-3 py-2.5", cardTone)}>
                        {message.text}
                        {message.attachmentIds?.map((id) => <AttachmentImage key={id} attachmentId={id} />)}
                      </UserMessageContent>
                    ) : (
                      <div className={cn("w-fit min-w-[80px] rounded-md border-2 px-3 py-2.5", cardTone)}>
                        {message.text ? <MessageResponse>{message.text}</MessageResponse> : null}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <PromptComposer
        status={status}
        ready={connectionReady}
        showCancel={status === "submitted" || status === "streaming" || status === "recovering" || status === "awaiting_approval"}
        disableInput={false}
        onSend={sendPrompt}
        onCancel={cancel}
      />
    </div>
  );
}
