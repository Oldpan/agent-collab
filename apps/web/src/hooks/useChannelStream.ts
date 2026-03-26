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
  loadMore: () => Promise<void>;
  hasMore: boolean;
} {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);

  useLayoutEffect(() => {
    setMessages([]);
    setHasMore(true);
    if (!channelId) {
      wsRef.current = null;
      return;
    }
    let cancelled = false;

    api
      .getChannelMessages(channelId, 100)
      .then((d) => {
        if (!cancelled) {
          setMessages(d.messages);
          if (d.messages.length < 100) setHasMore(false);
        }
      })
      .catch(() => {});

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/channels/${encodeURIComponent(channelId)}/stream`,
    );
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      if (wsRef.current !== ws) return;
      try {
        const event = JSON.parse(evt.data as string) as {
          type: string;
          message?: ChannelMessage;
          notice?: { message: string; createdAt: string };
        };
        if (event.type === "channel.message" && event.message) {
          const msg = event.message;
          if (!msg.threadRootId) {
            // Top-level message — add to main channel list
            setMessages((prev) =>
              prev.some((m) => m.id === msg.id) ? prev : [...prev, msg],
            );
          } else {
            // Thread reply — increment replyCount on parent message
            setMessages((prev) =>
              prev.map((m) =>
                m.id.slice(0, 8) === msg.threadRootId
                  ? { ...m, replyCount: (m.replyCount ?? 0) + 1 }
                  : m,
              ),
            );
          }
        } else if (event.type === "channel.notice" && event.notice) {
          const notice = event.notice;
          setMessages((prev) => [
            ...prev,
            {
              id: `notice-${notice.createdAt}-${prev.length}`,
              senderName: "System",
              senderType: "system",
              content: notice.message,
              createdAt: notice.createdAt,
            },
          ]);
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

  const loadMore = useCallback(async () => {
    if (!channelId || !hasMore) return;
    const oldest = messages[0];
    const before = oldest?.seq;
    const data = await api.getChannelMessages(channelId, 50, before);
    if (data.messages.length < 50) setHasMore(false);
    if (data.messages.length > 0) {
      setMessages((prev) => {
        // Deduplicate in case of overlap
        const existingIds = new Set(prev.map((m) => m.id));
        const newMsgs = data.messages.filter((m) => !existingIds.has(m.id));
        return [...newMsgs, ...prev];
      });
    }
  }, [channelId, messages, hasMore]);

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

  return { messages, sendMessage, loadMore, hasMore };
}
