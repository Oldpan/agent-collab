import { cn } from "@/lib/utils";
import type { UserIdentity } from "@/lib/userIdentity";
import type { AgentInfo } from "@agent-collab/protocol";
import { UserIcon } from "lucide-react";
import { useMemo } from "react";

type ChatAvatarProps = {
  role: "user" | "assistant";
  agent?: AgentInfo | null;
  user?: UserIdentity;
  size?: number;
  className?: string;
};

export function ChatAvatar({
  role,
  agent,
  user,
  size = 40,
  className,
}: ChatAvatarProps) {
  if (role === "user") {
    return <UserAvatar user={user ?? { name: "You", avatarUrl: null }} size={size} className={className} />;
  }

  return (
    <PixelAgentAvatar
      seed={`${agent?.agentId ?? "agent"}:${agent?.name ?? "Agent"}`}
      label={agent?.name ?? "Agent"}
      size={size}
      className={className}
    />
  );
}

function UserAvatar({
  user,
  size,
  className,
}: {
  user: UserIdentity;
  size: number;
  className?: string;
}) {
  const initial = user.name.trim().charAt(0).toUpperCase() || "Y";

  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={user.name}
        className={cn("shrink-0 rounded-sm border-2 border-foreground/90 bg-background object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-sm border-2 border-foreground/90 bg-violet-100 text-foreground shadow-[2px_2px_0_0_rgba(0,0,0,0.16)]",
        className,
      )}
      style={{ width: size, height: size }}
      aria-label={user.name}
      title={user.name}
    >
      <span className="sr-only">{user.name}</span>
      <span className="hidden text-sm font-semibold">{initial}</span>
      <UserIcon className="size-4" />
    </div>
  );
}

function PixelAgentAvatar({
  seed,
  label,
  size,
  className,
}: {
  seed: string;
  label: string;
  size: number;
  className?: string;
}) {
  const { pixels, foreground, background } = useMemo(() => buildPixelAvatar(seed), [seed]);

  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-sm border-[3px] border-foreground bg-background shadow-[3px_3px_0_0_rgba(0,0,0,0.18)]",
        className,
      )}
      style={{ width: size, height: size }}
      title={label}
      aria-label={label}
    >
      <svg viewBox="0 0 8 8" className="size-full" shapeRendering="crispEdges" aria-hidden="true">
        <rect width="8" height="8" fill={background} />
        {pixels.map((active, index) => {
          if (!active) return null;
          const x = index % 8;
          const y = Math.floor(index / 8);
          return <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={foreground} />;
        })}
      </svg>
    </div>
  );
}

function buildPixelAvatar(seed: string): {
  pixels: boolean[];
  foreground: string;
  background: string;
} {
  const palette = [
    { foreground: "#111827", background: "#dbeafe" },
    { foreground: "#0f172a", background: "#fde68a" },
    { foreground: "#1f2937", background: "#bfdbfe" },
    { foreground: "#0b1324", background: "#fecdd3" },
    { foreground: "#111827", background: "#bbf7d0" },
    { foreground: "#172554", background: "#ddd6fe" },
  ];

  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const paletteEntry = palette[Math.abs(hash) % palette.length] ?? palette[0]!;
  const pixels = new Array<boolean>(64).fill(false);

  let state = hash >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const active = (next() & 1) === 1;
      pixels[y * 8 + x] = active;
      pixels[y * 8 + (7 - x)] = active;
    }
  }

  pixels[0] = false;
  pixels[7] = false;
  pixels[56] = false;
  pixels[63] = false;

  return {
    pixels,
    foreground: paletteEntry.foreground,
    background: paletteEntry.background,
  };
}
