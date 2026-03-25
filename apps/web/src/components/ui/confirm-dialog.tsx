import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AlertTriangleIcon, XIcon } from "lucide-react";
import { useCallback, useEffect } from "react";

export type ConfirmDialogProps = {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "warning" | "info";
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "warning",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Handle ESC key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      } else if (e.key === "Enter") {
        onConfirm();
      }
    },
    [onCancel, onConfirm]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  const variantStyles = {
    danger: {
      icon: "text-red-600",
      iconBg: "bg-red-100",
      border: "border-red-500",
      confirmButton: "bg-red-500 hover:bg-red-600 border-red-700",
    },
    warning: {
      icon: "text-amber-600",
      iconBg: "bg-amber-100",
      border: "border-amber-500",
      confirmButton: "bg-amber-500 hover:bg-amber-600 border-amber-700",
    },
    info: {
      icon: "text-blue-600",
      iconBg: "bg-blue-100",
      border: "border-blue-500",
      confirmButton: "bg-blue-500 hover:bg-blue-600 border-blue-700",
    },
  };

  const styles = variantStyles[variant];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div
        className={cn(
          "relative z-10 w-full max-w-md rounded-sm border-4 bg-[#fffce8] p-0 shadow-[8px_8px_0_0_rgba(0,0,0,0.3)]",
          styles.border
        )}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b-2 border-black bg-[#fff5c2] px-4 py-3">
          <div className="flex items-center gap-2">
            <div className={cn("rounded-sm p-1", styles.iconBg)}>
              <AlertTriangleIcon className={cn("size-5", styles.icon)} />
            </div>
            <h2
              id="confirm-dialog-title"
              className="text-sm font-bold text-zinc-900"
            >
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-sm border-2 border-transparent p-1 hover:border-zinc-900 hover:bg-[#fff9d0]"
            aria-label="Close"
          >
            <XIcon className="size-4 text-zinc-600" />
          </button>
        </div>

        {/* Content */}
        <div className="px-4 py-4">
          <p
            id="confirm-dialog-message"
            className="text-sm leading-relaxed text-zinc-700"
          >
            {message}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 border-t-2 border-black/10 bg-[#fff9d0] px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            className="rounded-sm border-2 border-zinc-900 bg-white px-4 text-xs font-semibold text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#f0f0f0]"
          >
            {cancelText}
          </Button>
          <Button
            size="sm"
            onClick={onConfirm}
            className={cn(
              "rounded-sm border-2 px-4 text-xs font-semibold text-white shadow-[2px_2px_0_0_rgba(0,0,0,0.2)]",
              styles.confirmButton
            )}
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}
