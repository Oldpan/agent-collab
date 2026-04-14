import { ExternalLinkIcon, GitBranchIcon } from "lucide-react";
import type {
  WorkbenchGitDiffFile,
  WorkbenchGitDiffMode,
  WorkbenchGitStatusApiResult,
} from "@agent-collab/protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type WorkspaceDiffTabProps = {
  filePath: string;
  file: WorkbenchGitDiffFile | null;
  status: WorkbenchGitStatusApiResult | null;
  mode: WorkbenchGitDiffMode;
  loading: boolean;
  onOpenFile: () => void;
};

export function WorkspaceDiffTab({
  filePath,
  file,
  status,
  mode,
  loading,
  onOpenFile,
}: WorkspaceDiffTabProps) {
  const modeLabel = mode === "base" ? `Base${status?.baseRef ? ` · ${status.baseRef}` : ""}` : "Uncommitted";

  if (loading && !file) {
    return <div className="px-4 py-4 text-sm text-stone-600">Loading diff...</div>;
  }

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-stone-600">
        No diff is available for <span className="mx-1 font-mono text-stone-800">{filePath}</span> in this compare mode.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-[#fff9d0]">
      <div className="border-b-2 border-amber-300/80 bg-[#fffdf5] px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-5 text-stone-900 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden [overflow-wrap:anywhere]">
              {file.path}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] leading-4 text-stone-600">
              <span className={cn(
                "rounded border px-1.5 py-0.5 font-semibold uppercase",
                file.status === "added" || file.status === "untracked"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : file.status === "deleted"
                    ? "border-rose-200 bg-rose-50 text-rose-700"
                    : file.status === "renamed"
                      ? "border-sky-200 bg-sky-50 text-sky-700"
                      : "border-amber-300 bg-amber-50 text-stone-700",
              )}>
                {file.status}
              </span>
              <span className="inline-flex items-center gap-1 rounded-sm border border-[#f3a8c4] bg-[#fde3ec] px-1.5 py-0.5 text-[#93415f]">
                <GitBranchIcon className="size-3" />
                {modeLabel}
              </span>
              {file.oldPath ? (
                <span className="[overflow-wrap:anywhere]">
                  {file.oldPath} → {file.path}
                </span>
              ) : null}
            </div>
          </div>
          {!file.isDeleted ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-sm border-2 border-amber-300 bg-[#fffdf5] text-stone-800 shadow-[3px_3px_0_0_rgba(180,120,32,0.12)] hover:bg-[#fff1a9]"
              onClick={onOpenFile}
              title="Open file"
            >
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {file.hunks.length === 0 ? (
        <div className="px-4 py-4 text-sm text-stone-600">No line-level diff available for this file.</div>
      ) : (
        <div className="divide-y divide-amber-200/80">
          {file.hunks.map((hunk, index) => (
            <div key={`${file.path}:${hunk.header}:${index}`}>
              <div className="border-b border-amber-200 bg-[#fff1a9] px-4 py-2 font-mono text-[11px] text-stone-800">
                {hunk.header}
              </div>
              <div className="font-mono text-[11px]">
                {hunk.lines.map((line, lineIndex) => (
                  <div
                    key={`${file.path}:${hunk.header}:${lineIndex}`}
                    className={cn(
                      "grid min-w-max grid-cols-[56px_56px_1fr] items-start gap-0 border-b border-amber-100/80 last:border-b-0",
                      line.type === "add"
                        ? "bg-emerald-50"
                        : line.type === "remove"
                          ? "bg-rose-50"
                          : line.type === "header"
                            ? "bg-[#fde3ec] text-[#93415f]"
                            : "bg-[#fffdf5]",
                    )}
                  >
                    <div className="border-r border-amber-200 px-2 py-1 text-right text-amber-400">
                      {line.oldLineNumber ?? ""}
                    </div>
                    <div className="border-r border-amber-200 px-2 py-1 text-right text-amber-400">
                      {line.newLineNumber ?? ""}
                    </div>
                    <div className="whitespace-pre-wrap break-words px-3 py-1 text-stone-900">
                      {line.content || " "}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
