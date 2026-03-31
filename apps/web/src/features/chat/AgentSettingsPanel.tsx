import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCwIcon, MessageSquareOffIcon, Trash2Icon, SaveIcon } from "lucide-react";
import type { AgentInfo, UpdateAgentRequest } from "@agent-collab/protocol";
import { cn } from "@/lib/utils";
import { AgentEnvVarsKeyValueEditor } from "@/features/sidebar/AgentEnvVarsKeyValueEditor";
import { AgentPermissionSettings } from "@/features/sidebar/AgentPermissionSettings";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useChannels } from "@/hooks/useChannels";
import { joinAgentChannel, leaveAgentChannel } from "@/lib/api";
import { ScrollArea } from "@/components/ui/scroll-area";

type Props = {
  agent: AgentInfo;
  isAdmin?: boolean;
  onUpdate: (req: UpdateAgentRequest) => Promise<void>;
  onRestart: () => Promise<void>;
  onClearChat: () => Promise<void>;
  onReset: () => Promise<void>;
};

export function AgentSettingsPanel({ agent, isAdmin = false, onUpdate, onRestart, onClearChat, onReset }: Props) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [joinedChannelIds, setJoinedChannelIds] = useState<Set<string>>(
    new Set(agent.channelIds && agent.channelIds.length > 0 ? agent.channelIds : [agent.channelId]),
  );
  const [envVars, setEnvVars] = useState<Record<string, string> | undefined>(agent.envVars);
  const [disabledToolKinds, setDisabledToolKinds] = useState(agent.disabledToolKinds);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const { channels } = useChannels();

  // Dialog states
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogConfig, setDialogConfig] = useState<{
    title: string;
    message: string;
    confirmText: string;
    variant: "danger" | "warning" | "info";
    onConfirm: () => Promise<void>;
  } | null>(null);

  const openDialog = (config: typeof dialogConfig) => {
    setDialogConfig(config);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setDialogConfig(null);
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const prevIds = new Set(agent.channelIds && agent.channelIds.length > 0 ? agent.channelIds : [agent.channelId]);
      const toJoin = [...joinedChannelIds].filter((id) => !prevIds.has(id));
      const toLeave = [...prevIds].filter((id) => !joinedChannelIds.has(id));
      await Promise.all([
        onUpdate({ name, description: description.trim() || undefined, envVars, disabledToolKinds }),
        ...toJoin.map((id) => joinAgentChannel(agent.agentId, id)),
        ...toLeave.map((id) => leaveAgentChannel(agent.agentId, id)),
      ]);
    } finally {
      setSaving(false);
    }
  }, [agent.agentId, agent.channelId, agent.channelIds, description, disabledToolKinds, envVars, joinedChannelIds, name, onUpdate]);

  const toggleChannel = useCallback((id: string) => {
    setJoinedChannelIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleRestart = useCallback(async () => {
    openDialog({
      title: "Restart Agent",
      message: `Restart ${agent.name}?\n\nThe agent process will be restarted. All chat history and workspace files are preserved.`,
      confirmText: "Restart",
      variant: "info",
      onConfirm: async () => {
        setBusy(true);
        try {
          await onRestart();
        } finally {
          setBusy(false);
          closeDialog();
        }
      },
    });
  }, [agent.name, onRestart]);

  const handleClearChat = useCallback(async () => {
    openDialog({
      title: "Clear Chat History",
      message: `Clear chat history for ${agent.name}?\n\nAll messages will be removed and the session will restart. Workspace files are preserved.`,
      confirmText: "Clear",
      variant: "warning",
      onConfirm: async () => {
        setBusy(true);
        try {
          await onClearChat();
        } finally {
          setBusy(false);
          closeDialog();
        }
      },
    });
  }, [agent.name, onClearChat]);

  const handleReset = useCallback(async () => {
    openDialog({
      title: "Full Reset",
      message: `Full reset of ${agent.name}?\n\nThis will clear ALL chat history AND delete all workspace files. This cannot be undone.`,
      confirmText: "Reset",
      variant: "danger",
      onConfirm: async () => {
        setBusy(true);
        try {
          await onReset();
        } finally {
          setBusy(false);
          closeDialog();
        }
      },
    });
  }, [agent.name, onReset]);

  const workspaceMemoryPath = agent.workspacePath
    ? `${agent.workspacePath}/MEMORY.md`
    : null;

  if (!isAdmin) {
    return (
      <ScrollArea className="h-full flex-1 bg-[#fff9d0]">
        <div className="space-y-4 px-4 py-4">
          <section className="rounded-sm border-2 border-zinc-900 bg-[#fff8d8] px-3 py-3 text-sm text-zinc-700 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
            Agent settings are read-only for non-admin users. You can chat with this agent, but only admins can change its configuration or lifecycle.
          </section>
          {workspaceMemoryPath && (
            <section className="rounded-sm border-2 border-zinc-900 bg-[#fff8d8] px-3 py-2 text-xs text-zinc-600">
              <span className="font-medium">Local memory: </span>
              <span className={cn("font-mono break-all")}>{workspaceMemoryPath}</span>
              <span className="mt-0.5 block opacity-70">(managed by Agent Collab)</span>
            </section>
          )}
        </div>
      </ScrollArea>
    );
  }

  return (
    <>
      <ScrollArea className="h-full flex-1 bg-[#fff9d0]">
        <div className="space-y-4 px-4 py-4">
          {/* Action Buttons */}
          <section className="space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Actions</div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 flex-1 rounded-sm border-2 border-zinc-900 bg-[#dff0ff] px-2 text-xs text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#c5e4ff]"
                onClick={handleRestart}
                disabled={saving || busy}
                title="Restart agent process, keep all data"
              >
                <RefreshCwIcon className="mr-1 size-3.5" />
                Restart
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 flex-1 rounded-sm border-2 border-zinc-900 bg-[#fff0d0] px-2 text-xs text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#ffe4b0]"
                onClick={handleClearChat}
                disabled={saving || busy}
                title="Clear chat history, keep workspace files"
              >
                <MessageSquareOffIcon className="mr-1 size-3.5" />
                Clear chat
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 flex-1 rounded-sm border-2 border-zinc-900 bg-[#ffd8d8] px-2 text-xs text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#ffc6c6]"
                onClick={handleReset}
                disabled={saving || busy}
                title="Full reset: clear chat history and workspace files"
              >
                <Trash2Icon className="mr-1 size-3.5" />
                Full reset
              </Button>
            </div>
          </section>

          {/* Settings Form */}
          <section className="space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Settings</div>

            {/* Name */}
            <div className="space-y-1">
              <label className="text-xs text-zinc-600">Name</label>
              <input
                className="w-full rounded-sm border-2 border-zinc-900 bg-white px-2 py-1.5 text-sm"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {/* Description */}
            <div className="space-y-1">
              <label className="flex items-center gap-1 text-xs text-zinc-600">
                Description
                <span className="text-zinc-400">({description.length}/50)</span>
              </label>
              <input
                className="w-full rounded-sm border-2 border-zinc-900 bg-white px-2 py-1.5 text-sm placeholder:text-zinc-400"
                placeholder="Short bio (optional)"
                maxLength={50}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {/* Channel membership */}
            {channels.length > 0 && (
              <div className="space-y-1">
                <label className="text-xs text-zinc-600">Channels</label>
                <div className="max-h-32 overflow-y-auto rounded-sm border-2 border-zinc-900 bg-white p-1.5">
                  {channels.map((c) => {
                    const isJoined = joinedChannelIds.has(c.channelId);
                    return (
                      <label
                        key={c.channelId}
                        className="flex items-center gap-2 px-1.5 py-1 text-sm cursor-pointer rounded hover:bg-zinc-50"
                      >
                        <input
                          type="checkbox"
                          checked={isJoined}
                          onChange={() => toggleChannel(c.channelId)}
                          className="size-3.5 shrink-0"
                        />
                        <span className="truncate">#{c.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Workspace local memory path (read-only info) */}
            {workspaceMemoryPath && (
              <div className="rounded-sm border-2 border-zinc-900 bg-[#fff8d8] px-3 py-2 text-xs text-zinc-600">
                <span className="font-medium">Local memory: </span>
                <span className={cn("font-mono break-all")}>{workspaceMemoryPath}</span>
                <span className="block mt-0.5 opacity-70">(managed by Agent Collab)</span>
              </div>
            )}

            <AgentEnvVarsKeyValueEditor
              editorKey={agent.agentId}
              value={envVars}
              onChange={setEnvVars}
            />

            <AgentPermissionSettings
              value={disabledToolKinds}
              onChange={setDisabledToolKinds}
            />

            {isAdmin && (
              <Button
                size="sm"
                className="w-full rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-sm text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
                onClick={handleSave}
                disabled={saving || !name.trim()}
              >
                <SaveIcon className="size-3.5 mr-1" />
                {saving ? "Saving..." : "Save Changes"}
              </Button>
            )}
          </section>
        </div>
      </ScrollArea>

      <ConfirmDialog
        isOpen={dialogOpen}
        title={dialogConfig?.title ?? ""}
        message={dialogConfig?.message ?? ""}
        confirmText={busy ? "Processing..." : (dialogConfig?.confirmText ?? "Confirm")}
        cancelText="Cancel"
        variant={dialogConfig?.variant ?? "info"}
        onConfirm={async () => {
          await dialogConfig?.onConfirm();
        }}
        onCancel={closeDialog}
      />
    </>
  );
}
