import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { XIcon, SaveIcon } from "lucide-react";
import type { AgentInfo, UpdateAgentRequest } from "@agent-collab/protocol";
import { cn } from "@/lib/utils";

type Props = {
  agent: AgentInfo;
  onUpdate: (req: UpdateAgentRequest) => Promise<void>;
  onClose: () => void;
};

export function AgentDetailPanel({ agent, onUpdate, onClose }: Props) {
  const [name, setName] = useState(agent.name);
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onUpdate({ name });
      onClose();
    } finally {
      setSaving(false);
    }
  }, [name, onUpdate, onClose]);

  const workspaceMemoryPath = agent.workspacePath
    ? `${agent.workspacePath}/MEMORY.md`
    : null;

  return (
    <div className="border-t border-sidebar-border px-3 py-2 space-y-2 bg-sidebar-accent/30">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-sidebar-foreground">Edit Agent</span>
        <Button size="icon-xs" variant="ghost" onClick={onClose}>
          <XIcon className="size-3" />
        </Button>
      </div>

      {/* Name */}
      <div className="space-y-0.5">
        <label className="text-[10px] text-muted-foreground">Name</label>
        <input
          className="w-full rounded border border-input bg-background px-1.5 py-0.5 text-xs"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      {/* Workspace local memory path (read-only info) */}
      {workspaceMemoryPath && (
        <div className="rounded bg-muted/50 px-2 py-1 text-[10px] text-muted-foreground">
          <span className="font-medium">Local memory: </span>
          <span className={cn("font-mono break-all")}>{workspaceMemoryPath}</span>
          <span className="block mt-0.5 opacity-70">(managed by Agent Collab)</span>
        </div>
      )}

      <Button
        size="sm"
        className="w-full text-xs"
        onClick={handleSave}
        disabled={saving || !name.trim()}
      >
        <SaveIcon className="size-3 mr-1" />
        {saving ? "Saving..." : "Save"}
      </Button>
    </div>
  );
}
