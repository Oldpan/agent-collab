import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { XIcon, SaveIcon, RotateCcwIcon } from "lucide-react";
import type { AgentInfo, UpdateAgentRequest } from "@agent-collab/protocol";
import { cn } from "@/lib/utils";
import { AgentEnvVarsEditor } from "./AgentEnvVarsEditor";
import { AgentPermissionSettings } from "./AgentPermissionSettings";

type Props = {
  agent: AgentInfo;
  onUpdate: (req: UpdateAgentRequest) => Promise<void>;
  onReset: () => Promise<void>;
  onClose: () => void;
};

export function AgentDetailPanel({ agent, onUpdate, onReset, onClose }: Props) {
  const [name, setName] = useState(agent.name);
  const [envVars, setEnvVars] = useState<Record<string, string> | undefined>(agent.envVars);
  const [disabledToolKinds, setDisabledToolKinds] = useState(agent.disabledToolKinds);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onUpdate({ name, envVars, disabledToolKinds });
      onClose();
    } finally {
      setSaving(false);
    }
  }, [disabledToolKinds, envVars, name, onUpdate, onClose]);

  const handleReset = useCallback(async () => {
    const confirmed = window.confirm(
      `Reset ${agent.name}?\n\nThis will clear the agent workspace, remove chat history, and start the current private session from a clean state.`,
    );
    if (!confirmed) return;

    setResetting(true);
    try {
      await onReset();
      onClose();
    } catch (error) {
      window.alert(String((error as Error)?.message ?? error));
    } finally {
      setResetting(false);
    }
  }, [agent.name, onClose, onReset]);

  const workspaceMemoryPath = agent.workspacePath
    ? `${agent.workspacePath}/MEMORY.md`
    : null;

  return (
    <div className="space-y-2 border-t border-black/10 bg-[#fff0ae] px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-950">Edit Agent</span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-6 rounded-sm border-2 border-zinc-900 bg-[#ffd8d8] px-2 text-[10px] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#ffc6c6]"
            onClick={handleReset}
            disabled={saving || resetting}
            title="Reset agent workspace and chat history"
          >
            <RotateCcwIcon className="mr-1 size-3" />
            {resetting ? "Resetting..." : "Reset"}
          </Button>
          <Button size="icon-xs" variant="outline" className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]" onClick={onClose}>
            <XIcon className="size-3" />
          </Button>
        </div>
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
  );
}
