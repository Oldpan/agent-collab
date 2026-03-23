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
        className="flex w-full items-center justify-between rounded border border-input bg-background px-2 py-1 text-left text-[11px] font-medium hover:bg-accent/40"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="flex items-center gap-1.5">
          {isOpen ? (
            <ChevronDownIcon className="size-3 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3 text-muted-foreground" />
          )}
          Environment Variables
        </span>
        <span className="text-[10px] text-muted-foreground">
          {envEntries.length > 0 ? `${envEntries.length} vars` : "optional"}
        </span>
      </button>

      {isOpen && (
        <div className="rounded border border-sidebar-border bg-background/60 p-2 space-y-2">
          <Textarea
            className="min-h-[140px] resize-y px-2 py-1.5 text-[11px] font-mono leading-5"
            placeholder={[
              "Paste shell exports here",
              "export https_proxy=http://127.0.0.1:7893",
              "export ANTHROPIC_MODEL=GLM-4.7",
            ].join("\n")}
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
          />

          <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span>Supports `export KEY=value` and `KEY=value` lines.</span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setRawText("")}
              disabled={!rawText.trim()}
            >
              Clear
            </Button>
          </div>

          {parsed.ignoredLines.length > 0 && (
            <div className="rounded border border-amber-300/60 bg-amber-50 px-2 py-1 text-[10px] text-amber-900">
              Ignored {parsed.ignoredLines.length} line(s) that are not valid env assignments.
            </div>
          )}

          <div className="rounded border border-dashed border-sidebar-border bg-muted/30 px-2 py-1.5">
            <div className="mb-1 text-[10px] font-medium text-muted-foreground">Parsed Variables</div>
            {envEntries.length === 0 ? (
              <div className="text-[10px] text-muted-foreground">No variables parsed yet.</div>
            ) : (
              <div className="max-h-28 overflow-auto space-y-1">
                {envEntries.map(([key, envValue]) => (
                  <div key={key} className="flex gap-2 text-[10px]">
                    <span className="min-w-0 flex-none rounded bg-background px-1 font-mono text-foreground">
                      {key}
                    </span>
                    <span className="min-w-0 truncate font-mono text-muted-foreground" title={envValue}>
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
