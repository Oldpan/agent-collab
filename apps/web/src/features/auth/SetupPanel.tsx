import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';

interface SetupPanelProps {
  initialToken?: string;
  onSuccess?: () => void;
}

export function SetupPanel({ initialToken = '', onSuccess }: SetupPanelProps) {
  const [token, setToken] = useState(initialToken);
  const [username, setUsername] = useState('yanzong');
  const [password, setPassword] = useState('7fL9xQ2mVp~-=');
  const [confirmPassword, setConfirmPassword] = useState('7fL9xQ2mVp~-=');
  const [showPassword, setShowPassword] = useState(false);
  const { doSetup, isLoading, error, clearError } = useAuth();

  // Clear error when inputs change
  useEffect(() => {
    if (error) clearError();
  }, [token, username, password, confirmPassword, error, clearError]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!token.trim()) return;
    if (!username.trim()) return;
    if (!password.trim()) return;

    if (password !== confirmPassword) {
      return;
    }

    const success = await doSetup(token.trim(), username.trim(), password);
    if (success) {
      onSuccess?.();
    }
  };

  const passwordsMatch = password === confirmPassword;
  const canSubmit = token.trim() && username.trim() && password.trim() && passwordsMatch;

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50">
      <div className="w-full max-w-md">
        <div className="rounded-sm border-2 border-zinc-900 bg-white p-8 shadow-[8px_8px_0_0_rgba(0,0,0,0.3)]">
          <div className="mb-8 text-center">
            <h1 className="mb-2 text-2xl font-bold text-zinc-900">Agent Collab</h1>
            <p className="text-sm text-zinc-500">Initial Setup</p>
          </div>

          <div className="mb-6 rounded-sm border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm text-amber-800">
              Welcome! This appears to be the first time you're setting up Agent Collab.
              Please complete the initial setup to create the administrator account.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="token"
                className="mb-1.5 block text-sm font-medium text-zinc-700"
              >
                Invite Token
              </label>
              <Input
                id="token"
                type="text"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Enter your invite token"
                className="rounded-sm border-2 border-zinc-900 bg-white px-3 py-2 text-sm focus-visible:ring-[#ffd54a]"
                disabled={isLoading}
              />
              <p className="mt-1 text-xs text-zinc-400">
                Token can be passed via URL: ?invite=YOUR_TOKEN
              </p>
            </div>

            <div className="border-t border-zinc-200 pt-4">
              <h3 className="mb-3 text-sm font-semibold text-zinc-700">Admin Account</h3>

              <div className="space-y-4">
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
                    placeholder="Choose a username"
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
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Set a password"
                    className="rounded-sm border-2 border-zinc-900 bg-white px-3 py-2 text-sm focus-visible:ring-[#ffd54a]"
                    disabled={isLoading}
                    autoComplete="new-password"
                  />
                </div>

                <div>
                  <label
                    htmlFor="confirmPassword"
                    className="mb-1.5 block text-sm font-medium text-zinc-700"
                  >
                    Confirm Password
                  </label>
                  <Input
                    id="confirmPassword"
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm your password"
                    className="rounded-sm border-2 border-zinc-900 bg-white px-3 py-2 text-sm focus-visible:ring-[#ffd54a]"
                    disabled={isLoading}
                    autoComplete="new-password"
                  />
                  {!passwordsMatch && confirmPassword && (
                    <p className="mt-1 text-xs text-red-500">Passwords do not match</p>
                  )}
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={showPassword}
                    onChange={(e) => setShowPassword(e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-300"
                  />
                  <span className="text-zinc-600">Show password</span>
                </label>
              </div>
            </div>

            {error && (
              <div className="rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </div>
            )}

            <Button
              type="submit"
              disabled={isLoading || !canSubmit}
              className="w-full rounded-sm border-2 border-zinc-900 bg-[#ffd54a] py-2 text-sm font-semibold text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] transition-all hover:translate-y-[1px] hover:bg-[#f7ca2e] hover:shadow-[1px_1px_0_0_rgba(0,0,0,0.12)] active:translate-y-[2px] active:shadow-none disabled:opacity-50"
            >
              {isLoading ? 'Setting up...' : 'Complete Setup'}
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
