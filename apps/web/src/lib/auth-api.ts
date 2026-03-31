// Authentication API client

const API_BASE = '/api';

// Get stored token
function getToken(): string | null {
  return localStorage.getItem('auth_token');
}

// Store token
function setToken(token: string): void {
  localStorage.setItem('auth_token', token);
}

// Clear token
function clearToken(): void {
  localStorage.removeItem('auth_token');
  // Also clear selected conversation to prevent cross-user access
  localStorage.removeItem('agent-collab:selected-conversation-id');
}

// Request helper with auth header
async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const token = getToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) ?? {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = data.error ?? `HTTP ${response.status}`;
    throw new Error(error);
  }

  return data as T;
}

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface CheckSetupResponse {
  hasAdmin: boolean;
}

export interface InviteResponse {
  token: string;
  expiresAt: number;
  inviteUrl: string;
}

// Check if setup is complete
export async function checkSetup(): Promise<CheckSetupResponse> {
  return apiRequest<CheckSetupResponse>('/auth/check-setup', {
    method: 'GET',
  });
}

// Initial setup with invite token
export async function setup(
  token: string,
  username: string,
  password: string,
): Promise<AuthResponse> {
  const data = await apiRequest<AuthResponse>('/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ token, username, password }),
  });
  setToken(data.token);
  return data;
}

// Login
export async function login(username: string, password: string): Promise<AuthResponse> {
  const data = await apiRequest<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  setToken(data.token);
  return data;
}

// Logout
export async function logout(): Promise<void> {
  try {
    await apiRequest('/auth/logout', {
      method: 'POST',
    });
  } finally {
    clearToken();
  }
}

// Get current user
export async function getMe(): Promise<{ user: User }> {
  return apiRequest<{ user: User }>('/auth/me', {
    method: 'GET',
  });
}

// Check invite token validity — server always returns 200, result in body
export async function checkInviteToken(token: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const data = await apiRequest<{ valid: boolean; error?: string }>(`/auth/invite/${encodeURIComponent(token)}`, {
      method: 'GET',
    });
    return data;
  } catch {
    // Network error or proxy interference — treat as invalid
    return { valid: false, error: 'Unable to validate invite token' };
  }
}

// Admin: Create invite token
export async function createInvite(): Promise<InviteResponse> {
  return apiRequest<InviteResponse>('/admin/invite', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// Get stored token
export { getToken, setToken, clearToken };
