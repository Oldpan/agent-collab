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
  const [memory, setMemory] = useState(agent.memory);
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onUpdate({ name, memory });
      onClose();
    } finally {
      setSaving(false);
    }
  }, [name, memory, onUpdate, onClose]);

  const claudeMemoryPath = agent.agentType === "claude_acp" && agent.workspacePath
    ? `~/.claude/projects/${agent.workspacePath.replace(/\//g, "-")}/memory/MEMORY.md`
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

      {/* Platform Memory */}
      <div className="space-y-0.5">
        <label className="text-[10px] text-muted-foreground">Platform Memory</label>
        <textarea
          className="w-full rounded border border-input bg-background px-1.5 py-0.5 text-xs resize-none min-h-[60px]"
          value={memory}
          onChange={(e) => setMemory(e.target.value)}
          placeholder="Key facts to remember across conversations..."
        />
      </div>

      {/* Claude native memory path (read-only info) */}
      {claudeMemoryPath && (
        <div className="rounded bg-muted/50 px-2 py-1 text-[10px] text-muted-foreground">
          <span className="font-medium">Native memory: </span>
          <span className={cn("font-mono break-all")}>{claudeMemoryPath}</span>
          <span className="block mt-0.5 opacity-70">(managed by Claude Code, read-only)</span>
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
