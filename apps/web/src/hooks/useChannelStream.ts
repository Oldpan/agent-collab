import { useState, useCallback, useRef, useLayoutEffect, useEffect } from "react";
import type { ChannelMessage } from "@/lib/api";
import * as api from "@/lib/api";

function canMarkSeen(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function readUserName(): string {
  try {
    const stored = JSON.parse(localStorage.getItem("agent-collab:user-identity") ?? "{}") as { name?: string };
    return stored.name ?? "User";
  } catch {
    return "User";
  }
}

type UseChannelStreamOptions = {
  channelId: string | null;
  onSeenSeq?: (seq: number) => void;
};

export type ChannelNotice = { message: string; createdAt: string };

export function useChannelStream(options: UseChannelStreamOptions): {
  messages: ChannelMessage[];
  notices: ChannelNotice[];
  sendMessage: (content: string, attachmentIds?: string[]) => Promise<void>;
  loadMore: () => Promise<void>;
  hasMore: boolean;
  resetVersion: number;
  taskVersion: number;
} {
  const { channelId, onSeenSeq } = options;
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [notices, setNotices] = useState<ChannelNotice[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [resetVersion, setResetVersion] = useState(0);
  const [taskVersion, setTaskVersion] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const onSeenSeqRef = useRef<typeof onSeenSeq>(onSeenSeq);

  useEffect(() => {
    onSeenSeqRef.current = onSeenSeq;
  }, [onSeenSeq]);

  useLayoutEffect(() => {
    setMessages([]);
    setNotices([]);
    setHasMore(true);
    setResetVersion(0);
    setTaskVersion(0);
    if (!channelId) {
      wsRef.current = null;
      return;
    }
    let cancelled = false;

    const loadInitialMessages = () => {
      void api
        .getChannelMessages(channelId, 100)
        .then((d) => {
          if (cancelled) return;
          setMessages(d.messages);
          setHasMore(d.messages.length >= 100);
          const latestSeq = d.messages.reduce((max, message) => Math.max(max, Number(message.seq ?? 0)), 0);
          if (latestSeq > 0 && canMarkSeen()) {
            onSeenSeqRef.current?.(latestSeq);
          }
        })
        .catch(() => {});
    };

    loadInitialMessages();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = localStorage.getItem("auth_token") ?? "";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/channels/${encodeURIComponent(channelId)}/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`,
    );
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      if (wsRef.current !== ws) return;
      try {
        const event = JSON.parse(evt.data as string) as {
          type: string;
          message?: ChannelMessage;
          notice?: { message: string; createdAt: string };
          channelId?: string;
        };
        if (event.type === "channel.message" && event.message) {
          const msg = event.message;
          if (typeof msg.seq === "number" && canMarkSeen()) {
            onSeenSeqRef.current?.(msg.seq);
          }
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
          setNotices((prev) => [...prev, { message: notice.message, createdAt: notice.createdAt }]);
        } else if (event.type === "channel.history.reset") {
          setMessages([]);
          setHasMore(true);
          setResetVersion((prev) => prev + 1);
          loadInitialMessages();
        } else if (event.type === "channel.tasks.changed" && event.channelId === channelId) {
          setTaskVersion((prev) => prev + 1);
          loadInitialMessages();
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
    async (content: string, attachmentIds?: string[]) => {
      if (!channelId) return;
      const senderName = readUserName();
      const result = await api.sendChannelMessage(channelId, content, senderName, undefined, attachmentIds);
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
            ...(attachmentIds?.length ? { attachmentIds } : {}),
          },
        ];
      });
    },
    [channelId],
  );

  return { messages, notices, sendMessage, loadMore, hasMore, resetVersion, taskVersion };
}
