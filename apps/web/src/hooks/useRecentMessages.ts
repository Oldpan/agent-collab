import { useCallback, useEffect, useState } from "react";
import {
  buildRecentMessageSourceKey,
  type RecentMessageSourceItem,
} from "@agent-collab/protocol";
import * as api from "@/lib/api";
import {
  AGENT_DM_READ_STORAGE_KEY,
  CHANNEL_READ_STORAGE_KEY,
  RECENT_SOURCE_READ_STORAGE_KEY,
  readStoredSeqMap,
  writeStoredSeqMap,
} from "@/lib/readState";

const POLL_INTERVAL_MS = 3000;

function readCombinedRecentSeqs(): Record<string, number> {
  const agentReadSeqs = readStoredSeqMap(AGENT_DM_READ_STORAGE_KEY);
  const channelReadSeqs = readStoredSeqMap(CHANNEL_READ_STORAGE_KEY);
  const recentReadSeqs = readStoredSeqMap(RECENT_SOURCE_READ_STORAGE_KEY);
  return {
    ...Object.fromEntries(
      Object.entries(agentReadSeqs).map(([agentId, seq]) => [
        buildRecentMessageSourceKey({ sourceType: "dm", agentId }),
        seq,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(channelReadSeqs).map(([channelId, seq]) => [
        buildRecentMessageSourceKey({ sourceType: "channel", channelId }),
        seq,
      ]),
    ),
    ...recentReadSeqs,
  };
}

export function useRecentMessages(params: {
  markAgentReadUpTo: (agentId: string, seq?: number) => void;
  markChannelReadUpTo: (channelId: string, seq?: number) => void;
}) {
  const { markAgentReadUpTo, markChannelReadUpTo } = params;
  const [items, setItems] = useState<RecentMessageSourceItem[]>([]);
  const [totalUnreadCount, setTotalUnreadCount] = useState(0);
  const [totalSourceCount, setTotalSourceCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const summary = await api.getRecentMessagesSummary({
        readSeqs: readCombinedRecentSeqs(),
        limit: 100,
      });
      setItems(summary.items);
      setTotalUnreadCount(summary.totalUnreadCount);
      setTotalSourceCount(summary.totalSourceCount);
    } catch {
      // keep last known inbox
    }
  }, []);

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [refresh]);

  const markSourceReadUpTo = useCallback((item: RecentMessageSourceItem, latestSeq?: number) => {
    const resolvedSeq = Math.max(0, Number(latestSeq ?? item.latestSeq ?? 0));
    if (item.sourceType === "dm" && item.agentId) {
      markAgentReadUpTo(item.agentId, resolvedSeq);
    } else if (item.sourceType === "channel") {
      markChannelReadUpTo(item.channelId, resolvedSeq);
    } else {
      const current = readStoredSeqMap(RECENT_SOURCE_READ_STORAGE_KEY);
      const existingSeq = Math.max(0, Number(current[item.sourceKey] ?? 0));
      if (resolvedSeq > existingSeq) {
        writeStoredSeqMap(RECENT_SOURCE_READ_STORAGE_KEY, {
          ...current,
          [item.sourceKey]: resolvedSeq,
        });
      }
    }

    setItems((prev) => prev.filter((entry) => entry.sourceKey !== item.sourceKey));
    setTotalUnreadCount((prev) => Math.max(0, prev - Math.max(0, item.unreadCount ?? 0)));
    setTotalSourceCount((prev) => Math.max(0, prev - 1));
  }, [markAgentReadUpTo, markChannelReadUpTo]);

  return {
    items,
    totalUnreadCount,
    totalSourceCount,
    refresh,
    markSourceReadUpTo,
  };
}
