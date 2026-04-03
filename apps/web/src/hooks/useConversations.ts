import { useCallback, useEffect } from "react";
import { create } from "zustand";
import type { ConversationInfo, CreateConversationRequest } from "@agent-collab/protocol";
import * as api from "@/lib/api";

const SELECTED_CONVERSATION_STORAGE_KEY = "agent-collab:selected-conversation-id";
const LAST_USER_STORAGE_KEY = "agent-collab:last-user-id";

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

function readStoredLastUserId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(LAST_USER_STORAGE_KEY);
}

function writeStoredLastUserId(id: string | null): void {
  if (typeof window === "undefined") return;
  if (id) {
    window.localStorage.setItem(LAST_USER_STORAGE_KEY, id);
  } else {
    window.localStorage.removeItem(LAST_USER_STORAGE_KEY);
  }
}

type ConversationsState = {
  conversations: ConversationInfo[];
  selectedId: string | null;
  lastUserId: string | null;
  loading: boolean;
  error: string | null;
  setConversations: (conversations: ConversationInfo[]) => void;
  addConversation: (conversation: ConversationInfo) => void;
  upsertConversation: (conversation: ConversationInfo) => void;
  removeConversation: (id: string) => void;
  selectConversation: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  checkAndResetUser: (userId: string | null) => void;
};

const useConversationsStore = create<ConversationsState>((set) => ({
  conversations: [],
  selectedId: readStoredSelectedConversationId(),
  lastUserId: readStoredLastUserId(),
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
  checkAndResetUser: (userId) =>
    set((state) => {
      if (state.lastUserId !== userId) {
        // User changed - clear selection
        writeStoredLastUserId(userId);
        writeStoredSelectedConversationId(null);
        return { lastUserId: userId, selectedId: null, conversations: [] };
      }
      return {};
    }),
}));

export function useConversations(userId?: string | null) {
  const conversations = useConversationsStore((state) => state.conversations);
  const selectedId = useConversationsStore((state) => state.selectedId);
  const loading = useConversationsStore((state) => state.loading);
  const error = useConversationsStore((state) => state.error);
  const setConversations = useConversationsStore((state) => state.setConversations);
  const addConversation = useConversationsStore((state) => state.addConversation);
  const upsertConversation = useConversationsStore((state) => state.upsertConversation);
  const removeConversation = useConversationsStore((state) => state.removeConversation);
  const selectConversationInStore = useConversationsStore((state) => state.selectConversation);
  const setLoading = useConversationsStore((state) => state.setLoading);
  const setError = useConversationsStore((state) => state.setError);
  const checkAndResetUser = useConversationsStore((state) => state.checkAndResetUser);

  const refreshConversations = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.listConversations();
      setConversations(next);
      setError(null);
      return next;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list conversations";
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [setConversations, setError, setLoading]);

  // Check for user change and clear selection if needed
  useEffect(() => {
    checkAndResetUser(userId ?? null);
  }, [checkAndResetUser, userId]);

  // Fetch conversations once auth state resolves for the current user.
  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    api
      .listConversations()
      .then((conversations) => {
        if (!cancelled) {
          setConversations(conversations);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [setConversations, setError, setLoading, userId]);

  const createConversation = useCallback(
    async (req: CreateConversationRequest) => {
      try {
        const conversation = await api.createConversation(req);
        addConversation(conversation);
        return conversation;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create conversation");
        throw err;
      }
    },
    [addConversation, setError],
  );

  const openAgentThread = useCallback(
    async (agentId: string) => {
      try {
        const conversation = await api.openAgentThread(agentId);
        upsertConversation(conversation);
        return conversation;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to open agent thread");
        throw err;
      }
    },
    [setError, upsertConversation],
  );

  const openAgentChannelSession = useCallback(
    async (agentId: string, channelId: string, threadRootId?: string | null) => {
      try {
        const conversation = await api.openAgentChannelSession(agentId, channelId, threadRootId);
        upsertConversation(conversation);
        return conversation;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to open agent channel session");
        throw err;
      }
    },
    [setError, upsertConversation],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        await api.deleteConversation(id);
        removeConversation(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete conversation");
        throw err;
      }
    },
    [removeConversation, setError],
  );

  const selectConversation = useCallback(
    (id: string | null) => {
      selectConversationInStore(id);
    },
    [selectConversationInStore],
  );

  return {
    conversations,
    selectedId,
    loading,
    error,
    createConversation,
    openAgentThread,
    openAgentChannelSession,
    deleteConversation,
    selectConversation,
    upsertConversation,
    refreshConversations,
  };
}
