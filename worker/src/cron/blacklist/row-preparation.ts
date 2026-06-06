import {
  buildBlacklistContractBalanceKey,
  getBlacklistPriceAssetId,
} from "@shared/lib/blacklist";
import type { BlacklistStablecoin } from "@shared/types/market";
import type { BlacklistRow } from "./shared";

export const BLACKLIST_PRICE_CACHE_TTL_SEC = 6 * 60 * 60;

export function buildLatestBlacklistRows(rows: readonly BlacklistRow[]): BlacklistRow[] {
  const latestByAddress = new Map<string, BlacklistRow>();
  const orderedRows = [...rows].sort((left, right) =>
    left.timestamp === right.timestamp ? left.id.localeCompare(right.id) : left.timestamp - right.timestamp,
  );

  for (const row of orderedRows) {
    latestByAddress.set(
      buildBlacklistContractBalanceKey(
        row.stablecoin,
        row.chain_id,
        row.address,
        row.config_key,
        row.contract_address,
      ),
      row,
    );
  }

  return Array.from(latestByAddress.values());
}

export async function fetchBlacklistAssetPriceFromCache(
  db: D1Database,
  stablecoin: BlacklistStablecoin,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<number | null> {
  const assetId = getBlacklistPriceAssetId(stablecoin);
  if (!assetId) return null;
  const row = await db
    .prepare("SELECT price, updated_at FROM price_cache WHERE asset_id = ? LIMIT 1")
    .bind(assetId)
    .first<{ price: number; updated_at: number }>();
  if (
    !row ||
    typeof row.price !== "number" ||
    !Number.isFinite(row.price) ||
    row.price <= 0 ||
    typeof row.updated_at !== "number" ||
    !Number.isFinite(row.updated_at) ||
    row.updated_at <= 0
  ) {
    return null;
  }

  const ageSec = nowSec - row.updated_at;
  if (ageSec >= BLACKLIST_PRICE_CACHE_TTL_SEC) {
    console.warn(
      `[sync-blacklist] Ignoring stale price_cache entry for ${assetId}: ` +
      `${ageSec}s old (max ${BLACKLIST_PRICE_CACHE_TTL_SEC}s)`,
    );
    return null;
  }

  return row.price;
}
