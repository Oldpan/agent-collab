import { useCallback, useEffect } from "react";
import { create } from "zustand";
import type { ConversationInfo, CreateConversationRequest } from "@agent-collab/protocol";
import * as api from "@/lib/api";

const SELECTED_CONVERSATION_STORAGE_KEY = "agent-collab:selected-conversation-id";

function readStoredSelectedConversationId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(SELECTED_CONVERSATION_STORAGE_KEY);
}

function writeStoredSelectedConversationId(id: string | null): void {
  if (typeof window === "undefined") return;
  if (id) {
    window.localStorage.setItem(SELECTED_CONVERSATION_STORAGE_KEY, id);
  } else {
    window.localStorage.removeItem(SELECTED_CONVERSATION_STORAGE_KEY);
  }
}

type ConversationsState = {
  conversations: ConversationInfo[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  setConversations: (conversations: ConversationInfo[]) => void;
  addConversation: (conversation: ConversationInfo) => void;
  upsertConversation: (conversation: ConversationInfo) => void;
  removeConversation: (id: string) => void;
  selectConversation: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
};

const useConversationsStore = create<ConversationsState>((set) => ({
  conversations: [],
  selectedId: readStoredSelectedConversationId(),
  loading: false,
  error: null,
  setConversations: (conversations) =>
    set((state) => {
      const sorted = conversations.sort((a, b) => b.updatedAt - a.updatedAt);
      const selectedId = sorted.some((conversation) => conversation.id === state.selectedId)
        ? state.selectedId
        : (sorted[0]?.id ?? null);
      writeStoredSelectedConversationId(selectedId);
      return { conversations: sorted, selectedId };
    }),
  addConversation: (conversation) =>
    set((state) => {
      writeStoredSelectedConversationId(conversation.id);
      return {
        conversations: [conversation, ...state.conversations],
        selectedId: conversation.id,
      };
    }),
  upsertConversation: (conversation) =>
    set((state) => {
      const existing = state.conversations.some((item) => item.id === conversation.id);
      const conversations = existing
        ? state.conversations.map((item) => (item.id === conversation.id ? conversation : item))
        : [conversation, ...state.conversations];
      conversations.sort((a, b) => {
        if (a.isPrimaryThread !== b.isPrimaryThread) return a.isPrimaryThread ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
      writeStoredSelectedConversationId(conversation.id);
      return {
        conversations,
        selectedId: conversation.id,
      };
    }),
  removeConversation: (id) =>
    set((state) => {
      const conversations = state.conversations.filter((conversation) => conversation.id !== id);
      const selectedId = state.selectedId === id
        ? (conversations[0]?.id ?? null)
        : state.selectedId;
      writeStoredSelectedConversationId(selectedId);
      return { conversations, selectedId };
    }),
  selectConversation: (id) => {
    writeStoredSelectedConversationId(id);
    set({ selectedId: id });
  },
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

  const openAgentThread = useCallback(
    async (agentId: string) => {
      try {
        const conversation = await api.openAgentThread(agentId);
        store.upsertConversation(conversation);
        return conversation;
      } catch (err) {
        store.setError(err instanceof Error ? err.message : "Failed to open agent thread");
        throw err;
      }
    },
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
    openAgentThread,
    deleteConversation,
    selectConversation,
  };
}
