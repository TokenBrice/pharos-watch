import {
  buildBlacklistContractBalanceKey,
  getBlacklistPriceAssetId,
} from "@shared/lib/blacklist";
import type { BlacklistStablecoin } from "@shared/types/market";
import type { BlacklistRow } from "./shared";

const BLACKLIST_PRICE_CACHE_TTL_SEC = 6 * 60 * 60;

function compareBlacklistRows(left: BlacklistRow, right: BlacklistRow): number {
  return left.timestamp === right.timestamp ? left.id.localeCompare(right.id) : left.timestamp - right.timestamp;
}

export function buildLatestBlacklistRows(rows: readonly BlacklistRow[]): BlacklistRow[] {
  const latestByAddress = new Map<string, BlacklistRow>();
  const orderedRows = [...rows].sort(compareBlacklistRows);

  for (const row of orderedRows) {
    latestByAddress.set(buildCurrentBalanceKey(row), row);
  }

  return [...latestByAddress.values()].sort(compareBlacklistRows);
}

function buildCurrentBalanceKey(row: BlacklistRow): string {
  return buildBlacklistContractBalanceKey(
    row.stablecoin,
    row.chain_id,
    row.address,
    row.config_key,
    row.contract_address,
  );
}

export function buildCurrentBalanceSnapshotRows(rows: readonly BlacklistRow[]): BlacklistRow[] {
  const latestByAddress = new Map<
    string,
    { latest: BlacklistRow; latestBlacklist: BlacklistRow | null }
  >();
  const orderedRows = [...rows].sort(compareBlacklistRows);

  for (const row of orderedRows) {
    const key = buildCurrentBalanceKey(row);
    const existing = latestByAddress.get(key);
    latestByAddress.set(key, {
      latest: row,
      latestBlacklist: row.event_type === "blacklist" ? row : existing?.latestBlacklist ?? null,
    });
  }

  const snapshotRows: BlacklistRow[] = [];
  const selectedIds = new Set<string>();
  for (const { latest, latestBlacklist } of latestByAddress.values()) {
    if (latest.event_type === "unblacklist" && latestBlacklist) {
      snapshotRows.push(latestBlacklist);
      selectedIds.add(latestBlacklist.id);
    }
    if (!selectedIds.has(latest.id)) {
      snapshotRows.push(latest);
      selectedIds.add(latest.id);
    }
  }

  return snapshotRows.sort(compareBlacklistRows);
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
    return null;
  }

  return row.price;
}
