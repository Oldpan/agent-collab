import { useState, useCallback, useRef, useLayoutEffect } from "react";
import type { ChannelMessage } from "@/lib/api";
import * as api from "@/lib/api";

function readUserName(): string {
  try {
    const stored = JSON.parse(localStorage.getItem("agent-collab:user-identity") ?? "{}") as { name?: string };
    return stored.name ?? "User";
  } catch {
    return "User";
  }
}

export function useChannelStream(channelId: string | null): {
  messages: ChannelMessage[];
  sendMessage: (content: string) => Promise<void>;
} {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useLayoutEffect(() => {
    setMessages([]);
    if (!channelId) {
      wsRef.current = null;
      return;
    }
    let cancelled = false;

    api
      .getChannelMessages(channelId, 100)
      .then((d) => { if (!cancelled) setMessages(d.messages); })
      .catch(() => {});

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/channels/${encodeURIComponent(channelId)}/stream`,
    );
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      if (wsRef.current !== ws) return;
      try {
        const event = JSON.parse(evt.data as string) as { type: string; message?: ChannelMessage };
        if (event.type === "channel.message" && event.message) {
          const msg = event.message;
          setMessages((prev) =>
            prev.some((m) => m.id === msg.id) ? prev : [...prev, msg],
          );
        }
      } catch {
        // ignore malformed messages
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
    };

    return () => {
      cancelled = true;
      ws.close();
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [channelId]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!channelId) return;
      const senderName = readUserName();
      const result = await api.sendChannelMessage(channelId, content, senderName);
      // Add message only if WS broadcast hasn't delivered it yet (race: WS can arrive before REST response)
      setMessages((prev) => {
        if (prev.some((m) => m.id === result.messageId)) return prev;
        return [
          ...prev,
          {
            id: result.messageId,
            senderName,
            senderType: "user",
            content,
            createdAt: new Date().toISOString(),
          },
        ];
      });
    },
    [channelId],
  );

  return { messages, sendMessage };
}
