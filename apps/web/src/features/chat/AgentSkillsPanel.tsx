import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageResponse } from "@/components/ai-elements/message";
import type {
  AgentInfo,
  AgentSkillEntry,
  AgentSkillFileResult,
  AgentSkillListResult,
  UpdateAgentRequest,
} from "@agent-collab/protocol";
import { listAgentSkills, readAgentSkillFile } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  AlertCircleIcon,
  CopyIcon,
  FileTextIcon,
  FolderIcon,
  RefreshCwIcon,
  SaveIcon,
} from "lucide-react";

type AgentSkillsPanelProps = {
  agent: AgentInfo | null;
  isAdmin?: boolean;
  onUpdate: (req: UpdateAgentRequest) => Promise<void>;
};

export function AgentSkillsPanel({ agent, isAdmin = false, onUpdate }: AgentSkillsPanelProps) {
  const [skillRootsText, setSkillRootsText] = useState((agent?.skillRoots ?? []).join("\n"));
  const [summary, setSummary] = useState<AgentSkillListResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<AgentSkillFileResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSkillRootsText((agent?.skillRoots ?? []).join("\n"));
    setSummary(null);
    setSelectedPath(null);
    setSelectedFile(null);
    setError(null);
  }, [agent?.agentId]);

  const parsedSkillRoots = useMemo(
    () => skillRootsText.split("\n").map((line) => line.trim()).filter(Boolean),
    [skillRootsText],
  );

  const loadSummary = useCallback(async () => {
    if (!agent?.agentId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listAgentSkills(agent.agentId);
      setSummary(result);
      if (!selectedPath && result.skills.length > 0) {
        const defaultPath = result.skills[0]?.path ?? null;
        setSelectedPath(defaultPath);
        if (defaultPath) {
          const file = await readAgentSkillFile(agent.agentId, defaultPath);
          setSelectedFile(file);
        }
      }
    } catch (err) {
      setSummary(null);
      setSelectedFile(null);
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, [agent?.agentId, selectedPath]);

  useEffect(() => {
    if (!agent?.agentId || !agent.nodeId || (agent.skillRoots?.length ?? 0) === 0) return;
    if (summary || loading || error) return;
    void loadSummary();
  }, [agent?.agentId, agent?.nodeId, agent?.skillRoots, error, loadSummary, loading, summary]);

  const openDirectory = useCallback(async (directoryPath: string) => {
    if (!agent?.agentId) return;
    setLoading(true);
    setError(null);
    setSelectedPath(directoryPath);
    try {
      const result = await listAgentSkills(agent.agentId, directoryPath);
      setSummary(result);
      setSelectedFile(null);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, [agent?.agentId]);

  const openFile = useCallback(async (filePath: string) => {
    if (!agent?.agentId) return;
    setLoading(true);
    setError(null);
    setSelectedPath(filePath);
    try {
      const file = await readAgentSkillFile(agent.agentId, filePath);
      setSelectedFile(file);
    } catch (err) {
      setSelectedFile(null);
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, [agent?.agentId]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await onUpdate({ skillRoots: parsedSkillRoots });
      setSummary(null);
      setSelectedPath(null);
      setSelectedFile(null);
      await loadSummary();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setSaving(false);
    }
  }, [loadSummary, onUpdate, parsedSkillRoots]);

  const handleRefresh = useCallback(async () => {
    setSummary(null);
    setSelectedFile(null);
    setError(null);
    await loadSummary();
  }, [loadSummary]);

  const handleCopyPath = useCallback(async () => {
    if (!selectedPath) return;
    try {
      await navigator.clipboard.writeText(selectedPath);
    } catch {
      // ignore clipboard failures
    }
  }, [selectedPath]);

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

  const directoryEntries = summary?.path ? summary.entries : [];

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3 space-y-3">
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skill Roots</div>
          <textarea
            className="min-h-[92px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
            placeholder="/code/.claude/skills"
            value={skillRootsText}
            onChange={(event) => setSkillRootsText(event.target.value)}
            readOnly={!isAdmin}
          />
          <div className="text-[11px] text-muted-foreground">
            {isAdmin
              ? "One absolute path per line. These paths are resolved on the assigned node."
              : "Skill roots are read-only for non-admin users. These paths are resolved on the assigned node."}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {isAdmin && (
            <Button size="sm" onClick={handleSave} disabled={saving}>
              <SaveIcon className="mr-1 size-4" />
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={handleRefresh} disabled={loading}>
            <RefreshCwIcon className="mr-1 size-4" />
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={handleCopyPath} disabled={!selectedPath}>
            <CopyIcon className="mr-1 size-4" />
            Copy path
          </Button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {(agent.skillRoots?.length ?? 0) === 0 && parsedSkillRoots.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Configure at least one skill root to browse skills.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[360px] min-w-[300px] flex-col border-r border-border">
            <div className="border-b border-border px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Skills
            </div>
            <ScrollArea className="flex-1">
              <div className="space-y-4 p-3">
                <section className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Roots</div>
                  <div className="space-y-1">
                    {(summary?.roots ?? parsedSkillRoots).map((root) => (
                      <button
                        key={root}
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left text-xs",
                          selectedPath === root ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
                        )}
                        onClick={() => void openDirectory(root)}
                      >
                        <FolderIcon className="size-4 shrink-0" />
                        <span className="truncate font-mono">{root}</span>
                      </button>
                    ))}
                  </div>
                </section>

                {!summary?.path && (
                  <section className="space-y-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Discovered Skills</div>
                    <div className="space-y-1">
                      {(summary?.skills ?? []).map((skill) => (
                        <button
                          key={skill.path}
                          type="button"
                          className={cn(
                            "flex w-full items-start gap-2 rounded-md border px-2 py-2 text-left",
                            selectedPath === skill.path ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
                          )}
                          onClick={() => void openFile(skill.path)}
                        >
                          <FileTextIcon className="mt-0.5 size-4 shrink-0" />
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{skill.name}</div>
                            {skill.description ? (
                              <div className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</div>
                            ) : null}
                            <div className="truncate font-mono text-[11px] text-muted-foreground">{skill.path}</div>
                          </div>
                        </button>
                      ))}
                      {summary && summary.skills.length === 0 && !loading && (
                        <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                          No skills discovered under the configured roots.
                        </div>
                      )}
                    </div>
                  </section>
                )}

                {summary?.path && (
                  <section className="space-y-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Directory
                    </div>
                    <div className="rounded-md border border-border bg-muted/20 px-2 py-2 font-mono text-[11px] text-muted-foreground">
                      {summary.path}
                    </div>
                    <div className="space-y-1">
                      {directoryEntries.map((entry) => (
                        <DirectoryEntryButton
                          key={entry.path}
                          entry={entry}
                          selected={selectedPath === entry.path}
                          onOpenDirectory={openDirectory}
                          onOpenFile={openFile}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </ScrollArea>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-border px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {selectedPath ?? "Preview"}
            </div>
            <ScrollArea className="flex-1">
              <div className="p-4">
                {selectedFile ? (
                  <MessageResponse>{selectedFile.content}</MessageResponse>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    {loading ? "Loading..." : "Select a skill file to preview."}
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      )}
    </div>
  );
}

function DirectoryEntryButton({
  entry,
  selected,
  onOpenDirectory,
  onOpenFile,
}: {
  entry: AgentSkillEntry;
  selected: boolean;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const handleClick = () => {
    if (entry.kind === "directory") {
      void onOpenDirectory(entry.path);
      return;
    }
    void onOpenFile(entry.path);
  };

  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left text-sm",
        selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
      )}
      onClick={handleClick}
    >
      {entry.kind === "directory" ? <FolderIcon className="size-4 shrink-0" /> : <FileTextIcon className="size-4 shrink-0" />}
      <span className="truncate font-mono">{entry.path}</span>
    </button>
  );
}
