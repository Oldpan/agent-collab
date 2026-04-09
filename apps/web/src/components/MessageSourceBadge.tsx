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
        "pointer-events-none inline-flex items-center rounded-full border border-amber-300/90 bg-[#fff7dc] px-1.5 py-[2px] text-[7px] font-bold uppercase leading-none tracking-[0.04em] text-amber-700 shadow-[1px_1px_0_0_rgba(180,120,0,0.1)]",
        className,
      )}
    >
      fallback
    </span>
  );
}
