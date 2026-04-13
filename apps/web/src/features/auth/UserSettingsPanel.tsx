import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { XIcon, ShieldIcon, CalendarIcon, UploadIcon, RotateCcwIcon } from 'lucide-react';
import { BEIJING_TIME_ZONE } from '@agent-collab/protocol';
import type { User } from '@/lib/auth-api';
import { ChatAvatar } from '../chat/ChatAvatar';
import { clearStoredUserAvatar, createStoredAvatarDataUrl, useStoredUserIdentity, writeStoredUserIdentity } from '@/lib/userIdentity';

interface UserSettingsPanelProps {
  user: User;
  onClose: () => void;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { timeZone: BEIJING_TIME_ZONE });
}

export function UserSettingsPanel({ user, onClose }: UserSettingsPanelProps) {
  const [tab, setTab] = useState<'profile' | 'password'>('profile');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-sm border-2 border-zinc-900 bg-white shadow-[8px_8px_0_0_rgba(0,0,0,0.3)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b-2 border-zinc-900 bg-[#ffd700] px-5 py-3">
          <h2 className="text-sm font-bold text-zinc-900">User Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-600 hover:text-zinc-900 transition-colors cursor-pointer"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b-2 border-zinc-200 px-5 pt-3 gap-4">
          {(['profile', 'password'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={[
                'pb-2 text-xs font-semibold capitalize transition-colors cursor-pointer border-b-2 -mb-[2px]',
                tab === t
                  ? 'border-zinc-900 text-zinc-900'
                  : 'border-transparent text-zinc-400 hover:text-zinc-700',
              ].join(' ')}
            >
              {t === 'profile' ? 'Profile' : 'Change Password'}
            </button>
          ))}
        </div>

        <div className="p-5">
          {tab === 'profile' && <ProfileTab user={user} />}
          {tab === 'password' && <PasswordTab onSuccess={onClose} />}
        </div>
      </div>
    </div>
  );
}

function ProfileTab({ user }: { user: User }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userIdentity = useStoredUserIdentity();
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const handleAvatarUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingAvatar(true);
    setAvatarError(null);
    try {
      const avatarUrl = await createStoredAvatarDataUrl(file);
      writeStoredUserIdentity({ avatarUrl });
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Failed to update avatar');
    } finally {
      setUploadingAvatar(false);
    }
  }, []);

  const handleAvatarReset = useCallback(() => {
    setAvatarError(null);
    clearStoredUserAvatar();
  }, []);

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => void handleAvatarUpload(e)}
      />
      <div className="flex items-center gap-3 rounded-sm border-2 border-zinc-200 bg-zinc-50 p-4">
        <ChatAvatar role="user" user={userIdentity} size={40} className="shrink-0" />
        <div>
          <div className="text-sm font-bold text-zinc-900">{user.username}</div>
          {user.isAdmin && (
            <div className="flex items-center gap-1 text-xs text-zinc-500">
              <ShieldIcon className="size-3" />
              Administrator
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2 rounded-sm border-2 border-zinc-200 bg-zinc-50 p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Avatar</div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingAvatar}
            className="rounded-sm border-2 border-zinc-900 bg-[#ffd54a] px-3 py-2 text-xs font-semibold text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e] disabled:opacity-50"
          >
            <UploadIcon className="mr-2 size-3.5" />
            {uploadingAvatar ? 'Uploading...' : 'Upload avatar'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleAvatarReset}
            disabled={uploadingAvatar || !userIdentity.avatarUrl}
            className="rounded-sm border-2 border-zinc-900 bg-white px-3 py-2 text-xs font-semibold text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-zinc-50 disabled:opacity-50"
          >
            <RotateCcwIcon className="mr-2 size-3.5" />
            Use default avatar
          </Button>
        </div>
        <div className="text-[11px] text-zinc-500">
          Custom avatars are stored in this browser and appear in DM, channel, and thread messages. If cleared, the default avatar stays unchanged.
        </div>
        {avatarError && (
          <div className="rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-600">
            {avatarError}
          </div>
        )}
      </div>

      <div className="space-y-2 text-xs text-zinc-600">
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 font-medium text-zinc-500">User ID</span>
          <span className="font-mono text-zinc-400 truncate" title={user.id}>{user.id}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 font-medium text-zinc-500">Role</span>
          <span>{user.isAdmin ? 'Admin' : 'User'}</span>
        </div>
        <div className="flex items-center gap-2">
          <CalendarIcon className="size-3 text-zinc-400" />
          <span className="font-medium text-zinc-500">Joined</span>
          <span>{formatDate(user.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

function PasswordTab({ onSuccess }: { onSuccess: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const passwordsMatch = newPassword === confirmPassword;
  const canSubmit = currentPassword && newPassword && confirmPassword && passwordsMatch && newPassword.length >= 6;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setIsLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('auth_token') ?? '';
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSuccess(true);
      setTimeout(onSuccess, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <div className="rounded-sm border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-700">
        Password changed successfully.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-zinc-700">Current Password</label>
        <Input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="rounded-sm border-2 border-zinc-900 bg-white text-sm focus-visible:ring-[#ffd54a]"
          disabled={isLoading}
          autoComplete="current-password"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-zinc-700">New Password</label>
        <Input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="rounded-sm border-2 border-zinc-900 bg-white text-sm focus-visible:ring-[#ffd54a]"
          disabled={isLoading}
          autoComplete="new-password"
        />
        {newPassword && newPassword.length < 6 && (
          <p className="mt-1 text-xs text-red-500">At least 6 characters</p>
        )}
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-zinc-700">Confirm New Password</label>
        <Input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="rounded-sm border-2 border-zinc-900 bg-white text-sm focus-visible:ring-[#ffd54a]"
          disabled={isLoading}
          autoComplete="new-password"
        />
        {confirmPassword && !passwordsMatch && (
          <p className="mt-1 text-xs text-red-500">Passwords do not match</p>
        )}
      </div>

      {error && (
        <div className="rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-600">
          {error}
        </div>
      )}

      <Button
        type="submit"
        disabled={isLoading || !canSubmit}
        className="w-full rounded-sm border-2 border-zinc-900 bg-[#ffd54a] py-2 text-sm font-semibold text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] transition-all hover:translate-y-[1px] hover:bg-[#f7ca2e] hover:shadow-[1px_1px_0_0_rgba(0,0,0,0.12)] active:translate-y-[2px] active:shadow-none disabled:opacity-50"
      >
        {isLoading ? 'Saving...' : 'Change Password'}
      </Button>
    </form>
  );
}
