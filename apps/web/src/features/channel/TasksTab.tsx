import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentInfo, TaskInfo } from "@agent-collab/protocol";
import { Button } from "@/components/ui/button";
import {
  claimChannelTask,
  createChannelTask,
  deleteChannelTask,
  getChannelTasks,
  unclaimChannelTask,
  updateChannelTaskDetails,
  updateTaskStatus,
  type ChannelTask,
} from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";
import { TaskEditorDialog, type TaskEditorValues } from "./TaskEditorDialog";
import { TaskAgentClaimDialog } from "./TaskAgentClaimDialog";

type TasksTabProps = {
  channelId: string;
  channelAgents: Pick<AgentInfo, "agentId" | "name">[];
  onOpenThread?: (threadShortId: string) => void;
  taskVersion?: number;
  currentAgentId?: string | null;
  currentAgentName?: string | null;
};

const TASK_ORDER: TaskInfo["status"][] = ["todo", "in_progress", "in_review", "done"];
const TASK_BOARD_COLUMNS: Array<TaskInfo["status"][]> = [
  ["todo", "in_progress"],
  ["in_review", "done"],
];

function nextStatus(status: TaskInfo["status"]): TaskInfo["status"] {
  const idx = TASK_ORDER.indexOf(status);
  return TASK_ORDER[Math.min(idx + 1, TASK_ORDER.length - 1)] ?? "done";
}

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

function sameUserName(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a === b;
}

function hasTaskBrief(description?: string | null): boolean {
  return Boolean(description?.trim());
}

export function TasksTab({
  channelId,
  channelAgents,
  onOpenThread,
  taskVersion = 0,
  currentAgentId = null,
  currentAgentName = null,
}: TasksTabProps) {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<ChannelTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TaskInfo["status"] | "all">("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [claimingTaskNumber, setClaimingTaskNumber] = useState<number | null>(null);
  const [unclaimingTaskNumber, setUnclaimingTaskNumber] = useState<number | null>(null);
  const [updatingTaskNumber, setUpdatingTaskNumber] = useState<number | null>(null);
  const [deletingTaskNumber, setDeletingTaskNumber] = useState<number | null>(null);
  const [editingTask, setEditingTask] = useState<ChannelTask | null>(null);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [assigningTask, setAssigningTask] = useState<ChannelTask | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Record<TaskInfo["status"], boolean>>({
    todo: false,
    in_progress: false,
    in_review: false,
    done: true,
  });

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getChannelTasks(channelId);
      setTasks(result.tasks);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks, taskVersion]);

  useEffect(() => {
    setAssigneeFilter(currentAgentId ?? "all");
  }, [channelId, currentAgentId]);

  const assigneeOptions = useMemo(() => {
    const options = [...channelAgents];
    if (currentAgentId && !options.some((agent) => agent.agentId === currentAgentId)) {
      options.unshift({ agentId: currentAgentId, name: currentAgentName ?? "Current agent" });
    }
    return options;
  }, [channelAgents, currentAgentId, currentAgentName]);

  const filteredTasks = useMemo(() => tasks.filter((task) => {
    if (statusFilter !== "all" && task.status !== statusFilter) return false;
    if (assigneeFilter !== "all" && task.assigneeId !== assigneeFilter) return false;
    return true;
  }), [assigneeFilter, statusFilter, tasks]);

  const grouped = useMemo(() => {
    const buckets: Record<TaskInfo["status"], ChannelTask[]> = {
      todo: [],
      in_progress: [],
      in_review: [],
      done: [],
    };
    for (const task of filteredTasks) buckets[task.status].push(task);
    return buckets;
  }, [filteredTasks]);

  const counts = useMemo(() => {
    const done = grouped.done.length;
    return {
      total: filteredTasks.length,
      open: filteredTasks.length - done,
      inProgress: grouped.in_progress.length,
      inReview: grouped.in_review.length,
      done,
    };
  }, [filteredTasks.length, grouped]);

  const handleCreate = useCallback(async () => {
    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    if (!trimmedTitle || !trimmedDescription || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createChannelTask(channelId, trimmedTitle, trimmedDescription);
      setTasks((prev) => [...prev, created]);
      setTitle("");
      setDescription("");
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setCreating(false);
    }
  }, [channelId, creating, description, title]);

  const handleEditSubmit = useCallback(async ({ title: nextTitle, description: nextDescription }: TaskEditorValues) => {
    if (!editingTask || editing) return;
    setEditing(true);
    setEditError(null);
    try {
      const updated = await updateChannelTaskDetails(channelId, editingTask.taskNumber, nextTitle, nextDescription);
      setTasks((prev) => prev.map((item) => (item.taskId === updated.taskId ? updated : item)));
      setEditingTask(null);
    } catch (err) {
      setEditError(String((err as Error)?.message ?? err));
    } finally {
      setEditing(false);
    }
  }, [channelId, editing, editingTask]);

  const handleStatusChange = useCallback(async (task: ChannelTask, nextStatus: TaskInfo["status"]) => {
    if (updatingTaskNumber === task.taskNumber) return;
    setUpdatingTaskNumber(task.taskNumber);
    setError(null);
    try {
      const updated = await updateTaskStatus(channelId, task.taskNumber, nextStatus);
      setTasks((prev) => prev.map((item) => (item.taskId === updated.taskId ? updated : item)));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setUpdatingTaskNumber(null);
    }
  }, [channelId, updatingTaskNumber]);

  const handleAdvance = useCallback(async (task: ChannelTask) => {
    if (task.status !== "todo" && task.status !== "in_progress") return;
    await handleStatusChange(task, nextStatus(task.status));
  }, [handleStatusChange]);

  const handleMarkDone = useCallback(async (task: ChannelTask) => {
    if (task.status !== "in_review") return;
    await handleStatusChange(task, "done");
  }, [handleStatusChange]);

  const handleRequestChanges = useCallback(async (task: ChannelTask) => {
    if (task.status !== "in_review") return;
    await handleStatusChange(task, "in_progress");
  }, [handleStatusChange]);

  const handleClaimSelf = useCallback(async (task: ChannelTask) => {
    if (claimingTaskNumber === task.taskNumber) return;
    setClaimingTaskNumber(task.taskNumber);
    setError(null);
    try {
      const updated = await claimChannelTask(channelId, task.taskNumber);
      setTasks((prev) => prev.map((item) => (item.taskId === updated.taskId ? updated : item)));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setClaimingTaskNumber(null);
    }
  }, [channelId, claimingTaskNumber]);

  const handleAssignAgent = useCallback(async (agentId: string) => {
    if (!assigningTask || claimingTaskNumber === assigningTask.taskNumber) return;
    setClaimingTaskNumber(assigningTask.taskNumber);
    setAssignError(null);
    setError(null);
    try {
      const updated = await claimChannelTask(channelId, assigningTask.taskNumber, agentId);
      setTasks((prev) => prev.map((item) => (item.taskId === updated.taskId ? updated : item)));
      setAssigningTask(null);
    } catch (err) {
      setAssignError(String((err as Error)?.message ?? err));
    } finally {
      setClaimingTaskNumber(null);
    }
  }, [assigningTask, channelId, claimingTaskNumber]);

  const handleUnclaim = useCallback(async (task: ChannelTask) => {
    if (unclaimingTaskNumber === task.taskNumber) return;
    setUnclaimingTaskNumber(task.taskNumber);
    setError(null);
    try {
      const updated = await unclaimChannelTask(channelId, task.taskNumber);
      setTasks((prev) => prev.map((item) => (item.taskId === updated.taskId ? updated : item)));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setUnclaimingTaskNumber(null);
    }
  }, [channelId, unclaimingTaskNumber]);

  const handleDelete = useCallback(async (task: ChannelTask) => {
    if (deletingTaskNumber === task.taskNumber) return;
    setDeletingTaskNumber(task.taskNumber);
    setError(null);
    try {
      await deleteChannelTask(channelId, task.taskNumber);
      setTasks((prev) => prev.filter((item) => item.taskId !== task.taskId));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setDeletingTaskNumber(null);
    }
  }, [channelId, deletingTaskNumber]);

  const toggleSection = useCallback((status: TaskInfo["status"]) => {
    setCollapsedSections((prev) => ({
      ...prev,
      [status]: !prev[status],
    }));
  }, []);

  const renderTaskCard = (task: ChannelTask) => {
    const isAgentAssignee = Boolean(task.assigneeId);
    const isCurrentUserAssignee = !task.assigneeId && sameUserName(task.assigneeName, user?.username);
    const canClaimSelf = !task.assigneeName && task.status !== "done";
    const canAssignAgent = (
      channelAgents.length > 0
      && Boolean(task.linkedThreadShortId)
      && hasTaskBrief(task.description)
      && task.status !== "done"
      && (!task.assigneeName || isCurrentUserAssignee || isAgentAssignee)
    );
    const canUnclaim = task.status !== "done" && (isCurrentUserAssignee || isAgentAssignee);
    const canAdvance = isCurrentUserAssignee && (task.status === "todo" || task.status === "in_progress");
    const canReview = task.status === "in_review";
    const isUpdating = updatingTaskNumber === task.taskNumber;
    const isClaiming = claimingTaskNumber === task.taskNumber;
    const isUnclaiming = unclaimingTaskNumber === task.taskNumber;
    const isDeleting = deletingTaskNumber === task.taskNumber;
    const statusChip = canAdvance ? (
      <button
        type="button"
        onClick={() => void handleAdvance(task)}
        disabled={isUpdating}
        className={cn(
          "rounded-full border border-zinc-900 px-2 py-0.5 text-[11px] font-medium transition-colors",
          statusClassName(task.status),
          "hover:brightness-95",
          isUpdating && "opacity-60",
        )}
      >
        {isUpdating ? "Updating..." : formatStatus(task.status)}
      </button>
    ) : (
      <span
        className={cn(
          "rounded-full border border-zinc-900 px-2 py-0.5 text-[11px] font-medium",
          statusClassName(task.status),
        )}
      >
        {formatStatus(task.status)}
      </span>
    );

    return (
      <div
        key={task.taskId}
        className="rounded-sm border-2 border-zinc-900 bg-white px-3 py-2 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-zinc-900">
                #{task.taskNumber} {task.title}
              </div>
              {hasTaskBrief(task.description) ? (
                <div className="mt-1 whitespace-pre-wrap text-xs text-zinc-500">
                  {task.description}
                </div>
              ) : (
                <div className="mt-1 rounded-sm border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                  Task brief missing. Add the goal and done criteria before starting.
                </div>
              )}
              {task.assigneeName && (
                <div className="mt-2 inline-flex rounded-full border border-zinc-300 bg-[#fff8d8] px-2 py-0.5 text-[11px] text-zinc-600">
                  @{task.assigneeName}{task.assigneeId ? " · agent" : ""}
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                {task.linkedThreadShortId ? (
                  <button
                    type="button"
                    onClick={() => onOpenThread?.(task.linkedThreadShortId!)}
                    className="rounded-full border border-zinc-400 bg-[#d8efff] px-2 py-0.5 text-blue-700 hover:bg-[#b8e0ff] transition-colors"
                  >
                    Task thread {task.linkedThreadShortId}
                  </button>
                ) : (
                  <span className="rounded-full border border-dashed border-zinc-300 bg-[#fffdf4] px-2 py-0.5">
                    No task thread
                  </span>
                )}
                {!task.assigneeName && (
                  <span className="rounded-full border border-dashed border-zinc-300 bg-[#fffdf4] px-2 py-0.5">
                    Unassigned
                  </span>
                )}
                {canReview && (
                  <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-800">
                    Waiting for user review
                  </span>
                )}
              </div>
            </div>
            <div className="shrink-0">
              {statusChip}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200/80 pt-2">
            {canReview ? (
              <>
                <Button
                  size="sm"
                  disabled={isUpdating}
                  onClick={() => void handleMarkDone(task)}
                  className="h-8 rounded-sm border-2 border-zinc-900 bg-[#d8f8c8] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#b8f0a8]"
                >
                  {isUpdating ? "Updating..." : "Mark done"}
                </Button>
                <Button
                  size="sm"
                  disabled={isUpdating}
                  onClick={() => void handleRequestChanges(task)}
                  className="h-8 rounded-sm border-2 border-zinc-900 bg-[#fff0d0] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#ffe4b0]"
                >
                  {isUpdating ? "Updating..." : "Request changes"}
                </Button>
              </>
            ) : null}
            {canAssignAgent ? (
              <Button
                size="sm"
                disabled={isClaiming}
                onClick={() => {
                  setAssigningTask(task);
                  setAssignError(null);
                }}
                className="h-8 rounded-sm border-2 border-zinc-900 bg-[#d8f8c8] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#b8f0a8]"
              >
                {isClaiming
                  ? "Assigning..."
                  : task.assigneeId
                    ? "Reassign"
                    : "Claim"}
              </Button>
            ) : null}
            {canClaimSelf ? (
              <Button
                size="sm"
                disabled={isClaiming}
                onClick={() => void handleClaimSelf(task)}
                className="h-8 rounded-sm border-2 border-zinc-900 bg-[#fff9d8] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#fff1a9]"
              >
                {isClaiming ? "Claiming..." : "Claim self"}
              </Button>
            ) : canUnclaim ? (
              <Button
                size="sm"
                disabled={isUnclaiming}
                onClick={() => void handleUnclaim(task)}
                className="h-8 rounded-sm border-2 border-zinc-900 bg-[#fff0d0] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#ffe4b0]"
              >
                {isUnclaiming
                  ? (task.assigneeId ? "Releasing..." : "Unclaiming...")
                  : (task.assigneeId ? "Release" : "Unclaim")}
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => {
                setEditingTask(task);
                setEditError(null);
              }}
              className="h-8 rounded-sm border-2 border-zinc-900 bg-[#d8efff] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#b8e0ff]"
            >
              Edit
            </Button>
            <Button
              size="sm"
              disabled={isDeleting}
              onClick={() => void handleDelete(task)}
              className="h-8 rounded-sm border-2 border-zinc-900 bg-[#ffe1e1] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#ffd2d2]"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </div>
      </div>
    );
  };

  const renderSection = (status: TaskInfo["status"]) => {
    const items = grouped[status];
    const isCollapsed = collapsedSections[status];

    return (
      <section
        key={status}
        className="rounded-md border-2 border-zinc-900 bg-[#fffdf4] p-3 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)]"
      >
        <button
          type="button"
          onClick={() => toggleSection(status)}
          className="mb-2 flex w-full items-center justify-between rounded-sm border border-zinc-200 bg-white/70 px-2 py-1.5 text-left transition-colors hover:bg-white"
          aria-expanded={!isCollapsed}
        >
          <span className="text-sm font-semibold text-zinc-900">
            {formatStatus(status)} ({items.length})
          </span>
          <span className="text-[11px] uppercase tracking-wide text-zinc-500">
            {isCollapsed ? "Show" : "Hide"}
          </span>
        </button>
        {!isCollapsed && (
          items.length === 0 ? (
            <div className="rounded border border-dashed border-zinc-300 bg-[#fff8d8] px-3 py-2 text-xs text-zinc-400">
              No tasks
            </div>
          ) : (
            <div className="space-y-2">
              {items.map(renderTaskCard)}
            </div>
          )
        )}
      </section>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b-2 border-black bg-[#fff6b8] px-4 py-3">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-zinc-700">
          <span className="rounded-full border border-zinc-900 bg-white px-2 py-0.5 font-semibold">
            {counts.open} open
          </span>
          <span className="rounded-full border border-zinc-900/70 bg-[#d8efff] px-2 py-0.5">
            {counts.inProgress} in progress
          </span>
          <span className="rounded-full border border-zinc-900/70 bg-[#ffe8c7] px-2 py-0.5">
            {counts.inReview} in review
          </span>
          <span className="rounded-full border border-zinc-900/70 bg-[#d8f8c8] px-2 py-0.5">
            {counts.done} done
          </span>
          <span className="text-zinc-500">{counts.total} total</span>
        </div>
        <div className="mb-3 grid gap-2 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-600">
              Assignee
            </span>
            <select
              value={assigneeFilter}
              onChange={(event) => setAssigneeFilter(event.target.value)}
              className="h-9 w-full rounded-sm border-2 border-zinc-900 bg-white px-3 text-sm text-zinc-900"
            >
              <option value="all">All assignees</option>
              {assigneeOptions.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  @{agent.name}
                </option>
              ))}
            </select>
          </label>
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
        <div className="flex gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreate();
              }
            }}
            placeholder="New task-message title"
            className="h-9 flex-1 rounded-sm border-2 border-zinc-900 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400"
            disabled={creating}
          />
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={creating || !title.trim() || !description.trim()}
            className="h-9 rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
          >
            Create task
          </Button>
        </div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Task brief / goal / done criteria"
          rows={2}
          className="mt-1 w-full resize-none rounded-sm border-2 border-zinc-900 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400"
          disabled={creating}
        />
        {error && (
          <div className="mt-2 rounded-sm border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700">
            {error}
          </div>
        )}
        <div className="mt-3 rounded-sm border border-zinc-900/10 bg-white/60 px-3 py-2 text-xs text-zinc-600">
          New tasks need a clear brief. The brief should state the goal, constraints, expected output, and what counts as done.
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fff8d8] px-4 py-6 text-center text-sm text-zinc-500">
            Loading tasks...
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fff8d8] px-4 py-6 text-center text-sm text-zinc-500">
            No task-messages yet. Create the first task-message for this channel.
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fff8d8] px-4 py-6 text-center text-sm text-zinc-500">
            No tasks match the current filters.
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {TASK_BOARD_COLUMNS.map((column, index) => (
              <div key={index} className="flex flex-col gap-4">
                {column.map(renderSection)}
              </div>
            ))}
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
      <TaskAgentClaimDialog
        isOpen={assigningTask != null}
        taskNumber={assigningTask?.taskNumber}
        taskTitle={assigningTask?.title}
        taskDescription={assigningTask?.description}
        currentAgentId={assigningTask?.assigneeId ?? null}
        agents={channelAgents}
        submitting={assigningTask != null && claimingTaskNumber === assigningTask.taskNumber}
        error={assignError}
        onClose={() => {
          if (assigningTask && claimingTaskNumber === assigningTask.taskNumber) return;
          setAssigningTask(null);
          setAssignError(null);
        }}
        onSubmit={handleAssignAgent}
      />
    </div>
  );
}
