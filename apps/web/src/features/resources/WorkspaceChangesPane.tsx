import { ExternalLinkIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react";
import type {
  WorkbenchGitDiffApiResult,
  WorkbenchGitDiffMode,
  WorkbenchGitStatusApiResult,
} from "@agent-collab/protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type WorkspaceChangesPaneProps = {
  status: WorkbenchGitStatusApiResult | null;
  diff: WorkbenchGitDiffApiResult | null;
  loadingStatus: boolean;
  loadingDiff: boolean;
  diffMode: WorkbenchGitDiffMode;
  onChangeMode: (mode: WorkbenchGitDiffMode) => void;
  onRefresh: () => void;
  onOpenDiff: (path: string, mode: WorkbenchGitDiffMode) => void;
  onOpenFile: (path: string) => void;
};

export function WorkspaceChangesPane({
  status,
  diff,
  loadingStatus,
  loadingDiff,
  diffMode,
  onChangeMode,
  onRefresh,
  onOpenDiff,
  onOpenFile,
}: WorkspaceChangesPaneProps) {
  if (loadingStatus && !status) {
    return <div className="px-2 py-3 text-sm text-stone-600">Loading changes...</div>;
  }

  if (!status) {
    return <div className="px-2 py-3 text-sm text-stone-600">Git status unavailable for this root.</div>;
  }

  if (!status.isGit) {
    return <div className="px-2 py-3 text-sm text-stone-600">This project root is not a git repository.</div>;
  }

  const baseDisabled = !status.baseRef;
  const files = diff?.files ?? [];

  return (
    <div className="space-y-3">
      <div className="rounded-sm border-2 border-amber-300/90 bg-[#fffdf5] p-3 shadow-[4px_4px_0_0_rgba(180,120,32,0.12)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-stone-900">
              <GitBranchIcon className="size-4 text-stone-700" />
              <span>{status.branchName ?? "(detached)"}</span>
              <span className="rounded-sm border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-stone-700">
                {status.workspaceKind}
              </span>
              {status.baseRef ? (
              <span className="rounded-sm border border-[#f3a8c4] bg-[#fde3ec] px-1.5 py-0.5 text-[10px] text-[#93415f]">
                  base {status.baseRef}
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-[11px] text-stone-600">
              {[
                `${status.changedFiles} changed`,
                status.stagedFiles > 0 ? `${status.stagedFiles} staged` : null,
                status.unstagedFiles > 0 ? `${status.unstagedFiles} unstaged` : null,
                status.untrackedFiles > 0 ? `${status.untrackedFiles} untracked` : null,
              ].filter(Boolean).join(" · ") || "No changes"}
              {status.aheadOfOrigin > 0 || status.behindOfOrigin > 0 ? (
                <span>{` · origin +${status.aheadOfOrigin}/-${status.behindOfOrigin}`}</span>
              ) : null}
              {status.aheadBehind ? (
                <span>{` · base +${status.aheadBehind.ahead}/-${status.aheadBehind.behind}`}</span>
              ) : null}
            </div>
          </div>
          <Button
            size="icon-xs"
            variant="outline"
            className="rounded-sm border-2 border-amber-300 bg-[#fffdf5] text-stone-800 hover:bg-[#fff1a9]"
            onClick={onRefresh}
            title="Refresh changes"
          >
            <RefreshCwIcon className={cn("size-3", loadingStatus || loadingDiff ? "animate-spin" : "")} />
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={cn(
              "rounded-sm border px-2 py-1 text-[11px] font-semibold",
              diffMode === "uncommitted"
                ? "border-zinc-900 bg-[#ffd54a] text-zinc-950"
                : "border-amber-300 bg-[#fffdf5] text-stone-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => onChangeMode("uncommitted")}
          >
            Uncommitted
          </button>
          <button
            type="button"
            className={cn(
              "rounded-sm border px-2 py-1 text-[11px] font-semibold",
              diffMode === "base"
                ? "border-zinc-900 bg-[#ffd54a] text-zinc-950"
                : "border-amber-300 bg-[#fffdf5] text-stone-700 hover:bg-[#fff1a9]",
              baseDisabled ? "cursor-not-allowed opacity-50" : "",
            )}
            onClick={() => {
              if (!baseDisabled) onChangeMode("base");
            }}
            disabled={baseDisabled}
          >
            Base
          </button>
        </div>
      </div>

      {diffMode === "base" && baseDisabled ? (
        <div className="rounded-sm border-2 border-dashed border-amber-300 bg-[#fffdf5] px-3 py-4 text-xs text-stone-600">
          Base compare is unavailable because this repo does not expose a resolvable base ref yet.
        </div>
      ) : loadingDiff && !diff ? (
        <div className="px-2 py-3 text-sm text-stone-600">Loading diff...</div>
      ) : files.length === 0 ? (
        <div className="rounded-sm border-2 border-dashed border-amber-300 bg-[#fffdf5] px-3 py-4 text-center text-xs text-stone-600">
          {diffMode === "uncommitted" ? "No uncommitted changes." : "No branch diff against base."}
        </div>
      ) : (
        <div className="space-y-2">
          {files.map((file) => (
            <div
              key={`${file.path}:${file.oldPath ?? ""}`}
              className="rounded-sm border-2 border-amber-300/90 bg-[#fffdf5] px-3 py-3 shadow-[4px_4px_0_0_rgba(180,120,32,0.12)]"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <button
                    type="button"
                    className="text-left text-xs font-semibold leading-4 text-stone-900 hover:text-[#c85a83] hover:underline [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden [overflow-wrap:anywhere]"
                    onClick={() => onOpenDiff(file.path, diffMode)}
                    title={`Open diff for ${file.path}`}
                  >
                    {file.path}
                  </button>
                  {file.oldPath ? (
                    <div className="mt-1 text-[11px] leading-4 text-stone-600 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden [overflow-wrap:anywhere]">
                      {file.oldPath} → {file.path}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-start">
                  <span className={cn(
                    "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
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
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="icon-xs"
                  variant="outline"
                  className="rounded-sm border-2 border-amber-300 bg-[#fffdf5] text-stone-800 hover:bg-[#fff1a9]"
                  onClick={() => onOpenDiff(file.path, diffMode)}
                  title="Open diff"
                >
                  <GitBranchIcon className="size-3" />
                </Button>
                {!file.isDeleted ? (
                  <Button
                    size="icon-xs"
                    variant="outline"
                    className="rounded-sm border-2 border-amber-300 bg-[#fffdf5] text-stone-800 hover:bg-[#fff1a9]"
                    onClick={() => onOpenFile(file.path)}
                    title="Open file"
                  >
                    <ExternalLinkIcon className="size-3" />
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
