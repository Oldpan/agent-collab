import { useState, useCallback, useRef, useLayoutEffect, useEffect } from "react";
import type { ServerEvent, ClientEvent } from "@agent-collab/protocol";
import type {
  LiveMessage,
  LiveRun,
  LiveRunActivityItem,
  LiveToolCall,
  PendingApproval,
  ChatStatus,
  PendingLocalPrompt,
} from "./types";
import * as api from "@/lib/api";
import { useConversationsStore } from "./useConversations";

let nextId = 1;
const createId = () => `msg-${nextId++}`;
const ACTIVE_CONVERSATION_SYNC_INTERVAL_MS = 1500;
const PENDING_STORAGE_PREFIX = "conversation-pending-prompts";

type PendingPromptState = {
  items: PendingLocalPrompt[];
  awaitingIdle: boolean;
};

type ServerConversationStatus =
  | "idle"
  | "queued"
  | "active"
  | "recovering"
  | "awaiting_approval"
  | "failed";

function createClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `client-${crypto.randomUUID()}`;
  }
  return `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getDisplayRunId(turnId: string): string {
  return turnId.startsWith("replay-") ? turnId.slice("replay-".length) : turnId;
}

function isDispatchFailureError(error?: string): boolean {
  return error === "Node not connected" || error === "Node disconnected during dispatch";
}

function canMarkSeen(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function getPendingStorageKey(conversationId: string): string {
  return `${PENDING_STORAGE_PREFIX}:${conversationId}`;
}

function readPendingPromptState(conversationId: string): PendingPromptState {
  if (typeof window === "undefined") return { items: [], awaitingIdle: false };
  try {
    const raw = window.sessionStorage.getItem(getPendingStorageKey(conversationId));
    if (!raw) return { items: [], awaitingIdle: false };
    const parsed = JSON.parse(raw) as Partial<PendingPromptState>;
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter((value): value is PendingLocalPrompt => {
          if (!value || typeof value !== "object") return false;
          return typeof value.id === "string"
            && typeof value.text === "string"
            && typeof value.createdAt === "number"
            && (value.attachmentIds == null || Array.isArray(value.attachmentIds))
            && (value.sendAsTask == null || typeof value.sendAsTask === "boolean");
        })
      : [];
    return {
      items,
      awaitingIdle: parsed.awaitingIdle === true,
    };
  } catch {
    return { items: [], awaitingIdle: false };
  }
}

function writePendingPromptState(
  conversationId: string | null,
  state: PendingPromptState,
): void {
  if (typeof window === "undefined" || !conversationId) return;
  const key = getPendingStorageKey(conversationId);
  if (state.items.length === 0) {
    window.sessionStorage.removeItem(key);
    return;
  }
  window.sessionStorage.setItem(key, JSON.stringify(state));
}

function buildPromptTextWithAttachments(text: string, attachmentIds?: string[]): string {
  const attachmentNote = attachmentIds?.length
    ? `\n\n[Attached image${attachmentIds.length > 1 ? "s" : ""}]\n`
      + attachmentIds
        .map((aid) => `ID: ${aid}\nUse view_file(attachment_id="${aid}") to view it.`)
        .join("\n")
    : "";
  return text + attachmentNote;
}

function mergePendingPrompts(
  items: PendingLocalPrompt[],
): { displayText: string; promptText: string; attachmentIds: string[]; sendAsTask: boolean } {
  const displayParts = items
    .map((item) => item.text.trim())
    .filter((text) => text.length > 0);
  const displayText = displayParts.join("\n\n");
  const attachmentIds = items.flatMap((item) => item.attachmentIds ?? []);
  return {
    displayText,
    promptText: buildPromptTextWithAttachments(displayText, attachmentIds),
    attachmentIds,
    sendAsTask: items.length === 1 && items[0]?.sendAsTask === true,
  };
}

function splitPendingPromptBatch(items: PendingLocalPrompt[]): {
  batch: PendingLocalPrompt[];
  remaining: PendingLocalPrompt[];
} {
  const firstTaskIndex = items.findIndex((item) => item.sendAsTask === true);
  if (firstTaskIndex === -1) {
    return { batch: items, remaining: [] };
  }
  if (firstTaskIndex === 0) {
    return {
      batch: items.slice(0, 1),
      remaining: items.slice(1),
    };
  }
  return {
    batch: items.slice(0, firstTaskIndex),
    remaining: items.slice(firstTaskIndex),
  };
}

/** Split agent-facing prompt text into display text + attachment IDs */
function parsePromptText(text: string): { displayText: string; attachmentIds: string[] } {
  const noteIdx = text.indexOf('\n\n[Attached image');
  if (noteIdx === -1) return { displayText: text, attachmentIds: [] };
  const displayText = text.slice(0, noteIdx);
  const noteText = text.slice(noteIdx);
  const attachmentIds = [...noteText.matchAll(/^ID: ([a-f0-9-]{36})$/gm)].map((m) => m[1]).filter((x): x is string => !!x);
  return { displayText, attachmentIds };
}

function isLegacyPlanOrTaskDelta(text: string): boolean {
  const normalized = text.trimStart();
  return normalized.startsWith("[plan] ") || normalized.startsWith("[task] ");
}

function isIgnorableFallbackDisplayText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.includes(`empty response: {'content':`)) return true;
  return normalized === 'plan updated'
    || normalized === 'task updated'
    || normalized === '[plan] plan updated'
    || normalized === '[task] task updated';
}

function shouldHideChannelMessage(params: {
  text: string;
  messageSource?: string;
}): boolean {
  return params.messageSource === "delta_fallback" && isIgnorableFallbackDisplayText(params.text);
}

function getRunTerminalStatus(params: {
  stopReason?: string;
  error?: string;
}): LiveRun["status"] {
  if (params.error && isDispatchFailureError(params.error)) return "not_dispatched";
  if (params.stopReason?.includes("cancel")) return "cancelled";
  if (params.error) return "failed";
  return "completed";
}

function getToolTerminalStatus(params: {
  turnStatus: LiveRun["status"];
  toolError?: boolean;
}): LiveToolCall["status"] {
  if (params.toolError) return "failed";
  if (params.turnStatus === "cancelled") return "cancelled";
  if (params.turnStatus === "failed" || params.turnStatus === "not_dispatched") return "failed";
  return "completed";
}

function upsertRun(
  runs: LiveRun[],
  runId: string,
  recipe: (current: LiveRun | undefined) => LiveRun,
): LiveRun[] {
  const existingIndex = runs.findIndex((run) => run.id === runId);
  if (existingIndex < 0) {
    return [...runs, recipe(undefined)].sort((a, b) => a.startedAt - b.startedAt);
  }
  return runs.map((run, index) => (index === existingIndex ? recipe(run) : run));
}

function appendActivityItem(
  items: LiveRunActivityItem[],
  item: LiveRunActivityItem,
): LiveRunActivityItem[] {
  if (items.some((existing) => existing.id === item.id)) return items;
  return [...items, item].sort((a, b) => a.createdAt - b.createdAt);
}

function mergeMessagesById(
  current: LiveMessage[],
  incoming: LiveMessage[],
): LiveMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
    byId.set(message.id, existing ? { ...existing, ...message } : message);
  }
  return [...byId.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
}

function toLiveChannelMessage(message: Awaited<ReturnType<typeof api.getConversationChannelMessages>>["messages"][number]): LiveMessage {
  return {
    id: message.id,
    role: message.senderType === "user" ? "user" : message.senderType === "system" ? "system" : "assistant",
    text: message.content,
    createdAt: new Date(message.createdAt).getTime(),
    isStreaming: false,
    ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
    ...(typeof message.replyCount === "number" ? { replyCount: message.replyCount } : {}),
    ...(message.taskNumber != null
      ? {
          taskNumber: message.taskNumber,
          taskStatus: message.taskStatus,
          taskAssigneeName: message.taskAssigneeName ?? null,
        }
      : {}),
    ...(message.messageSource ? { messageSource: message.messageSource } : {}),
    ...(message.attachmentIds?.length ? { attachmentIds: message.attachmentIds } : {}),
  };
}

type UseConversationStreamOptions = {
  conversationId: string | null;
  /** When set (agent conversation), use channel-based message model instead of ACP streaming */
  conversationAgentId?: string | null;
  onSeenSeq?: (seq: number) => void;
};

type ConversationContextSnapshot = Awaited<ReturnType<typeof api.getConversationChannelMessages>>["contextSnapshot"];

type UseConversationStreamReturn = {
  messages: LiveMessage[];
  pendingMessages: PendingLocalPrompt[];
  runs: LiveRun[];
  status: ChatStatus;
  connectionReady: boolean;
  hasActiveRun: boolean;
  isFlushingPending: boolean;
  pendingApproval: PendingApproval | null;
  contextSnapshot: ConversationContextSnapshot | null;
  sendPrompt: (text: string, attachmentIds?: string[], sendAsTask?: boolean) => boolean;
  respondApproval: (requestId: string, decision: "allow" | "deny") => void;
  cancel: () => void;
};

/**
 * Manages a WebSocket connection for one conversation, processing ServerEvents
 * into a LiveMessage[] timeline. Uses refs for streaming accumulators to avoid
 * fighting React's async render model.
 */
export function useConversationStream(
  options: UseConversationStreamOptions,
): UseConversationStreamReturn {
  const { conversationId, conversationAgentId } = options;
  const { onSeenSeq } = options;
  const isChannelMode = Boolean(conversationAgentId);

  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [pendingState, setPendingState] = useState<PendingPromptState>({ items: [], awaitingIdle: false });
  const [runs, setRuns] = useState<LiveRun[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [connectionReady, setConnectionReady] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [contextSnapshot, setContextSnapshot] = useState<ConversationContextSnapshot | null>(null);
  const [historyReady, setHistoryReady] = useState(false);
  const [isFlushingPending, setIsFlushingPending] = useState(false);
  const hasActiveRun = runs.some((run) => run.isActive);

  // Refs for streaming accumulators
  const wsRef = useRef<WebSocket | null>(null);
  const onSeenSeqRef = useRef<typeof onSeenSeq>(onSeenSeq);
  const textRef = useRef("");
  const thinkingRef = useRef("");
  const currentToolCallsRef = useRef<LiveToolCall[]>([]);
  const currentMsgIdRef = useRef<string | null>(null);
  const currentRunIdRef = useRef<string | null>(null);
  const pendingClientEventsRef = useRef<ClientEvent[]>([]);
  const connectionReadyRef = useRef(false);
  const terminalWsErrorRef = useRef<string | null>(null);
  const syncInFlightRef = useRef(false);
  const pendingStateRef = useRef<PendingPromptState>(pendingState);
  const historyReadyRef = useRef(false);
  const initialServerStatusRef = useRef<ServerConversationStatus | null>(null);
  const pendingStorageConversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    onSeenSeqRef.current = onSeenSeq;
  }, [onSeenSeq]);

  useEffect(() => {
    pendingStateRef.current = pendingState;
  }, [pendingState]);

  useEffect(() => {
    if (conversationId !== pendingStorageConversationIdRef.current) return;
    writePendingPromptState(conversationId, pendingState);
  }, [conversationId, pendingState]);

  const syncChannelMessages = useCallback(async () => {
    if (!conversationId || !isChannelMode || syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    try {
      const data = await api.getConversationChannelMessages(conversationId, 100);
      setContextSnapshot(data.contextSnapshot ?? null);
      if (!data.messages?.length) return;
      const latestSeq = data.messages.reduce(
        (max, message) => Math.max(max, Number(message.seq ?? 0)),
        0,
      );
      if (latestSeq > 0 && canMarkSeen()) {
        onSeenSeqRef.current?.(latestSeq);
      }
      setMessages((prev) => mergeMessagesById(
        prev,
        data.messages
          .filter((message) => !shouldHideChannelMessage({
            text: message.content,
            messageSource: message.messageSource ?? undefined,
          }))
          .map(toLiveChannelMessage),
      ));
    } catch {
      // Ignore background sync failures; realtime WS remains primary.
    } finally {
      syncInFlightRef.current = false;
    }
  }, [conversationId, isChannelMode]);

  const appendOptimisticUserMessage = useCallback((params: {
    id: string;
    text: string;
    attachmentIds?: string[];
  }) => {
    setMessages((prev) => mergeMessagesById(prev, [
      {
        id: params.id,
        role: "user",
        text: params.text,
        createdAt: Date.now(),
        isStreaming: false,
        ...(params.attachmentIds?.length ? { attachmentIds: params.attachmentIds } : {}),
      },
    ]));
  }, []);

  const removeOptimisticUserMessage = useCallback((messageId: string) => {
    setMessages((prev) => prev.filter((message) => message.id !== messageId));
  }, []);

  const releasePendingBarrier = useCallback(() => {
    setPendingState((current) => (
      current.awaitingIdle
        ? { ...current, awaitingIdle: false }
        : current
    ));
  }, []);

  const enqueuePendingPrompt = useCallback((text: string, attachmentIds?: string[], sendAsTask?: boolean) => {
    const pendingPrompt: PendingLocalPrompt = {
      id: createClientMessageId(),
      text,
      createdAt: Date.now(),
      ...(attachmentIds?.length ? { attachmentIds } : {}),
      ...(sendAsTask ? { sendAsTask: true } : {}),
    };
    setPendingState((current) => ({
      items: [...current.items, pendingPrompt],
      awaitingIdle: true,
    }));
  }, []);

  const flushPendingQueue = useCallback(async () => {
    if (!conversationId) return;
    const currentPending = pendingStateRef.current;
    if (currentPending.items.length === 0 || currentPending.awaitingIdle || isFlushingPending) return;

    const { batch, remaining } = splitPendingPromptBatch(currentPending.items);
    const flushMessageId = createClientMessageId();
    const { displayText, promptText, attachmentIds, sendAsTask } = mergePendingPrompts(batch);
    setIsFlushingPending(true);
    setPendingState({ items: remaining, awaitingIdle: false });
    appendOptimisticUserMessage({
      id: flushMessageId,
      text: displayText,
      attachmentIds,
    });
    setStatus("submitted");

    try {
      const result = await api.sendConversationPrompt(conversationId, promptText, flushMessageId, sendAsTask || undefined);
      setStatus(result.skippedPrimaryDispatch ? "idle" : result.queued ? "queued" : "submitted");
    } catch (error) {
      removeOptimisticUserMessage(flushMessageId);
      setPendingState((current) => ({
        items: [...batch, ...current.items],
        awaitingIdle: true,
      }));
      setStatus("error");
      setMessages((prev) => [
        ...prev,
        {
          id: createId(),
          role: "system",
          text: String((error as Error)?.message ?? error),
          createdAt: Date.now(),
          isStreaming: false,
        },
      ]);
    } finally {
      setIsFlushingPending(false);
    }
  }, [
    appendOptimisticUserMessage,
    conversationId,
    isFlushingPending,
    removeOptimisticUserMessage,
  ]);

  // Helper: update the latest assistant message in-place
  const updateCurrentMessage = useCallback(() => {
    const msgId = currentMsgIdRef.current;
    if (!msgId) return;

    const text = textRef.current;
    const thinking = thinkingRef.current;
    const toolCalls = [...currentToolCallsRef.current];

    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? { ...m, text, thinking: thinking || undefined, toolCalls }
          : m,
      ),
    );
  }, []);

  const finalizeCurrentToolCalls = useCallback(() => {
    if (currentToolCallsRef.current.length === 0) return;
    currentToolCallsRef.current = currentToolCallsRef.current.map((tc) =>
      tc.completed
        ? tc
        : {
            ...tc,
            completed: true,
            endedAt: tc.endedAt ?? Date.now(),
            status: tc.status === "running" ? "completed" : tc.status,
          },
    );
    // Only update message if there's an active message being built (non-channel mode)
    if (currentMsgIdRef.current) {
      updateCurrentMessage();
    }
  }, [updateCurrentMessage]);

  // Process a single server event
  const processEvent = useCallback(
    (event: ServerEvent, ws: WebSocket) => {
      // Session identity guard: ignore stale WebSocket callbacks
      if (wsRef.current !== ws) return;

      if ((event as { type: string }).type === "history.reset") {
        setMessages([]);
        setRuns([]);
        setPendingApproval(null);
        setContextSnapshot(null);
        textRef.current = "";
        thinkingRef.current = "";
        currentToolCallsRef.current = [];
        currentMsgIdRef.current = null;
        currentRunIdRef.current = null;
        setStatus("idle");
        return;
      }

      switch (event.type) {
        case "error": {
          const message =
            typeof (event as { message?: unknown }).message === "string"
              ? (event as { message: string }).message
              : "Conversation connection failed.";
          if (
            message === "Unauthorized" ||
            message === "Access denied" ||
            message === "Conversation not found"
          ) {
            terminalWsErrorRef.current = message;
          }
          finalizeCurrentToolCalls();
          setStatus("error");
          setMessages((prev) => [
            ...prev,
            {
              id: createId(),
              role: "system",
              text: message,
              createdAt: Date.now(),
              isStreaming: false,
            },
          ]);
          break;
        }

        case "channel.message": {
          // Channel-based message: agent responded via send_message MCP.
          // Do NOT finalize the run here — the agent may continue with tool calls
          // (e.g. memory writes) after send_message. Let turn.end handle finalization.
          const { id, senderType, content, createdAt, messageSource } = event.message;
          if (shouldHideChannelMessage({ text: content, messageSource: messageSource ?? undefined })) {
            break;
          }
          const role = senderType === "user" ? "user" : senderType === "system" ? "system" : "assistant";
          const liveMessage = {
            id,
            role,
            text: content,
            createdAt: new Date(createdAt).getTime(),
            isStreaming: false,
            ...(messageSource ? { messageSource } : {}),
            ...(("threadRootId" in event.message && typeof event.message.threadRootId === "string")
              ? { threadRootId: event.message.threadRootId }
              : {}),
            ...(("replyCount" in event.message && typeof event.message.replyCount === "number")
              ? { replyCount: event.message.replyCount }
              : {}),
            ...(("taskNumber" in event.message && typeof event.message.taskNumber === "number")
              ? {
                  taskNumber: event.message.taskNumber,
                  taskStatus: "taskStatus" in event.message ? event.message.taskStatus : undefined,
                  taskAssigneeName: "taskAssigneeName" in event.message ? event.message.taskAssigneeName ?? null : null,
                }
              : {}),
          } satisfies LiveMessage;
          setMessages((prev) => {
            const index = prev.findIndex((message) => message.id === liveMessage.id);
            if (index < 0) return [...prev, liveMessage];
            const next = [...prev];
            next[index] = {
              ...prev[index],
              ...liveMessage,
            };
            return next;
          });
          if (typeof event.message.seq === "number" && canMarkSeen()) {
            onSeenSeqRef.current?.(event.message.seq);
          }
          break;
        }

        case "turn.begin": {
          const isReplay = event.turnId.startsWith("replay-");
          if (isChannelMode) {
            // Channel mode: create a run entry for Activity tab; no message bubble.
            // Replay turns (history) are included but don't change streaming status.
            const runId = event.turnId;
            const isReplay = runId.startsWith("replay-");
            const startedAt = event.startedAt ?? Date.now();
            currentRunIdRef.current = runId;
            textRef.current = "";
            thinkingRef.current = "";
            currentToolCallsRef.current = [];
            currentMsgIdRef.current = null;
            if (!isReplay) setStatus("streaming");
            setRuns((prev) =>
              upsertRun(prev, runId, (current) => ({
                id: runId,
                runId: current?.runId ?? getDisplayRunId(runId),
                startedAt: current?.startedAt ?? startedAt,
                endedAt: current?.endedAt,
                promptText: event.promptText ?? current?.promptText,
                toolCalls: current?.toolCalls ?? [],
                activityItems: current?.activityItems ?? [],
                thinking: current?.thinking,
                outputText: current?.outputText,
                isActive: !isReplay,
                status:
                  current?.endedAt != null
                    ? current.status
                    : current?.status === "recovering"
                      ? "recovering"
                      : "running",
                stopReason: current?.stopReason,
                error: current?.error,
              })),
            );
            break;
          }
          // Start a new assistant message
          const id = createId();
          currentMsgIdRef.current = id;
          textRef.current = "";
          thinkingRef.current = "";
          currentToolCallsRef.current = [];
          if (!isReplay) {
            setStatus("streaming");
          }
          currentRunIdRef.current = event.turnId;
          setMessages((prev) => [
            ...prev,
            {
              id,
              role: "assistant",
              text: "",
              createdAt: Date.now(),
              isStreaming: !isReplay,
            },
          ]);
          break;
        }

        case "content.delta": {
          if (isLegacyPlanOrTaskDelta(event.text)) {
            break;
          }
          textRef.current += event.text;
          // Only update message content in non-channel mode (ACP streaming)
          // In channel mode, content comes via channel.message event
          if (!isChannelMode && currentMsgIdRef.current) {
            updateCurrentMessage();
          }
          if (isChannelMode && currentRunIdRef.current) {
            const runId = currentRunIdRef.current;
            const outputText = textRef.current;
            setRuns((prev) =>
              prev.map((r) => (r.id === runId ? { ...r, outputText } : r)),
            );
          }
          break;
        }

        case "plan.update":
        case "task.update": {
          if (!currentRunIdRef.current) break;
          const runId = currentRunIdRef.current;
          const kind = event.type === "plan.update" ? "plan" : "task";
          const activityItem: LiveRunActivityItem = {
            id: `${runId}:${kind}:${event.createdAt ?? Date.now()}:${event.title}`,
            kind,
            title: event.title,
            detail: event.detail,
            createdAt: event.createdAt ?? Date.now(),
          };
          setRuns((prev) =>
            prev.map((r) =>
              r.id === runId
                ? {
                    ...r,
                    activityItems: appendActivityItem(r.activityItems, activityItem),
                  }
                : r,
            ),
          );
          break;
        }

        case "thinking.delta": {
          thinkingRef.current += event.text;
          // Only update message thinking in non-channel mode (ACP streaming)
          if (!isChannelMode && currentMsgIdRef.current) {
            updateCurrentMessage();
          }
          if (isChannelMode && currentRunIdRef.current) {
            const runId = currentRunIdRef.current;
            const thinking = thinkingRef.current;
            setRuns((prev) =>
              prev.map((r) => (r.id === runId ? { ...r, thinking } : r)),
            );
          }
          break;
        }

        case "tool.call": {
          const startedAt =
            typeof event.startedAt === "number" ? event.startedAt : Date.now();
          const existingIndex = currentToolCallsRef.current.findIndex(
            (tc) => tc.id === event.toolCallId,
          );

          if (existingIndex >= 0) {
            currentToolCallsRef.current = currentToolCallsRef.current.map((tc, index) =>
              index === existingIndex
                ? {
                    ...tc,
                    name: event.name,
                    input: event.input,
                    completed: false,
                    startedAt: tc.startedAt ?? startedAt,
                    status: "running",
                  }
                : tc,
            );
          } else {
            currentToolCallsRef.current = [
              ...currentToolCallsRef.current,
              {
                id: event.toolCallId,
                name: event.name,
                input: event.input,
                completed: false,
                startedAt,
                status: "running",
              },
            ];
          }
          // Only update message tool calls in non-channel mode (ACP streaming)
          // In channel mode, tool calls should only appear in Activity tab (runs)
          if (!isChannelMode && currentMsgIdRef.current) {
            updateCurrentMessage();
          }
          if (isChannelMode && currentRunIdRef.current) {
            const runId = currentRunIdRef.current;
            const toolCalls = [...currentToolCallsRef.current];
            setRuns((prev) =>
              prev.map((r) => (r.id === runId ? { ...r, toolCalls } : r)),
            );
          }
          break;
        }

        case "tool.result": {
          const endedAt =
            typeof event.endedAt === "number" ? event.endedAt : Date.now();
          const toolStatus = "status" in event ? event.status : undefined;
          currentToolCallsRef.current = currentToolCallsRef.current.map((tc) =>
            tc.id === event.toolCallId
              ? {
                  ...tc,
                  completed: true,
                  output: event.output,
                  error: event.error,
                  status:
                    toolStatus === "cancelled"
                      ? "cancelled"
                      : event.error || toolStatus === "failed"
                        ? "failed"
                        : "completed",
                  endedAt,
                  startedAt: tc.startedAt ?? endedAt,
                }
              : tc,
          );
          // Only update message tool calls in non-channel mode (ACP streaming)
          // In channel mode, tool calls should only appear in Activity tab (runs)
          if (!isChannelMode && currentMsgIdRef.current) {
            updateCurrentMessage();
          }
          if (isChannelMode && currentRunIdRef.current) {
            const runId = currentRunIdRef.current;
            const toolCalls = [...currentToolCallsRef.current];
            setRuns((prev) =>
              prev.map((r) => (r.id === runId ? { ...r, toolCalls } : r)),
            );
          }
          break;
        }

        case "approval.request": {
          setPendingApproval({
            requestId: event.requestId,
            toolName: event.toolName,
            toolArgs: event.toolArgs,
          });
          if (currentRunIdRef.current) {
            const runId = currentRunIdRef.current;
            setRuns((prev) =>
              prev.map((r) => (r.id === runId ? { ...r, status: "awaiting_approval" } : r)),
            );
          }
          break;
        }

        case "turn.end": {
          const turnError = "error" in event ? event.error : undefined;
          const endedAt =
            typeof (event as { endedAt?: unknown }).endedAt === "number"
              ? ((event as { endedAt?: number }).endedAt ?? Date.now())
              : Date.now();
          const runStatus = getRunTerminalStatus({
            stopReason: event.stopReason,
            error: turnError,
          });
          currentToolCallsRef.current = currentToolCallsRef.current.map((tc) =>
            tc.completed
              ? tc
              : {
                  ...tc,
                  completed: true,
                  endedAt: tc.endedAt ?? endedAt,
                  status: getToolTerminalStatus({
                    turnStatus: runStatus,
                    toolError: tc.error,
                  }),
                },
          );
          finalizeCurrentToolCalls();
          const msgId = currentMsgIdRef.current;
          if (msgId) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId ? { ...m, isStreaming: false } : m,
              ),
            );
          }
          // Finalize any active run — include finalized toolCalls so tool calls without
          // an explicit tool.result (e.g. some codex tools) are shown as completed.
          if (currentRunIdRef.current) {
            const runId = currentRunIdRef.current;
            const toolCalls = [...currentToolCallsRef.current];
            setRuns((prev) =>
              prev.map((r) =>
                r.id === runId
                  ? {
                      ...r,
                      isActive: false,
                      status: runStatus,
                      endedAt,
                      stopReason: event.stopReason,
                      error: turnError,
                      toolCalls,
                      activityItems: r.activityItems,
                      outputText: textRef.current || r.outputText,
                      thinking: thinkingRef.current || r.thinking,
                    }
                  : r,
              ),
            );
          }
          currentRunIdRef.current = null;
          currentMsgIdRef.current = null;
          if (!event.turnId.startsWith("replay-")) {
            releasePendingBarrier();
          }
          setStatus("idle");
          break;
        }

        case "conversation.status": {
          if (!historyReadyRef.current && initialServerStatusRef.current == null) {
            initialServerStatusRef.current = event.status as ServerConversationStatus;
          }
          // 同步 status 到全局 conversation store，确保 Session Manager 等面板实时准确
          if (conversationId) {
            useConversationsStore.getState().patchConversationStatus(conversationId, event.status);
          }
          if (event.status === "idle") {
            setStatus("idle");
          } else if (event.status === "queued") {
            setStatus("queued");
          } else if (event.status === "active") {
            setStatus((prev) => (prev === "streaming" ? prev : "submitted"));
            if (currentRunIdRef.current) {
              const runId = currentRunIdRef.current;
              setRuns((prev) =>
                prev.map((r) => (r.id === runId ? { ...r, status: "running" } : r)),
              );
            }
          } else if (event.status === "recovering") {
            setStatus("recovering");
            if (currentRunIdRef.current) {
              const runId = currentRunIdRef.current;
              setRuns((prev) =>
                prev.map((r) => (r.id === runId ? { ...r, status: "recovering" } : r)),
              );
            }
          } else if (event.status === "awaiting_approval") {
            setStatus("awaiting_approval");
            if (currentRunIdRef.current) {
              const runId = currentRunIdRef.current;
              setRuns((prev) =>
                prev.map((r) => (r.id === runId ? { ...r, status: "awaiting_approval" } : r)),
              );
            }
          } else if (event.status === "failed") {
            setStatus("error");
          }
          if (
            historyReadyRef.current
            && pendingStateRef.current.awaitingIdle
            && (event.status === "idle" || event.status === "failed")
          ) {
            releasePendingBarrier();
          }
          break;
        }

        case "history.user_message": {
          // Channel mode uses REST history — skip WS replay to avoid duplicates
          if (isChannelMode) break;
          const umId = createId();
          const { displayText, attachmentIds: parsedIds } = parsePromptText((event as any).text ?? "");
          setMessages((prev) => [
            ...prev,
            {
              id: umId,
              role: "user",
              text: displayText,
              createdAt: Date.now(),
              isStreaming: false,
              ...(parsedIds.length ? { attachmentIds: parsedIds } : {}),
            },
          ]);
          break;
        }

        case "history.complete": {
          historyReadyRef.current = true;
          setHistoryReady(true);
          // History replay done, ready for interaction
          const replayRunActive =
            currentRunIdRef.current?.startsWith("replay-") ?? false;
          if (replayRunActive) {
            finalizeCurrentToolCalls();
            const msgId = currentMsgIdRef.current;
            if (msgId) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === msgId ? { ...m, isStreaming: false } : m,
                ),
              );
            }
            currentRunIdRef.current = null;
            currentMsgIdRef.current = null;
            const initialStatus = initialServerStatusRef.current;
            const shouldRemainBusy = initialStatus != null && initialStatus !== "idle" && initialStatus !== "failed";
            if (!shouldRemainBusy) {
              setStatus("idle");
            }
          }
          if (
            pendingStateRef.current.awaitingIdle
            && (initialServerStatusRef.current === "idle" || initialServerStatusRef.current === "failed")
          ) {
            releasePendingBarrier();
          }
          break;
        }

        case "system.notice": {
          const noticeId = createId();
          setMessages((prev) => [
            ...prev,
            {
              id: noticeId,
              role: "system",
              text: event.message,
              createdAt: Date.now(),
              isStreaming: false,
            },
          ]);
          break;
        }
      }
    },
    [conversationId, finalizeCurrentToolCalls, releasePendingBarrier, updateCurrentMessage],
  );

  // Connect / disconnect WebSocket on conversationId change
  useLayoutEffect(() => {
    let cancelled = false;

    // Reset state
    setMessages([]);
    setPendingState({ items: [], awaitingIdle: false });
    setRuns([]);
    setStatus("idle");
    setConnectionReady(false);
    setPendingApproval(null);
    setContextSnapshot(null);
    setHistoryReady(false);
    setIsFlushingPending(false);
    textRef.current = "";
    thinkingRef.current = "";
    currentToolCallsRef.current = [];
    currentMsgIdRef.current = null;
    currentRunIdRef.current = null;
    pendingClientEventsRef.current = [];
    connectionReadyRef.current = false;
    terminalWsErrorRef.current = null;
    historyReadyRef.current = false;
    initialServerStatusRef.current = null;

    if (!conversationId) {
      pendingStorageConversationIdRef.current = null;
      wsRef.current = null;
      return;
    }

    pendingStorageConversationIdRef.current = conversationId;
    setPendingState(readPendingPromptState(conversationId));

    api
      .getHistory(conversationId)
      .then((historyRuns) => {
        if (cancelled) return;
        setRuns(
          historyRuns.map((run) => ({
            id: `replay-${run.runId}`,
            runId: run.runId,
            startedAt: run.startedAt,
            endedAt: run.endedAt ?? undefined,
            promptText: run.promptText,
            toolCalls: [],
            activityItems: [],
            thinking: run.thinkingText,
            outputText: run.assistantText,
            isActive: run.endedAt == null,
            status:
              run.endedAt == null
                ? "running"
                : getRunTerminalStatus({
                    stopReason: run.error ? "error" : (run.stopReason ?? "end_turn"),
                    error: run.error ?? undefined,
                  }),
            stopReason: run.error ? "error" : (run.stopReason ?? undefined),
            error: run.error ?? undefined,
          })),
        );
      })
      .catch(() => {
        // Fall back to websocket replay only.
      });

    // Channel mode: load history from REST endpoint before opening WS
    if (isChannelMode) {
      api
        .getConversationChannelMessages(conversationId, 100)
        .then((data) => {
          if (cancelled) return;
          setContextSnapshot(data.contextSnapshot ?? null);
          if (!data.messages) return;
          const latestSeq = data.messages.reduce(
            (max, message) => Math.max(max, Number(message.seq ?? 0)),
            0,
          );
          if (latestSeq > 0 && canMarkSeen()) {
            onSeenSeqRef.current?.(latestSeq);
          }
          setMessages((prev) => mergeMessagesById(prev, data.messages.map(toLiveChannelMessage)));
        })
        .catch(() => {/* ignore */});
    }

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    const connect = () => {
      if (cancelled || !conversationId) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const token = localStorage.getItem('auth_token') ?? '';
      const wsUrl = `${protocol}//${window.location.host}/api/conversations/${conversationId}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      const openTimeout = setTimeout(() => {
        if (wsRef.current !== ws) return;
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      }, 8_000);

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        clearTimeout(openTimeout);
        reconnectAttempt = 0;
        connectionReadyRef.current = true;
        setConnectionReady(true);
        setStatus((prev) => (prev === "error" ? "idle" : prev));
        if (pendingClientEventsRef.current.length === 0) return;
        for (const pendingEvent of pendingClientEventsRef.current) {
          ws.send(JSON.stringify(pendingEvent));
        }
        pendingClientEventsRef.current = [];
      };

      ws.onmessage = (evt) => {
        try {
          const event: ServerEvent = JSON.parse(evt.data);
          processEvent(event, ws);
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onerror = () => {
        if (wsRef.current !== ws) return;
        connectionReadyRef.current = false;
        setConnectionReady(false);
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        clearTimeout(openTimeout);
        connectionReadyRef.current = false;
        setConnectionReady(false);
        finalizeCurrentToolCalls();
        if (pendingClientEventsRef.current.length > 0) {
          setMessages((prev) => [
            ...prev,
            {
              id: createId(),
              role: "system",
              text: "Message delivery failed before the conversation connection was ready. Please resend.",
              createdAt: Date.now(),
              isStreaming: false,
            },
          ]);
          pendingClientEventsRef.current = [];
        }
        const msgId = currentMsgIdRef.current;
        if (msgId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId ? { ...m, isStreaming: false } : m,
            ),
          );
        }
        if (cancelled || terminalWsErrorRef.current) {
          setStatus("error");
          return;
        }
        reconnectAttempt += 1;
        const delayMs = Math.min(5_000, 500 * reconnectAttempt);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delayMs);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      const ws = wsRef.current;
      ws?.close();
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
  }, [conversationId, isChannelMode, finalizeCurrentToolCalls, processEvent]);

  useEffect(() => {
    if (!conversationId || !isChannelMode) return;

    const intervalId = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void syncChannelMessages();
    }, ACTIVE_CONVERSATION_SYNC_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [conversationId, isChannelMode, syncChannelMessages]);

  useEffect(() => {
    if (!conversationId || !connectionReady || !historyReady || isFlushingPending) return;
    if (
      status === "queued"
      || status === "submitted"
      || status === "streaming"
      || status === "recovering"
      || status === "awaiting_approval"
    ) {
      return;
    }
    if (pendingState.items.length === 0 || pendingState.awaitingIdle) return;
    void flushPendingQueue();
  }, [
    connectionReady,
    conversationId,
    flushPendingQueue,
    historyReady,
    isFlushingPending,
    pendingState.awaitingIdle,
    pendingState.items.length,
    status,
  ]);

  // Send helpers
  const sendEvent = useCallback((event: ClientEvent) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
      return true;
    }
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      pendingClientEventsRef.current.push(event);
      return true;
    }
    return false;
  }, []);

  const sendPrompt = useCallback(
    (text: string, attachmentIds?: string[], sendAsTask?: boolean) => {
      if (!conversationId) {
        setStatus("error");
        return false;
      }

      const isBusy =
        status === "queued"
        || status === "submitted"
        || status === "streaming"
        || status === "recovering"
        || status === "awaiting_approval";
      if (pendingStateRef.current.items.length > 0 && !isFlushingPending) {
        enqueuePendingPrompt(text, attachmentIds, sendAsTask);
        if (!isBusy) {
          releasePendingBarrier();
        }
        return true;
      }
      if (isBusy) {
        enqueuePendingPrompt(text, attachmentIds, sendAsTask);
        return true;
      }

      const id = createClientMessageId();
      const promptText = buildPromptTextWithAttachments(text, attachmentIds);
      appendOptimisticUserMessage({ id, text, attachmentIds });
      const rollback = () => removeOptimisticUserMessage(id);

      setStatus("submitted");
      void api
        .sendConversationPrompt(conversationId, promptText, id, sendAsTask || undefined)
        .then((result) => {
          setStatus(result.skippedPrimaryDispatch ? "idle" : result.queued ? "queued" : "submitted");
        })
        .catch((error) => {
          rollback();
          setStatus("error");
          setMessages((prev) => [
            ...prev,
            {
              id: createId(),
              role: "system",
              text: String(error?.message ?? error),
              createdAt: Date.now(),
              isStreaming: false,
            },
          ]);
        });

      return true;
    },
    [appendOptimisticUserMessage, conversationId, enqueuePendingPrompt, isFlushingPending, releasePendingBarrier, removeOptimisticUserMessage, status],
  );

  const respondApproval = useCallback(
    (requestId: string, decision: "allow" | "deny") => {
      setPendingApproval(null);
      setStatus("submitted");
      if (!sendEvent({ type: "approval.response", requestId, decision })) {
        setStatus("error");
      }
    },
    [sendEvent],
  );

  const cancel = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "cancel" } satisfies ClientEvent));
      return;
    }
    if (!conversationId) {
      setStatus("error");
      return;
    }
    void api
      .cancelConversationPrompt(conversationId)
      .catch((error) => {
        setStatus("error");
        setMessages((prev) => [
          ...prev,
          {
            id: createId(),
            role: "system",
            text: String(error?.message ?? error),
            createdAt: Date.now(),
            isStreaming: false,
          },
        ]);
      });
  }, [conversationId]);

  return {
    messages,
    pendingMessages: pendingState.items,
    runs,
    status,
    connectionReady,
    hasActiveRun,
    isFlushingPending,
    pendingApproval,
    contextSnapshot,
    sendPrompt,
    respondApproval,
    cancel,
  };
}
