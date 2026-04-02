import { useCallback, useEffect } from "react";
import { create } from "zustand";
import type { ChannelInfo } from "@agent-collab/protocol";
import * as api from "@/lib/api";

type ChannelStoreInfo = ChannelInfo & {
  members?: Array<{
    agentId: string;
    name: string;
  }>;
};

type ChannelsState = {
  channels: ChannelStoreInfo[];
  loading: boolean;
  setChannels: (channels: ChannelStoreInfo[]) => void;
  setLoading: (loading: boolean) => void;
  addChannel: (channel: ChannelStoreInfo) => void;
  replaceChannel: (channel: ChannelStoreInfo) => void;
};

const useChannelsStore = create<ChannelsState>((set) => ({
  channels: [],
  loading: false,
  setChannels: (channels) => set({ channels }),
  setLoading: (loading) => set({ loading }),
  addChannel: (channel) => set((state) => ({ channels: [...state.channels, channel] })),
  replaceChannel: (channel) => set((state) => ({
    channels: state.channels.map((item) => (item.channelId === channel.channelId ? channel : item)),
  })),
}));

export function useChannels() {
  const { channels, loading, setChannels, setLoading, addChannel, replaceChannel } = useChannelsStore();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.listChannels().then((data) => {
      if (!cancelled) { setChannels(data); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const createChannel = useCallback(async (
    req: { name: string; workspacePath?: string; description?: string; agentIds?: string[] },
  ) => {
    const channel = await api.createChannel(req) as ChannelStoreInfo;
    addChannel(channel);
    return channel;
  }, [addChannel]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateChannel = useCallback((channel: ChannelStoreInfo) => {
    replaceChannel(channel);
  }, [replaceChannel]);

  return { channels, loading, createChannel, updateChannel };
}
