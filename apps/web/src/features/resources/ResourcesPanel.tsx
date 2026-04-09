import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderSearchIcon,
  HashIcon,
  MenuIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import type {
  AgentInfo,
  ChannelInfo,
  ConversationInfo,
  CreateResourceSpaceRequest,
  MachineInfo,
  ResourceFileResult,
  ResourceSpaceInfo,
  ResourceTreeEntry,
} from "@agent-collab/protocol";
import { MessageResponse } from "@/components/ai-elements/message";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CreateDialog } from "@/components/ui/create-dialog";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { analyzeResource, listResourceTree, readResourceFile, readResourceFileBlob } from "@/lib/api";

type ResourcesPanelProps = {
  resourceSpaces: ResourceSpaceInfo[];
  channels: ChannelInfo[];
  agents: AgentInfo[];
  machines: MachineInfo[];
  isAdmin?: boolean;
  onToggleSidebar?: () => void;
  sidebarCollapsed?: boolean;
  onExitResources: () => void;
  onCreateResourceSpace: (req: CreateResourceSpaceRequest) => Promise<ResourceSpaceInfo>;
  onDeleteResourceSpace: (resourceSpaceId: string) => Promise<void>;
  onOpenConversation: (conversation: ConversationInfo) => void;
};

type DirectoryMap = Record<string, ResourceTreeEntry[]>;

const KEY_RESOURCE_FILE_NAMES = [
  "README.md",
  "summary.md",
  "metrics.json",
  "config.json",
  "results.json",
  "notes.md",
];

const IMAGE_RESOURCE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

function isImageResourcePath(resourcePath: string): boolean {
  const lowerPath = resourcePath.toLowerCase();
  return [...IMAGE_RESOURCE_EXTENSIONS].some((extension) => lowerPath.endsWith(extension));
}

function inferImageMimeType(resourcePath: string): ResourceFileResult["mimeType"] {
  const lowerPath = resourcePath.toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) return "image/jpeg";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".gif")) return "image/gif";
  return "image/svg+xml";
}

function findTreeEntryByPath(directories: DirectoryMap, resourcePath: string): ResourceTreeEntry | null {
  for (const entries of Object.values(directories)) {
    const match = entries.find((entry) => entry.path === resourcePath);
    if (match) return match;
  }
  return null;
}

function filterVisibleResourceEntries(resourcePath: string, entries: ResourceTreeEntry[]): ResourceTreeEntry[] {
  return entries.filter((entry) => {
    if (resourcePath !== "") return true;
    if (entry.kind === "file" && entry.name === "MEMORY.md") return false;
    if (entry.kind === "directory" && entry.name === "notes") return false;
    return true;
  });
}

function buildDisplayedResourcePath(resourceSpace: ResourceSpaceInfo | null, selectedFilePath: string | null): string {
  if (!resourceSpace) return "Preview";
  if (!selectedFilePath) return resourceSpace.rootPath;
  return `${resourceSpace.rootPath.replace(/\/+$/, "")}/${selectedFilePath.replace(/^\/+/, "")}`;
}

function pickDefaultPreviewEntry(
  resourceSpace: ResourceSpaceInfo,
  entries: ResourceTreeEntry[],
): ResourceTreeEntry | null {
  const preferred = KEY_RESOURCE_FILE_NAMES
    .map((name) => entries.find((entry) => entry.kind === "file" && entry.name === name))
    .find(Boolean);
  if (preferred) return preferred;

  if (resourceSpace.resourceType === "docs") {
    return entries.find(
      (entry) =>
        entry.kind === "file"
        && entry.name.toLowerCase().endsWith(".md")
        && entry.name !== "MEMORY.md",
    ) ?? null;
  }

  return null;
}

export function ResourcesPanel({
  resourceSpaces,
  channels,
  agents,
  machines,
  isAdmin = false,
  onToggleSidebar,
  sidebarCollapsed,
  onExitResources,
  onCreateResourceSpace,
  onDeleteResourceSpace,
  onOpenConversation,
}: ResourcesPanelProps) {
  const [selectedResourceSpaceId, setSelectedResourceSpaceId] = useState<string | null>(null);
  const [directories, setDirectories] = useState<DirectoryMap>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<ResourceFileResult | null>(null);
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set());
  const [loadingFilePath, setLoadingFilePath] = useState<string | null>(null);
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [question, setQuestion] = useState("");
  const [askingAgent, setAskingAgent] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deletingResourceSpace, setDeletingResourceSpace] = useState(false);
  const currentObjectUrlRef = useRef<string | null>(null);

  const selectedResourceSpace = useMemo(
    () => resourceSpaces.find((item) => item.resourceSpaceId === selectedResourceSpaceId) ?? null,
    [resourceSpaces, selectedResourceSpaceId],
  );
  const channelNameById = useMemo(
    () => new Map(channels.map((channel) => [channel.channelId, channel.name])),
    [channels],
  );
  const machineNameById = useMemo(
    () => new Map(machines.map((machine) => [machine.nodeId, machine.name])),
    [machines],
  );
  const rootEntries = directories[""] ?? [];
  const selectedFileSupportsAnalysis = selectedFile
    ? selectedFile.mimeType === "text/markdown" || selectedFile.mimeType === "text/plain"
    : false;

  useEffect(() => {
    if (resourceSpaces.length === 0) {
      setSelectedResourceSpaceId(null);
      return;
    }
    if (selectedResourceSpaceId && resourceSpaces.some((item) => item.resourceSpaceId === selectedResourceSpaceId)) {
      return;
    }
    setSelectedResourceSpaceId(resourceSpaces[0]?.resourceSpaceId ?? null);
  }, [resourceSpaces, selectedResourceSpaceId]);

  useEffect(() => {
    if (!agents.length) {
      setSelectedAgentId("");
      return;
    }
    setSelectedAgentId((current) => (current && agents.some((agent) => agent.agentId === current)
      ? current
      : agents[0]?.agentId ?? ""));
  }, [agents]);

  useEffect(() => {
    if (currentObjectUrlRef.current) {
      URL.revokeObjectURL(currentObjectUrlRef.current);
      currentObjectUrlRef.current = null;
    }
    setDirectories({});
    setExpanded(new Set());
    setSelectedFilePath(null);
    setSelectedFile(null);
    setLoadingDirectories(new Set());
    setLoadingFilePath(null);
    setSpaceError(null);
    setQuestion("");
  }, [selectedResourceSpaceId]);

  useEffect(() => {
    return () => {
      if (currentObjectUrlRef.current) {
        URL.revokeObjectURL(currentObjectUrlRef.current);
        currentObjectUrlRef.current = null;
      }
    };
  }, []);

  const loadDirectory = useCallback(async (resourceSpaceId: string, resourcePath: string, options?: { force?: boolean }) => {
    if (!options?.force && directories[resourcePath]) return directories[resourcePath];

    setSpaceError(null);
    setLoadingDirectories((prev) => new Set(prev).add(resourcePath));
    try {
      const result = await listResourceTree(resourceSpaceId, resourcePath);
      const visibleEntries = filterVisibleResourceEntries(resourcePath, result.entries);
      setDirectories((prev) => ({ ...prev, [resourcePath]: visibleEntries }));
      return visibleEntries;
    } catch (error) {
      setSpaceError(String((error as Error)?.message ?? error));
      return null;
    } finally {
      setLoadingDirectories((prev) => {
        const next = new Set(prev);
        next.delete(resourcePath);
        return next;
      });
    }
  }, [directories]);

  const loadFile = useCallback(async (resourceSpaceId: string, resourcePath: string) => {
    setSpaceError(null);
    setSelectedFilePath(resourcePath);
    setLoadingFilePath(resourcePath);
    if (currentObjectUrlRef.current) {
      URL.revokeObjectURL(currentObjectUrlRef.current);
      currentObjectUrlRef.current = null;
    }
    try {
      if (isImageResourcePath(resourcePath)) {
        const blob = await readResourceFileBlob(resourceSpaceId, resourcePath);
        const objectUrl = URL.createObjectURL(blob);
        currentObjectUrlRef.current = objectUrl;
        const entry = findTreeEntryByPath(directories, resourcePath);
        setSelectedFile({
          path: resourcePath,
          content: objectUrl,
          mimeType: (blob.type || inferImageMimeType(resourcePath)) as ResourceFileResult["mimeType"],
          size: blob.size,
          modifiedAt: entry?.modifiedAt ?? null,
        });
      } else {
        const result = await readResourceFile(resourceSpaceId, resourcePath);
        setSelectedFile(result);
      }
    } catch (error) {
      setSelectedFile(null);
      setSpaceError(String((error as Error)?.message ?? error));
    } finally {
      setLoadingFilePath((current) => (current === resourcePath ? null : current));
    }
  }, [directories]);

  useEffect(() => {
    if (!selectedResourceSpace) return;
    if (directories[""] || loadingDirectories.has("")) return;

    void loadDirectory(selectedResourceSpace.resourceSpaceId, "").then((entries) => {
      if (!entries || selectedFilePath) return;
      const nextFile = pickDefaultPreviewEntry(selectedResourceSpace, entries);
      if (nextFile) {
        void loadFile(selectedResourceSpace.resourceSpaceId, nextFile.path);
      }
    });
  }, [directories, loadDirectory, loadFile, loadingDirectories, selectedFilePath, selectedResourceSpace]);

  const handleToggleDirectory = useCallback((resourcePath: string) => {
    if (!selectedResourceSpace) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(resourcePath)) {
        next.delete(resourcePath);
      } else {
        next.add(resourcePath);
      }
      return next;
    });
    if (!directories[resourcePath]) {
      void loadDirectory(selectedResourceSpace.resourceSpaceId, resourcePath);
    }
  }, [directories, loadDirectory, selectedResourceSpace]);

  const handleRefresh = useCallback(async () => {
    if (!selectedResourceSpace) return;
    if (currentObjectUrlRef.current) {
      URL.revokeObjectURL(currentObjectUrlRef.current);
      currentObjectUrlRef.current = null;
    }
    setDirectories({});
    setExpanded(new Set());
    setSelectedFile(null);
    setSpaceError(null);
    const entries = await loadDirectory(selectedResourceSpace.resourceSpaceId, "", { force: true });
    if (selectedFilePath) {
      await loadFile(selectedResourceSpace.resourceSpaceId, selectedFilePath);
      return;
    }
    const nextFile = entries ? pickDefaultPreviewEntry(selectedResourceSpace, entries) : null;
    if (nextFile) {
      await loadFile(selectedResourceSpace.resourceSpaceId, nextFile.path);
    }
  }, [loadDirectory, loadFile, selectedFilePath, selectedResourceSpace]);

  const suggestedEntries = useMemo(() => {
    return KEY_RESOURCE_FILE_NAMES
      .map((name) => rootEntries.find((entry) => entry.kind === "file" && entry.name === name))
      .filter((entry): entry is ResourceTreeEntry => Boolean(entry));
  }, [rootEntries]);

  const handleAnalyze = useCallback(async () => {
    if (!selectedResourceSpace || !selectedFilePath || !selectedAgentId || !question.trim() || askingAgent) return;
    setAskingAgent(true);
    setSpaceError(null);
    try {
      const result = await analyzeResource(selectedResourceSpace.resourceSpaceId, {
        agentId: selectedAgentId,
        question: question.trim(),
        path: selectedFilePath,
      });
      onOpenConversation(result.conversation);
    } catch (error) {
      setSpaceError(String((error as Error)?.message ?? error));
    } finally {
      setAskingAgent(false);
    }
  }, [askingAgent, onOpenConversation, question, selectedAgentId, selectedFilePath, selectedResourceSpace]);

  const handleDeleteResourceSpace = useCallback(async () => {
    if (!selectedResourceSpace || deletingResourceSpace) return;
    setDeletingResourceSpace(true);
    setSpaceError(null);
    try {
      await onDeleteResourceSpace(selectedResourceSpace.resourceSpaceId);
      setShowDeleteDialog(false);
    } catch (error) {
      setSpaceError(String((error as Error)?.message ?? error));
    } finally {
      setDeletingResourceSpace(false);
    }
  }, [deletingResourceSpace, onDeleteResourceSpace, selectedResourceSpace]);

  return (
    <div className="flex h-full flex-col bg-[#fff9d0]">
      <div className="border-b-2 border-black bg-[#fffdf5] px-4 py-3 shadow-[0_2px_0_0_rgba(0,0,0,0.1)]">
        <div className="flex items-center gap-3">
          {onToggleSidebar ? (
            <button
              type="button"
              className="shrink-0 rounded-md border-2 border-zinc-900 bg-[#fff9d8] p-1 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#fff1a9] cursor-pointer"
              onClick={onToggleSidebar}
              title={typeof sidebarCollapsed === "boolean"
                ? (sidebarCollapsed ? "Show sidebar" : "Hide sidebar")
                : "Open sidebar"}
              aria-label={typeof sidebarCollapsed === "boolean"
                ? (sidebarCollapsed ? "Show sidebar" : "Hide sidebar")
                : "Open sidebar"}
            >
              <MenuIcon className="size-4 text-zinc-700" />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FolderSearchIcon className="size-4 shrink-0 text-zinc-600" />
              <h2 className="truncate text-sm font-semibold tracking-tight text-zinc-950">Resources</h2>
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              Browse shared docs and experiment outputs, then ask an agent to analyze the current file.
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-sm border-2 border-zinc-900 bg-[#fffdf4] text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#fff1a9]"
            onClick={onExitResources}
          >
            <ArrowLeftIcon className="mr-1.5 size-3" />
            Exit Resources
          </Button>
          {isAdmin ? (
            <div className="flex items-center gap-2">
              {selectedResourceSpace ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 rounded-sm border-2 border-red-700 bg-[#fff2ea] text-red-700 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#ffe0d1]"
                  onClick={() => setShowDeleteDialog(true)}
                >
                  <Trash2Icon className="mr-1.5 size-3" />
                  Delete Space
                </Button>
              ) : null}
              <Button
                size="sm"
                className="h-8 rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
                onClick={() => setShowCreateDialog(true)}
              >
                <PlusIcon className="mr-1.5 size-3" />
                New Space
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {spaceError ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {spaceError}
        </div>
      ) : null}

      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId="resources-layout"
        className="min-h-0 flex-1"
      >
        <ResizablePanel defaultSize={24} minSize={18} maxSize={34}>
          <div className="flex h-full min-h-0 flex-col bg-[#fff5c2]">
            <ResizablePanelGroup
              direction="vertical"
              autoSaveId="resources-left-stack"
              className="min-h-0 flex-1"
            >
              <ResizablePanel defaultSize={36} minSize={18} maxSize={72}>
                <div className="flex h-full min-h-0 flex-col">
                  <div className="border-b border-zinc-300 px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                    Resource Spaces
                  </div>
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="p-2">
                      {resourceSpaces.length === 0 ? (
                        <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fffdf4] px-3 py-4 text-center text-xs text-zinc-500">
                          No resource spaces yet.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {resourceSpaces.map((resourceSpace) => (
                            <button
                              key={resourceSpace.resourceSpaceId}
                              type="button"
                              onClick={() => {
                                setSelectedFilePath(null);
                                setSelectedFile(null);
                                setSpaceError(null);
                                setSelectedResourceSpaceId(resourceSpace.resourceSpaceId);
                              }}
                              className={cn(
                                "w-full rounded-md border-2 border-zinc-900 px-3 py-2 text-left shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] transition-colors",
                                selectedResourceSpaceId === resourceSpace.resourceSpaceId
                                  ? "bg-[#ffd54a]"
                                  : "bg-[#fffdf4] hover:bg-[#fff1a9]",
                              )}
                            >
                              <div className="truncate text-xs font-semibold text-zinc-900">{resourceSpace.name}</div>
                              <div className="mt-1 flex flex-wrap gap-1">
                                <span className="rounded border border-zinc-400 bg-white/80 px-1.5 py-0.5 text-[10px] text-zinc-600">
                                  {resourceSpace.resourceType}
                                </span>
                                <span className="rounded border border-zinc-400 bg-white/80 px-1.5 py-0.5 text-[10px] text-zinc-600">
                                  {resourceSpace.backendType}
                                </span>
                              </div>
                              {resourceSpace.channelId ? (
                                <div className="mt-1 text-[10px] text-zinc-500">
                                  Related channel: #{channelNameById.get(resourceSpace.channelId) ?? resourceSpace.channelId}
                                </div>
                              ) : null}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </ResizablePanel>

              <ResizableHandle withHandle showHandleOnHover />

              <ResizablePanel defaultSize={64} minSize={28}>
                <div className="flex h-full min-h-0 flex-col">
                  <div className="border-b border-zinc-300 px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                    Files
                  </div>
                  <div className="flex items-center gap-2 border-b border-zinc-300 px-3 py-2 text-xs text-zinc-600">
                    <div className="min-w-0 flex-1 truncate">
                      {selectedResourceSpace ? selectedResourceSpace.rootPath : "Select a resource space"}
                    </div>
                    <Button
                      size="icon-xs"
                      variant="outline"
                      className="rounded-sm border-2 border-zinc-900 bg-[#fffdf4] hover:bg-[#fff1a9]"
                      onClick={() => void handleRefresh()}
                      disabled={!selectedResourceSpace}
                      title="Refresh"
                    >
                      <RefreshCwIcon className="size-3" />
                    </Button>
                  </div>
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="p-2">
                      {!selectedResourceSpace ? (
                        <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fffdf4] px-3 py-4 text-center text-xs text-zinc-500">
                          Choose a resource space first.
                        </div>
                      ) : loadingDirectories.has("") && rootEntries.length === 0 ? (
                        <div className="px-2 py-3 text-sm text-muted-foreground">Loading files...</div>
                      ) : rootEntries.length === 0 ? (
                        <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fffdf4] px-3 py-4 text-center text-xs text-zinc-500">
                          This resource space is empty.
                        </div>
                      ) : (
                        <ResourceTree
                          parentPath=""
                          directories={directories}
                          expanded={expanded}
                          selectedFilePath={selectedFilePath}
                          loadingDirectories={loadingDirectories}
                          onToggleDirectory={handleToggleDirectory}
                          onSelectFile={(resourcePath) => {
                            if (!selectedResourceSpace) return;
                            void loadFile(selectedResourceSpace.resourceSpaceId, resourcePath);
                          }}
                        />
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle showHandleOnHover />

        <ResizablePanel defaultSize={51} minSize={32}>
          <div className="flex h-full min-h-0 flex-col bg-[#fffdf4]">
            <div className="border-b border-zinc-300 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-900">
                    {buildDisplayedResourcePath(selectedResourceSpace, selectedFilePath)}
                  </div>
                  {selectedResourceSpace ? (
                    <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                      <span>{selectedResourceSpace.resourceType}</span>
                      <span>{selectedResourceSpace.backendType}</span>
                      {selectedResourceSpace.nodeId ? (
                        <span>Node: {machineNameById.get(selectedResourceSpace.nodeId) ?? selectedResourceSpace.nodeId}</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {suggestedEntries.length > 0 && selectedResourceSpace ? (
                  <div className="hidden max-w-[50%] flex-wrap justify-end gap-1 md:flex">
                    {suggestedEntries.map((entry) => (
                      <Button
                        key={entry.path}
                        size="sm"
                        variant="outline"
                        className="h-7 rounded-sm border-2 border-zinc-900 bg-[#fff9d8] px-2 text-[10px] text-zinc-700 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#fff1a9]"
                        onClick={() => void loadFile(selectedResourceSpace.resourceSpaceId, entry.path)}
                      >
                        {entry.name}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <ScrollArea className="flex-1">
              <div className="px-4 py-4">
                {loadingFilePath ? (
                  <div className="text-sm text-zinc-500">Loading file...</div>
                ) : selectedFile ? (
                  selectedFile.mimeType === "text/markdown" ? (
                    <MessageResponse>{selectedFile.content}</MessageResponse>
                  ) : selectedFile.mimeType.startsWith("image/") ? (
                    <div className="flex justify-center rounded-md border border-zinc-300 bg-white p-3">
                      <img
                        src={selectedFile.content}
                        alt={selectedFilePath ?? "resource image"}
                        className="max-h-[70vh] max-w-full rounded object-contain"
                      />
                    </div>
                  ) : (
                    <pre className="overflow-x-auto rounded-md border border-zinc-300 bg-white p-4 font-mono text-xs leading-6 text-zinc-800">
                      {selectedFile.content}
                    </pre>
                  )
                ) : (
                  <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fff8d8] px-4 py-6 text-center text-sm text-zinc-500">
                    Select a markdown, metrics, config, or log file to preview it here.
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle showHandleOnHover />

        <ResizablePanel defaultSize={25} minSize={20} maxSize={36}>
          <div className="flex h-full min-h-0 flex-col bg-[#fff5c2]">
            <div className="border-b border-zinc-300 px-4 py-3">
              <div className="flex items-center gap-2">
                <BotIcon className="size-4 text-zinc-700" />
                <div className="text-sm font-semibold text-zinc-900">Ask Agent</div>
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">
                Start a private analysis thread based on the current file.
              </div>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-3 px-4 py-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                    Agent
                  </label>
                  <select
                    className="w-full rounded-sm border-2 border-zinc-900 bg-white px-2 py-2 text-sm text-zinc-900"
                    value={selectedAgentId}
                    onChange={(event) => setSelectedAgentId(event.target.value)}
                  >
                    {agents.map((agent) => (
                      <option key={agent.agentId} value={agent.agentId}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                    Current file
                  </label>
                <div className="rounded-sm border-2 border-zinc-900 bg-white px-2 py-2 text-xs text-zinc-600">
                  {selectedFilePath ?? "Select a file first"}
                </div>
                {selectedFile && !selectedFileSupportsAnalysis ? (
                  <div className="text-[11px] text-zinc-500">
                    Image files can be previewed here, but `Analyze` currently only supports text files.
                  </div>
                ) : null}
              </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                    Question
                  </label>
                  <textarea
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    className="min-h-[160px] w-full resize-none rounded-sm border-2 border-zinc-900 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400"
                    placeholder="Ask the agent to summarize, review, compare results, diagnose an experiment, or propose next steps."
                  />
                </div>

                <Button
                  className="w-full rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
                  onClick={() => void handleAnalyze()}
                  disabled={!selectedResourceSpace || !selectedFilePath || !selectedAgentId || !question.trim() || askingAgent || !selectedFileSupportsAnalysis}
                >
                  <SendIcon className="mr-1.5 size-4" />
                  {askingAgent ? "Sending..." : "Analyze In Private Thread"}
                </Button>
              </div>
            </ScrollArea>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <CreateDialog
        isOpen={showCreateDialog}
        title="New Resource Space"
        onClose={() => setShowCreateDialog(false)}
      >
        <ResourceSpaceCreatePanel
          channels={channels}
          machines={machines}
          onClose={() => setShowCreateDialog(false)}
          onCreate={async (req) => {
            const resourceSpace = await onCreateResourceSpace(req);
            setSelectedResourceSpaceId(resourceSpace.resourceSpaceId);
            setShowCreateDialog(false);
            return resourceSpace;
          }}
        />
      </CreateDialog>

      <ConfirmDialog
        isOpen={showDeleteDialog}
        title="Delete Resource Space"
        message={selectedResourceSpace
          ? `Delete resource space "${selectedResourceSpace.name}"?\n\nThis only removes the resource-space entry from the platform. Files under ${selectedResourceSpace.rootPath} will stay on disk.`
          : "Delete this resource space?"}
        confirmText={deletingResourceSpace ? "Deleting..." : "Delete Space"}
        cancelText="Cancel"
        variant="danger"
        onCancel={() => {
          if (!deletingResourceSpace) {
            setShowDeleteDialog(false);
          }
        }}
        onConfirm={() => void handleDeleteResourceSpace()}
      />
    </div>
  );
}

type ResourceTreeProps = {
  parentPath: string;
  directories: DirectoryMap;
  expanded: Set<string>;
  selectedFilePath: string | null;
  loadingDirectories: Set<string>;
  onToggleDirectory: (resourcePath: string) => void;
  onSelectFile: (resourcePath: string) => void;
};

function ResourceTree({
  parentPath,
  directories,
  expanded,
  selectedFilePath,
  loadingDirectories,
  onToggleDirectory,
  onSelectFile,
}: ResourceTreeProps) {
  const entries = directories[parentPath] ?? [];

  return (
    <div className="space-y-1">
      {entries.map((entry) => {
        const isDirectory = entry.kind === "directory";
        const isExpanded = expanded.has(entry.path);
        const isSelected = !isDirectory && selectedFilePath === entry.path;
        return (
          <div key={entry.path}>
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors",
                isSelected ? "bg-[#ffd54a]" : "hover:bg-[#fff1a9]",
              )}
              onClick={() => {
                if (isDirectory) {
                  onToggleDirectory(entry.path);
                  return;
                }
                onSelectFile(entry.path);
              }}
            >
              {isDirectory ? (
                isExpanded ? <ChevronDownIcon className="size-3 shrink-0 text-zinc-500" /> : <ChevronRightIcon className="size-3 shrink-0 text-zinc-500" />
              ) : (
                <span className="size-3 shrink-0" />
              )}
              {isDirectory ? (
                <FolderIcon className="size-3.5 shrink-0 text-zinc-600" />
              ) : entry.name.toLowerCase().endsWith(".md") ? (
                <FileTextIcon className="size-3.5 shrink-0 text-zinc-600" />
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-zinc-600" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
            {isDirectory && isExpanded ? (
              <div className="ml-2.5 border-l border-zinc-300 pl-1.5">
                {loadingDirectories.has(entry.path) && !(directories[entry.path]?.length) ? (
                  <div className="px-2 py-1 text-[11px] text-zinc-500">Loading...</div>
                ) : (
                  <ResourceTree
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
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

type ResourceSpaceCreatePanelProps = {
  channels: ChannelInfo[];
  machines: MachineInfo[];
  onClose: () => void;
  onCreate: (req: CreateResourceSpaceRequest) => Promise<ResourceSpaceInfo>;
};

function ResourceSpaceCreatePanel({
  channels,
  machines,
  onClose,
  onCreate,
}: ResourceSpaceCreatePanelProps) {
  const [name, setName] = useState("");
  const [resourceType, setResourceType] = useState<ResourceSpaceInfo["resourceType"]>("docs");
  const [backendType, setBackendType] = useState<ResourceSpaceInfo["backendType"]>("shared_mount");
  const [nodeId, setNodeId] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [channelId, setChannelId] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    if (!name.trim() || !rootPath.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        resourceType,
        backendType,
        rootPath: rootPath.trim(),
        ...(nodeId.trim() ? { nodeId: nodeId.trim() } : {}),
        ...(channelId ? { channelId } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setCreating(false);
    }
  }, [backendType, channelId, description, name, nodeId, onCreate, resourceType, rootPath]);

  return (
    <div className="space-y-3">
      {error ? (
        <div className="rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      ) : null}

      <div className="space-y-1">
        <label className="text-[10px] text-zinc-500">Name</label>
        <div className="flex items-center gap-1 rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1">
          <FolderIcon className="size-3 text-zinc-500" />
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full bg-transparent text-xs outline-none placeholder:text-zinc-400"
            placeholder="shared-docs"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-[10px] text-zinc-500">Resource Type</label>
          <select
            className="w-full rounded-sm border-2 border-zinc-900 bg-white px-2 py-2 text-xs"
            value={resourceType}
            onChange={(event) => setResourceType(event.target.value as ResourceSpaceInfo["resourceType"])}
          >
            <option value="docs">docs</option>
            <option value="experiments">experiments</option>
            <option value="mixed">mixed</option>
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] text-zinc-500">Backend</label>
          <select
            className="w-full rounded-sm border-2 border-zinc-900 bg-white px-2 py-2 text-xs"
            value={backendType}
            onChange={(event) => setBackendType(event.target.value as ResourceSpaceInfo["backendType"])}
          >
            <option value="shared_mount">shared_mount</option>
            <option value="node_path">node_path</option>
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] text-zinc-500">
          {backendType === "node_path" ? "Node" : "Preferred Node (optional)"}
        </label>
        <select
          className="w-full rounded-sm border-2 border-zinc-900 bg-white px-2 py-2 text-xs"
          value={nodeId}
          onChange={(event) => setNodeId(event.target.value)}
        >
          <option value="">{backendType === "node_path" ? "Select a node" : "Auto-select any online node"}</option>
          {machines.map((machine) => (
            <option key={machine.nodeId} value={machine.nodeId}>
              {machine.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] text-zinc-500">Root Path</label>
        <input
          value={rootPath}
          onChange={(event) => setRootPath(event.target.value)}
          className="w-full rounded-sm border-2 border-zinc-900 bg-white px-2 py-2 text-xs outline-none"
          placeholder="/shared/docs"
        />
      </div>

      <div className="space-y-1">
        <label className="text-[10px] text-zinc-500">Related Channel (optional)</label>
        <div className="flex items-center gap-1 rounded-sm border-2 border-zinc-900 bg-white px-1.5 py-1">
          <HashIcon className="size-3 text-zinc-500" />
          <select
            className="w-full bg-transparent text-xs outline-none"
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
          >
            <option value="">No related channel</option>
            {channels.map((channel) => (
              <option key={channel.channelId} value={channel.channelId}>
                #{channel.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] text-zinc-500">Description</label>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="min-h-[72px] w-full resize-none rounded-sm border-2 border-zinc-900 bg-white px-2 py-2 text-xs outline-none"
          placeholder="What this resource space is for..."
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
          onClick={() => void handleCreate()}
          disabled={creating || !name.trim() || !rootPath.trim() || (backendType === "node_path" && !nodeId.trim())}
        >
          {creating ? "Creating..." : "Create"}
        </Button>
      </div>
    </div>
  );
}
