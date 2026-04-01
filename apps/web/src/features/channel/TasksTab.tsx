import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskInfo } from "@agent-collab/protocol";
import { Button } from "@/components/ui/button";
import {
  bindThreadTask,
  createChannelTask,
  getChannelTasks,
  unbindThreadTask,
  updateTaskStatus,
  type ChannelTask,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type TasksTabProps = {
  channelId: string;
  activeThreadShortId?: string;
  onOpenThread?: (threadShortId: string) => void;
};

const TASK_ORDER: TaskInfo["status"][] = ["todo", "in_progress", "in_review", "done"];

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

export function TasksTab({ channelId, activeThreadShortId, onOpenThread }: TasksTabProps) {
  const [tasks, setTasks] = useState<ChannelTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [updatingTaskNumber, setUpdatingTaskNumber] = useState<number | null>(null);
  const [bindingTaskNumber, setBindingTaskNumber] = useState<number | null>(null);
  const [showDone, setShowDone] = useState(false);

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
  }, [loadTasks]);

  const grouped = useMemo(() => {
    const buckets: Record<TaskInfo["status"], ChannelTask[]> = {
      todo: [],
      in_progress: [],
      in_review: [],
      done: [],
    };
    for (const task of tasks) buckets[task.status].push(task);
    return buckets;
  }, [tasks]);

  const counts = useMemo(() => {
    const done = grouped.done.length;
    return {
      total: tasks.length,
      open: tasks.length - done,
      inProgress: grouped.in_progress.length,
      inReview: grouped.in_review.length,
      done,
    };
  }, [grouped, tasks.length]);

  const handleCreate = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createChannelTask(channelId, trimmed, description.trim() || undefined);
      setTasks((prev) => [...prev, created]);
      setTitle("");
      setDescription("");
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setCreating(false);
    }
  }, [channelId, creating, title]);

  const handleAdvance = useCallback(async (task: TaskInfo) => {
    if (task.status === "done" || updatingTaskNumber === task.taskNumber) return;
    setUpdatingTaskNumber(task.taskNumber);
    setError(null);
    try {
      const updated = await updateTaskStatus(channelId, task.taskNumber, nextStatus(task.status));
      setTasks((prev) => prev.map((item) => (item.taskId === updated.taskId ? updated : item)));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setUpdatingTaskNumber(null);
    }
  }, [channelId, updatingTaskNumber]);

  const handleBind = useCallback(async (task: ChannelTask) => {
    if (!activeThreadShortId || bindingTaskNumber === task.taskNumber) return;
    setBindingTaskNumber(task.taskNumber);
    setError(null);
    try {
      await bindThreadTask(channelId, activeThreadShortId, task.taskNumber);
      await loadTasks();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBindingTaskNumber(null);
    }
  }, [activeThreadShortId, bindingTaskNumber, channelId, loadTasks]);

  const handleUnbind = useCallback(async (task: ChannelTask) => {
    if (!task.linkedThreadShortId || bindingTaskNumber === task.taskNumber) return;
    setBindingTaskNumber(task.taskNumber);
    setError(null);
    try {
      await unbindThreadTask(channelId, task.linkedThreadShortId);
      await loadTasks();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBindingTaskNumber(null);
    }
  }, [bindingTaskNumber, channelId, loadTasks]);

  return (
    <div className="flex h-full flex-col">
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
            placeholder="New task title"
            className="h-9 flex-1 rounded-sm border-2 border-zinc-900 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400"
            disabled={creating}
          />
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={creating || !title.trim()}
            className="h-9 rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
          >
            Add
          </Button>
        </div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
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
          {activeThreadShortId
            ? <>Current thread: <span className="font-mono">{activeThreadShortId}</span>. Tasks without a linked thread can be bound here.</>
            : "New tasks automatically create a thread in Chat. Click a task's thread link to open it."}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fff8d8] px-4 py-6 text-center text-sm text-zinc-500">
            Loading tasks...
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fff8d8] px-4 py-6 text-center text-sm text-zinc-500">
            No tasks yet. Add the first task for this channel.
          </div>
        ) : (
          <div className="space-y-4">
            {TASK_ORDER.map((status) => {
              const items = grouped[status];
              if (status === "done" && items.length === 0) return null;
              if (status === "done" && !showDone) {
                return (
                  <div key={status} className="rounded-md border-2 border-zinc-900 bg-[#fffdf4] p-3 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)]">
                    <button
                      type="button"
                      onClick={() => setShowDone(true)}
                      className="flex w-full items-center justify-between text-left text-sm font-semibold text-zinc-700"
                    >
                      <span>done ({items.length})</span>
                      <span className="text-xs font-normal text-zinc-500">Show</span>
                    </button>
                  </div>
                );
              }
              return (
                <section
                  key={status}
                  className="rounded-md border-2 border-zinc-900 bg-[#fffdf4] p-3 shadow-[2px_2px_0_0_rgba(0,0,0,0.1)]"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-zinc-900">
                      {formatStatus(status)} ({items.length})
                    </h3>
                    {status === "done" && (
                      <button
                        type="button"
                        onClick={() => setShowDone(false)}
                        className="text-xs text-zinc-500 hover:text-zinc-700"
                      >
                        Hide
                      </button>
                    )}
                  </div>
                  {items.length === 0 ? (
                    <div className="rounded border border-dashed border-zinc-300 bg-[#fff8d8] px-3 py-2 text-xs text-zinc-400">
                      No tasks
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {items.map((task) => (
                        <div
                          key={task.taskId}
                          className="rounded-sm border-2 border-zinc-900 bg-white px-3 py-2 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]"
                        >
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium text-zinc-900">
                                #{task.taskNumber} {task.title}
                              </div>
                              {task.description && (
                                <div className="mt-1 whitespace-pre-wrap text-xs text-zinc-500">
                                  {task.description}
                                </div>
                              )}
                              {task.assigneeName && (
                                <div className="mt-2 inline-flex rounded-full border border-zinc-300 bg-[#fff8d8] px-2 py-0.5 text-[11px] text-zinc-600">
                                  @{task.assigneeName}
                                </div>
                              )}
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                                {task.linkedThreadShortId ? (
                                  <button
                                    type="button"
                                    onClick={() => onOpenThread?.(task.linkedThreadShortId!)}
                                    className="rounded-full border border-zinc-400 bg-[#d8efff] px-2 py-0.5 text-blue-700 hover:bg-[#b8e0ff] transition-colors"
                                  >
                                    Thread {task.linkedThreadShortId}
                                  </button>
                                ) : (
                                  <span className="rounded-full border border-dashed border-zinc-300 bg-[#fffdf4] px-2 py-0.5">
                                    No linked thread
                                  </span>
                                )}
                                {!task.assigneeName && (
                                  <span className="rounded-full border border-dashed border-zinc-300 bg-[#fffdf4] px-2 py-0.5">
                                    Unassigned
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-2">
                              <button
                                type="button"
                                onClick={() => void handleAdvance(task)}
                                disabled={task.status === "done" || updatingTaskNumber === task.taskNumber}
                                className={cn(
                                  "rounded-full border border-zinc-900 px-2 py-0.5 text-[11px] font-medium transition-colors",
                                  statusClassName(task.status),
                                  task.status !== "done" && "hover:brightness-95",
                                  updatingTaskNumber === task.taskNumber && "opacity-60",
                                )}
                              >
                                {updatingTaskNumber === task.taskNumber ? "Updating..." : formatStatus(task.status)}
                              </button>
                              {activeThreadShortId ? (
                                task.linkedThreadShortId === activeThreadShortId ? (
                                  <Button
                                    size="sm"
                                    disabled={bindingTaskNumber === task.taskNumber}
                                    onClick={() => void handleUnbind(task)}
                                    className="h-8 rounded-sm border-2 border-zinc-900 bg-[#ffd8d8] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#ffc6c6]"
                                  >
                                    {bindingTaskNumber === task.taskNumber ? "Saving..." : "Unbind"}
                                  </Button>
                                ) : task.linkedThreadShortId ? (
                                  <div className="text-[11px] text-zinc-400">
                                    Bound to {task.linkedThreadShortId}
                                  </div>
                                ) : (
                                  <Button
                                    size="sm"
                                    disabled={task.status === "done" || bindingTaskNumber === task.taskNumber}
                                    onClick={() => void handleBind(task)}
                                    className="h-8 rounded-sm border-2 border-zinc-900 bg-[#d8f8c8] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#c8efb8]"
                                  >
                                    {bindingTaskNumber === task.taskNumber ? "Saving..." : "Bind to current thread"}
                                  </Button>
                                )
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
