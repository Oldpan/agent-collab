import { cn } from "@/lib/utils";
import type { Element } from "hast";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import type { StreamdownProps } from "streamdown";
import { defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import { CodeBlock } from "./code-block";

// Safe rehype plugins (no raw HTML rendering)
// 只使用当前 streamdown 版本实际导出的插件
export const safeRehypePlugins: StreamdownProps["rehypePlugins"] = [
  defaultRehypePlugins.sanitize,
].filter(Boolean);

// Remark plugins — 只使用已有的 gfm 和 codeMeta
export const safeRemarkPlugins: StreamdownProps["remarkPlugins"] = [
  defaultRemarkPlugins.gfm,
  defaultRemarkPlugins.codeMeta,
].filter(Boolean);

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

type StreamdownCodeProps = ComponentProps<"code"> & { node?: Element };

const StreamdownCode = ({ className, children, node, ...props }: StreamdownCodeProps) => {
  const isInline = node?.position?.start?.line === node?.position?.end?.line;

  if (isInline) {
    return (
      <code
        className={cn("rounded bg-secondary px-1 py-0.5 font-mono text-xs", className)}
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

const StreamdownPre = ({ children }: ComponentProps<"pre">) => children;

export const streamdownComponents: StreamdownProps["components"] = {
  code: StreamdownCode,
  pre: StreamdownPre,
};
