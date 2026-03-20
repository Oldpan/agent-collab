import { useCallback, useEffect } from "react";
import { create } from "zustand";
import type { ConversationInfo, CreateConversationRequest } from "@agent-collab/wire-types";
import * as api from "@/lib/api";

type ConversationsState = {
  conversations: ConversationInfo[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  setConversations: (conversations: ConversationInfo[]) => void;
  addConversation: (conversation: ConversationInfo) => void;
  removeConversation: (id: string) => void;
  selectConversation: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
};

const useConversationsStore = create<ConversationsState>((set) => ({
  conversations: [],
  selectedId: null,
  loading: false,
  error: null,
  setConversations: (conversations) =>
    set({ conversations: conversations.sort((a, b) => b.updatedAt - a.updatedAt) }),
  addConversation: (conversation) =>
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      selectedId: conversation.id,
    })),
  removeConversation: (id) =>
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      selectedId: state.selectedId === id ? null : state.selectedId,
    })),
  selectConversation: (id) => set({ selectedId: id }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));

export function useConversations() {
  const store = useConversationsStore();

  // Fetch conversations on mount
  useEffect(() => {
    let cancelled = false;
    store.setLoading(true);
    api
      .listConversations()
      .then((conversations) => {
        if (!cancelled) {
          store.setConversations(conversations);
          store.setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          store.setError(err.message);
          store.setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createConversation = useCallback(
    async (req: CreateConversationRequest) => {
      try {
        const conversation = await api.createConversation(req);
        store.addConversation(conversation);
        return conversation;
      } catch (err) {
        store.setError(err instanceof Error ? err.message : "Failed to create conversation");
        throw err;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        await api.deleteConversation(id);
        store.removeConversation(id);
      } catch (err) {
        store.setError(err instanceof Error ? err.message : "Failed to delete conversation");
        throw err;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const selectConversation = useCallback(
    (id: string | null) => {
      store.selectConversation(id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    conversations: store.conversations,
    selectedId: store.selectedId,
    loading: store.loading,
    error: store.error,
    createConversation,
    deleteConversation,
    selectConversation,
  };
}
