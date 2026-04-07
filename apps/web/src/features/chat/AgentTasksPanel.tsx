import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentInfo, ConversationInfo, TaskInfo } from "@agent-collab/protocol";
import { Button } from "@/components/ui/button";
import {
  getConversationTasks,
  getAgentTasks,
  type AgentTask,
  unclaimAgentDmTask,
  updateAgentDmTask,
  updateAgentDmTaskStatus,
  unclaimChannelTask,
  updateChannelTaskDetails,
  updateTaskStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { TaskEditorDialog, type TaskEditorValues } from "@/features/channel/TaskEditorDialog";

type AgentTasksPanelProps = {
  agent: AgentInfo | null;
  conversation?: ConversationInfo | null;
  onOpenTask?: (task: AgentTask) => void;
};

type TaskScopeFilter = "all" | "channel" | "dm";
type ConversationTaskView = "current_dm" | "all_agent";

function formatStatus(status: TaskInfo["status"]): string {
  switch (status) {
    case "todo":
      return "todo";
    case "in_progress":
      return "in progress";
    case "in_review":
      return "in review";
    case "done":
      return "done";
  }
}

function statusClassName(status: TaskInfo["status"]): string {
  switch (status) {
    case "todo":
      return "bg-[#fff8d8] text-zinc-700";
    case "in_progress":
      return "bg-[#d8efff] text-blue-800";
    case "in_review":
      return "bg-[#ffe8c7] text-amber-800";
    case "done":
      return "bg-[#d8f8c8] text-green-800";
  }
}

function hasTaskBrief(description?: string | null): boolean {
  return Boolean(description?.trim());
}

function formatUpdatedAt(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

function sortTasks(items: AgentTask[]): AgentTask[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

function replaceTask(items: AgentTask[], updated: AgentTask): AgentTask[] {
  return sortTasks(items.map((item) => (item.taskId === updated.taskId ? updated : item)));
}

export function AgentTasksPanel({ agent, conversation, onOpenTask }: AgentTasksPanelProps) {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TaskInfo["status"] | "all">("all");
  const [scopeFilter, setScopeFilter] = useState<TaskScopeFilter>("all");
  const [conversationView, setConversationView] = useState<ConversationTaskView>("current_dm");
  const [editingTask, setEditingTask] = useState<AgentTask | null>(null);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);
  const [unclaimingTaskId, setUnclaimingTaskId] = useState<string | null>(null);
  const isPrimaryDirectConversation = Boolean(conversation?.threadKind === "direct" && conversation?.isPrimaryThread);

  const loadTasks = useCallback(async () => {
    if (!agent) {
      setTasks([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = isPrimaryDirectConversation && conversation
        ? await getConversationTasks(conversation.id, conversationView, statusFilter)
        : await getAgentTasks(agent.agentId, statusFilter, scopeFilter);
      setTasks(sortTasks(result.tasks));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, [agent, conversation, conversationView, isPrimaryDirectConversation, scopeFilter, statusFilter]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    if (!isPrimaryDirectConversation) return;
    setConversationView("current_dm");
  }, [conversation?.id, isPrimaryDirectConversation]);

  const counts = useMemo(() => {
    const done = tasks.filter((task) => task.status === "done").length;
    return {
      total: tasks.length,
      open: tasks.length - done,
      channel: tasks.filter((task) => task.sourceType === "channel").length,
      dm: tasks.filter((task) => task.sourceType === "dm").length,
    };
  }, [tasks]);

  const handleEditSubmit = useCallback(async ({ title, description }: TaskEditorValues) => {
    if (!agent || !editingTask || editing) return;
    setEditing(true);
    setEditError(null);
    try {
      const updated = editingTask.sourceType === "dm"
        ? await updateAgentDmTask(agent.agentId, editingTask.taskId, title, description)
        : { ...editingTask, ...(await updateChannelTaskDetails(editingTask.channelId, editingTask.taskNumber, title, description)) };
      setTasks((prev) => replaceTask(prev, updated));
      setEditingTask(null);
    } catch (err) {
      setEditError(String((err as Error)?.message ?? err));
    } finally {
      setEditing(false);
    }
  }, [agent, editing, editingTask]);

  const handleStatusChange = useCallback(async (task: AgentTask, nextStatus: TaskInfo["status"]) => {
    if (!agent || updatingTaskId === task.taskId) return;
    setUpdatingTaskId(task.taskId);
    setError(null);
    try {
      const updated = task.sourceType === "dm"
        ? await updateAgentDmTaskStatus(agent.agentId, task.taskId, nextStatus)
        : { ...task, ...(await updateTaskStatus(task.channelId, task.taskNumber, nextStatus)) };
      setTasks((prev) => replaceTask(prev, updated));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setUpdatingTaskId(null);
    }
  }, [agent, updatingTaskId]);

  const handleUnclaim = useCallback(async (task: AgentTask) => {
    if (!agent || unclaimingTaskId === task.taskId) return;
    setUnclaimingTaskId(task.taskId);
    setError(null);
    try {
      const updated = task.sourceType === "dm"
        ? await unclaimAgentDmTask(agent.agentId, task.taskId)
        : { ...task, ...(await unclaimChannelTask(task.channelId, task.taskNumber)) };
      setTasks((prev) => prev.filter((item) => item.taskId !== updated.taskId));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setUnclaimingTaskId(null);
    }
  }, [agent, unclaimingTaskId]);

  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        Agent tasks unavailable.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#fff9d0]">
      <div className="border-b-2 border-black bg-[#fff6b8] px-4 py-3">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-zinc-700">
          <span className="rounded-full border border-zinc-900 bg-white px-2 py-0.5 font-semibold">
            {counts.open} open
          </span>
          <span className="rounded-full border border-zinc-900/70 bg-[#d8efff] px-2 py-0.5">
            {counts.channel} channel
          </span>
          <span className="rounded-full border border-zinc-900/70 bg-[#fff0d0] px-2 py-0.5">
            {counts.dm} dm
          </span>
          <span className="text-zinc-500">{counts.total} total</span>
        </div>
        <div className={cn("grid gap-2", isPrimaryDirectConversation ? "md:grid-cols-[minmax(0,1fr)_220px]" : "md:grid-cols-2")}>
          {isPrimaryDirectConversation ? (
            <div className="space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-600">
                View
              </span>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={conversationView === "current_dm" ? "default" : "outline"}
                  className={cn(
                    "h-9 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
                    conversationView === "current_dm" ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]" : "bg-white text-zinc-700 hover:bg-[#fff1a9]",
                  )}
                  onClick={() => setConversationView("current_dm")}
                >
                  Current DM
                </Button>
                <Button
                  size="sm"
                  variant={conversationView === "all_agent" ? "default" : "outline"}
                  className={cn(
                    "h-9 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
                    conversationView === "all_agent" ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]" : "bg-white text-zinc-700 hover:bg-[#fff1a9]",
                  )}
                  onClick={() => setConversationView("all_agent")}
                >
                  All agent tasks
                </Button>
              </div>
            </div>
          ) : (
            <label className="space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-600">
                Scope
              </span>
              <select
                value={scopeFilter}
                onChange={(event) => setScopeFilter(event.target.value as TaskScopeFilter)}
                className="h-9 w-full rounded-sm border-2 border-zinc-900 bg-white px-3 text-sm text-zinc-900"
              >
                <option value="all">All tasks</option>
                <option value="channel">Channel only</option>
                <option value="dm">DM only</option>
              </select>
            </label>
          )}
          <label className="space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-600">
              Status
            </span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as TaskInfo["status"] | "all")}
              className="h-9 w-full rounded-sm border-2 border-zinc-900 bg-white px-3 text-sm text-zinc-900"
            >
              <option value="all">All statuses</option>
              <option value="todo">Todo</option>
              <option value="in_progress">In progress</option>
              <option value="in_review">In review</option>
              <option value="done">Done</option>
            </select>
          </label>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fff8d8] px-4 py-6 text-center text-sm text-zinc-500">
            Loading tasks...
          </div>
        ) : error ? (
          <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fff8d8] px-4 py-6 text-center text-sm text-zinc-500">
            No assigned tasks match the current filters.
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map((task) => {
              const isUpdating = updatingTaskId === task.taskId;
              const isUnclaiming = unclaimingTaskId === task.taskId;
              const canAdvance = task.status === "todo" || task.status === "in_progress";
              const canReview = task.status === "in_review";

              return (
                <div
                  key={task.taskId}
                  className="rounded-sm border-2 border-zinc-900 bg-white px-3 py-3 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-medium text-zinc-900">
                          #{task.taskNumber} {task.title}
                        </div>
                        <span className={cn(
                          "rounded-full border border-zinc-900 px-2 py-0.5 text-[11px] font-medium",
                          statusClassName(task.status),
                        )}>
                          {formatStatus(task.status)}
                        </span>
                        <span className="rounded-full border border-zinc-300 bg-[#fff8d8] px-2 py-0.5 text-[11px] text-zinc-700">
                          {task.sourceLabel}
                        </span>
                      </div>
                      {hasTaskBrief(task.description) ? (
                        <div className="mt-1 whitespace-pre-wrap text-xs text-zinc-500">
                          {task.description}
                        </div>
                      ) : (
                        <div className="mt-1 rounded-sm border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                          Task brief missing.
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                        <span className="rounded-full border border-zinc-300 bg-[#fffdf4] px-2 py-0.5">
                          Updated {formatUpdatedAt(task.updatedAt)}
                        </span>
                        {task.sourceType === "channel" && task.linkedThreadShortId ? (
                          <span className="rounded-full border border-zinc-300 bg-[#d8efff] px-2 py-0.5 text-blue-700">
                            Thread {task.linkedThreadShortId}
                          </span>
                        ) : null}
                        {task.sourceType === "dm" ? (
                          <span className="rounded-full border border-zinc-300 bg-[#fff0d0] px-2 py-0.5 text-zinc-700">
                            Private chat
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-200/80 pt-2">
                    <Button
                      size="sm"
                      className="h-8 rounded-sm border-2 border-zinc-900 bg-[#d8efff] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#b8e0ff]"
                      onClick={() => onOpenTask?.(task)}
                    >
                      Open
                    </Button>
                    {canAdvance ? (
                      <Button
                        size="sm"
                        disabled={isUpdating}
                        className="h-8 rounded-sm border-2 border-zinc-900 bg-[#fff9d8] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#fff1a9]"
                        onClick={() => void handleStatusChange(task, task.status === "todo" ? "in_progress" : "in_review")}
                      >
                        {isUpdating ? "Updating..." : task.status === "todo" ? "Start" : "Move to review"}
                      </Button>
                    ) : null}
                    {canReview ? (
                      <>
                        <Button
                          size="sm"
                          disabled={isUpdating}
                          className="h-8 rounded-sm border-2 border-zinc-900 bg-[#d8f8c8] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#b8f0a8]"
                          onClick={() => void handleStatusChange(task, "done")}
                        >
                          {isUpdating ? "Updating..." : "Mark done"}
                        </Button>
                        <Button
                          size="sm"
                          disabled={isUpdating}
                          className="h-8 rounded-sm border-2 border-zinc-900 bg-[#fff0d0] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#ffe4b0]"
                          onClick={() => void handleStatusChange(task, "in_progress")}
                        >
                          {isUpdating ? "Updating..." : "Request changes"}
                        </Button>
                      </>
                    ) : null}
                    <Button
                      size="sm"
                      className="h-8 rounded-sm border-2 border-zinc-900 bg-[#d8efff] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#b8e0ff]"
                      onClick={() => {
                        setEditingTask(task);
                        setEditError(null);
                      }}
                    >
                      Edit
                    </Button>
                    {task.status !== "done" ? (
                      <Button
                        size="sm"
                        disabled={isUnclaiming}
                        className="h-8 rounded-sm border-2 border-zinc-900 bg-[#fff0d0] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#ffe4b0]"
                        onClick={() => void handleUnclaim(task)}
                      >
                        {isUnclaiming ? "Unclaiming..." : "Unclaim"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <TaskEditorDialog
        isOpen={editingTask != null}
        dialogTitle={editingTask ? `Edit Task #${editingTask.taskNumber}` : "Edit task"}
        submitLabel="Save changes"
        initialTitle={editingTask?.title ?? ""}
        initialDescription={editingTask?.description ?? ""}
        saving={editing}
        error={editError}
        onClose={() => {
          if (editing) return;
          setEditingTask(null);
          setEditError(null);
        }}
        onSubmit={handleEditSubmit}
      />
    </div>
  );
}
