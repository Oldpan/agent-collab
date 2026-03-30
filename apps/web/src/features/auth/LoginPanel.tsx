import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';

interface LoginPanelProps {
  onSuccess?: () => void;
}

export function LoginPanel({ onSuccess }: LoginPanelProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { doLogin, isLoading, error, clearError } = useAuth();

  // Clear error when inputs change
  useEffect(() => {
    if (error) clearError();
  }, [username, password, error, clearError]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return;

    const success = await doLogin(username.trim(), password);
    if (success) {
      onSuccess?.();
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50">
      <div className="w-full max-w-md">
        <div className="rounded-sm border-2 border-zinc-900 bg-white p-8 shadow-[8px_8px_0_0_rgba(0,0,0,0.3)]">
          <div className="mb-8 text-center">
            <h1 className="mb-2 text-2xl font-bold text-zinc-900">Agent Collab</h1>
            <p className="text-sm text-zinc-500">Sign in to your account</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="username"
                className="mb-1.5 block text-sm font-medium text-zinc-700"
              >
                Username
              </label>
              <Input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your username"
                className="rounded-sm border-2 border-zinc-900 bg-white px-3 py-2 text-sm focus-visible:ring-[#ffd54a]"
                disabled={isLoading}
                autoComplete="username"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-sm font-medium text-zinc-700"
              >
                Password
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                className="rounded-sm border-2 border-zinc-900 bg-white px-3 py-2 text-sm focus-visible:ring-[#ffd54a]"
                disabled={isLoading}
                autoComplete="current-password"
              />
            </div>

            {error && (
              <div className="rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </div>
            )}

            <Button
              type="submit"
              disabled={isLoading || !username.trim() || !password.trim()}
              className="w-full rounded-sm border-2 border-zinc-900 bg-[#ffd54a] py-2 text-sm font-semibold text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] transition-all hover:translate-y-[1px] hover:bg-[#f7ca2e] hover:shadow-[1px_1px_0_0_rgba(0,0,0,0.12)] active:translate-y-[2px] active:shadow-none disabled:opacity-50"
            >
              {isLoading ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>

          <div className="mt-6 text-center text-xs text-zinc-400">
            Agent Collab - Multi-Agent Collaboration Platform
          </div>
        </div>
      </div>
    </div>
  );
}
