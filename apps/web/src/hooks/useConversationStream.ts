import { useState, useCallback, useRef, useLayoutEffect } from "react";
import type { ServerEvent, ClientEvent } from "@agent-collab/protocol";
import type { LiveMessage, LiveToolCall, PendingApproval, ChatStatus } from "./types";

let nextId = 1;
const createId = () => `msg-${nextId++}`;

type UseConversationStreamOptions = {
  conversationId: string | null;
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
  const { conversationId } = options;

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

  // Process a single server event
  const processEvent = useCallback(
    (event: ServerEvent, ws: WebSocket) => {
      // Session identity guard: ignore stale WebSocket callbacks
      if (wsRef.current !== ws) return;

      switch (event.type) {
        case "turn.begin": {
          // Start a new assistant message
          const id = createId();
          currentMsgIdRef.current = id;
          textRef.current = "";
          thinkingRef.current = "";
          currentToolCallsRef.current = [];
          setStatus("streaming");
          setMessages((prev) => [
            ...prev,
            { id, role: "assistant", text: "", isStreaming: true },
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
          currentToolCallsRef.current = [
            ...currentToolCallsRef.current,
            {
              id: event.toolCallId,
              name: event.name,
              input: event.input,
            },
          ];
          updateCurrentMessage();
          break;
        }

        case "tool.result": {
          currentToolCallsRef.current = currentToolCallsRef.current.map((tc) =>
            tc.id === event.toolCallId
              ? { ...tc, output: event.output, error: event.error }
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
          setStatus("error");
          break;
        }

        case "history.user_message": {
          // 历史回放：插入用户消息
          const umId = createId();
          setMessages((prev) => [
            ...prev,
            { id: umId, role: "user", text: (event as any).text ?? "", isStreaming: false },
          ]);
          break;
        }

        case "history.complete": {
          // History replay done, ready for interaction
          break;
        }
      }
    },
    [updateCurrentMessage],
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
  }, [conversationId, processEvent]);

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
        { id, role: "user", text, isStreaming: false },
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
