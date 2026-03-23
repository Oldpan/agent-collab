import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SendIcon, SquareIcon } from "lucide-react";
import { useCallback, useRef, type KeyboardEvent } from "react";
import type { ChatStatus } from "@/hooks/types";

export type PromptComposerProps = {
  status: ChatStatus;
  onSend: (text: string) => void;
  onCancel: () => void;
};

/** Auto-resizing textarea with send/cancel buttons */
export function PromptComposer({ status, onSend, onCancel }: PromptComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const text = textarea.value.trim();
    if (!text) return;
    onSend(text);
    textarea.value = "";
    // Reset textarea height
    textarea.style.height = "auto";
  }, [onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (status !== "queued" && status !== "submitted" && status !== "streaming" && status !== "recovering" && status !== "awaiting_approval") {
          handleSubmit();
        }
      }
    },
    [status, handleSubmit],
  );

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, []);

  const isBusy =
    status === "queued" ||
    status === "submitted" ||
    status === "streaming" ||
    status === "recovering" ||
    status === "awaiting_approval";

  const showCancel = status === "submitted" || status === "streaming" || status === "recovering" || status === "awaiting_approval";

  return (
    <div className="border-t border-black/10 bg-[#fffbe3] px-4 py-3 shadow-[0_-10px_24px_-18px_rgba(0,0,0,0.35)]">
      <div className="flex items-end gap-2 rounded-md border-2 border-zinc-900 bg-[#fffdf4] p-2 shadow-[4px_4px_0_0_rgba(0,0,0,0.12)]">
      <textarea
        ref={textareaRef}
        className={cn(
          "min-h-[40px] max-h-[200px] flex-1 resize-none rounded-sm border border-transparent bg-transparent px-3 py-2 text-sm text-zinc-900",
          "placeholder:text-zinc-400",
          "focus:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
        placeholder="Send a message... (Shift+Enter for newline)"
        disabled={isBusy}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        rows={1}
      />

      {showCancel ? (
        <Button
          size="icon"
          variant="outline"
          onClick={onCancel}
          className="shrink-0 rounded-sm border-2 border-zinc-900 bg-white text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#fff0a8]"
          title="Cancel"
        >
          <SquareIcon className="size-4" />
        </Button>
      ) : (
        <Button
          size="icon"
          onClick={handleSubmit}
          className="shrink-0 rounded-sm border-2 border-zinc-900 bg-[#ffd54a] text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f7ca2e]"
          title="Send"
          disabled={isBusy}
        >
          <SendIcon className="size-4" />
        </Button>
      )}
      </div>
    </div>
  );
}
