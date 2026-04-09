import { GripVerticalIcon } from "lucide-react";
import {
  PanelGroup,
  Panel,
  PanelResizeHandle,
} from "react-resizable-panels";
import type {
  PanelGroupProps,
  PanelProps,
  PanelResizeHandleProps,
} from "react-resizable-panels";
import { cn } from "@/lib/utils";

function ResizablePanelGroup({
  className,
  ...props
}: PanelGroupProps) {
  return (
    <PanelGroup
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: PanelProps) {
  return <Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  withHandle,
  showHandleOnHover = false,
  className,
  ...props
}: PanelResizeHandleProps & { withHandle?: boolean; showHandleOnHover?: boolean }) {
  return (
    <PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        "group/resize relative flex w-[3px] items-center justify-center bg-black shadow-[2px_0_0_0_rgba(0,0,0,0.2)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[panel-group-direction=vertical]:h-[3px] data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:shadow-[0_2px_0_0_rgba(0,0,0,0.2)]",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div
          className={cn(
            "pointer-events-none z-10 flex h-4 w-3 items-center justify-center rounded-sm border-2 border-black bg-[#ffd54a] transition-opacity duration-150",
            showHandleOnHover
              ? "opacity-0 group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100 group-active/resize:opacity-100"
              : "opacity-100",
          )}
        >
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </PanelResizeHandle>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
