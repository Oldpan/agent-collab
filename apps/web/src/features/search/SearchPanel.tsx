import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MenuIcon, SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { searchMessages, type SearchMessageHit } from "@/lib/api";

type SearchPanelProps = {
  onClose: () => void;
  onOpenResult: (result: SearchMessageHit) => void;
  onOpenSidebar?: () => void;
};

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const diffMs = ts - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  if (Math.abs(diffMinutes) < 60) return relativeTimeFormatter.format(diffMinutes, "minute");
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return relativeTimeFormatter.format(diffHours, "hour");
  const diffDays = Math.round(diffHours / 24);
  return relativeTimeFormatter.format(diffDays, "day");
}

function renderMarkedSnippet(input: string): ReactNode[] {
  const parts = input.split(/(\[\[.*?\]\])/g);
  return parts.filter(Boolean).map((part, index) => {
    const match = /^\[\[(.*)\]\]$/.exec(part);
    if (!match) return part;
    return (
      <mark key={`mark-${index}`} className="bg-[#ffd400] px-0.5 text-zinc-950">
        {match[1]}
      </mark>
    );
  });
}

function SearchResultRow({ result, onOpen }: { result: SearchMessageHit; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-none border-2 border-zinc-900 bg-white px-3.5 py-2.5 text-left shadow-[0_2px_0_0_rgba(0,0,0,0.08)] transition-colors hover:bg-[#fff8d8] cursor-pointer"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
        <span className="font-semibold text-zinc-700">@{result.senderName}</span>
        <span>{formatRelativeTime(result.createdAt)}</span>
        <span className="uppercase tracking-[0.18em] text-zinc-400">#{result.channelName}</span>
        {result.threadRootId ? (
          <span className="rounded border border-zinc-400 bg-[#fff4bf] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-700">
            thread {result.threadRootId}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-zinc-700">
        {renderMarkedSnippet(result.snippet || result.content)}
      </div>
    </button>
  );
}

export function SearchPanel({ onClose, onOpenResult, onOpenSidebar }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchMessageHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setError(null);
    setLoading(true);
    const timer = window.setTimeout(() => {
      void searchMessages(trimmed, 20, controller.signal)
        .then((data) => {
          setResults(data.results);
          setLoading(false);
        })
        .catch((err) => {
          if ((err as Error).name === "AbortError") return;
          setError((err as Error)?.message ?? "Search failed");
          setLoading(false);
        });
    }, 200);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  const resultCountLabel = useMemo(() => {
    if (query.trim().length < 2) return "TYPE AT LEAST 2 CHARACTERS";
    if (loading) return "SEARCHING";
    return `${results.length} RESULT${results.length === 1 ? "" : "S"}`;
  }, [loading, query, results.length]);

  return (
    <div className="flex h-full flex-col bg-[#f7efd8] text-zinc-950">
      <div className="border-b-2 border-black bg-[#fffdf5] px-3.5 py-2.5 shadow-[0_2px_0_0_rgba(0,0,0,0.08)]">
        <div className="flex items-center gap-2.5">
          {onOpenSidebar ? (
            <button
              type="button"
              className="shrink-0 rounded-md border-2 border-zinc-900 bg-[#fff9d8] p-1 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] hover:bg-[#fff1a9] cursor-pointer md:hidden"
              onClick={onOpenSidebar}
              aria-label="Open sidebar"
            >
              <MenuIcon className="size-4 text-zinc-700" />
            </button>
          ) : null}
          <div className="flex size-10 shrink-0 items-center justify-center border-2 border-zinc-900 bg-[#ffd400] shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]">
            <SearchIcon className="size-4.5 text-zinc-900" />
          </div>
          <div className="flex min-w-0 flex-1 items-stretch border-2 border-zinc-900 bg-white shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]">
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search messages"
              className="min-w-0 flex-1 bg-transparent px-3.5 py-2 text-[13px] outline-none placeholder:text-zinc-400"
            />
            <button
              type="button"
              onClick={onClose}
              className="m-1.5 inline-flex size-7 items-center justify-center border-2 border-zinc-900 bg-[#fffdf5] text-zinc-900 hover:bg-[#fff1a9] cursor-pointer"
              aria-label="Close search"
            >
              <XIcon className="size-3.5" />
            </button>
            <div className="m-1.5 inline-flex items-center justify-center border-2 border-zinc-400 px-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              Esc
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3.5 py-3.5">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
          {resultCountLabel}
        </div>

        {query.trim().length < 2 ? (
          <div className="rounded-md border-2 border-dashed border-zinc-900/30 bg-[#fff8d8] px-3.5 py-4 text-[13px] text-zinc-500 shadow-[2px_2px_0_0_rgba(0,0,0,0.05)]">
            Search across visible channels and thread replies.
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border-2 border-red-300 bg-red-50 px-3.5 py-3 text-[13px] text-red-700">
            {error}
          </div>
        ) : null}

        {!error && query.trim().length >= 2 && !loading && results.length === 0 ? (
          <div className="rounded-md border-2 border-zinc-900/20 bg-[#fff8d8] px-3.5 py-4 text-[13px] text-zinc-500 shadow-[2px_2px_0_0_rgba(0,0,0,0.05)]">
            No matching messages.
          </div>
        ) : null}

        <div className={cn("space-y-3", loading && "opacity-70")}>
          {results.map((result) => (
            <SearchResultRow
              key={`${result.channelId}:${result.messageId}`}
              result={result}
              onOpen={() => onOpenResult(result)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
