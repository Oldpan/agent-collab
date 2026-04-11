const DRAFT_STORAGE_PREFIX = "agent-collab.draft.";

function getDraftStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getDraftStorageKey(draftKey: string): string {
  return `${DRAFT_STORAGE_PREFIX}${draftKey}`;
}

export function readDraft(draftKey?: string | null): string {
  if (!draftKey) return "";
  const storage = getDraftStorage();
  if (!storage) return "";
  try {
    return storage.getItem(getDraftStorageKey(draftKey)) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(draftKey: string | null | undefined, text: string): void {
  if (!draftKey) return;
  const storage = getDraftStorage();
  if (!storage) return;
  try {
    if (text.length === 0) {
      storage.removeItem(getDraftStorageKey(draftKey));
      return;
    }
    storage.setItem(getDraftStorageKey(draftKey), text);
  } catch {
    // Ignore storage failures and keep the draft in memory only.
  }
}

export function clearDraft(draftKey?: string | null): void {
  if (!draftKey) return;
  const storage = getDraftStorage();
  if (!storage) return;
  try {
    storage.removeItem(getDraftStorageKey(draftKey));
  } catch {
    // Ignore storage failures.
  }
}
