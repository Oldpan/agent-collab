import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CreateDialog } from "@/components/ui/create-dialog";

export type TaskEditorValues = {
  title: string;
  description: string;
};

type TaskEditorDialogProps = {
  isOpen: boolean;
  dialogTitle: string;
  submitLabel: string;
  initialTitle?: string;
  initialDescription?: string | null;
  sourceMessage?: {
    senderName: string;
    content: string;
  };
  saving?: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (values: TaskEditorValues) => Promise<void> | void;
};

export function TaskEditorDialog({
  isOpen,
  dialogTitle,
  submitLabel,
  initialTitle = "",
  initialDescription = "",
  sourceMessage,
  saving = false,
  error,
  onClose,
  onSubmit,
}: TaskEditorDialogProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription ?? "");

  useEffect(() => {
    if (!isOpen) return;
    setTitle(initialTitle);
    setDescription(initialDescription ?? "");
  }, [initialDescription, initialTitle, isOpen]);

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();

  const handleSubmit = async () => {
    if (!trimmedTitle || !trimmedDescription || saving) return;
    await onSubmit({
      title: trimmedTitle,
      description: trimmedDescription,
    });
  };

  return (
    <CreateDialog
      isOpen={isOpen}
      title={dialogTitle}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="space-y-3">
        {sourceMessage && (
          <div className="rounded-sm border-2 border-zinc-900 bg-white px-3 py-2 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              Source message
            </div>
            <div className="mt-1 text-[11px] font-medium text-zinc-700">
              @{sourceMessage.senderName}
            </div>
            <div className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap text-sm text-zinc-800">
              {sourceMessage.content}
            </div>
          </div>
        )}

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-zinc-600">
            Task title
          </label>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Summarize the task in one line"
            className="h-10 w-full rounded-sm border-2 border-zinc-900 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400"
            disabled={saving}
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-zinc-600">
            Task brief / goal / done criteria
          </label>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="State the goal, constraints, expected output, and what counts as done."
            rows={6}
            className="w-full resize-y rounded-sm border-2 border-zinc-900 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400"
            disabled={saving}
          />
          <div className="mt-1 text-[11px] text-zinc-500">
            Every new task needs a clear brief so humans and agents can see the target and completion bar.
          </div>
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
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
            onClick={() => void handleSubmit()}
            disabled={saving || !trimmedTitle || !trimmedDescription}
          >
            {saving ? "Saving..." : submitLabel}
          </Button>
        </div>
      </div>
    </CreateDialog>
  );
}
