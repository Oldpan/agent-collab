import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { XIcon, SaveIcon } from "lucide-react";
import type { AgentInfo, UpdateAgentRequest } from "@agent-collab/protocol";
import { cn } from "@/lib/utils";
import { AgentEnvVarsEditor } from "./AgentEnvVarsEditor";

type Props = {
  agent: AgentInfo;
  onUpdate: (req: UpdateAgentRequest) => Promise<void>;
  onClose: () => void;
};

export function AgentDetailPanel({ agent, onUpdate, onClose }: Props) {
  const [name, setName] = useState(agent.name);
  const [envVars, setEnvVars] = useState<Record<string, string> | undefined>(agent.envVars);
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onUpdate({ name, envVars });
      onClose();
    } finally {
      setSaving(false);
    }
  }, [envVars, name, onUpdate, onClose]);

  const workspaceMemoryPath = agent.workspacePath
    ? `${agent.workspacePath}/MEMORY.md`
    : null;

  return (
    <div className="space-y-2 border-t border-black/10 bg-[#fff0ae] px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-950">Edit Agent</span>
        <Button size="icon-xs" variant="outline" className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]" onClick={onClose}>
          <XIcon className="size-3" />
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
