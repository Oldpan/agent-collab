import { create } from 'zustand';
import type { User } from '../lib/auth-api';
import {
  checkSetup,
  setup,
  login as apiLogin,
  logout as apiLogout,
  getMe,
  getToken,
  clearToken,
} from '../lib/auth-api';

interface AuthState {
  // State
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  hasAdmin: boolean | null;
  error: string | null;

  // Actions
  checkAuth: () => Promise<void>;
  checkSetupStatus: () => Promise<void>;
  doSetup: (token: string, username: string, password: string) => Promise<boolean>;
  doLogin: (username: string, password: string) => Promise<boolean>;
  doLogout: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  hasAdmin: null,
  error: null,

  checkAuth: async () => {
    const token = getToken();

    if (!token) {
      set({ isAuthenticated: false, isLoading: false, user: null });
      return;
    }

    try {
      const { user } = await getMe();
      set({
        user,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch {
      // Token is invalid or expired
      clearToken();
      set({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
      });
    }
  },

  checkSetupStatus: async () => {
    try {
      const { hasAdmin } = await checkSetup();
      set({ hasAdmin, isLoading: false });
    } catch {
      set({ hasAdmin: false, isLoading: false });
    }
  },

  doSetup: async (token: string, username: string, password: string) => {
    set({ isLoading: true, error: null });

    try {
      const { user } = await setup(token, username, password);
      set({
        user,
        isAuthenticated: true,
        hasAdmin: true,
        isLoading: false,
        error: null,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Setup failed';
      set({ isLoading: false, error: message });
      return false;
    }
  },

  doLogin: async (username: string, password: string) => {
    set({ isLoading: true, error: null });

    try {
      const { user } = await apiLogin(username, password);
      set({
        user,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      set({ isLoading: false, error: message });
      return false;
    }
  },

  doLogout: async () => {
    set({ isLoading: true });

    try {
      await apiLogout();
    } finally {
      clearToken();
      set({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
      });
    }
  },

  clearError: () => set({ error: null }),
}));

// Hook for components
export function useAuth() {
  return useAuthStore();
}
