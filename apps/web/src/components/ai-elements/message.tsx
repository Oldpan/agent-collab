import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo, useState } from "react";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  escapeHtmlOutsideCodeBlocks,
  safeRehypePlugins,
  safeRemarkPlugins,
  streamdownComponents,
  streamdownRootClass,
} from "./streamdown";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant";
};

/** Wrapper container for a single message */
export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-1",
      from === "user" ? "is-user" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn("flex w-full flex-col gap-1 overflow-hidden text-sm", className)}
    {...props}
  >
    {children}
  </div>
);

/** User message bubble */
export type UserMessageContentProps = HTMLAttributes<HTMLDivElement>;

export const UserMessageContent = ({
  children,
  className,
  ...props
}: UserMessageContentProps) => (
  <div
    className={cn(
      "w-full rounded-2xl bg-secondary/50 px-4 py-3 text-sm",
      "dark:bg-secondary/30",
      className,
    )}
    {...props}
  >
    <div className="whitespace-pre-wrap break-words">{children}</div>
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1 ml-4", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  className,
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} className={cn("size-6", className)} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent className="px-1.5 py-0.5">
          <p className="text-[12px]">{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return button;
};

export type MessageCopyButtonProps = {
  content: string;
  timeout?: number;
};

export const MessageCopyButton = ({
  content,
  timeout = 2000,
}: MessageCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), timeout);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <MessageAction tooltip={isCopied ? "Copied!" : "Copy"} onClick={handleCopy}>
      {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </MessageAction>
  );
};

/** Streaming markdown response renderer */
export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
  ({ className, children, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        streamdownRootClass,
        className,
      )}
      components={streamdownComponents}
      rehypePlugins={safeRehypePlugins}
      remarkPlugins={safeRemarkPlugins}
      {...props}
    >
      {typeof children === "string"
        ? escapeHtmlOutsideCodeBlocks(children)
        : children}
    </Streamdown>
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponse.displayName = "MessageResponse";
