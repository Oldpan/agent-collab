import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
  type ToolState,
} from "@/components/ai-elements/tool";
import { Loader } from "@/components/ai-elements/loader";
import { ChevronRightIcon, ActivityIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LiveRun, LiveToolCall } from "@/hooks/types";

type AgentActivityPanelProps = {
  runs: LiveRun[];
};

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function getToolState(tc: LiveToolCall): ToolState {
  if (tc.error) return "error";
  if (tc.completed || tc.output !== undefined) return "result";
  return "calling";
}

function RunRow({ run }: { run: LiveRun }) {
  const [open, setOpen] = useState(run.isActive);
  const toolCount = run.toolCalls.length;
  const duration =
    run.endedAt && run.startedAt
      ? ((run.endedAt - run.startedAt) / 1000).toFixed(1) + "s"
      : null;

  return (
    <Collapsible open={open || run.isActive} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-md border-2 border-zinc-900 px-3 py-2 text-left text-xs font-medium transition-colors",
          run.isActive
            ? "bg-[#fff9d0] hover:bg-[#fff3b0]"
            : "bg-[#fffbe6] hover:bg-[#fff5c2]",
          "shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 transition-transform",
            (open || run.isActive) && "rotate-90",
          )}
        />
        <span className="text-zinc-500 tabular-nums">
          {timeFormatter.format(run.startedAt)}
        </span>
        {run.isActive ? (
          <span className="flex items-center gap-1.5 text-amber-600 font-semibold">
            <Loader size={10} />
            Running
          </span>
        ) : (
          <span className="text-zinc-400">
            {toolCount} tool{toolCount !== 1 ? "s" : ""}
            {duration && <span className="ml-1.5">· {duration}</span>}
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="ml-3 mt-1 flex flex-col gap-1 border-l-2 border-zinc-200 pl-3">
          {run.thinking && (
            <Collapsible className="mb-1">
              <CollapsibleTrigger className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 hover:text-zinc-700">
                <ChevronRightIcon className="size-3 shrink-0 transition-transform data-[state=open]:rotate-90" />
                Reasoning
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-1 rounded border border-zinc-200 bg-[#fffdf0] px-2.5 py-2 text-xs italic text-zinc-500 whitespace-pre-wrap break-words">
                  {run.thinking}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {run.toolCalls.length === 0 && run.isActive && (
            <div className="flex items-center gap-1.5 py-1 text-xs text-zinc-400">
              <Loader size={10} />
              Waiting for tool calls...
            </div>
          )}

          {run.toolCalls.map((tc) => (
            <Tool key={tc.id} className="mb-0.5">
              <ToolHeader name={tc.name} state={getToolState(tc)} input={tc.input} />
              <ToolContent>
                <ToolInput input={tc.input} />
                <ToolOutput output={tc.output} isError={tc.error} />
              </ToolContent>
            </Tool>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AgentActivityPanel({ runs }: AgentActivityPanelProps) {
  if (runs.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-zinc-400">
        <ActivityIcon className="size-8 opacity-30" />
        <p className="text-sm">No activity yet</p>
        <p className="text-xs text-zinc-400/70">Tool calls will appear here when the agent runs</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-4">
      <div className="flex flex-col gap-2">
        {runs.map((run) => (
          <RunRow key={run.id} run={run} />
        ))}
      </div>
    </div>
  );
}
