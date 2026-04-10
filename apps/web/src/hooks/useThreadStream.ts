import { useState, useCallback, useRef, useLayoutEffect, useEffect } from "react";
import type { ChannelMessage, ThreadCollaborationSummary } from "@/lib/api";
import * as api from "@/lib/api";
import { readStoredUserIdentity } from "@/lib/userIdentity";
import { useAuthStore } from "./useAuth";

function readUserName(): string {
  const currentUser = useAuthStore.getState().user;
  if (currentUser?.username?.trim()) return currentUser.username.trim();
  const storedName = readStoredUserIdentity().name.trim();
  return storedName && storedName !== "You" ? storedName : "User";
}

/**
 * Manages messages for a single thread (identified by channelId + threadRootId).
 * Subscribes to the parent channel's WS stream and filters for thread messages.
 */
export function useThreadStream(
  channelId: string | null,
  threadRootId: string | null,
  aroundMessageId?: string | null,
  aroundRequestId?: number | null,
  taskVersion = 0,
): {
  messages: ChannelMessage[];
  summary: ThreadCollaborationSummary | null;
  sendMessage: (content: string) => Promise<void>;
  loadMore: () => Promise<void>;
  hasMore: boolean;
} {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [summary, setSummary] = useState<ThreadCollaborationSummary | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);

  useLayoutEffect(() => {
    setMessages([]);
    setSummary(null);
    setHasMore(true);
    if (!channelId || !threadRootId) return;
    let cancelled = false;

    const loadSummary = () => {
      void api
        .getThreadSummary(channelId, threadRootId)
        .then((data) => {
          if (!cancelled) setSummary(data);
        })
        .catch(() => {});
    };

    api
      .getThreadMessages(channelId, threadRootId, 100, undefined, aroundMessageId ?? undefined)
      .then((d) => {
        if (!cancelled) {
          setMessages(d.messages);
          setHasMore(aroundMessageId ? Boolean(d.hasOlder) : d.messages.length >= 100);
        }
      })
      .catch(() => {});
    loadSummary();

    // Reuse the channel-level WS stream; filter by threadRootId
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = localStorage.getItem("auth_token") ?? "";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/channels/${encodeURIComponent(channelId)}/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`,
    );
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      if (wsRef.current !== ws) return;
      try {
        const event = JSON.parse(evt.data as string) as { type: string; message?: ChannelMessage; channelId?: string };
        if (event.type === "channel.message" && event.message?.threadRootId === threadRootId) {
          const msg = event.message;
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          loadSummary();
        } else if (event.type === "channel.tasks.changed" && event.channelId === channelId) {
          loadSummary();
        }
      } catch {
        // ignore
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => { if (wsRef.current === ws) wsRef.current = null; };

    return () => {
      cancelled = true;
      ws.close();
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [aroundMessageId, aroundRequestId, channelId, threadRootId]);

  useEffect(() => {
    if (!channelId || !threadRootId) return;
    void api.getThreadSummary(channelId, threadRootId).then(setSummary).catch(() => {});
  }, [channelId, threadRootId, taskVersion]);

  const loadMore = useCallback(async () => {
    if (!channelId || !threadRootId || !hasMore) return;
    const oldest = messages[0];
    const before = oldest?.seq;
    const data = await api.getThreadMessages(channelId, threadRootId, 50, before);
    if (data.messages.length < 50) setHasMore(false);
    if (data.messages.length > 0) {
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const newMsgs = data.messages.filter((m) => !existingIds.has(m.id));
        return [...newMsgs, ...prev];
      });
    }
  }, [channelId, threadRootId, messages, hasMore]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!channelId || !threadRootId) return;
      const senderName = readUserName();
      const result = await api.sendChannelMessage(channelId, content, senderName, threadRootId);
      void api.getThreadSummary(channelId, threadRootId).then(setSummary).catch(() => {});
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
            threadRootId,
          },
        ];
      });
    },
    [channelId, threadRootId],
  );

  return { messages, summary, sendMessage, loadMore, hasMore };
}
