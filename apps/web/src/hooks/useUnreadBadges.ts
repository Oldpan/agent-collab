import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentInfo, ChannelInfo } from "@agent-collab/protocol";
import * as api from "@/lib/api";

const AGENT_READ_STORAGE_KEY = "agent-collab:agent-dm-read-seqs";
const CHANNEL_READ_STORAGE_KEY = "agent-collab:channel-read-seqs";
const POLL_INTERVAL_MS = 3000;

type SeqMap = Record<string, number>;
type UnreadEntry = { unreadCount: number; latestSeq: number };

function readStoredSeqMap(key: string): SeqMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([entryKey, value]) =>
        typeof value === "number" && Number.isFinite(value)
          ? [[entryKey, value]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

function writeStoredSeqMap(key: string, value: SeqMap): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function filterSeqMap(ids: string[], source: SeqMap): SeqMap {
  return Object.fromEntries(ids.map((id) => [id, Math.max(0, Number(source[id] ?? 0))]));
}

function updateEntry(
  current: Record<string, UnreadEntry>,
  id: string,
  recipe: (existing: UnreadEntry | undefined) => UnreadEntry,
): Record<string, UnreadEntry> {
  const nextEntry = recipe(current[id]);
  const existing = current[id];
  if (
    existing &&
    existing.unreadCount === nextEntry.unreadCount &&
    existing.latestSeq === nextEntry.latestSeq
  ) {
    return current;
  }
  return {
    ...current,
    [id]: nextEntry,
  };
}

export function useUnreadBadges(params: {
  agents: AgentInfo[];
  channels: ChannelInfo[];
  activeAgentId: string | null;
  activeChannelId: string | null;
}) {
  const { agents, channels, activeAgentId, activeChannelId } = params;
  const agentIds = useMemo(() => agents.map((agent) => agent.agentId), [agents]);
  const channelIds = useMemo(() => channels.map((channel) => channel.channelId), [channels]);

  const [agentReadSeqs, setAgentReadSeqs] = useState<SeqMap>(() => readStoredSeqMap(AGENT_READ_STORAGE_KEY));
  const [channelReadSeqs, setChannelReadSeqs] = useState<SeqMap>(() => readStoredSeqMap(CHANNEL_READ_STORAGE_KEY));
  const [agentEntries, setAgentEntries] = useState<Record<string, UnreadEntry>>({});
  const [channelEntries, setChannelEntries] = useState<Record<string, UnreadEntry>>({});

  const markAgentReadUpTo = useCallback((agentId: string, seq?: number) => {
    if (!agentId) return;
    let resolvedLatestSeq = Math.max(0, Number(seq ?? 0));
    setAgentEntries((prev) =>
      updateEntry(prev, agentId, (existing) => {
        resolvedLatestSeq = Math.max(resolvedLatestSeq, existing?.latestSeq ?? 0);
        return {
          unreadCount: 0,
          latestSeq: resolvedLatestSeq,
        };
      }),
    );
    setAgentReadSeqs((prev) => {
      const current = Math.max(0, Number(prev[agentId] ?? 0));
      if (resolvedLatestSeq <= current) return prev;
      const next = { ...prev, [agentId]: resolvedLatestSeq };
      writeStoredSeqMap(AGENT_READ_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const markChannelReadUpTo = useCallback((channelId: string, seq?: number) => {
    if (!channelId) return;
    let resolvedLatestSeq = Math.max(0, Number(seq ?? 0));
    setChannelEntries((prev) =>
      updateEntry(prev, channelId, (existing) => {
        resolvedLatestSeq = Math.max(resolvedLatestSeq, existing?.latestSeq ?? 0);
        return {
          unreadCount: 0,
          latestSeq: resolvedLatestSeq,
        };
      }),
    );
    setChannelReadSeqs((prev) => {
      const current = Math.max(0, Number(prev[channelId] ?? 0));
      if (resolvedLatestSeq <= current) return prev;
      const next = { ...prev, [channelId]: resolvedLatestSeq };
      writeStoredSeqMap(CHANNEL_READ_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    if (agentIds.length === 0 && channelIds.length === 0) {
      setAgentEntries({});
      setChannelEntries({});
      return;
    }
    try {
      const summary = await api.getUnreadSummary({
        agentIds,
        channelIds,
        agentDmReadSeqs: filterSeqMap(agentIds, agentReadSeqs),
        channelReadSeqs: filterSeqMap(channelIds, channelReadSeqs),
      });
      setAgentEntries(summary.agentDms);
      setChannelEntries(summary.channels);
    } catch {
      // Ignore polling failures; keep last known counts.
    }
  }, [agentIds, agentReadSeqs, channelIds, channelReadSeqs]);

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [refresh]);

  useEffect(() => {
    if (activeAgentId) {
      markAgentReadUpTo(activeAgentId);
    }
  }, [activeAgentId, markAgentReadUpTo]);

  useEffect(() => {
    if (activeChannelId) {
      markChannelReadUpTo(activeChannelId);
    }
  }, [activeChannelId, markChannelReadUpTo]);

  return {
    agentUnreadCounts: Object.fromEntries(agentIds.map((agentId) => [agentId, agentEntries[agentId]?.unreadCount ?? 0])),
    channelUnreadCounts: Object.fromEntries(channelIds.map((channelId) => [channelId, channelEntries[channelId]?.unreadCount ?? 0])),
    markAgentReadUpTo,
    markChannelReadUpTo,
    refresh,
  };
}
