import { useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatEnvVarsText, parseEnvVarsText } from "@/lib/env-vars";

type Props = {
  value?: Record<string, string>;
  onChange: (value: Record<string, string> | undefined) => void;
  editorKey: string;
  className?: string;
};

export function AgentEnvVarsEditor({ value, onChange, editorKey, className }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [rawText, setRawText] = useState(() => formatEnvVarsText(value));

  useEffect(() => {
    setRawText(formatEnvVarsText(value));
    setIsOpen(false);
  }, [editorKey, value]);

  const parsed = useMemo(() => parseEnvVarsText(rawText), [rawText]);
  const envEntries = Object.entries(parsed.envVars);

  useEffect(() => {
    onChange(envEntries.length > 0 ? parsed.envVars : undefined);
  }, [envEntries.length, onChange, parsed.envVars]);

  return (
    <div className={cn("space-y-1", className)}>
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-sm border-2 border-zinc-900 bg-white px-2 py-1 text-left text-[11px] font-medium hover:bg-[#fff1a9]"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="flex items-center gap-1.5">
          {isOpen ? (
            <ChevronDownIcon className="size-3 text-zinc-500" />
          ) : (
            <ChevronRightIcon className="size-3 text-zinc-500" />
          )}
          Environment Variables
        </span>
        <span className="text-[10px] text-zinc-500">
          {envEntries.length > 0 ? `${envEntries.length} vars` : "optional"}
        </span>
      </button>

      {isOpen && (
        <div className="space-y-2 rounded-sm border-2 border-zinc-900 bg-[#fff8d8] p-2">
          <Textarea
            className="min-h-[140px] resize-y border-2 border-zinc-900 bg-white px-2 py-1.5 text-[11px] font-mono leading-5"
            placeholder={[
              "Paste shell exports here",
              "export https_proxy=http://127.0.0.1:7893",
              "export ANTHROPIC_MODEL=GLM-4.7",
            ].join("\n")}
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
          />

          <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
            <span>Supports `export KEY=value` and `KEY=value` lines.</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]"
              onClick={() => setRawText("")}
              disabled={!rawText.trim()}
            >
              Clear
            </Button>
          </div>

          {parsed.ignoredLines.length > 0 && (
            <div className="rounded-sm border border-amber-300/60 bg-amber-50 px-2 py-1 text-[10px] text-amber-900">
              Ignored {parsed.ignoredLines.length} line(s) that are not valid env assignments.
            </div>
          )}

          <div className="rounded-sm border-2 border-dashed border-zinc-900/40 bg-[#fffdf0] px-2 py-1.5">
            <div className="mb-1 text-[10px] font-medium text-zinc-500">Parsed Variables</div>
            {envEntries.length === 0 ? (
              <div className="text-[10px] text-zinc-500">No variables parsed yet.</div>
            ) : (
              <div className="max-h-28 overflow-auto space-y-1">
                {envEntries.map(([key, envValue]) => (
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
            )}
          </div>
        </div>
      )}
    </div>
  );
}
