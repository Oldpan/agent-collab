import type { AgentPermissionKind } from "@agent-collab/protocol";
import { cn } from "@/lib/utils";

type Props = {
  value?: AgentPermissionKind[];
  onChange: (value: AgentPermissionKind[] | undefined) => void;
};

const PERMISSION_OPTIONS: Array<{
  kind: AgentPermissionKind;
  label: string;
  description: string;
}> = [
  { kind: "read", label: "Read", description: "Read files in the workspace." },
  { kind: "edit", label: "Edit", description: "Create or modify files." },
  { kind: "delete", label: "Delete", description: "Delete files or folders." },
  { kind: "move", label: "Move", description: "Rename or move files." },
  { kind: "search", label: "Search", description: "Search files and content." },
  { kind: "execute", label: "Execute", description: "Run terminal commands." },
  { kind: "think", label: "Think", description: "Use internal planning tools." },
  { kind: "fetch", label: "Fetch", description: "Access remote web/network tools." },
  { kind: "switch_mode", label: "Switch Mode", description: "Change runtime interaction mode." },
  { kind: "other", label: "Other", description: "Any uncategorized tool calls." },
];

export function AgentPermissionSettings({ value, onChange }: Props) {
  const selected = new Set(value ?? []);

  const toggle = (kind: AgentPermissionKind) => {
    const next = new Set(selected);
    if (next.has(kind)) {
      next.delete(kind);
    } else {
      next.add(kind);
    }
    const out = [...next];
    onChange(out.length > 0 ? out : undefined);
  };

  return (
    <div className="space-y-1.5 rounded-sm border-2 border-zinc-900 bg-[#fff8d8] px-2 py-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-700">
            Disabled Permissions
          </div>
          <div className="text-[10px] text-zinc-500">
            Default is fully allowed. Check only the permissions this agent must not use.
          </div>
        </div>
        <span className="rounded-sm border border-zinc-900/20 bg-white px-1.5 py-0.5 text-[10px] text-zinc-600">
          {selected.size === 0 ? "Allow all" : `${selected.size} blocked`}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {PERMISSION_OPTIONS.map((option) => {
          const checked = selected.has(option.kind);
          return (
            <label
              key={option.kind}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-sm border-2 px-2 py-1.5 text-left transition-colors",
                checked
                  ? "border-zinc-900 bg-[#ffd54a]"
                  : "border-zinc-900/20 bg-white hover:bg-[#fff1a9]",
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5 size-3 shrink-0 accent-zinc-900"
                checked={checked}
                onChange={() => toggle(option.kind)}
              />
              <span className="min-w-0">
                <span className="block text-[11px] font-medium text-zinc-900">
                  {option.label}
                </span>
                <span className="block text-[10px] leading-snug text-zinc-600">
                  {option.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
