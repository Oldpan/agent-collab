import { useState, useCallback, useRef, useLayoutEffect } from "react";
import type { ServerEvent, ClientEvent } from "@agent-collab/protocol";
import type { LiveMessage, LiveToolCall, PendingApproval, ChatStatus } from "./types";

let nextId = 1;
const createId = () => `msg-${nextId++}`;

type UseConversationStreamOptions = {
  conversationId: string | null;
  /** When set (agent conversation), use channel-based message model instead of ACP streaming */
  conversationAgentId?: string | null;
};

type UseConversationStreamReturn = {
  messages: LiveMessage[];
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
  const isChannelMode = Boolean(conversationAgentId);

  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);

  // Refs for streaming accumulators
  const wsRef = useRef<WebSocket | null>(null);
  const textRef = useRef("");
  const thinkingRef = useRef("");
  const currentToolCallsRef = useRef<LiveToolCall[]>([]);
  const currentMsgIdRef = useRef<string | null>(null);

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
      tc.completed ? tc : { ...tc, completed: true },
    );
    updateCurrentMessage();
  }, [updateCurrentMessage]);

  // Process a single server event
  const processEvent = useCallback(
    (event: ServerEvent, ws: WebSocket) => {
      // Session identity guard: ignore stale WebSocket callbacks
      if (wsRef.current !== ws) return;

      if ((event as { type: string }).type === "history.reset") {
        setMessages([]);
        setPendingApproval(null);
        textRef.current = "";
        thinkingRef.current = "";
        currentToolCallsRef.current = [];
        currentMsgIdRef.current = null;
        setStatus("idle");
        return;
      }

      switch (event.type) {
        case "channel.message": {
          // Channel-based message: agent responded via send_message MCP
          const { id, senderName, senderType, content, createdAt } = event.message;
          const role = senderType === "user" ? "user" : "assistant";
          const toolCalls = role === "assistant" ? [...currentToolCallsRef.current] : undefined;
          currentToolCallsRef.current = [];
          currentMsgIdRef.current = null;
          setMessages((prev) => [
            ...prev,
            {
              id,
              role,
              text: content,
              createdAt: new Date(createdAt).getTime(),
              isStreaming: false,
              toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
            },
          ]);
          break;
        }

        case "turn.begin": {
          if (isChannelMode) {
            // Channel mode: don't create a message bubble — just reset accumulators.
            // The message will be created when channel.message arrives.
            textRef.current = "";
            thinkingRef.current = "";
            currentToolCallsRef.current = [];
            currentMsgIdRef.current = null;
            setStatus("streaming");
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
          textRef.current += event.text;
          updateCurrentMessage();
          break;
        }

        case "thinking.delta": {
          thinkingRef.current += event.text;
          updateCurrentMessage();
          break;
        }

        case "tool.call": {
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
              },
            ];
          }
          updateCurrentMessage();
          break;
        }

        case "tool.result": {
          currentToolCallsRef.current = currentToolCallsRef.current.map((tc) =>
            tc.id === event.toolCallId
              ? { ...tc, completed: true, output: event.output, error: event.error }
              : tc,
          );
          updateCurrentMessage();
          break;
        }

        case "approval.request": {
          setPendingApproval({
            requestId: event.requestId,
            toolName: event.toolName,
            toolArgs: event.toolArgs,
          });
          break;
        }

        case "turn.end": {
          finalizeCurrentToolCalls();
          const msgId = currentMsgIdRef.current;
          if (msgId) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId ? { ...m, isStreaming: false } : m,
              ),
            );
          }
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
          } else if (event.status === "recovering") {
            setStatus("recovering");
          } else if (event.status === "awaiting_approval") {
            setStatus("awaiting_approval");
          } else if (event.status === "failed") {
            setStatus("error");
          }
          break;
        }

        case "error": {
          finalizeCurrentToolCalls();
          setStatus("error");
          break;
        }

        case "history.user_message": {
          // 历史回放：插入用户消息
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
      }
    },
    [finalizeCurrentToolCalls, updateCurrentMessage],
  );

  // Connect / disconnect WebSocket on conversationId change
  useLayoutEffect(() => {
    // Reset state
    setMessages([]);
    setStatus("idle");
    setPendingApproval(null);
    textRef.current = "";
    thinkingRef.current = "";
    currentToolCallsRef.current = [];
    currentMsgIdRef.current = null;

    if (!conversationId) {
      wsRef.current = null;
      return;
    }

    // Channel mode: load history from REST endpoint before opening WS
    if (isChannelMode) {
      fetch(`/api/conversations/${conversationId}/channel-messages?limit=100`)
        .then((r) => r.json())
        .then((data: { messages?: Array<{ id: string; senderName: string; senderType: string; content: string; createdAt: string }> }) => {
          if (!data.messages) return;
          setMessages(
            data.messages.map((m) => ({
              id: m.id,
              role: m.senderType === "user" ? "user" : "assistant",
              text: m.content,
              createdAt: new Date(m.createdAt).getTime(),
              isStreaming: false,
            })),
          );
        })
        .catch(() => {/* ignore */});
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/conversations/${conversationId}/stream`;
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
    status,
    pendingApproval,
    sendPrompt,
    respondApproval,
    cancel,
  };
}
