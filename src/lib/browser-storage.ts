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

export interface BrowserStorageStore<T> {
  read: () => T;
  write: (value: T) => boolean;
  remove: () => boolean;
  notify: () => void;
  subscribe: (listener: () => void) => () => void;
}

export function createBrowserStorageStore<T>({
  key,
  kind = "local",
  fallback,
  decode,
  encode = String,
}: {
  key: string;
  kind?: "local" | "session";
  fallback: T;
  decode: (raw: string | null) => T | null;
  encode?: (value: T) => string;
}): BrowserStorageStore<T> {
  const changeEvent = `pharos-storage:${key}`;

  function notify() {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new Event(changeEvent));
  }

  function read(): T {
    return decode(safeStorageGetItem(getWindowStorage(kind), key)) ?? fallback;
  }

  function write(value: T): boolean {
    const ok = safeStorageSetItem(getWindowStorage(kind), key, encode(value));
    notify();
    return ok;
  }

  function remove(): boolean {
    const ok = safeStorageRemoveItem(getWindowStorage(kind), key);
    notify();
    return ok;
  }

  function subscribe(listener: () => void) {
    if (typeof window === "undefined") return () => {};

    const handleStorage = (event: StorageEvent) => {
      if (event.key === key) listener();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(changeEvent, listener);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(changeEvent, listener);
    };
  }

  return { read, write, remove, notify, subscribe };
}
