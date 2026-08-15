import {
  getWindowStorage,
  readJsonStorageValue,
  safeStorageGetItem,
  safeStorageRemoveItem,
  writeJsonStorageValue,
} from "@/lib/browser-storage";

export const WATCHLIST_STORAGE_KEY = "pharos-watchlist-v1";
const LEGACY_PINNED_KEY = "pharos-pinned-stablecoins";
const LEGACY_YIELD_KEY = "pharos:yield-watchlist:v1";
export const EMPTY_WATCHLIST_IDS: readonly string[] = Object.freeze([]);
let sharedIds: readonly string[] = EMPTY_WATCHLIST_IDS;
const listeners = new Set<() => void>();

function normalize(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === "string" && entry.length > 0)) return [];
  return Array.from(new Set(raw));
}

function readLegacy(storage: Storage | null, key: string): string[] {
  return readJsonStorageValue(storage, key, normalize, []);
}

export function loadWatchlistFromStorage(): string[] {
  const storage = getWindowStorage("local");
  if (!storage) return [];

  if (safeStorageGetItem(storage, WATCHLIST_STORAGE_KEY) !== null) {
    return readJsonStorageValue(storage, WATCHLIST_STORAGE_KEY, normalize, []);
  }

  const merged = normalize([
    ...readLegacy(storage, LEGACY_PINNED_KEY),
    ...readLegacy(storage, LEGACY_YIELD_KEY),
  ]);
  if (writeJsonStorageValue(storage, WATCHLIST_STORAGE_KEY, merged)) {
    safeStorageRemoveItem(storage, LEGACY_PINNED_KEY);
    safeStorageRemoveItem(storage, LEGACY_YIELD_KEY);
  }
  return merged;
}

export function persistWatchlistToStorage(ids: readonly string[]): void {
  writeJsonStorageValue(getWindowStorage("local"), WATCHLIST_STORAGE_KEY, ids);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b || a.length !== b.length) return a === b;
  return a.every((id, index) => id === b[index]);
}

function broadcast(next: readonly string[]): void {
  sharedIds = next;
  for (const listener of listeners) listener();
}

export function syncWatchlistFromStorage(): void {
  if (typeof window === "undefined") return;
  const next = loadWatchlistFromStorage();
  if (!arraysEqual(sharedIds, next)) broadcast(next);
}

export function mutateWatchlist(updater: (previous: readonly string[]) => readonly string[]): void {
  const next = updater(readWatchlistSnapshot());
  if (next === sharedIds || arraysEqual(sharedIds, next)) return;
  persistWatchlistToStorage(next);
  broadcast(next);
}

export function subscribeWatchlist(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readWatchlistSnapshot(): readonly string[] {
  if (typeof window === "undefined") return EMPTY_WATCHLIST_IDS;
  if (sharedIds === EMPTY_WATCHLIST_IDS) sharedIds = loadWatchlistFromStorage();
  return sharedIds;
}

export const getWatchlistSnapshot = readWatchlistSnapshot;

export function getWatchlistServerSnapshot(): readonly string[] {
  return EMPTY_WATCHLIST_IDS;
}
