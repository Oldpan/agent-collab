import { useEffect, useMemo, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Loader } from "@/components/ai-elements/loader";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getCodexConversationDebug,
  type CodexConversationDebug,
  type CodexPlatformInput,
  type CodexDebugRollout,
  type CodexDebugTurn,
} from "@/lib/api";

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function DebugBlock({ title, text }: { title: string; text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="rounded border border-zinc-200 bg-[#fffdf0] px-3 py-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{title}</div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-zinc-700">{text}</pre>
    </div>
  );
}

function FoldedDebugBlock({
  title,
  text,
  defaultOpen = false,
}: {
  title: string;
  text: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!text.trim()) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded border border-sky-200 bg-white px-3 py-2 text-left hover:bg-sky-100/60">
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-sky-800">{title}</div>
          {!open ? <div className="mt-1 text-[11px] text-sky-700">{text.length} chars</div> : null}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <DebugBlock title={title} text={text} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function PlatformInputSection({ input }: { input: CodexPlatformInput }) {
  const startedAt = Number.isNaN(Date.parse(String(input.startedAt)))
    ? String(input.startedAt)
    : timeFormatter.format(input.startedAt);
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded border border-sky-300 bg-sky-50 px-3 py-2 text-left hover:bg-sky-100/60">
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-sky-800">
            <span className="font-semibold">Platform Input</span>
            <span className="rounded border border-sky-300 bg-white px-1.5 py-0.5 normal-case">
              {input.source === "exact_snapshot" ? "Exact snapshot" : "Reconstructed"}
            </span>
            <span className="rounded border border-sky-300 bg-white px-1.5 py-0.5 normal-case">
              run {input.runId.slice(0, 8)}
            </span>
            <span className="normal-case">{startedAt}</span>
          </div>
          {input.dispatchMode ? (
            <div className="mt-1 text-[11px] text-sky-900">
              dispatch {input.dispatchMode}
              {input.isFreshSession != null ? ` · ${input.isFreshSession ? "fresh session" : "warm session"}` : ""}
            </div>
          ) : null}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <div className="space-y-2 rounded border border-sky-300 bg-sky-50 px-3 py-2">
          {input.acpSessionId ? (
            <div className="font-mono text-[11px] text-sky-900">acp_session_id: {input.acpSessionId}</div>
          ) : null}
          {input.isFreshSession === false ? (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              Warm session: this run reused an existing ACP session. The platform system prompt shown here was held on that
              session and was not retransmitted as a new turn input.
            </div>
          ) : null}
          {input.systemPromptText ? <DebugBlock title="Platform System Prompt" text={input.systemPromptText} /> : null}
          {input.contextText ? <DebugBlock title="Platform Context Text" text={input.contextText} /> : null}
          <FoldedDebugBlock title="Platform Prompt Text" text={input.promptText} />
          {input.dispatchedPromptText ? (
            <FoldedDebugBlock title="Platform Dispatched Prompt" text={input.dispatchedPromptText} />
          ) : null}
          {input.error ? (
            <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-[11px] text-red-700">
              run error: {input.error}
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TurnCard({ turn }: { turn: CodexDebugTurn }) {
  const [open, setOpen] = useState(false);
  const timestampLabel = useMemo(() => {
    const parsed = Date.parse(turn.timestamp);
    return Number.isNaN(parsed) ? turn.timestamp : timeFormatter.format(parsed);
  }, [turn.timestamp]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-left text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.06)] hover:bg-zinc-50"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[10px] text-zinc-500">codex turn #{turn.turnId.slice(0, 8)}</span>
            <span className="text-zinc-600">{timestampLabel}</span>
            {turn.replyTarget ? <span className="rounded border border-zinc-300 bg-[#fff8d8] px-1.5 py-0.5 text-[10px] text-zinc-600">{turn.replyTarget}</span> : null}
            {turn.functionCalls.length > 0 ? <span className="text-zinc-500">{turn.functionCalls.length} call{turn.functionCalls.length !== 1 ? "s" : ""}</span> : null}
            {turn.tokenUsage?.totalTokens ? <span className="text-zinc-500">{turn.tokenUsage.totalTokens} tokens</span> : null}
          </div>
          {turn.triggerTarget ? (
            <div className="mt-1 text-[11px] text-zinc-500">trigger target {turn.triggerTarget}</div>
          ) : null}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 space-y-2 pl-5">
          {turn.platformInput ? <PlatformInputSection input={turn.platformInput} /> : null}
          {turn.combinedUserMessage ? (
            <DebugBlock title="Combined User Message" text={turn.combinedUserMessage} />
          ) : null}
          {turn.inputBlocks.map((block, index) => (
            <FoldedDebugBlock
              key={`${turn.turnId}-input-${index}`}
              title={`Codex Input Block ${index + 1} · ${block.length} chars`}
              text={block}
            />
          ))}
          {turn.functionCalls.length > 0 ? (
            <div className="space-y-2 rounded border border-zinc-200 bg-[#fffdf0] px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Function Calls</div>
              {turn.functionCalls.map((call) => (
                <div key={call.callId} className="rounded border border-zinc-200 bg-white px-2.5 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                    <span className="font-medium text-zinc-700">{call.name}</span>
                    <span className="font-mono">{call.callId.slice(0, 8)}</span>
                    <span>{timeFormatter.format(Date.parse(call.timestamp))}</span>
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-zinc-700">{call.arguments}</pre>
                  {call.output ? (
                    <pre className="mt-2 whitespace-pre-wrap break-words rounded border border-zinc-200 bg-[#fff9d8] p-2 font-mono text-[11px] leading-5 text-zinc-700">{call.output}</pre>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {turn.assistantOutputs.map((output, index) => (
            <DebugBlock
              key={`${turn.turnId}-assistant-${index}`}
              title={`Assistant Output${output.phase ? ` · ${output.phase}` : ""}`}
              text={output.text}
            />
          ))}
          {turn.reasoningSummaries.length > 0 ? (
            <DebugBlock title="Reasoning Summary" text={turn.reasoningSummaries.join("\n")} />
          ) : null}
          {turn.hasEncryptedReasoning ? (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Codex recorded encrypted reasoning for this turn. Raw reasoning text is not available from the transcript.
            </div>
          ) : null}
          {turn.tokenUsage ? (
            <div className="rounded border border-zinc-200 bg-[#fffdf0] px-3 py-2 text-[11px] text-zinc-600">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Token Usage</div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {turn.tokenUsage.inputTokens != null ? <span>input {turn.tokenUsage.inputTokens}</span> : null}
                {turn.tokenUsage.cachedInputTokens != null ? <span>cached {turn.tokenUsage.cachedInputTokens}</span> : null}
                {turn.tokenUsage.outputTokens != null ? <span>output {turn.tokenUsage.outputTokens}</span> : null}
                {turn.tokenUsage.reasoningOutputTokens != null ? <span>reasoning {turn.tokenUsage.reasoningOutputTokens}</span> : null}
                {turn.tokenUsage.totalTokens != null ? <span>total {turn.tokenUsage.totalTokens}</span> : null}
                {turn.tokenUsage.modelContextWindow != null ? <span>window {turn.tokenUsage.modelContextWindow}</span> : null}
              </div>
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PlatformOnlyCard({ input }: { input: CodexPlatformInput }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-left text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.06)] hover:bg-sky-100"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[10px] text-zinc-500">run {input.runId.slice(0, 8)}</span>
            <span className="text-zinc-600">
              {Number.isNaN(Date.parse(String(input.startedAt))) ? String(input.startedAt) : timeFormatter.format(input.startedAt)}
            </span>
            <span className="rounded border border-sky-300 bg-white px-1.5 py-0.5 text-[10px] text-sky-800">
              {input.source === "exact_snapshot" ? "Exact snapshot" : "Reconstructed"}
            </span>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 pl-5">
          <PlatformInputSection input={input} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RolloutCard({ rollout }: { rollout: CodexDebugRollout }) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 rounded-md border-2 border-zinc-900 bg-[#fff7c7] px-3 py-2 text-left text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#fff1a9]"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[11px] text-zinc-700">{rollout.path}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-500">
            {rollout.sessionId ? <span>codex session_meta.id {rollout.sessionId.slice(0, 8)}</span> : null}
            {rollout.cwd ? <span className="truncate">cwd {rollout.cwd}</span> : null}
            <span>{rollout.turns.length} matched turn{rollout.turns.length !== 1 ? "s" : ""}</span>
            <span>{rollout.size} bytes</span>
          </div>
        </div>
      </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 space-y-3 pl-5">
          {rollout.baseInstructions ? <FoldedDebugBlock title="Codex Base Instructions" text={rollout.baseInstructions} /> : null}
          {rollout.preludeDeveloperMessages.map((text, index) => (
            <FoldedDebugBlock
              key={`${rollout.path}-dev-${index}`}
              title={`Prelude Developer Message ${index + 1}`}
              text={text}
            />
          ))}
          {rollout.preludeUserMessages.map((text, index) => (
            <FoldedDebugBlock
              key={`${rollout.path}-user-${index}`}
              title={`Prelude User Message ${index + 1}`}
              text={text}
            />
          ))}
          {rollout.turns.map((turn) => (
            <TurnCard key={`${rollout.path}-${turn.turnId}`} turn={turn} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function CodexDebugPanel({
  conversationId,
}: {
  conversationId: string;
}) {
  const [data, setData] = useState<CodexConversationDebug | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    getCodexConversationDebug(conversationId)
      .then((result) => {
        if (cancelled) return;
        setData(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String((err as Error)?.message ?? err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-zinc-600">
        <Loader size={12} />
        Loading Codex transcript debug view...
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}
      </div>
    );
  }

  if (!data || (data.rollouts.length === 0 && data.unmatchedPlatformInputs.length === 0)) {
    return (
      <div className="m-4 rounded border border-zinc-200 bg-white/70 px-3 py-2 text-sm text-zinc-600">
        No Codex transcript matched this conversation.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="mb-3 rounded border border-zinc-300 bg-white/70 px-3 py-2 text-xs text-zinc-600">
        <div className="font-medium text-zinc-800">Codex transcript only</div>
        <div className="mt-1">
          {data.matchMode === "acp_session_id"
            ? "Matched by exact ACP session id, then exact reply target."
            : "Matched by exact workspace path and exact reply target."}
        </div>
        <div className="mt-1 font-mono">reply_target: {data.replyTarget}</div>
        {data.acpSessionId ? <div className="mt-1 font-mono">platform acp_session_id: {data.acpSessionId}</div> : null}
        {data.sessionMatchMissed ? (
          <div className="mt-1 text-amber-700">
            No transcript matched the current ACP session id, so this view fell back to heuristic matching and sorts the newest history first.
          </div>
        ) : null}
        {data.matchMode === "heuristic" && !data.sessionMatchMissed ? (
          <div className="mt-1 text-amber-700">Current ACP session id is unavailable, so this view fell back to heuristic matching.</div>
        ) : null}
        {data.truncated ? <div className="mt-1 text-amber-700">Transcript file listing was truncated to the newest files.</div> : null}
      </div>
      <div className="mb-3 rounded border border-sky-300 bg-sky-50/70 px-3 py-2 text-xs text-sky-900">
        <div className="font-medium">Field guide</div>
        <div className="mt-1">
          <span className="font-medium">platform acp_session_id</span>: the session id our platform saved for the live ACP/Codex session.
        </div>
        <div className="mt-1">
          <span className="font-medium">codex session_meta.id</span>: the session id recorded inside the Codex rollout JSONL. We match these when possible.
        </div>
        <div className="mt-1">
          <span className="font-medium">codex turn #xxxxxxxx</span>: the Codex transcript turn id, not our platform run id.
        </div>
        <div className="mt-1">
          <span className="font-medium">Platform System Prompt</span>: the platform-level system prompt held on the ACP session. On warm-session runs it may be shown here even though it was not retransmitted in this turn.
        </div>
        <div className="mt-1">
          <span className="font-medium">Platform Context Text</span>: background context the platform prepends for this turn, such as memory, replay, recent messages, unread summary, or history cursor.
        </div>
        <div className="mt-1">
          <span className="font-medium">Platform Prompt Text</span>: the platform-side business prompt before the final reply-contract wrapper.
        </div>
        <div className="mt-1">
          <span className="font-medium">Platform Dispatched Prompt</span>: the final prompt block the platform sent to runtime, usually reply contract plus Platform Prompt Text.
        </div>
        <div className="mt-1">
          <span className="font-medium">Codex Input Block</span>: the actual ordered input blocks Codex received in that turn. Multiple blocks usually mean one turn with separate context and prompt blocks, not multiple sends.
        </div>
        <div className="mt-1">
          <span className="font-medium">Combined User Message</span>: Codex transcript&apos;s merged view of the user-side blocks for that turn. It is a log view, not an extra injected prompt.
        </div>
      </div>
      <div className="space-y-3">
        {data.rollouts.map((rollout) => (
          <RolloutCard key={rollout.path} rollout={rollout} />
        ))}
        {data.unmatchedPlatformInputs.length > 0 ? (
          <div className="rounded border border-sky-300 bg-sky-50/50 px-3 py-3">
            <div className="mb-2 text-xs font-medium text-sky-900">Unmatched Platform Inputs</div>
            <div className="space-y-2">
              {data.unmatchedPlatformInputs.map((input) => (
                <PlatformOnlyCard key={input.runId} input={input} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
