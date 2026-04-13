import { useState, useEffect } from 'react';
import { XIcon, UserIcon, ShieldIcon, CalendarIcon, SettingsIcon, CheckIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BEIJING_TIME_ZONE } from '@agent-collab/protocol';
import type { User } from '@/lib/auth-api';
import { UserSettingsPanel } from './UserSettingsPanel';
import { useAgents } from '@/hooks/useAgents';
import { useChannels } from '@/hooks/useChannels';
import * as api from '@/lib/api';

interface HumanProfilePanelProps {
  user: User;
  currentUser: User;
  onClose: () => void;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { timeZone: BEIJING_TIME_ZONE });
}

export function HumanProfilePanel({ user, currentUser, onClose }: HumanProfilePanelProps) {
  const [showSettings, setShowSettings] = useState(false);
  const isSelf = user.id === currentUser.id;
  const isAdminViewing = currentUser.isAdmin && !isSelf;

  // Access control state (only relevant when admin views another user)
  const [accessAgentIds, setAccessAgentIds] = useState<Set<string>>(new Set());
  const [accessChannelIds, setAccessChannelIds] = useState<Set<string>>(new Set());
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessSaving, setAccessSaving] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [accessSaved, setAccessSaved] = useState(false);

  const { agents } = useAgents();
  const { channels } = useChannels();

  // Load current access grants when admin opens another user's profile
  useEffect(() => {
    if (!isAdminViewing) return;
    setAccessLoading(true);
    setAccessError(null);
    api.getUserAccess(user.id)
      .then((data) => {
        setAccessAgentIds(new Set(data.agentIds));
        setAccessChannelIds(new Set(data.channelIds));
      })
      .catch((err) => setAccessError(err instanceof Error ? err.message : 'Failed to load access'))
      .finally(() => setAccessLoading(false));
  }, [user.id, isAdminViewing]);

  const toggleAgent = (agentId: string) => {
    setAccessAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId); else next.add(agentId);
      return next;
    });
    setAccessSaved(false);
  };

  const toggleChannel = (channelId: string) => {
    setAccessChannelIds((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId); else next.add(channelId);
      return next;
    });
    setAccessSaved(false);
  };

  const saveAccess = async () => {
    setAccessSaving(true);
    setAccessError(null);
    setAccessSaved(false);
    try {
      await api.setUserAccess(user.id, [...accessAgentIds], [...accessChannelIds]);
      setAccessSaved(true);
    } catch (err) {
      setAccessError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setAccessSaving(false);
    }
  };

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

        <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto">
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

          {/* Self: edit settings button */}
          {isSelf && (
            <Button
              onClick={() => setShowSettings(true)}
              className="w-full rounded-sm border-2 border-zinc-900 bg-[#ffd54a] py-2 text-sm font-semibold text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] transition-all hover:translate-y-[1px] hover:bg-[#f7ca2e] hover:shadow-[1px_1px_0_0_rgba(0,0,0,0.12)] active:translate-y-[2px] active:shadow-none"
            >
              <SettingsIcon className="mr-2 size-3.5" />
              Edit Profile / Settings
            </Button>
          )}

          {/* Admin: permissions section for other users */}
          {isAdminViewing && (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-zinc-700 border-t-2 border-zinc-100 pt-3">
                Permissions
              </div>

              {accessLoading ? (
                <div className="text-xs text-zinc-400">Loading...</div>
              ) : (
                <>
                  {/* Agents */}
                  {agents.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Agents</div>
                      <div className="space-y-1 max-h-32 overflow-y-auto rounded-sm border border-zinc-200 p-2">
                        {agents.map((agent) => (
                          <label
                            key={agent.agentId}
                            className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-zinc-50"
                          >
                            <div
                              onClick={() => toggleAgent(agent.agentId)}
                              className={[
                                'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border cursor-pointer',
                                accessAgentIds.has(agent.agentId)
                                  ? 'border-zinc-900 bg-zinc-900 text-white'
                                  : 'border-zinc-300 bg-white',
                              ].join(' ')}
                            >
                              {accessAgentIds.has(agent.agentId) && <CheckIcon className="size-2.5" />}
                            </div>
                            <span className="truncate text-zinc-700">{agent.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Channels */}
                  {channels.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Channels</div>
                      <div className="space-y-1 max-h-32 overflow-y-auto rounded-sm border border-zinc-200 p-2">
                        {channels.map((ch) => (
                          <label
                            key={ch.channelId}
                            className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-zinc-50"
                          >
                            <div
                              onClick={() => toggleChannel(ch.channelId)}
                              className={[
                                'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border cursor-pointer',
                                accessChannelIds.has(ch.channelId)
                                  ? 'border-zinc-900 bg-zinc-900 text-white'
                                  : 'border-zinc-300 bg-white',
                              ].join(' ')}
                            >
                              {accessChannelIds.has(ch.channelId) && <CheckIcon className="size-2.5" />}
                            </div>
                            <span className="truncate text-zinc-700">{ch.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {agents.length === 0 && channels.length === 0 && (
                    <div className="text-xs text-zinc-400">No agents or channels exist yet.</div>
                  )}

                  {accessError && (
                    <div className="rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-600">
                      {accessError}
                    </div>
                  )}

                  {accessSaved && (
                    <div className="rounded-sm border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-700">
                      Permissions saved.
                    </div>
                  )}

                  <Button
                    onClick={saveAccess}
                    disabled={accessSaving}
                    className="w-full rounded-sm border-2 border-zinc-900 bg-[#ffd54a] py-2 text-sm font-semibold text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] transition-all hover:translate-y-[1px] hover:bg-[#f7ca2e] hover:shadow-[1px_1px_0_0_rgba(0,0,0,0.12)] active:translate-y-[2px] active:shadow-none disabled:opacity-50"
                  >
                    {accessSaving ? 'Saving...' : 'Save Permissions'}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
