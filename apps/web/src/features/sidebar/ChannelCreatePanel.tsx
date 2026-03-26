import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { XIcon, HashIcon } from "lucide-react";
import type { AgentInfo, ChannelInfo } from "@agent-collab/protocol";

type Props = {
  agents: AgentInfo[];
  onClose: () => void;
  onCreate: (req: { name: string; workspacePath?: string; description?: string; agentIds?: string[] }) => Promise<ChannelInfo>;
  onCreated?: (channel: ChannelInfo) => void;
};

export function ChannelCreatePanel({ agents, onClose, onCreate, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const sortedAgents = useMemo(
    () => [...agents].sort((a, b) => a.name.localeCompare(b.name)),
    [agents],
  );

  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const channel = await onCreate({
        name: name.trim(),
        description: description.trim() || undefined,
        agentIds: [...selectedAgentIds],
      });
      onCreated?.(channel);
      onClose();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mb-2 space-y-2 rounded-md border-2 border-zinc-900 bg-[#fff8d8] p-2 shadow-[3px_3px_0_0_rgba(0,0,0,0.1)]">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
          New Channel
        </span>
        <Button
          size="icon-xs"
          variant="outline"
          className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]"
          onClick={onClose}
        >
          <XIcon className="size-3" />
        </Button>
      </div>

      <div className="space-y-0.5">
        <label className="text-[10px] text-zinc-500">Name</label>
        <div className="flex items-center gap-1 rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1">
          <HashIcon className="size-3 text-zinc-500" />
          <input
            autoFocus
            className="w-full bg-transparent text-xs outline-none placeholder:text-zinc-400"
            placeholder="channel-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
              if (e.key === "Escape") onClose();
            }}
          />
        </div>
      </div>

      <div className="space-y-0.5">
        <label className="text-[10px] text-zinc-500">Description</label>
        <textarea
          className="min-h-[56px] w-full resize-none rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1 text-xs placeholder:text-zinc-400"
          placeholder="What this channel is for..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <label className="text-[10px] text-zinc-500">Add Agents</label>
        {sortedAgents.length === 0 ? (
          <p className="rounded-sm border-2 border-dashed border-zinc-900/30 bg-white/60 px-2 py-2 text-[10px] text-zinc-500">
            No agents available yet.
          </p>
        ) : (
          <div className="max-h-32 space-y-1 overflow-auto rounded-sm border-2 border-zinc-900 bg-white p-1.5">
            {sortedAgents.map((agent) => {
              const checked = selectedAgentIds.has(agent.agentId);
              return (
                <label
                  key={agent.agentId}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-sm px-1 py-1 text-xs hover:bg-[#fff8d8]"
                >
                  <span className="truncate">{agent.name}</span>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleAgent(agent.agentId)}
                  />
                </label>
              );
            })}
          </div>
        )}
      </div>

      <Button
        size="sm"
        className="w-full rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-xs text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
        onClick={() => void handleCreate()}
        disabled={creating || !name.trim()}
      >
        {creating ? "Creating..." : "Create Channel"}
      </Button>
    </div>
  );
}
