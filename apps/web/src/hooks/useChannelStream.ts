import { useState, useCallback, useRef, useLayoutEffect, useEffect } from "react";
import { buildThreadShortId } from "@agent-collab/protocol";
import type { ChannelMessage } from "@/lib/api";
import * as api from "@/lib/api";
import { readStoredUserIdentity } from "@/lib/userIdentity";
import { useAuthStore } from "./useAuth";

function canMarkSeen(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function readUserName(): string {
  const currentUser = useAuthStore.getState().user;
  if (currentUser?.username?.trim()) return currentUser.username.trim();
  const storedName = readStoredUserIdentity().name.trim();
  return storedName && storedName !== "You" ? storedName : "User";
}

type UseChannelStreamOptions = {
  channelId: string | null;
  onSeenSeq?: (seq: number) => void;
  aroundMessageId?: string | null;
  aroundRequestId?: number | null;
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
  resetHistory: () => Promise<void>;
} {
  const { channelId, onSeenSeq, aroundMessageId, aroundRequestId } = options;
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

  const loadInitialMessages = useCallback(async (activeChannelId: string | null) => {
    if (!activeChannelId) return;
    const data = await api.getChannelMessages(activeChannelId, 100, undefined, aroundMessageId ?? undefined);
    setMessages(data.messages);
    setHasMore(aroundMessageId ? Boolean(data.hasOlder) : data.messages.length >= 100);
    const latestSeq = data.messages.reduce((max, message) => Math.max(max, Number(message.seq ?? 0)), 0);
    if (latestSeq > 0 && canMarkSeen()) {
      onSeenSeqRef.current?.(latestSeq);
    }
  }, [aroundMessageId]);

  const resetHistory = useCallback(async () => {
    setMessages([]);
    setNotices([]);
    setHasMore(true);
    setResetVersion((prev) => prev + 1);
    try {
      await loadInitialMessages(channelId);
    } catch {
      // ignore reload failures; the websocket stream can still repopulate state
    }
  }, [channelId, loadInitialMessages]);

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
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    void loadInitialMessages(channelId).catch(() => {});

    const connect = () => {
      if (cancelled) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const token = localStorage.getItem("auth_token") ?? "";
      const ws = new WebSocket(
        `${protocol}//${window.location.host}/api/channels/${encodeURIComponent(channelId)}/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        if (reconnectAttempt > 0) {
          // Reconnect after a drop — catch up on messages we missed
          void loadInitialMessages(channelId).catch(() => {});
        }
        reconnectAttempt = 0;
      };

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
                  buildThreadShortId(m.id) === msg.threadRootId
                    ? { ...m, replyCount: (m.replyCount ?? 0) + 1 }
                    : m,
                ),
              );
            }
          } else if (event.type === "channel.notice" && event.notice) {
            const notice = event.notice;
            setNotices((prev) => [...prev, { message: notice.message, createdAt: notice.createdAt }]);
          } else if (event.type === "channel.history.reset") {
            void resetHistory();
          } else if (event.type === "channel.tasks.changed" && event.channelId === channelId) {
            setTaskVersion((prev) => prev + 1);
            void loadInitialMessages(channelId).catch(() => {});
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onerror = () => {};

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (cancelled) return;
        // Reconnect with exponential backoff (capped at 5s)
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
        reconnectTimer = null;
      }
      const ws = wsRef.current;
      if (ws) {
        ws.close();
        wsRef.current = null;
      }
    };
  }, [aroundRequestId, channelId, loadInitialMessages, resetHistory]);

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

  return { messages, notices, sendMessage, loadMore, hasMore, resetVersion, taskVersion, resetHistory };
}
