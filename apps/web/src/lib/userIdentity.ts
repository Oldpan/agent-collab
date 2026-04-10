import { useEffect, useState } from "react";

const USER_AVATAR_URL_KEY = "agent-collab.user-avatar-url";
const USER_DISPLAY_NAME_KEY = "agent-collab.user-display-name";
const LEGACY_USER_IDENTITY_KEY = "agent-collab:user-identity";
const USER_IDENTITY_CHANGED_EVENT = "agent-collab:user-identity-changed";
const MAX_AVATAR_DIMENSION = 256;
const AVATAR_OUTPUT_QUALITY = 0.9;

export type UserIdentity = {
  name: string;
  avatarUrl: string | null;
};

export function readStoredUserIdentity(): UserIdentity {
  if (typeof window === "undefined") {
    return { name: "You", avatarUrl: null };
  }

  const rawName = window.localStorage.getItem(USER_DISPLAY_NAME_KEY);
  const rawAvatarUrl = window.localStorage.getItem(USER_AVATAR_URL_KEY);
  let legacyName: string | null = null;
  try {
    const legacy = JSON.parse(window.localStorage.getItem(LEGACY_USER_IDENTITY_KEY) ?? "{}") as { name?: string };
    legacyName = typeof legacy.name === "string" ? legacy.name : null;
  } catch {
    legacyName = null;
  }

  return {
    name: rawName?.trim() || legacyName?.trim() || "You",
    avatarUrl: rawAvatarUrl?.trim() || null,
  };
}

export function useStoredUserIdentity(): UserIdentity {
  const [identity, setIdentity] = useState<UserIdentity>(() => readStoredUserIdentity());

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const refresh = () => setIdentity(readStoredUserIdentity());
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key == null
        || event.key === USER_AVATAR_URL_KEY
        || event.key === USER_DISPLAY_NAME_KEY
        || event.key === LEGACY_USER_IDENTITY_KEY
      ) {
        refresh();
      }
    };
    window.addEventListener(USER_IDENTITY_CHANGED_EVENT, refresh);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(USER_IDENTITY_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  return identity;
}

export function writeStoredUserIdentity(update: Partial<UserIdentity>): UserIdentity {
  const current = readStoredUserIdentity();
  const next: UserIdentity = {
    name: Object.prototype.hasOwnProperty.call(update, "name") ? (update.name?.trim() || "You") : current.name,
    avatarUrl: Object.prototype.hasOwnProperty.call(update, "avatarUrl") ? (update.avatarUrl?.trim() || null) : current.avatarUrl,
  };

  if (typeof window === "undefined") return next;

  if (Object.prototype.hasOwnProperty.call(update, "name")) {
    const trimmed = update.name?.trim();
    if (trimmed) {
      window.localStorage.setItem(USER_DISPLAY_NAME_KEY, trimmed);
    } else {
      window.localStorage.removeItem(USER_DISPLAY_NAME_KEY);
    }
  }

  if (Object.prototype.hasOwnProperty.call(update, "avatarUrl")) {
    const trimmed = update.avatarUrl?.trim();
    if (trimmed) {
      window.localStorage.setItem(USER_AVATAR_URL_KEY, trimmed);
    } else {
      window.localStorage.removeItem(USER_AVATAR_URL_KEY);
    }
  }

  try {
    const legacy = JSON.parse(window.localStorage.getItem(LEGACY_USER_IDENTITY_KEY) ?? "{}") as { name?: string };
    const legacyName = next.name && next.name !== "You" ? next.name : (typeof legacy.name === "string" ? legacy.name : undefined);
    if (legacyName) {
      window.localStorage.setItem(LEGACY_USER_IDENTITY_KEY, JSON.stringify({ ...legacy, name: legacyName }));
    }
  } catch {
    if (next.name && next.name !== "You") {
      window.localStorage.setItem(LEGACY_USER_IDENTITY_KEY, JSON.stringify({ name: next.name }));
    }
  }

  window.dispatchEvent(new Event(USER_IDENTITY_CHANGED_EVENT));
  return next;
}

export function clearStoredUserAvatar(): UserIdentity {
  return writeStoredUserIdentity({ avatarUrl: null });
}

export async function createStoredAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file.");
  }

  const sourceDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(sourceDataUrl);
  const { width, height } = fitWithinBounds(image.width, image.height, MAX_AVATAR_DIMENSION);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return sourceDataUrl;

  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/webp", AVATAR_OUTPUT_QUALITY);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read the selected image."));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read the selected image."));
    };
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load the selected image."));
    image.src = src;
  });
}

function fitWithinBounds(width: number, height: number, maxDimension: number): { width: number; height: number } {
  if (width <= maxDimension && height <= maxDimension) {
    return { width, height };
  }
  const scale = Math.min(maxDimension / width, maxDimension / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
