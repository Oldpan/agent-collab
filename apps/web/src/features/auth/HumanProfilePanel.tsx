import { useState } from 'react';
import { XIcon, UserIcon, ShieldIcon, CalendarIcon, SettingsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { User } from '@/lib/auth-api';
import { UserSettingsPanel } from './UserSettingsPanel';

interface HumanProfilePanelProps {
  user: User;
  currentUser: User;
  onClose: () => void;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function HumanProfilePanel({ user, currentUser, onClose }: HumanProfilePanelProps) {
  const [showSettings, setShowSettings] = useState(false);
  const isSelf = user.id === currentUser.id;

  if (showSettings) {
    return <UserSettingsPanel user={currentUser} onClose={() => setShowSettings(false)} />;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-sm rounded-sm border-2 border-zinc-900 bg-white shadow-[8px_8px_0_0_rgba(0,0,0,0.3)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b-2 border-zinc-900 bg-[#ffd700] px-5 py-3">
          <h2 className="text-sm font-bold text-zinc-900">Profile</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-600 hover:text-zinc-900 transition-colors cursor-pointer"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Avatar + name */}
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-zinc-900 shadow-[3px_3px_0_0_rgba(0,0,0,0.15)]">
              {user.isAdmin
                ? <ShieldIcon className="size-7" />
                : <UserIcon className="size-7" />
              }
            </div>
            <div>
              <div className="text-base font-bold text-zinc-900">{user.username}</div>
              <div className={[
                'mt-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold',
                user.isAdmin
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-zinc-100 text-zinc-500',
              ].join(' ')}>
                {user.isAdmin ? <ShieldIcon className="size-2.5" /> : <UserIcon className="size-2.5" />}
                {user.isAdmin ? 'Admin' : 'User'}
              </div>
              {isSelf && (
                <div className="mt-1 text-[10px] text-zinc-400">You</div>
              )}
            </div>
          </div>

          {/* Details */}
          <div className="space-y-2 rounded-sm border-2 border-zinc-200 bg-zinc-50 p-3 text-xs">
            <div className="flex items-start gap-2">
              <span className="w-20 shrink-0 font-medium text-zinc-500">User ID</span>
              <span className="break-all font-mono text-[10px] text-zinc-400">{user.id}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 font-medium text-zinc-500">Role</span>
              <span className="text-zinc-700">{user.isAdmin ? 'Administrator' : 'User'}</span>
            </div>
            <div className="flex items-center gap-2">
              <CalendarIcon className="size-3 shrink-0 text-zinc-400" />
              <span className="font-medium text-zinc-500">Joined</span>
              <span className="text-zinc-700">{formatDate(user.createdAt)}</span>
            </div>
          </div>

          {/* Actions */}
          {isSelf && (
            <Button
              onClick={() => setShowSettings(true)}
              className="w-full rounded-sm border-2 border-zinc-900 bg-[#ffd54a] py-2 text-sm font-semibold text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] transition-all hover:translate-y-[1px] hover:bg-[#f7ca2e] hover:shadow-[1px_1px_0_0_rgba(0,0,0,0.12)] active:translate-y-[2px] active:shadow-none"
            >
              <SettingsIcon className="mr-2 size-3.5" />
              Edit Profile / Settings
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
