import { getBlacklistPriceAssetId } from "@shared/lib/blacklist";
import type { BlacklistStablecoin } from "@shared/types/market";
import type { BlacklistRow } from "./shared";

export function buildLatestBlacklistRows(rows: readonly BlacklistRow[]): BlacklistRow[] {
  const latestByAddress = new Map<string, BlacklistRow>();
  const orderedRows = [...rows].sort((left, right) =>
    left.timestamp === right.timestamp ? left.id.localeCompare(right.id) : left.timestamp - right.timestamp,
  );

  for (const row of orderedRows) {
    latestByAddress.set(row.address.toLowerCase(), row);
  }

  return Array.from(latestByAddress.values());
}

export async function fetchBlacklistAssetPriceFromCache(
  db: D1Database,
  stablecoin: BlacklistStablecoin,
): Promise<number | null> {
  const assetId = getBlacklistPriceAssetId(stablecoin);
  if (!assetId) return null;
  const row = await db
    .prepare("SELECT price FROM price_cache WHERE asset_id = ? LIMIT 1")
    .bind(assetId)
    .first<{ price: number }>();
  return row?.price ?? null;
}
