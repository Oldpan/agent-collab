import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

export type ConfirmationProps = ComponentProps<"div"> & {
  toolName: string;
  toolArgs: unknown;
  onAllow: () => void;
  onDeny: () => void;
};

/** Approval request card -- show tool name/args with allow/deny buttons */
export const Confirmation = ({
  className,
  toolName,
  toolArgs,
  onAllow,
  onDeny,
  ...props
}: ConfirmationProps) => {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/5 p-4",
        className,
      )}
      {...props}
    >
      <div className="text-sm">
        <span className="font-medium text-warning">Approval required: </span>
        <span className="font-mono text-foreground">{toolName}</span>
      </div>

      {toolArgs != null && typeof toolArgs === "object" && (
        <div className="text-xs font-mono text-muted-foreground max-h-32 overflow-auto">
          <pre className="whitespace-pre-wrap">
            {JSON.stringify(toolArgs, null, 2)}
          </pre>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="default"
          onClick={onAllow}
          className="h-8 px-3 text-sm"
        >
          Allow
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onDeny}
          className="h-8 px-3 text-sm"
        >
          Deny
        </Button>
      </div>
    </div>
  );
};
