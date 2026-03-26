import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { XIcon, SaveIcon, RefreshCwIcon, MessageSquareOffIcon, Trash2Icon } from "lucide-react";
import type { AgentInfo, UpdateAgentRequest } from "@agent-collab/protocol";
import { cn } from "@/lib/utils";
import { AgentEnvVarsEditor } from "./AgentEnvVarsEditor";
import { AgentPermissionSettings } from "./AgentPermissionSettings";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useChannels } from "@/hooks/useChannels";

type Props = {
  agent: AgentInfo;
  onUpdate: (req: UpdateAgentRequest) => Promise<void>;
  onRestart: () => Promise<void>;
  onClearChat: () => Promise<void>;
  onReset: () => Promise<void>;
  onClose: () => void;
};

export function AgentDetailPanel({ agent, onUpdate, onRestart, onClearChat, onReset, onClose }: Props) {
  const [name, setName] = useState(agent.name);
  const [channelId, setChannelId] = useState(agent.channelId);
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
      await onUpdate({ name, envVars, disabledToolKinds, channelId });
      onClose();
    } finally {
      setSaving(false);
    }
  }, [disabledToolKinds, envVars, name, onUpdate, onClose]);

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
          onClose();
        } finally {
          setBusy(false);
          closeDialog();
        }
      },
    });
  }, [agent.name, onClose, onRestart]);

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
          onClose();
        } finally {
          setBusy(false);
          closeDialog();
        }
      },
    });
  }, [agent.name, onClose, onClearChat]);

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
          onClose();
        } finally {
          setBusy(false);
          closeDialog();
        }
      },
    });
  }, [agent.name, onClose, onReset]);

  const workspaceMemoryPath = agent.workspacePath
    ? `${agent.workspacePath}/MEMORY.md`
    : null;

  return (
    <>
      <div className="space-y-2 border-t border-black/10 bg-[#fff0ae] px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-950">Edit Agent</span>
          <Button size="icon-xs" variant="outline" className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]" onClick={onClose}>
            <XIcon className="size-3" />
          </Button>
        </div>

        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-6 flex-1 rounded-sm border-2 border-zinc-900 bg-[#dff0ff] px-1.5 text-[10px] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#c5e4ff]"
            onClick={handleRestart}
            disabled={saving || busy}
            title="Restart agent process, keep all data"
          >
            <RefreshCwIcon className="mr-1 size-3" />
            Restart
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 flex-1 rounded-sm border-2 border-zinc-900 bg-[#fff0d0] px-1.5 text-[10px] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#ffe4b0]"
            onClick={handleClearChat}
            disabled={saving || busy}
            title="Clear chat history, keep workspace files"
          >
            <MessageSquareOffIcon className="mr-1 size-3" />
            Clear chat
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 flex-1 rounded-sm border-2 border-zinc-900 bg-[#ffd8d8] px-1.5 text-[10px] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#ffc6c6]"
            onClick={handleReset}
            disabled={saving || busy}
            title="Full reset: clear chat history and workspace files"
          >
            <Trash2Icon className="mr-1 size-3" />
            Full reset
          </Button>
        </div>

        {/* Name */}
        <div className="space-y-0.5">
          <label className="text-[10px] text-zinc-500">Name</label>
          <input
            className="w-full rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1 text-xs"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {/* Channel assignment */}
        {channels.length > 0 && (
          <div className="space-y-0.5">
            <label className="text-[10px] text-zinc-500">Channel</label>
            <select
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              className="w-full rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1 text-xs"
            >
              {channels.map((c) => (
                <option key={c.channelId} value={c.channelId}>#{c.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Workspace local memory path (read-only info) */}
        {workspaceMemoryPath && (
          <div className="rounded-sm border-2 border-zinc-900 bg-[#fff8d8] px-2 py-1 text-[10px] text-zinc-600">
            <span className="font-medium">Local memory: </span>
            <span className={cn("font-mono break-all")}>{workspaceMemoryPath}</span>
            <span className="block mt-0.5 opacity-70">(managed by Agent Collab)</span>
          </div>
        )}

        <AgentEnvVarsEditor
          editorKey={agent.agentId}
          value={envVars}
          onChange={setEnvVars}
        />

        <AgentPermissionSettings
          value={disabledToolKinds}
          onChange={setDisabledToolKinds}
        />

        <Button
          size="sm"
          className="w-full rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-xs text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
          onClick={handleSave}
          disabled={saving || !name.trim()}
        >
          <SaveIcon className="size-3 mr-1" />
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

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
