import { Button } from "@/components/ui/button";
import { clearDraft, readDraft, writeDraft } from "@/lib/drafts";
import { cn } from "@/lib/utils";
import { SendIcon, SquareIcon, PaperclipIcon, XIcon, ListTodoIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatStatus } from "@/hooks/types";
import { uploadAttachment } from "@/lib/api";

export type PromptComposerProps = {
  status: ChatStatus;
  ready?: boolean;
  showCancel?: boolean;
  disableInput?: boolean;
  draftKey?: string;
  showSendAsTaskButton?: boolean;
  onSend: (text: string, attachmentIds?: string[], sendAsTask?: boolean) => boolean;
  onCancel: () => void;
};

/** Auto-resizing textarea with send/cancel and file upload buttons */
export function PromptComposer({
  status,
  ready = true,
  showCancel,
  disableInput,
  draftKey,
  showSendAsTaskButton = false,
  onSend,
  onCancel,
}: PromptComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const shiftPressedRef = useRef(false);
  const [text, setText] = useState(() => readDraft(draftKey));
  const [pendingFiles, setPendingFiles] = useState<Array<{ id: string; name: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [sendAsTask, setSendAsTask] = useState(false);

  useEffect(() => {
    const nextText = readDraft(draftKey);
    setText(nextText);
    setSendAsTask(false);
    const textarea = textareaRef.current;
    if (!textarea) return;
    requestAnimationFrame(() => {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    });
  }, [draftKey]);

  useEffect(() => {
    if (!showSendAsTaskButton) {
      setSendAsTask(false);
    }
  }, [showSendAsTaskButton]);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    e.target.value = "";
    setUploading(true);
    try {
      const results = await Promise.all(files.map((f) => uploadAttachment(f)));
      setPendingFiles((prev) => [...prev, ...results.map((r) => ({ id: r.id, name: r.filename }))]);
    } catch (err) {
      alert(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  }, []);

  const removeFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleSubmit = useCallback(() => {
    const textarea = textareaRef.current;
    const trimmed = text.trim();
    if ((!trimmed && pendingFiles.length === 0) || (sendAsTask && !trimmed)) return;
    const ids = pendingFiles.map((f) => f.id);
    const accepted = onSend(trimmed, ids.length ? ids : undefined, sendAsTask || undefined);
    if (!accepted) return;
    setText("");
    clearDraft(draftKey);
    if (textarea) {
      textarea.style.height = "auto";
    }
    setPendingFiles([]);
    setSendAsTask(false);
  }, [draftKey, onSend, pendingFiles, sendAsTask, text]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Shift") {
        shiftPressedRef.current = true;
        return;
      }
      if (e.key === "Enter" && shiftPressedRef.current) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleKeyUp = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Shift") {
      shiftPressedRef.current = false;
    }
  }, []);

  const handleBlur = useCallback(() => {
    shiftPressedRef.current = false;
  }, []);

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextText = e.target.value;
    setText(nextText);
    writeDraft(draftKey, nextText);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  }, [draftKey]);

  const isBusy =
    status === "queued" ||
    status === "submitted" ||
    status === "streaming" ||
    status === "recovering" ||
    status === "awaiting_approval";

  const shouldShowCancel =
    showCancel ?? (status === "submitted" || status === "streaming" || status === "recovering" || status === "awaiting_approval");
  const shouldDisableInput = disableInput ?? isBusy;

  return (
    <div className="border-t-2 border-black bg-[#fff5c2] px-4 py-3 shadow-[0_-2px_0_0_rgba(0,0,0,0.08)]">
      {/* Pending attachment chips */}
      {pendingFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pendingFiles.map((f) => (
            <span
              key={f.id}
              className="flex items-center gap-1 rounded-full border border-zinc-400 bg-[#d8efff] px-2 py-0.5 text-xs text-zinc-700"
            >
              <PaperclipIcon className="size-3 shrink-0" />
              <span className="max-w-[120px] truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => removeFile(f.id)}
                className="ml-0.5 text-zinc-500 hover:text-zinc-900"
                aria-label="Remove"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-sm border-2 border-black bg-[#fffdf4] p-1.5 shadow-[4px_4px_0_0_rgba(0,0,0,0.2)]">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={(e) => void handleFileChange(e)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={shouldDisableInput || uploading}
          className="shrink-0 self-center rounded p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40"
          title="Attach image"
        >
          <PaperclipIcon className="size-4" />
        </button>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          className={cn(
            "min-h-[36px] max-h-[200px] flex-1 resize-none rounded-sm border border-transparent bg-transparent px-3 py-1.5 text-sm text-zinc-900",
            "placeholder:text-zinc-400",
            "focus:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          placeholder={
            ready
              ? "Send a message... (Enter for newline, Shift+Enter to send)"
              : "Connection is reconnecting... You can still type."
          }
          disabled={shouldDisableInput}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onBlur={handleBlur}
          onInput={handleInput}
          rows={1}
        />

        <div className="flex shrink-0 self-center items-center gap-2">
          {shouldShowCancel && (
            <Button
              size="icon"
              variant="outline"
              onClick={onCancel}
              className="rounded-sm border-2 border-zinc-900 bg-white text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#fff0a8]"
              title="Cancel"
            >
              <SquareIcon className="size-4" />
            </Button>
          )}
          <Button
            size="icon"
            onClick={handleSubmit}
            className="rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
            title="Send"
            disabled={uploading}
          >
            <SendIcon className="size-4" />
          </Button>
          {showSendAsTaskButton && (
            <Button
              size="icon"
              type="button"
              variant="outline"
              onClick={() => setSendAsTask((current) => !current)}
              className={cn(
                "rounded-sm border-2 border-zinc-900 text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
                sendAsTask
                  ? "bg-[#d8f8c8] hover:bg-[#b8f0a8]"
                  : "bg-white hover:bg-[#eef7ff]",
              )}
              title={sendAsTask ? "Next send will create a task" : "Send next message as a task"}
              aria-label="Send next message as a task"
              aria-pressed={sendAsTask}
              disabled={shouldDisableInput || uploading}
            >
              <ListTodoIcon className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
