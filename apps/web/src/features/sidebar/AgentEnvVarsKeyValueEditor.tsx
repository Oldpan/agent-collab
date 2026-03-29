import { useEffect, useMemo, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type EnvVarRow = {
  id: string;
  key: string;
  value: string;
};

type Props = {
  value?: Record<string, string>;
  onChange: (value: Record<string, string> | undefined) => void;
  editorKey: string;
  className?: string;
};

function rowsFromEnvVars(envVars?: Record<string, string>): EnvVarRow[] {
  return Object.entries(envVars ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value], index) => ({
      id: `${key}-${index}`,
      key,
      value,
    }));
}

function nextRowId() {
  return `env-${Math.random().toString(36).slice(2, 10)}`;
}

export function AgentEnvVarsKeyValueEditor({ value, onChange, editorKey, className }: Props) {
  const [rows, setRows] = useState<EnvVarRow[]>(() => rowsFromEnvVars(value));

  useEffect(() => {
    setRows(rowsFromEnvVars(value));
  }, [editorKey, value]);

  const hasDuplicateKeys = useMemo(() => {
    const seen = new Set<string>();
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  }, [rows]);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      next[key] = row.value;
    }
    onChange(Object.keys(next).length > 0 ? next : undefined);
  }, [onChange, rows]);

  const updateRow = (id: string, patch: Partial<EnvVarRow>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
  };

  const addRow = () => {
    setRows((prev) => [...prev, { id: nextRowId(), key: "", value: "" }]);
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div className="rounded-sm border-2 border-zinc-900 bg-[#fff8d8] p-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium text-zinc-700">Environment Variables</div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]"
            onClick={addRow}
          >
            <PlusIcon className="mr-1 size-3" />
            Add variable
          </Button>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-sm border border-dashed border-zinc-900/30 bg-white px-2 py-3 text-[11px] text-zinc-500">
            No environment variables yet.
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
                <input
                  className="rounded-sm border-2 border-zinc-900 bg-white px-2 py-1.5 text-[11px] font-mono"
                  placeholder="KEY"
                  value={row.key}
                  onChange={(event) =>
                    updateRow(row.id, { key: event.target.value.replace(/\s+/g, "_").toUpperCase() })
                  }
                />
                <input
                  className="rounded-sm border-2 border-zinc-900 bg-white px-2 py-1.5 text-[11px] font-mono"
                  placeholder="value"
                  value={row.value}
                  onChange={(event) => updateRow(row.id, { value: event.target.value })}
                />
                <Button
                  type="button"
                  size="icon-xs"
                  variant="outline"
                  className="rounded-sm border-2 border-zinc-900 bg-white hover:bg-[#fff1a9]"
                  onClick={() => removeRow(row.id)}
                  title="Remove variable"
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
          <span>Edit each key and value directly here.</span>
          {hasDuplicateKeys && (
            <span className="rounded-sm border border-amber-300/60 bg-amber-50 px-1.5 py-0.5 text-amber-900">
              Duplicate keys: last value wins
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
