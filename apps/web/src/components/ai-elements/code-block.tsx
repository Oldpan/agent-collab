import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
} from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BundledLanguage, ShikiTransformer } from "shiki";

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
};

type CodeBlockContextType = { code: string };

const CodeBlockContext = createContext<CodeBlockContextType>({ code: "" });

// Shiki lazy-loading
type ShikiModule = typeof import("shiki");
let shikiModulePromise: Promise<ShikiModule> | null = null;
const loadShikiModule = async (): Promise<ShikiModule> => {
  if (!shikiModulePromise) shikiModulePromise = import("shiki");
  return shikiModulePromise;
};

const isBundledLanguage = (
  languages: Record<string, unknown>,
  language: string,
): language is BundledLanguage =>
  Object.prototype.hasOwnProperty.call(languages, language);

type HighlightCacheEntry = { html: string };
const highlightCache = new Map<string, HighlightCacheEntry>();

function makeLineNumberTransformer(): ShikiTransformer {
  return {
    name: "line-numbers",
    line(node, line) {
      node.children.unshift({
        type: "element",
        tagName: "span",
        properties: {
          className: ["inline-block", "min-w-10", "mr-4", "text-right", "select-none", "text-zinc-500"],
        },
        children: [{ type: "text", value: String(line) }],
      });
    },
  };
}

async function highlightCode(
  code: string,
  language: string,
  showLineNumbers = false,
): Promise<HighlightCacheEntry | null> {
  const { bundledLanguages, codeToHtml } = await loadShikiModule();
  if (!isBundledLanguage(bundledLanguages, language)) return null;

  const transformers: ShikiTransformer[] = showLineNumbers ? [makeLineNumberTransformer()] : [];

  const html = await codeToHtml(code, { lang: language, theme: "github-light", transformers });
  return { html };
}

const COLLAPSE_THRESHOLD = 300;

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  ...props
}: CodeBlockProps) => {
  const [html, setHtml] = useState("");
  const [isTall, setIsTall] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const checkOverflow = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) setIsTall(el.scrollHeight > COLLAPSE_THRESHOLD);
  }, []);

  useLayoutEffect(() => {
    checkOverflow();
  }, [checkOverflow, html]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(checkOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [checkOverflow]);

  const copyText = code ?? "";

  const cacheKey = useMemo(() => {
    if (!language) return null;
    return `${language}|${showLineNumbers}|${code}`;
  }, [code, language, showLineNumbers]);

  useEffect(() => {
    let cancelled = false;
    setHtml("");
    if (!language || !cacheKey) return () => { cancelled = true; };

    const cached = highlightCache.get(cacheKey);
    if (cached) {
      setHtml(cached.html);
      return () => { cancelled = true; };
    }

    highlightCode(code, language, showLineNumbers).then((result) => {
      if (cancelled || !result) return;
      highlightCache.set(cacheKey, result);
      setHtml(result.html);
    });

    return () => { cancelled = true; };
  }, [cacheKey, code, language, showLineNumbers]);

  const contentClassName = [
    "[&>pre]:m-0", "[&>pre]:whitespace-pre",
    "[&>pre]:p-3", "[&>pre]:text-xs",
    "[&_code]:font-mono", "[&_code]:text-xs",
  ].join(" ");

  return (
    <CodeBlockContext.Provider value={{ code: copyText }}>
      <div
        className={cn(
          "group relative w-full overflow-hidden rounded-md border-2 border-zinc-900 bg-[#f6f8fa] shadow-[2px_2px_0_0_rgba(0,0,0,0.1)]",
          className,
        )}
        {...props}
      >
        {/* Action buttons */}
        <div className="hover-reveal absolute top-1.5 right-1.5 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Tooltip>
            <TooltipTrigger asChild>
              <CodeBlockCopyButton />
            </TooltipTrigger>
            <TooltipContent className="px-1.5 py-0.5">
              <p className="text-[12px]">Copy</p>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Content */}
        <div className="relative">
          <div
            ref={scrollContainerRef}
            className={cn(
              "overflow-auto",
              isTall && !isExpanded ? "max-h-[200px] overflow-hidden" : "max-h-[60vh]",
            )}
          >
            <div className="relative">
              {html ? (
                <div className={contentClassName} dangerouslySetInnerHTML={{ __html: html }} />
              ) : (
                <div className={contentClassName}>
                  <pre><code>{copyText}</code></pre>
                </div>
              )}
            </div>
          </div>
          {/* Gradient fade */}
          {isTall && !isExpanded && (
            <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[#f6f8fa] to-transparent pointer-events-none" />
          )}
        </div>

        {/* Expand toggle */}
        {isTall && (
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1 border-t border-zinc-900 bg-[#fffdf4] py-1 text-xs text-zinc-600 cursor-pointer hover:text-zinc-900 hover:bg-[#fff1a9] transition-colors"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            <ChevronDownIcon className={cn("size-3 transition-transform", isExpanded && "rotate-180")} />
            {isExpanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </CodeBlockContext.Provider>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  timeout = 2000,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const { code } = useContext(CodeBlockContext);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), timeout);
    } catch {
      // Clipboard unavailable
    }
  };

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={handleCopy}
      size="icon-xs"
      variant="ghost"
      {...props}
    >
      <Icon className="size-3.5" />
    </Button>
  );
};
