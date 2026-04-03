import { useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import type { AgentType, CreateAgentRequest } from "@agent-collab/protocol";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { parseEnvVarsText } from "@/lib/env-vars";
import { CODEX_MODEL_OPTIONS, getCodexReasoningOptions } from "@/lib/codex-models";

type Props = {
  onClose: () => void;
  onCreate: (req: CreateAgentRequest) => void;
  machineNodeId: string;
};

export function AgentCreateDialog({ onClose, onCreate, machineNodeId }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("claude_acp");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [envVarsText, setEnvVarsText] = useState("");
  const [creating, setCreating] = useState(false);
  const parsedEnvVars = useMemo(() => parseEnvVarsText(envVarsText), [envVarsText]);
  const envVars = Object.keys(parsedEnvVars.envVars).length > 0 ? parsedEnvVars.envVars : undefined;
  const reasoningOptions = useMemo(() => getCodexReasoningOptions(model, reasoningEffort), [model, reasoningEffort]);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      onCreate({
        name: name.trim(),
        description: description.trim() || undefined,
        agentType,
        model: agentType === "codex_acp" ? (model.trim() || undefined) : undefined,
        reasoningEffort: agentType === "codex_acp" ? (reasoningEffort.trim() || undefined) : undefined,
        envVars,
        nodeId: machineNodeId,
      });
      onClose();
    } finally {
      setCreating(false);
    }
  }, [name, description, agentType, model, reasoningEffort, envVars, machineNodeId, onCreate, onClose]);

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
        <label className="text-[10px] text-zinc-500">
          Description
          <span className="ml-1 text-zinc-400">({description.length}/50)</span>
        </label>
        <input
          className="w-full rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1 text-xs placeholder:text-zinc-400"
          placeholder="Short bio (optional)"
          maxLength={50}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
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
              onClick={() => {
                setAgentType(t);
                if (t !== "codex_acp") {
                  setModel("");
                  setReasoningEffort("");
                }
              }}
            >
              {t === "claude_acp" ? "Claude" : "Codex"}
            </button>
          ))}
        </div>
      </div>

      {agentType === "codex_acp" && (
        <div className="space-y-2">
          <div className="space-y-0.5">
            <label className="text-[10px] text-zinc-500">Codex Model</label>
            <select
              className="h-8 w-full rounded-sm border-2 border-zinc-900 bg-white px-2 text-xs text-zinc-900"
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
              {CODEX_MODEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-0.5">
            <label className="text-[10px] text-zinc-500">Codex Reasoning</label>
            <select
              className="h-8 w-full rounded-sm border-2 border-zinc-900 bg-white px-2 text-xs text-zinc-900"
              value={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value)}
              disabled={!model}
            >
              <option value="">Remote default (~/.codex/config.toml)</option>
              {reasoningOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="text-[10px] text-zinc-500">
            Uses the remote machine&apos;s <span className="font-mono">~/.codex/config.toml</span> defaults when left empty.
          </div>
        </div>
      )}

      <div className="space-y-0.5">
        <label className="text-[10px] text-zinc-500">Environment Variables</label>
        <div className="space-y-2 rounded-sm border-2 border-zinc-900 bg-[#fff8d8] p-2">
          <Textarea
            className="min-h-[140px] resize-y border-2 border-zinc-900 bg-white px-2 py-1.5 text-[11px] font-mono leading-5"
            placeholder={[
              "Paste shell exports here",
              "export https_proxy=http://127.0.0.1:7893",
              "export ENABLE_TOOL_SEARCH=FALSE",
              "export ANTHROPIC_MODEL=kimi-k2.5",
            ].join("\n")}
            value={envVarsText}
            onChange={(event) => setEnvVarsText(event.target.value)}
          />

          <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
            <span>Supports `export KEY=value` and `KEY=value` lines.</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]"
              onClick={() => setEnvVarsText("")}
              disabled={!envVarsText.trim()}
            >
              Clear
            </Button>
          </div>

          {parsedEnvVars.ignoredLines.length > 0 && (
            <div className="rounded-sm border border-amber-300/60 bg-amber-50 px-2 py-1 text-[10px] text-amber-900">
              Ignored {parsedEnvVars.ignoredLines.length} line(s) that are not valid env assignments.
            </div>
          )}

          <div className="rounded-sm border-2 border-dashed border-zinc-900/40 bg-[#fffdf0] px-2 py-1.5">
            <div className="mb-1 text-[10px] font-medium text-zinc-500">Parsed Variables</div>
            {envVars ? (
              <div className="max-h-28 space-y-1 overflow-auto">
                {Object.entries(envVars).map(([key, envValue]) => (
                  <div key={key} className="flex gap-2 text-[10px]">
                    <span className="min-w-0 flex-none rounded-sm border border-zinc-900 bg-white px-1 font-mono text-foreground">
                      {key}
                    </span>
                    <span className="min-w-0 truncate font-mono text-zinc-500" title={envValue}>
                      {envValue}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[10px] text-zinc-500">No variables parsed yet.</div>
            )}
          </div>
        </div>
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
