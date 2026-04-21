import { ACTIVE_IDS } from "@shared/lib/stablecoins";

export const PINNED_STABLECOINS_STORAGE_KEY = "pharos-pinned-stablecoins";
export const MAX_PINNED_STABLECOINS = 12;

export function normalizePinnedStablecoinIds(
  raw: unknown,
  validIds: ReadonlySet<string> = ACTIVE_IDS,
): string[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const ids: string[] = [];

  for (const value of raw) {
    if (typeof value !== "string") continue;
    if (!validIds.has(value)) continue;
    if (seen.has(value)) continue;

    seen.add(value);
    ids.push(value);
    if (ids.length >= MAX_PINNED_STABLECOINS) break;
  }

  return ids;
}

export function addPinnedStablecoinId(
  pinnedIds: readonly string[],
  stablecoinId: string,
  validIds: ReadonlySet<string> = ACTIVE_IDS,
): string[] {
  if (!validIds.has(stablecoinId)) {
    return normalizePinnedStablecoinIds(pinnedIds, validIds);
  }

  const existing = normalizePinnedStablecoinIds(pinnedIds, validIds).filter((id) => id !== stablecoinId);
  return [stablecoinId, ...existing].slice(0, MAX_PINNED_STABLECOINS);
}

export function removePinnedStablecoinId(
  pinnedIds: readonly string[],
  stablecoinId: string,
  validIds: ReadonlySet<string> = ACTIVE_IDS,
): string[] {
  return normalizePinnedStablecoinIds(pinnedIds, validIds).filter((id) => id !== stablecoinId);
}

export function togglePinnedStablecoinId(
  pinnedIds: readonly string[],
  stablecoinId: string,
  validIds: ReadonlySet<string> = ACTIVE_IDS,
): string[] {
  const normalized = normalizePinnedStablecoinIds(pinnedIds, validIds);
  return normalized.includes(stablecoinId)
    ? removePinnedStablecoinId(normalized, stablecoinId, validIds)
    : addPinnedStablecoinId(normalized, stablecoinId, validIds);
}
