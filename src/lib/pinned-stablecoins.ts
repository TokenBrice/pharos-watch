import { CLIENT_ACTIVE_IDS as ACTIVE_IDS } from "@shared/lib/stablecoins/client-registry";

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
