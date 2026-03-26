import { useCallback, useEffect } from "react";
import { create } from "zustand";
import type { ChannelInfo } from "@agent-collab/protocol";
import * as api from "@/lib/api";

type ChannelsState = {
  channels: ChannelInfo[];
  loading: boolean;
  setChannels: (channels: ChannelInfo[]) => void;
  setLoading: (loading: boolean) => void;
  addChannel: (channel: ChannelInfo) => void;
};

const useChannelsStore = create<ChannelsState>((set) => ({
  channels: [],
  loading: false,
  setChannels: (channels) => set({ channels }),
  setLoading: (loading) => set({ loading }),
  addChannel: (channel) => set((state) => ({ channels: [...state.channels, channel] })),
}));

export function useChannels() {
  const { channels, loading, setChannels, setLoading, addChannel } = useChannelsStore();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.listChannels().then((data) => {
      if (!cancelled) { setChannels(data); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const createChannel = useCallback(async (name: string, workspacePath?: string) => {
    const channel = await api.createChannel({ name, workspacePath });
    addChannel(channel);
    return channel;
  }, [addChannel]); // eslint-disable-line react-hooks/exhaustive-deps

  return { channels, loading, createChannel };
}
