import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "lucide-react";
import type { AgentType, CreateAgentRequest } from "@agent-collab/protocol";
import { cn } from "@/lib/utils";
import defaultSystemPrompt from "@/prompts/default-system-prompt.md?raw";

// Simple env vars editor for the dialog
function SimpleEnvVarsEditor({
  value,
  onChange,
}: {
  value: Record<string, string> | undefined;
  onChange: (value: Record<string, string> | undefined) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const entries = Object.entries(value ?? {});

  const addEntry = () => {
    if (!newKey.trim()) return;
    onChange({ ...value, [newKey.trim()]: newValue });
    setNewKey("");
    setNewValue("");
  };

  const removeEntry = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };

  return (
    <div className="space-y-1">
      {entries.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {entries.map(([k]) => (
            <span
              key={k}
              className="inline-flex items-center gap-0.5 rounded-sm border border-zinc-900 bg-[#fff8d8] px-1.5 py-0.5 text-[10px] font-mono"
            >
              {k}
              <button
                onClick={() => removeEntry(k)}
                className="ml-0.5 text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <input
          className="flex-1 rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1 text-xs font-mono"
          placeholder="KEY"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && addEntry()}
        />
        <input
          className="flex-1 rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1 text-xs"
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addEntry()}
        />
        <Button size="icon-xs" variant="outline" className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]" onClick={addEntry}>
          <PlusIcon className="size-3" />
        </Button>
      </div>
    </div>
  );
}

type Props = {
  onClose: () => void;
  onCreate: (req: CreateAgentRequest) => void;
  machineNodeId: string;
};

export function AgentCreateDialog({ onClose, onCreate, machineNodeId }: Props) {
  const [name, setName] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("claude_acp");
  const [systemPrompt, setSystemPrompt] = useState(defaultSystemPrompt);
  const [envVars, setEnvVars] = useState<Record<string, string> | undefined>();
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      onCreate({
        name: name.trim(),
        agentType,
        systemPrompt: systemPrompt.trim() || undefined,
        envVars,
        nodeId: machineNodeId,
      });
      onClose();
    } finally {
      setCreating(false);
    }
  }, [name, agentType, systemPrompt, envVars, machineNodeId, onCreate, onClose]);

  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <label className="text-[10px] text-zinc-500">Name</label>
        <input
          autoFocus
          className="w-full rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1 text-xs placeholder:text-zinc-400"
          placeholder="Agent name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreate();
            if (e.key === "Escape") onClose();
          }}
        />
      </div>

      <div className="space-y-0.5">
        <label className="text-[10px] text-zinc-500">Type</label>
        <div className="flex gap-1">
          {(["claude_acp", "codex_acp"] as AgentType[]).map((t) => (
            <button
              key={t}
              type="button"
              className={cn(
                "flex-1 rounded-sm border-2 px-1 py-0.5 text-[10px] cursor-pointer",
                agentType === t
                  ? "border-zinc-900 bg-[#ffd54a] text-zinc-950"
                  : "border-zinc-900 bg-white text-zinc-700 hover:bg-[#fff1a9]",
              )}
              onClick={() => setAgentType(t)}
            >
              {t === "claude_acp" ? "Claude" : "Codex"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-0.5">
        <label className="text-[10px] text-zinc-500">System Prompt</label>
        <textarea
          className="min-h-[80px] w-full resize-none rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1 text-xs placeholder:text-zinc-400"
          placeholder="System prompt (optional)"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
      </div>

      <div className="space-y-0.5">
        <label className="text-[10px] text-zinc-500">Environment Variables</label>
        <SimpleEnvVarsEditor value={envVars} onChange={setEnvVars} />
      </div>

      <Button
        size="sm"
        className="w-full rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-xs text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
        onClick={handleCreate}
        disabled={creating || !name.trim()}
      >
        {creating ? "Creating..." : "Create Agent"}
      </Button>
    </div>
  );
}
