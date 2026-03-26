import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

type CreateDialogProps = {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
};

export function CreateDialog({ isOpen, title, onClose, children }: CreateDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-md border-4 border-zinc-900 bg-[#fff8d8] p-1 shadow-[8px_8px_0_0_rgba(0,0,0,0.3)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b-2 border-zinc-900 bg-[#ffd54a] px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-950">
            {title}
          </span>
          <Button
            size="icon-xs"
            variant="outline"
            className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]"
            onClick={onClose}
          >
            <XIcon className="size-3" />
          </Button>
        </div>

        {/* Content */}
        <div className="p-3">
          {children}
        </div>
      </div>
    </div>
  );
}
