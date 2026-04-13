export type SeqMap = Record<string, number>;

export const AGENT_DM_READ_STORAGE_KEY = "agent-collab:agent-dm-read-seqs:v2";
export const CHANNEL_READ_STORAGE_KEY = "agent-collab:channel-read-seqs:v2";
export const RECENT_SOURCE_READ_STORAGE_KEY = "agent-collab:recent-source-read-seqs:v1";

export function readStoredSeqMap(key: string): SeqMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([entryKey, value]) =>
        typeof value === "number" && Number.isFinite(value)
          ? [[entryKey, value]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

export function writeStoredSeqMap(key: string, value: SeqMap): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}
