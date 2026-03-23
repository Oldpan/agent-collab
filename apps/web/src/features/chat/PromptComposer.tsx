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
    <div className="flex items-end gap-2 border-t border-border bg-background p-4">
      <textarea
        ref={textareaRef}
        className={cn(
          "flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm",
          "placeholder:text-muted-foreground",
          "focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "min-h-[40px] max-h-[200px]",
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
          className="shrink-0"
          title="Cancel"
        >
          <SquareIcon className="size-4" />
        </Button>
      ) : (
        <Button
          size="icon"
          onClick={handleSubmit}
          className="shrink-0"
          title="Send"
          disabled={isBusy}
        >
          <SendIcon className="size-4" />
        </Button>
      )}
    </div>
  );
}
