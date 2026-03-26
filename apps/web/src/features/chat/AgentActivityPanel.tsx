import { useEffect, useMemo, useState } from "react";
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

function formatDurationMs(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatStopReason(reason?: string): string | null {
  if (!reason) return null;
  if (reason === "end_turn") return "completed";
  return reason.replaceAll("_", " ");
}

function formatRunStatus(run: LiveRun): string {
  if (run.status === "not_dispatched") return "not dispatched";
  if (run.status === "running") return "running";
  if (run.status === "awaiting_approval") return "awaiting approval";
  if (run.status === "recovering") return "recovering";
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "failed") return "failed";
  return formatStopReason(run.stopReason) ?? "completed";
}

function formatRunError(error?: string): string | null {
  if (!error) return null;
  if (error === "Node not connected") return "node offline";
  if (error === "Node disconnected during dispatch") return "node disconnected during dispatch";
  return error;
}

function getToolState(tc: LiveToolCall): ToolState {
  if (tc.status === "cancelled") return "cancelled";
  if (tc.status === "failed" || tc.error) return "error";
  if (tc.status === "completed" || tc.completed || tc.output !== undefined) return "result";
  return "calling";
}

function getToolDurationLabel(toolCall: LiveToolCall, now: number): string | null {
  if (!toolCall.startedAt) return null;
  const end = toolCall.endedAt ?? (toolCall.completed ? undefined : now);
  if (!end) return null;
  return formatDurationMs(end - toolCall.startedAt);
}

function RunRow({ run }: { run: LiveRun }) {
  const [open, setOpen] = useState(run.isActive);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!run.isActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.isActive]);

  const toolCount = run.toolCalls.length;
  const failedToolCount = run.toolCalls.filter((tc) => tc.status === "failed" || tc.error).length;
  const cancelledToolCount = run.toolCalls.filter((tc) => tc.status === "cancelled").length;
  const completedToolCount = run.toolCalls.filter((tc) => tc.status === "completed" || tc.completed || tc.output !== undefined).length;
  const runError = formatRunError(run.error);
  const duration = useMemo(() => {
    const end = run.endedAt ?? (run.isActive ? now : undefined);
    if (!end || !run.startedAt) return null;
    return formatDurationMs(end - run.startedAt);
  }, [now, run.endedAt, run.isActive, run.startedAt]);
  const runShortId = run.runId.slice(0, 8);
  const statusLabel = formatRunStatus(run);

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
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500 tabular-nums">
              {timeFormatter.format(run.startedAt)}
            </span>
            <span
              className={cn(
                "rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                run.isActive
                  ? "border-amber-300 bg-amber-100 text-amber-700"
                  : "border-zinc-300 bg-white/70 text-zinc-600",
              )}
            >
              {statusLabel}
            </span>
            <span className="truncate font-mono text-[10px] text-zinc-400">
              #{runShortId}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-500">
            <span>
              {toolCount} tool{toolCount !== 1 ? "s" : ""}
            </span>
            <span>{completedToolCount} done</span>
            {failedToolCount > 0 && <span>{failedToolCount} failed</span>}
            {cancelledToolCount > 0 && <span>{cancelledToolCount} cancelled</span>}
            {duration && <span>{duration}</span>}
            {run.thinking && <span>reasoning</span>}
            {runError && <span className="text-rose-600">{runError}</span>}
          </div>
        </div>
        {run.isActive && (
          <span className="flex items-center gap-1.5 text-amber-600 font-semibold">
            <Loader size={10} />
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="ml-3 mt-1 flex flex-col gap-1 border-l-2 border-zinc-200 pl-3">
          <div className="mb-1 rounded border border-zinc-200 bg-[#fffdf0] px-2.5 py-2 text-[11px] text-zinc-600">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-zinc-500">run #{runShortId}</span>
              <span>started {timeFormatter.format(run.startedAt)}</span>
              {run.endedAt && <span>ended {timeFormatter.format(run.endedAt)}</span>}
              {duration && <span>duration {duration}</span>}
              <span>status {statusLabel}</span>
              {runError && <span className="text-rose-600">error {runError}</span>}
            </div>
          </div>

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
              <ToolHeader
                name={tc.name}
                state={getToolState(tc)}
                input={tc.input}
                meta={getToolDurationLabel(tc, now)}
              />
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
