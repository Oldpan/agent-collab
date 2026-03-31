import { cn } from "@/lib/utils";

type MessageSourceBadgeProps = {
  messageSource?: string;
  className?: string;
};

export function MessageSourceBadge({ messageSource, className }: MessageSourceBadgeProps) {
  if (messageSource !== "delta_fallback") return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border border-amber-300 bg-[#fff2b8] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-700",
        className,
      )}
    >
      fallback
    </span>
  );
}
