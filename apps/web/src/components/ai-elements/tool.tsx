import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  CheckIcon,
  ChevronRightIcon,
  FileIcon,
  FilePenIcon,
  FolderSearchIcon,
  GlobeIcon,
  Loader2Icon,
  SearchIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useMemo, useState } from "react";
import { CodeBlock } from "./code-block";

export type ToolState =
  | "calling"
  | "result"
  | "cancelled"
  | "error";

export type ToolProps = ComponentProps<typeof Collapsible>;

/** Collapsible tool call card */
export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("not-prose mb-1 w-full text-sm", className)}
    {...props}
  />
);

// Icon map for common tool names
const TOOL_ICONS: Record<string, ReactNode> = {
  Read: <FileIcon className="size-3.5" />,
  Write: <FilePenIcon className="size-3.5" />,
  Edit: <FilePenIcon className="size-3.5" />,
  Glob: <FolderSearchIcon className="size-3.5" />,
  Grep: <SearchIcon className="size-3.5" />,
  Bash: <TerminalIcon className="size-3.5" />,
  WebSearch: <GlobeIcon className="size-3.5" />,
};

const getStatusIcon = (state: ToolState): ReactNode => {
  switch (state) {
    case "calling":
      return <Loader2Icon className="size-3 text-muted-foreground animate-spin" />;
    case "result":
      return <CheckIcon className="size-3 text-success" />;
    case "error":
      return <XIcon className="size-3 text-destructive" />;
    case "cancelled":
      return <XIcon className="size-3 text-zinc-400" />;
  }
};

function truncateInline(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function stringifyInline(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const rendered = value
      .map((item) => (typeof item === "string" || typeof item === "number" ? String(item) : null))
      .filter(Boolean)
      .join(", ");
    return rendered || null;
  }
  return null;
}

function humanizeKey(key: string): string {
  return key
    .replaceAll(/_/g, " ")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function getToolSummaryParts(name: string, input: unknown): Array<{ label: string; value: string }> {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;

  const toolLower = name.toLowerCase();
  const priorityKeys = [
    "path",
    "file_path",
    "source_path",
    "destination_path",
    "cwd",
    "command",
    "url",
    "query",
    "pattern",
    "channel",
    "target",
    "title",
    "task_numbers",
  ];

  const parts: Array<{ label: string; value: string }> = [];
  for (const key of priorityKeys) {
    const raw = record[key];
    const text = stringifyInline(raw);
    if (!text) continue;

    let label = humanizeKey(key);
    if (toolLower.includes("send_message") && key === "target") label = "to";
    if (toolLower.includes("read_history") && key === "channel") label = "from";
    if ((toolLower.includes("read") || toolLower.includes("write") || toolLower.includes("edit")) && key === "path") {
      label = "file";
    }
    if (toolLower.includes("execute") && key === "command") label = "cmd";

    parts.push({ label, value: truncateInline(text) });
  }

  if (parts.length > 0) return parts.slice(0, 3);

  for (const [key, raw] of Object.entries(record)) {
    const text = stringifyInline(raw);
    if (!text) continue;
    parts.push({ label: humanizeKey(key), value: truncateInline(text) });
    if (parts.length >= 2) break;
  }

  return parts;
}

export type ToolHeaderProps = {
  name: string;
  state: ToolState;
  input?: unknown;
  meta?: ReactNode;
  className?: string;
};

export const ToolHeader = ({
  className,
  name,
  state,
  input,
  meta,
}: ToolHeaderProps) => {
  const icon = TOOL_ICONS[name];
  const summaryParts = getToolSummaryParts(name, input);

  return (
    <CollapsibleTrigger className={cn("flex items-center gap-1.5 text-sm group", className)}>
      {icon ? (
        <span className="text-muted-foreground shrink-0">{icon}</span>
      ) : (
        <span className="size-2 rounded-full bg-muted-foreground/60 shrink-0" />
      )}
      <span className="text-primary font-medium">{name}</span>
      {summaryParts.length > 0 && (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground group-data-[state=open]:hidden">
          {summaryParts.map((part) => (
            <span key={`${part.label}:${part.value}`} className="truncate">
              <span className="text-zinc-400">{part.label}</span>{" "}
              <span>{part.value}</span>
            </span>
          ))}
        </span>
      )}
      {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
      <span className="ml-0.5">{getStatusIcon(state)}</span>
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent className={cn("pl-4 mt-1 text-sm", className)} {...props} />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: unknown;
};

/** Render tool input as structured key/value pairs */
export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const params = useMemo(() => {
    if (!input || typeof input !== "object") return [];
    return Object.entries(input as Record<string, unknown>);
  }, [input]);

  if (params.length === 0) return null;

  return (
    <div className={cn("space-y-1 text-xs font-mono", className)} {...props}>
      {params.map(([key, value]) => {
        const strValue = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        const isLong = strValue.length > 120 || strValue.includes("\n");

        if (isLong) {
          return <LongParam key={key} paramKey={key} value={strValue} />;
        }

        return (
          <div key={key} className="flex items-baseline gap-2">
            <span className="text-muted-foreground shrink-0 select-none">{key}</span>
            <span className="text-foreground/80">{strValue}</span>
          </div>
        );
      })}
    </div>
  );
};

const LongParam = ({ paramKey, value }: { paramKey: string; value: string }) => {
  const [expanded, setExpanded] = useState(false);
  const preview = value.split("\n")[0]?.slice(0, 80) ?? "";

  return (
    <div className="space-y-1">
      <div
        className="flex items-baseline gap-2 cursor-pointer group"
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        role="button"
        tabIndex={0}
      >
        <span className="text-muted-foreground shrink-0 select-none">{paramKey}</span>
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-200",
            expanded && "rotate-90",
          )}
        />
        {!expanded && (
          <span className="text-foreground/40 truncate group-hover:text-foreground/60">
            {preview}{value.length > 80 ? "..." : ""}
          </span>
        )}
      </div>
      {expanded && (
        <div className="ml-4">
          <CodeBlock code={value} language="text" />
        </div>
      )}
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output?: string;
  isError?: boolean;
};

/** Render tool output or error */
export const ToolOutput = ({
  className,
  output,
  isError,
  ...props
}: ToolOutputProps) => {
  if (!output) return null;

  return (
    <div className={cn("mt-1 space-y-1", className)} {...props}>
      <div className="text-xs font-mono">
        <span className={isError ? "text-destructive" : "text-muted-foreground"}>
          {isError ? "error:" : "result:"}
        </span>
        <div className={cn("ml-4 mt-0.5 rounded text-xs", isError && "text-destructive")}>
          {output.length > 200 ? (
            <CodeBlock code={output} language="text" />
          ) : (
            <pre className="whitespace-pre-wrap text-xs text-foreground/80">{output}</pre>
          )}
        </div>
      </div>
    </div>
  );
};
