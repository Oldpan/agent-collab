import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { XIcon, PlusIcon, CopyIcon, CheckIcon } from "lucide-react";
import type { MachineInfo, CreateMachineRequest } from "@agent-collab/protocol";

type Props = {
  onClose: () => void;
  onCreate: (req: CreateMachineRequest) => Promise<MachineInfo>;
};

const CORE_URL = typeof window !== "undefined"
  ? `ws://${window.location.hostname}:3100`
  : "ws://localhost:3100";

export function MachineCreatePanel({ onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [envKey, setEnvKey] = useState("");
  const [envVarKeys, setEnvVarKeys] = useState<string[]>(["ANTHROPIC_API_KEY"]);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<MachineInfo | null>(null);
  const [copied, setCopied] = useState(false);

  const addEnvKey = useCallback(() => {
    const key = envKey.trim().toUpperCase();
    if (key && !envVarKeys.includes(key)) {
      setEnvVarKeys((prev) => [...prev, key]);
    }
    setEnvKey("");
  }, [envKey, envVarKeys]);

  const removeEnvKey = useCallback((key: string) => {
    setEnvVarKeys((prev) => prev.filter((k) => k !== key));
  }, []);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const machine = await onCreate({ name: name.trim(), envVarKeys });
      setCreated(machine);
    } finally {
      setCreating(false);
    }
  }, [name, envVarKeys, onCreate]);

  const connectionCommand = created
    ? buildConnectionCommand(created, envVarKeys)
    : "";

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(connectionCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [connectionCommand]);

  return (
    <div className="space-y-2 border-t border-black/10 bg-[#fff0ae] px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-950">
          {created ? "Machine Created" : "New Machine"}
        </span>
        <Button size="icon-xs" variant="outline" className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]" onClick={onClose}>
          <XIcon className="size-3" />
        </Button>
      </div>

      {!created ? (
        <>
          <div className="space-y-0.5">
            <label className="text-[10px] text-zinc-500">Name</label>
            <input
              className="w-full rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1 text-xs"
              placeholder="e.g. my-gpu-box"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] text-zinc-500">
              API Key hints (shown in command)
            </label>
            <div className="flex flex-wrap gap-1">
              {envVarKeys.map((key) => (
                <span
                  key={key}
                  className="inline-flex items-center gap-0.5 rounded-sm border border-zinc-900 bg-[#fff8d8] px-1.5 py-0.5 text-[10px] font-mono"
                >
                  {key}
                  <button
                    onClick={() => removeEnvKey(key)}
                    className="ml-0.5 text-muted-foreground hover:text-foreground"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-1">
              <input
                className="flex-1 rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1 text-xs font-mono"
                placeholder="ADD_KEY"
                value={envKey}
                onChange={(e) => setEnvKey(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && addEnvKey()}
              />
              <Button size="icon-xs" variant="outline" className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]" onClick={addEnvKey}>
                <PlusIcon className="size-3" />
              </Button>
            </div>
          </div>

          <Button
            size="sm"
            className="w-full rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-xs text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
            onClick={handleCreate}
            disabled={creating || !name.trim()}
          >
            {creating ? "Creating..." : "Create Machine"}
          </Button>
        </>
      ) : (
        <>
          <div className="space-y-1 rounded-sm border-2 border-zinc-900 bg-[#fff8d8] p-2 shadow-[3px_3px_0_0_rgba(0,0,0,0.1)]">
            <div className="mb-1 text-[10px] text-zinc-500">
              Run this command on <span className="font-semibold">{created.name}</span>:
            </div>
            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all text-foreground leading-relaxed">
              {connectionCommand}
            </pre>
            <Button
              size="sm"
              variant="outline"
              className="mt-1 w-full rounded-sm border-2 border-zinc-900 bg-white text-xs hover:bg-[#fff1a9]"
              onClick={handleCopy}
            >
              {copied ? (
                <><CheckIcon className="size-3 mr-1" />Copied!</>
              ) : (
                <><CopyIcon className="size-3 mr-1" />Copy Command</>
              )}
            </Button>
          </div>
          <p className="text-center text-[10px] text-zinc-500">
            Machine will show <span className="text-green-500 font-medium">online</span> once this runs.
          </p>
        </>
      )}
    </div>
  );
}

function buildConnectionCommand(machine: MachineInfo, envVarKeys: string[]): string {
  const envParts = envVarKeys.map((k) => `${k}=<your-${k.toLowerCase()}>`).join(" \\\n  ");
  const prefix = envParts ? `${envParts} \\\n  ` : "";
  return (
    `${prefix}NODE_ID=${machine.nodeId} \\\n` +
    `  NODE_HOSTNAME=${machine.name} \\\n` +
    `  CORE_URL=${CORE_URL} \\\n` +
    `  WORKSPACE_ROOT=~/.agent-collab/agents \\\n` +
    `  DB_PATH=~/.agent-collab/agents/db.sqlite \\\n` +
    `  pnpm --filter @agent-collab/agent-node run dev`
  );
}
