"use client";

export function getWindowStorage(kind: "local" | "session"): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function safeStorageGetItem(
  storage: Storage | null | undefined,
  key: string,
): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function safeStorageSetItem(
  storage: Storage | null | undefined,
  key: string,
  value: string,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeStorageRemoveItem(
  storage: Storage | null | undefined,
  key: string,
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function readJsonStorageValue<T>(
  storage: Storage | null | undefined,
  key: string,
  decode: (value: unknown) => T | null,
  fallback: T,
  onError?: (error: unknown) => void,
): T {
  const raw = safeStorageGetItem(storage, key);
  if (!raw) return fallback;

  try {
    const decoded = decode(JSON.parse(raw));
    return decoded ?? fallback;
  } catch (error) {
    onError?.(error);
    return fallback;
  }
}

export function writeJsonStorageValue(
  storage: Storage | null | undefined,
  key: string,
  value: unknown,
): boolean {
  return safeStorageSetItem(storage, key, JSON.stringify(value));
}
