"use client";

import { useCallback, useEffect, useState } from "react";
import { getWindowStorage } from "@/lib/browser-storage";
import { readJsonStorageValue, writeJsonStorageValue } from "@/lib/url-storage-codecs";

const STORAGE_KEY = "pharos:yield-watchlist:v1";

export interface YieldWatchlistState {
  ids: ReadonlySet<string>;
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  add: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  isHydrated: boolean;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function loadFromStorage(): string[] {
  const storage = getWindowStorage("local");
  return readJsonStorageValue(
    storage,
    STORAGE_KEY,
    (parsed) => (isStringArray(parsed) ? Array.from(new Set(parsed)) : []),
    [],
    (error) => console.warn("[useYieldWatchlist] Failed to parse stored watchlist, resetting:", error),
  );
}

function saveToStorage(ids: ReadonlySet<string>): void {
  writeJsonStorageValue(getWindowStorage("local"), STORAGE_KEY, Array.from(ids));
}

// WHY: every star, preset chip, and filter share one watchlist. A module-level store
// lets sibling hook instances mirror the same Set without a Context provider, and the
// storage event keeps a second tab in sync.
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
let sharedIds: ReadonlySet<string> = EMPTY_IDS;
const listeners = new Set<(ids: ReadonlySet<string>) => void>();

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function broadcast(next: ReadonlySet<string>) {
  sharedIds = next;
  for (const listener of listeners) listener(next);
}

function syncFromStorage() {
  if (typeof window === "undefined") return;
  const next = new Set(loadFromStorage());
  if (!setsEqual(sharedIds, next)) broadcast(next);
}

function mutateShared(updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) {
  const next = updater(sharedIds);
  if (next === sharedIds) return;
  saveToStorage(next);
  broadcast(next);
}

export function useYieldWatchlist(): YieldWatchlistState {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => {
    if (typeof window === "undefined") return EMPTY_IDS;
    syncFromStorage();
    return sharedIds;
  });
  const isHydrated = typeof window !== "undefined";

  useEffect(() => {
    listeners.add(setIds);
    syncFromStorage();
    function onStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY) return;
      syncFromStorage();
    }
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(setIds);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const has = useCallback((id: string) => ids.has(id), [ids]);

  const toggle = useCallback((id: string) => {
    mutateShared((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const add = useCallback((id: string) => {
    mutateShared((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    mutateShared((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    mutateShared((prev) => (prev.size === 0 ? prev : EMPTY_IDS));
  }, []);

  return { ids, has, toggle, add, remove, clear, isHydrated };
}
