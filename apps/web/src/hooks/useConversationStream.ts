import { useState, useCallback, useRef, useLayoutEffect, useEffect } from "react";
import type { ServerEvent, ClientEvent } from "@agent-collab/protocol";
import type {
  LiveMessage,
  LiveRun,
  LiveRunActivityItem,
  LiveToolCall,
  PendingApproval,
  ChatStatus,
} from "./types";
import * as api from "@/lib/api";

let nextId = 1;
const createId = () => `msg-${nextId++}`;

function getDisplayRunId(turnId: string): string {
  return turnId.startsWith("replay-") ? turnId.slice("replay-".length) : turnId;
}

function isDispatchFailureError(error?: string): boolean {
  return error === "Node not connected" || error === "Node disconnected during dispatch";
}

function canMarkSeen(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function isLegacyPlanOrTaskDelta(text: string): boolean {
  const normalized = text.trimStart();
  return normalized.startsWith("[plan] ") || normalized.startsWith("[task] ");
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

type UseConversationStreamOptions = {
  conversationId: string | null;
  /** When set (agent conversation), use channel-based message model instead of ACP streaming */
  conversationAgentId?: string | null;
  onSeenSeq?: (seq: number) => void;
};

type UseConversationStreamReturn = {
  messages: LiveMessage[];
  runs: LiveRun[];
  status: ChatStatus;
  pendingApproval: PendingApproval | null;
  sendPrompt: (text: string) => void;
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
  const [runs, setRuns] = useState<LiveRun[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);

  // Refs for streaming accumulators
  const wsRef = useRef<WebSocket | null>(null);
  const onSeenSeqRef = useRef<typeof onSeenSeq>(onSeenSeq);
  const textRef = useRef("");
  const thinkingRef = useRef("");
  const currentToolCallsRef = useRef<LiveToolCall[]>([]);
  const currentMsgIdRef = useRef<string | null>(null);
  const currentRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    onSeenSeqRef.current = onSeenSeq;
  }, [onSeenSeq]);

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
        textRef.current = "";
        thinkingRef.current = "";
        currentToolCallsRef.current = [];
        currentMsgIdRef.current = null;
        currentRunIdRef.current = null;
        setStatus("idle");
        return;
      }

      switch (event.type) {
        case "channel.message": {
          // Channel-based message: agent responded via send_message MCP.
          // Do NOT finalize the run here — the agent may continue with tool calls
          // (e.g. memory writes) after send_message. Let turn.end handle finalization.
          const { id, senderType, content, createdAt, messageSource } = event.message;
          const role = senderType === "user" ? "user" : "assistant";
          setMessages((prev) => [
            ...prev,
            {
              id,
              role,
              text: content,
              createdAt: new Date(createdAt).getTime(),
              isStreaming: false,
              ...(messageSource ? { messageSource } : {}),
            },
          ]);
          if (typeof event.message.seq === "number" && canMarkSeen()) {
            onSeenSeqRef.current?.(event.message.seq);
          }
          break;
        }

        case "turn.begin": {
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
          setStatus("streaming");
          setMessages((prev) => [
            ...prev,
            { id, role: "assistant", text: "", createdAt: Date.now(), isStreaming: true },
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
          setStatus("idle");
          break;
        }

        case "conversation.status": {
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
          break;
        }

        case "error": {
          finalizeCurrentToolCalls();
          setStatus("error");
          const errorId = createId();
          setMessages((prev) => [
            ...prev,
            {
              id: errorId,
              role: "system",
              text: event.message,
              createdAt: Date.now(),
              isStreaming: false,
            },
          ]);
          break;
        }

        case "history.user_message": {
          // Channel mode uses REST history — skip WS replay to avoid duplicates
          if (isChannelMode) break;
          const umId = createId();
          setMessages((prev) => [
            ...prev,
            {
              id: umId,
              role: "user",
              text: (event as any).text ?? "",
              createdAt: Date.now(),
              isStreaming: false,
            },
          ]);
          break;
        }

        case "history.complete": {
          // History replay done, ready for interaction
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
    [finalizeCurrentToolCalls, updateCurrentMessage],
  );

  // Connect / disconnect WebSocket on conversationId change
  useLayoutEffect(() => {
    let cancelled = false;

    // Reset state
    setMessages([]);
    setRuns([]);
    setStatus("idle");
    setPendingApproval(null);
    textRef.current = "";
    thinkingRef.current = "";
    currentToolCallsRef.current = [];
    currentMsgIdRef.current = null;
    currentRunIdRef.current = null;

    if (!conversationId) {
      wsRef.current = null;
      return;
    }

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
          if (!data.messages) return;
          const latestSeq = data.messages.reduce(
            (max, message) => Math.max(max, Number(message.seq ?? 0)),
            0,
          );
          if (latestSeq > 0 && canMarkSeen()) {
            onSeenSeqRef.current?.(latestSeq);
          }
          setMessages(
            data.messages.map((m) => ({
              id: m.id,
              role: m.senderType === "user" ? "user" : "assistant",
              text: m.content,
              createdAt: new Date(m.createdAt).getTime(),
              isStreaming: false,
              ...(m.messageSource ? { messageSource: m.messageSource } : {}),
            })),
          );
        })
        .catch(() => {/* ignore */});
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = localStorage.getItem('auth_token') ?? '';
    const wsUrl = `${protocol}//${window.location.host}/api/conversations/${conversationId}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

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
      setStatus("error");
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      finalizeCurrentToolCalls();
      // Mark any streaming message as done
      const msgId = currentMsgIdRef.current;
      if (msgId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId ? { ...m, isStreaming: false } : m,
          ),
        );
      }
    };

    return () => {
      cancelled = true;
      ws.close();
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
  }, [conversationId, isChannelMode, finalizeCurrentToolCalls, processEvent]);

  // Send helpers
  const sendEvent = useCallback((event: ClientEvent) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }, []);

    const sendPrompt = useCallback(
    (text: string) => {
      // Add user message to timeline
      const id = createId();
      setMessages((prev) => [
        ...prev,
        { id, role: "user", text, createdAt: Date.now(), isStreaming: false },
      ]);
      setStatus("submitted");
      sendEvent({ type: "prompt", text });
    },
    [sendEvent],
  );

  const respondApproval = useCallback(
    (requestId: string, decision: "allow" | "deny") => {
      setPendingApproval(null);
      setStatus("submitted");
      sendEvent({ type: "approval.response", requestId, decision });
    },
    [sendEvent],
  );

  const cancel = useCallback(() => {
    sendEvent({ type: "cancel" });
  }, [sendEvent]);

  return {
    messages,
    runs,
    status,
    pendingApproval,
    sendPrompt,
    respondApproval,
    cancel,
  };
}
