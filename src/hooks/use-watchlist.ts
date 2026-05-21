"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  getWindowStorage,
  readJsonStorageValue,
  safeStorageGetItem,
  writeJsonStorageValue,
} from "@/lib/browser-storage";

// WHY: a single watchlist persists across screener, yield, alt-pegs, and compare.
// Sibling components subscribe via useSyncExternalStore so toggles in one place
// reflect everywhere without a Context provider, and the storage event keeps a
// second tab in sync.

export const WATCHLIST_STORAGE_KEY = "pharos-watchlist-v1";
const LEGACY_PINNED_KEY = "pharos-pinned-stablecoins";
const LEGACY_YIELD_KEY = "pharos:yield-watchlist:v1";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function normalize(raw: unknown): string[] {
  if (!isStringArray(raw)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of raw) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function readLegacy(storage: Storage | null, key: string): string[] {
  return readJsonStorageValue(storage, key, normalize, []);
}

function loadFromStorage(): string[] {
  const storage = getWindowStorage("local");
  if (!storage) return [];

  const fresh = safeStorageGetItem(storage, WATCHLIST_STORAGE_KEY);
  if (fresh !== null) {
    return readJsonStorageValue(storage, WATCHLIST_STORAGE_KEY, normalize, []);
  }

  // One-time migration: merge legacy keys into the canonical key.
  const legacyPinned = readLegacy(storage, LEGACY_PINNED_KEY);
  const legacyYield = readLegacy(storage, LEGACY_YIELD_KEY);
  const merged = normalize([...legacyPinned, ...legacyYield]);
  writeJsonStorageValue(storage, WATCHLIST_STORAGE_KEY, merged);
  return merged;
}

const EMPTY_IDS: readonly string[] = Object.freeze([]);
let sharedIds: readonly string[] = EMPTY_IDS;
const listeners = new Set<() => void>();

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function broadcast(next: readonly string[]) {
  sharedIds = next;
  for (const listener of listeners) listener();
}

function persist(next: readonly string[]) {
  const storage = getWindowStorage("local");
  writeJsonStorageValue(storage, WATCHLIST_STORAGE_KEY, next);
  // Dual-write to legacy keys so external consumers and tests that still read
  // from the old keys continue to work. Single source of truth for reads is
  // still the canonical key; legacy mirrors are write-only echoes.
  writeJsonStorageValue(storage, LEGACY_PINNED_KEY, next);
  writeJsonStorageValue(storage, LEGACY_YIELD_KEY, next);
}

function syncFromStorage() {
  if (typeof window === "undefined") return;
  const next = loadFromStorage();
  if (!arraysEqual(sharedIds, next)) broadcast(next);
}

function mutateShared(updater: (prev: readonly string[]) => readonly string[]) {
  const next = updater(sharedIds);
  if (next === sharedIds || arraysEqual(sharedIds, next)) return;
  persist(next);
  broadcast(next);
}

if (typeof window !== "undefined") {
  sharedIds = loadFromStorage();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): readonly string[] {
  return sharedIds;
}

function getServerSnapshot(): readonly string[] {
  return EMPTY_IDS;
}

export interface WatchlistState {
  ids: readonly string[];
  idSet: ReadonlySet<string>;
  count: number;
  has: (id: string) => boolean;
  add: (id: string) => void;
  remove: (id: string) => void;
  toggle: (id: string) => void;
  clear: () => void;
  isHydrated: boolean;
}

export function useWatchlist(): WatchlistState {
  const ids = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // After the first render commits on the client, useSyncExternalStore is
  // guaranteed to reflect the live store snapshot rather than the SSR-only
  // empty list. We expose that as `isHydrated` for consumers that gate UI on
  // browser-only state.
  const isHydrated = typeof window !== "undefined";

  useEffect(() => {
    syncFromStorage();
    function onStorage(event: StorageEvent) {
      if (event.key !== WATCHLIST_STORAGE_KEY) return;
      syncFromStorage();
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const idSet = useMemo(() => new Set(ids), [ids]);

  const has = useCallback((id: string) => idSet.has(id), [idSet]);

  const add = useCallback((id: string) => {
    mutateShared((prev) => {
      if (prev.includes(id)) return prev;
      return [id, ...prev];
    });
  }, []);

  const remove = useCallback((id: string) => {
    mutateShared((prev) => {
      if (!prev.includes(id)) return prev;
      return prev.filter((entry) => entry !== id);
    });
  }, []);

  const toggle = useCallback((id: string) => {
    mutateShared((prev) => {
      if (prev.includes(id)) return prev.filter((entry) => entry !== id);
      return [id, ...prev];
    });
  }, []);

  const clear = useCallback(() => {
    mutateShared((prev) => (prev.length === 0 ? prev : EMPTY_IDS));
  }, []);

  return { ids, idSet, count: ids.length, has, add, remove, toggle, clear, isHydrated };
}

/**
 * Synchronously read the current watchlist without subscribing. Useful for
 * presets and one-off lookups (e.g. compare-config). SSR returns an empty list.
 */
export function readWatchlistSnapshot(): readonly string[] {
  if (typeof window === "undefined") return EMPTY_IDS;
  // Ensure migration has run even if no hook has mounted yet.
  if (sharedIds === EMPTY_IDS) sharedIds = loadFromStorage();
  return sharedIds;
}
