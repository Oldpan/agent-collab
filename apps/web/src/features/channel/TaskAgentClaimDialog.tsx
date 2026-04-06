import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CreateDialog } from "@/components/ui/create-dialog";

type TaskAgentClaimDialogProps = {
  isOpen: boolean;
  taskTitle?: string;
  taskNumber?: number;
  taskDescription?: string | null;
  currentAgentId?: string | null;
  agents: Array<{ agentId: string; name: string }>;
  submitting?: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (agentId: string) => Promise<void> | void;
};

export function TaskAgentClaimDialog({
  isOpen,
  taskTitle,
  taskNumber,
  taskDescription,
  currentAgentId,
  agents,
  submitting = false,
  error,
  onClose,
  onSubmit,
}: TaskAgentClaimDialogProps) {
  const [agentId, setAgentId] = useState(currentAgentId ?? agents[0]?.agentId ?? "");

  useEffect(() => {
    if (!isOpen) return;
    setAgentId(currentAgentId ?? agents[0]?.agentId ?? "");
  }, [agents, currentAgentId, isOpen]);

  const handleSubmit = async () => {
    if (!agentId || submitting) return;
    await onSubmit(agentId);
  };

  return (
    <CreateDialog
      isOpen={isOpen}
      title={taskNumber != null ? `Assign Task #${taskNumber}` : "Assign task"}
      onClose={() => {
        if (!submitting) onClose();
      }}
    >
      <div className="space-y-3">
        <div className="rounded-sm border-2 border-zinc-900 bg-white px-3 py-2 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
            Task
          </div>
          <div className="mt-1 text-sm font-medium text-zinc-900">
            {taskNumber != null ? `#${taskNumber} ` : ""}{taskTitle}
          </div>
          {taskDescription && (
            <div className="mt-2 whitespace-pre-wrap text-xs text-zinc-600">
              {taskDescription}
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-zinc-600">
            Assign to agent
          </label>
          <select
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            className="h-10 w-full rounded-sm border-2 border-zinc-900 bg-white px-3 text-sm text-zinc-900"
            disabled={submitting}
          >
            {agents.map((agent) => (
              <option key={agent.agentId} value={agent.agentId}>
                @{agent.name}
              </option>
            ))}
          </select>
        </div>

        <div className="rounded-sm border border-zinc-300 bg-[#fffdf4] px-3 py-2 text-xs text-zinc-600">
          Assigning will claim the task for that agent, set the task thread owner, and post a kickoff prompt in the task thread automatically.
        </div>

        {error && (
          <div className="rounded-sm border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="rounded-sm border-2 border-zinc-900 bg-[#d8f8c8] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#b8f0a8]"
            onClick={() => void handleSubmit()}
            disabled={submitting || !agentId}
          >
            {submitting ? "Assigning..." : "Assign agent"}
          </Button>
        </div>
      </div>
    </CreateDialog>
  );
}
