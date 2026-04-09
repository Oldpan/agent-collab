import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import type { StreamdownProps } from "streamdown";
import { defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import { CodeBlock } from "./code-block";

// Safe rehype plugins (no raw HTML rendering)
export const safeRehypePlugins: StreamdownProps["rehypePlugins"] = [
  defaultRehypePlugins.sanitize,
].filter(Boolean) as NonNullable<StreamdownProps["rehypePlugins"]>;

// Remark plugins
export const safeRemarkPlugins: StreamdownProps["remarkPlugins"] = [
  defaultRemarkPlugins.gfm,
  defaultRemarkPlugins.codeMeta,
].filter(Boolean) as NonNullable<StreamdownProps["remarkPlugins"]>;

/** Escape HTML-like tags outside code blocks to prevent XSS */
export const escapeHtmlOutsideCodeBlocks = (text: string): string => {
  const codeBlockRegex =
    /(^|\n)```[a-z]*\n[\s\S]*?\n```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$(?!\s)[^$\n]+(?<!\s)\$/g;
  const codeBlocks: { start: number; end: number }[] = [];

  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const startsWithNewline = match[0].startsWith("\n");
    const start = startsWithNewline ? match.index + 1 : match.index;
    codeBlocks.push({ start, end: match.index + match[0].length });
  }

  const escapeForMarkdown = (str: string): string => {
    let result = str.replace(/<(?=[a-zA-Z/!?])/g, "\uFF1C");
    result = result.replace(/(?<!^)(?<![-=])>/gm, "\uFF1E");
    return result;
  };

  const result: string[] = [];
  let lastEnd = 0;

  for (const block of codeBlocks) {
    result.push(escapeForMarkdown(text.slice(lastEnd, block.start)));
    result.push(text.slice(block.start, block.end));
    lastEnd = block.end;
  }
  result.push(escapeForMarkdown(text.slice(lastEnd)));

  return result.join("");
};

// Prevent margin collapse issues with Virtuoso height measurement
export const streamdownRootClass = [
  "flow-root",
  "[&_p]:m-0", "[&_h1]:m-0", "[&_h2]:m-0", "[&_h3]:m-0",
  "[&_h4]:m-0", "[&_h5]:m-0", "[&_h6]:m-0",
  "[&_ul]:m-0", "[&_ol]:m-0", "[&_li]:m-0",
  "[&_blockquote]:m-0", "[&_hr]:m-0", "[&_pre]:m-0",
].join(" ");

const LANGUAGE_CLASS_RE = /language-([^\s]+)/;

const getCodeLanguage = (className?: string): string | undefined => {
  const match = className?.match(LANGUAGE_CLASS_RE);
  return match?.[1];
};

const getCodeText = (children: ReactNode): string => {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(getCodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return getCodeText(children.props.children);
  }
  return "";
};

type StreamdownCodeProps = ComponentProps<"code"> & { node?: { position?: { start?: { line?: number }; end?: { line?: number } } } };

const StreamdownCode = ({ className, children, node, ...props }: StreamdownCodeProps) => {
  const isInline = node?.position?.start?.line === node?.position?.end?.line;

  if (isInline) {
    return (
      <code
        className={cn(
          "rounded-sm border border-zinc-900 bg-[#fef08a] px-1 py-0.5 font-mono text-[0.8em] font-medium text-zinc-950",
          className,
        )}
        data-streamdown="inline-code"
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <CodeBlock
      className={cn("my-2", className)}
      code={getCodeText(children)}
      language={getCodeLanguage(className)}
      {...props}
    />
  );
};

const StreamdownPre = ({ children }: Record<string, unknown>) => children as ReactNode;

const StreamdownTable = ({ className, children, ...props }: ComponentProps<"table">) => (
  <table
    className={cn("my-2 w-full border-collapse border-2 border-zinc-900 text-sm", className)}
    {...props}
  >
    {children}
  </table>
);

const StreamdownTh = ({ className, children, ...props }: ComponentProps<"th">) => (
  <th
    className={cn("border-2 border-zinc-900 bg-[#22d3ee] px-3 py-1.5 text-left font-bold text-zinc-950", className)}
    {...props}
  >
    {children}
  </th>
);

const StreamdownTd = ({ className, children, ...props }: ComponentProps<"td">) => (
  <td
    className={cn("border-2 border-zinc-900 bg-white px-3 py-1.5 text-zinc-900", className)}
    {...props}
  >
    {children}
  </td>
);

export const streamdownComponents: StreamdownProps["components"] = {
  code: StreamdownCode,
  pre: StreamdownPre as any,
  table: StreamdownTable,
  th: StreamdownTh,
  td: StreamdownTd,
};
