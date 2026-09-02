import {
  createCachedJsonStorageStore,
  readJsonStorageValue,
  safeStorageRemoveItem,
  writeJsonStorageValue,
} from "@/lib/browser-storage";

export const WATCHLIST_STORAGE_KEY = "pharos-watchlist-v1";
const LEGACY_PINNED_KEY = "pharos-pinned-stablecoins";
const LEGACY_YIELD_KEY = "pharos:yield-watchlist:v1";
export const EMPTY_WATCHLIST_IDS: readonly string[] = Object.freeze([]);

function normalize(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === "string" && entry.length > 0)) return [];
  return Array.from(new Set(raw));
}

function readLegacy(storage: Storage | null, key: string): string[] {
  return readJsonStorageValue(storage, key, normalize, []);
}

function migrateLegacyWatchlist(storage: Storage): string[] {
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

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b || a.length !== b.length) return a === b;
  return a.every((id, index) => id === b[index]);
}

const watchlistStore = createCachedJsonStorageStore<readonly string[]>({
  key: WATCHLIST_STORAGE_KEY,
  fallback: EMPTY_WATCHLIST_IDS,
  decode: normalize,
  migrate: migrateLegacyWatchlist,
  isEqual: arraysEqual,
});

export function mutateWatchlist(updater: (previous: readonly string[]) => readonly string[]): void {
  const previous = readWatchlistSnapshot();
  const next = updater(previous);
  if (next === previous || arraysEqual(previous, next)) return;
  watchlistStore.write(next);
}

export function subscribeWatchlist(listener: () => void): () => void {
  return watchlistStore.subscribe(listener);
}

export function readWatchlistSnapshot(): readonly string[] {
  return watchlistStore.getSnapshot();
}

export const getWatchlistSnapshot = readWatchlistSnapshot;

export function getWatchlistServerSnapshot(): readonly string[] {
  return watchlistStore.getServerSnapshot();
}
