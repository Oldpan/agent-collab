import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageResponse } from "@/components/ai-elements/message";
import type {
  AgentInfo,
  AgentWorkspaceEntry,
  AgentWorkspaceFileResult,
} from "@agent-collab/protocol";
import { listAgentWorkspace, readAgentWorkspaceFile } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  RefreshCwIcon,
} from "lucide-react";

type AgentWorkspacePanelProps = {
  agent: AgentInfo | null;
};

type DirectoryMap = Record<string, AgentWorkspaceEntry[]>;

export function AgentWorkspacePanel({ agent }: AgentWorkspacePanelProps) {
  const [directories, setDirectories] = useState<DirectoryMap>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<AgentWorkspaceFileResult | null>(null);
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set());
  const [loadingFilePath, setLoadingFilePath] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const workspaceRoot = agent?.workspacePath ?? null;

  useEffect(() => {
    setDirectories({});
    setExpanded(new Set());
    setSelectedFilePath(null);
    setSelectedFile(null);
    setLoadingDirectories(new Set());
    setLoadingFilePath(null);
    setWorkspaceError(null);
  }, [agent?.agentId]);

  const loadDirectory = useCallback(async (relativePath: string, options?: { force?: boolean }) => {
    if (!agent?.agentId) return null;
    if (!options?.force && directories[relativePath]) return directories[relativePath];

    setWorkspaceError(null);
    setLoadingDirectories((prev) => new Set(prev).add(relativePath));
    try {
      const result = await listAgentWorkspace(agent.agentId, relativePath);
      setDirectories((prev) => ({ ...prev, [relativePath]: result.entries }));
      return result.entries;
    } catch (error) {
      setWorkspaceError(String((error as Error)?.message ?? error));
      return null;
    } finally {
      setLoadingDirectories((prev) => {
        const next = new Set(prev);
        next.delete(relativePath);
        return next;
      });
    }
  }, [agent?.agentId, directories]);

  const loadFile = useCallback(async (relativePath: string) => {
    if (!agent?.agentId) return;
    setWorkspaceError(null);
    setSelectedFilePath(relativePath);
    setLoadingFilePath(relativePath);
    try {
      const result = await readAgentWorkspaceFile(agent.agentId, relativePath);
      setSelectedFile(result);
    } catch (error) {
      setSelectedFile(null);
      setWorkspaceError(String((error as Error)?.message ?? error));
    } finally {
      setLoadingFilePath((current) => (current === relativePath ? null : current));
    }
  }, [agent?.agentId]);

  useEffect(() => {
    if (!agent?.agentId || !workspaceRoot) return;
    if (directories[""] || loadingDirectories.has("")) return;

    void loadDirectory("").then((entries) => {
      if (!entries || selectedFilePath) return;
      const memoryFile = entries.find((entry) => entry.kind === "file" && entry.name === "MEMORY.md");
      if (memoryFile) {
        void loadFile(memoryFile.path);
      }
    });
  }, [agent?.agentId, directories, loadDirectory, loadFile, loadingDirectories, selectedFilePath, workspaceRoot]);

  const rootEntries = directories[""] ?? [];
  const isRootLoading = loadingDirectories.has("");

  const handleToggleDirectory = useCallback((relativePath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(relativePath)) {
        next.delete(relativePath);
      } else {
        next.add(relativePath);
      }
      return next;
    });

    if (!directories[relativePath]) {
      void loadDirectory(relativePath);
    }
  }, [directories, loadDirectory]);

  const handleRefresh = useCallback(async () => {
    if (!agent?.agentId) return;
    setDirectories({});
    setExpanded(new Set());
    setSelectedFile(null);
    setWorkspaceError(null);
    const entries = await loadDirectory("", { force: true });
    if (selectedFilePath) {
      await loadFile(selectedFilePath);
      return;
    }
    const memoryFile = entries?.find((entry) => entry.kind === "file" && entry.name === "MEMORY.md");
    if (memoryFile) {
      await loadFile(memoryFile.path);
    }
  }, [agent?.agentId, loadDirectory, loadFile, selectedFilePath]);

  const handleCopyPath = useCallback(async () => {
    if (!workspaceRoot) return;
    try {
      await navigator.clipboard.writeText(workspaceRoot);
    } catch {
      // ignore clipboard failures
    }
  }, [workspaceRoot]);

  const previewTitle = useMemo(() => {
    if (selectedFilePath) return selectedFilePath;
    return "Select a file";
  }, [selectedFilePath]);

  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Agent info unavailable for this conversation.
      </div>
    );
  }

  if (!agent.nodeId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        This agent is not assigned to a remote node.
      </div>
    );
  }

  if (!workspaceRoot) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        This agent has no workspace configured.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">
          <span className="truncate block">{workspaceRoot}</span>
        </div>
        <Button size="icon-sm" variant="outline" title="Refresh workspace" onClick={handleRefresh}>
          <RefreshCwIcon className="size-4" />
        </Button>
        <Button size="icon-sm" variant="outline" title="Copy workspace path" onClick={handleCopyPath}>
          <CopyIcon className="size-4" />
        </Button>
      </div>

      {workspaceError && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span>{workspaceError}</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[320px] min-w-[260px] flex-col border-r border-border">
          <div className="border-b border-border px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Workspace
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2">
              {isRootLoading && rootEntries.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">Loading workspace...</div>
              ) : rootEntries.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">Workspace is empty.</div>
              ) : (
                <WorkspaceTree
                  parentPath=""
                  directories={directories}
                  expanded={expanded}
                  selectedFilePath={selectedFilePath}
                  loadingDirectories={loadingDirectories}
                  onToggleDirectory={handleToggleDirectory}
                  onSelectFile={loadFile}
                />
              )}
            </div>
          </ScrollArea>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-border px-4 py-3">
            <div className="truncate text-sm font-medium">{previewTitle}</div>
            {selectedFile && (
              <div className="mt-1 text-xs text-muted-foreground">
                {selectedFile.mimeType} · {formatBytes(selectedFile.size)}
              </div>
            )}
          </div>
          <ScrollArea className="flex-1">
            <div className="px-4 py-4">
              {loadingFilePath ? (
                <div className="text-sm text-muted-foreground">Loading file...</div>
              ) : selectedFile ? (
                selectedFile.mimeType === "text/markdown" ? (
                  <MessageResponse>{selectedFile.content}</MessageResponse>
                ) : (
                  <pre className="overflow-x-auto rounded-md bg-muted/40 p-4 font-mono text-xs leading-6">
                    {selectedFile.content}
                  </pre>
                )
              ) : (
                <div className="text-sm text-muted-foreground">
                  Select `MEMORY.md` or a note file to preview it here.
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}

type WorkspaceTreeProps = {
  parentPath: string;
  directories: DirectoryMap;
  expanded: Set<string>;
  selectedFilePath: string | null;
  loadingDirectories: Set<string>;
  onToggleDirectory: (relativePath: string) => void;
  onSelectFile: (relativePath: string) => void;
};

function WorkspaceTree({
  parentPath,
  directories,
  expanded,
  selectedFilePath,
  loadingDirectories,
  onToggleDirectory,
  onSelectFile,
}: WorkspaceTreeProps) {
  const entries = directories[parentPath] ?? [];

  return (
    <div className="space-y-0.5">
      {entries.map((entry) => {
        const isDirectory = entry.kind === "directory";
        const isExpanded = expanded.has(entry.path);
        const isSelected = selectedFilePath === entry.path;
        return (
          <div key={entry.path}>
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-accent/50",
                isSelected && "bg-accent text-accent-foreground",
              )}
              onClick={() => {
                if (isDirectory) {
                  onToggleDirectory(entry.path);
                } else {
                  onSelectFile(entry.path);
                }
              }}
            >
              {isDirectory ? (
                isExpanded ? (
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              {isDirectory ? (
                <FolderIcon className="size-4 shrink-0 text-amber-500" />
              ) : entry.name.endsWith(".md") ? (
                <FileTextIcon className="size-4 shrink-0 text-sky-600" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
            {isDirectory && isExpanded && (
              <div className="ml-4 border-l border-border/70 pl-2">
                {loadingDirectories.has(entry.path) && !directories[entry.path] ? (
                  <div className="px-2 py-1 text-xs text-muted-foreground">Loading...</div>
                ) : (
                  <WorkspaceTree
                    parentPath={entry.path}
                    directories={directories}
                    expanded={expanded}
                    selectedFilePath={selectedFilePath}
                    loadingDirectories={loadingDirectories}
                    onToggleDirectory={onToggleDirectory}
                    onSelectFile={onSelectFile}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
