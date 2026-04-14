import { useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCwIcon, MessageSquareOffIcon, Trash2Icon, SaveIcon } from "lucide-react";
import type { AgentInfo, UpdateAgentRequest } from "@agent-collab/protocol";
import { cn } from "@/lib/utils";
import { AgentEnvVarsKeyValueEditor } from "@/features/sidebar/AgentEnvVarsKeyValueEditor";
import { AgentPermissionSettings } from "@/features/sidebar/AgentPermissionSettings";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useChannels } from "@/hooks/useChannels";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getCodexModelOptions, getCodexReasoningOptions } from "@/lib/codex-models";

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
  const [projectPath, setProjectPath] = useState(agent.projectPath ?? "");
  const [model, setModel] = useState(agent.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState(agent.reasoningEffort ?? "");
  const [envVars, setEnvVars] = useState<Record<string, string> | undefined>(agent.envVars);
  const [disabledToolKinds, setDisabledToolKinds] = useState(agent.disabledToolKinds);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { channels } = useChannels();
  const codexModelOptions = useMemo(() => getCodexModelOptions(model), [model]);
  const codexReasoningOptions = useMemo(() => getCodexReasoningOptions(model, reasoningEffort), [model, reasoningEffort]);
  const memberChannels = useMemo(
    () => channels.filter((channel) =>
      channel.members?.some((member) => member.agentId === agent.agentId)
      ?? (agent.channelIds?.includes(channel.channelId) ?? false),
    ),
    [agent.agentId, agent.channelIds, channels],
  );

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
      await onUpdate({
        name,
        description: description.trim() || undefined,
        model: agent.agentType === "codex_acp" ? (model.trim() || undefined) : undefined,
        reasoningEffort: agent.agentType === "codex_acp" ? (reasoningEffort.trim() || undefined) : undefined,
        envVars,
        disabledToolKinds,
        projectPath: projectPath.trim() || null,
      });
    } finally {
      setSaving(false);
    }
  }, [agent.agentType, description, disabledToolKinds, envVars, model, projectPath, reasoningEffort, name, onUpdate]);

  const handleRestart = useCallback(async () => {
    setActionError(null);
    openDialog({
      title: "Restart Conversation",
      message: `Restart the current ${agent.name} conversation?\n\nThe current conversation runtime will be restarted. Chat history and workspace files are preserved.`,
      confirmText: "Restart",
      variant: "info",
      onConfirm: async () => {
        setBusy(true);
        try {
          await onRestart();
          closeDialog();
        } catch (error) {
          setActionError(String((error as Error)?.message ?? error));
          closeDialog();
        } finally {
          setBusy(false);
        }
      },
    });
  }, [agent.name, onRestart]);

  const handleClearChat = useCallback(async () => {
    setActionError(null);
    openDialog({
      title: "Clear Chat History",
      message: `Clear chat history for the current ${agent.name} conversation?\n\nThis conversation will get a fresh session. Workspace files are preserved.`,
      confirmText: "Clear",
      variant: "warning",
      onConfirm: async () => {
        setBusy(true);
        try {
          await onClearChat();
          closeDialog();
        } catch (error) {
          setActionError(String((error as Error)?.message ?? error));
          closeDialog();
        } finally {
          setBusy(false);
        }
      },
    });
  }, [agent.name, onClearChat]);

  const handleReset = useCallback(async () => {
    setActionError(null);
    openDialog({
      title: "Full Reset",
      message: `Full reset of ${agent.name}?\n\nThis will clear ALL chat history AND delete all workspace files. This cannot be undone.`,
      confirmText: "Reset",
      variant: "danger",
      onConfirm: async () => {
        setBusy(true);
        try {
          await onReset();
          closeDialog();
        } catch (error) {
          setActionError(String((error as Error)?.message ?? error));
          closeDialog();
        } finally {
          setBusy(false);
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
          <section className="space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Actions</div>
            {actionError ? (
              <div className="rounded-sm border-2 border-red-700 bg-[#ffe3e3] px-3 py-2 text-xs text-red-800 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
                Action failed: {actionError}
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 flex-1 rounded-sm border-2 border-zinc-900 bg-[#dff0ff] px-2 text-xs text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#c5e4ff]"
                onClick={handleRestart}
                disabled={busy}
                title="Restart the current conversation runtime, keep all history and workspace files"
              >
                <RefreshCwIcon className="mr-1 size-3.5" />
                Restart
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 flex-1 rounded-sm border-2 border-zinc-900 bg-[#fff0d0] px-2 text-xs text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#ffe4b0]"
                onClick={handleClearChat}
                disabled={busy}
                title="Clear chat history for the current conversation, keep workspace files"
              >
                <MessageSquareOffIcon className="mr-1 size-3.5" />
                Clear chat
              </Button>
            </div>
          </section>
          <section className="rounded-sm border-2 border-zinc-900 bg-[#fff8d8] px-3 py-3 text-sm text-zinc-700 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
            Agent settings are read-only for non-admin users. You can restart or clear the current conversation, but only admins can edit configuration or run a full reset.
          </section>
          <section className="rounded-sm border-2 border-zinc-900 bg-[#fff8d8] px-3 py-2 text-xs text-zinc-600">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Member Of</div>
            {memberChannels.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {memberChannels.map((channel) => (
                  <span
                    key={channel.channelId}
                    className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-[11px] text-zinc-700"
              >
                #{channel.name}
              </span>
                ))}
              </div>
            ) : (
              <div className="mt-1 text-xs text-zinc-500">No channel memberships.</div>
            )}
          </section>
          {workspaceMemoryPath && (
            <section className="rounded-sm border-2 border-zinc-900 bg-[#fff8d8] px-3 py-2 text-xs text-zinc-600">
              <span className="font-medium">Local memory: </span>
              <span className={cn("font-mono break-all")}>{workspaceMemoryPath}</span>
              <span className="mt-0.5 block opacity-70">(managed by Agent Collab)</span>
            </section>
          )}
          <section className="rounded-sm border-2 border-zinc-900 bg-[#fff8d8] px-3 py-2 text-xs text-zinc-600">
            <span className="font-medium">Project directory: </span>
            <span className={cn("font-mono break-all")}>{agent.projectPath ?? "Not configured"}</span>
          </section>
        </div>
        <ConfirmDialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) setDialogConfig(null);
          }}
          title={dialogConfig?.title ?? ""}
          message={dialogConfig?.message ?? ""}
          confirmText={dialogConfig?.confirmText ?? "Confirm"}
          variant={dialogConfig?.variant ?? "info"}
          onConfirm={async () => {
            if (dialogConfig?.onConfirm) {
              await dialogConfig.onConfirm();
            }
          }}
        />
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
            {actionError ? (
              <div className="rounded-sm border-2 border-red-700 bg-[#ffe3e3] px-3 py-2 text-xs text-red-800 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
                Action failed: {actionError}
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 flex-1 rounded-sm border-2 border-zinc-900 bg-[#dff0ff] px-2 text-xs text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#c5e4ff]"
                onClick={handleRestart}
                disabled={saving || busy}
                title="Restart the current conversation runtime, keep all history and workspace files"
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
                title="Clear chat history for the current conversation, keep workspace files"
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

            {agent.agentType === "codex_acp" && (
              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-xs text-zinc-600">Codex Model</label>
                  <select
                    className="h-9 w-full rounded-sm border-2 border-zinc-900 bg-white px-2 text-sm text-zinc-900"
                    value={model}
                    onChange={(e) => {
                      const nextModel = e.target.value;
                      setModel(nextModel);
                      const nextReasoningOptions = getCodexReasoningOptions(nextModel, undefined);
                      if (!nextReasoningOptions.some((option) => option.value === reasoningEffort)) {
                        setReasoningEffort("");
                      }
                    }}
                  >
                    <option value="">Remote default (~/.codex/config.toml)</option>
                    {codexModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-zinc-600">Codex Reasoning</label>
                  <select
                    className="h-9 w-full rounded-sm border-2 border-zinc-900 bg-white px-2 text-sm text-zinc-900"
                    value={reasoningEffort}
                    onChange={(e) => setReasoningEffort(e.target.value)}
                    disabled={!model}
                  >
                    <option value="">Remote default (~/.codex/config.toml)</option>
                    {codexReasoningOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs text-zinc-600">Member Of</label>
              {memberChannels.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 rounded-sm border-2 border-zinc-900 bg-white px-2 py-2">
                  {memberChannels.map((channel) => (
                    <span
                      key={channel.channelId}
                      className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-700"
                    >
                      #{channel.name}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="rounded-sm border-2 border-dashed border-zinc-900/30 bg-white/60 px-3 py-2 text-xs text-zinc-500">
                  No channel memberships. Manage memberships from a channel panel.
                </div>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-xs text-zinc-600">Project Directory</label>
              <input
                className="w-full rounded-sm border-2 border-zinc-900 bg-white px-2 py-1.5 font-mono text-sm"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                placeholder="/absolute/path/to/project"
              />
              <div className="text-[11px] text-zinc-500">
                Shared development directory on the assigned machine. The private workspace and memory stay under the agent workspace path.
              </div>
            </div>

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
