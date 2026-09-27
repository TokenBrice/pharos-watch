import { compareBlacklistEvents } from "@shared/lib/blacklist-event-order";
import {
  buildBlacklistContractBalanceKey,
  getBlacklistPriceAssetId,
} from "@shared/lib/blacklist";
import type { BlacklistStablecoin } from "@shared/types/market";
import type { BlacklistRow } from "./shared";

const BLACKLIST_PRICE_CACHE_TTL_SEC = 6 * 60 * 60;

function unambiguousRows(rows: readonly BlacklistRow[]): BlacklistRow[] {
  const transactions = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    if (row.chain_id !== "tron") continue;
    const key = `${buildCurrentBalanceKey(row)}:${row.timestamp}:${row.block_number}`;
    const prior = transactions.get(key);
    if (prior != null && prior !== row.tx_hash) ambiguous.add(key);
    transactions.set(key, row.tx_hash);
  }
  return rows.filter((row) => !ambiguous.has(`${buildCurrentBalanceKey(row)}:${row.timestamp}:${row.block_number}`));
}

export function buildLatestBlacklistRows(rows: readonly BlacklistRow[]): BlacklistRow[] {
  const latestByAddress = new Map<string, BlacklistRow>();
  const orderedRows = unambiguousRows(rows).sort(compareBlacklistEvents);

  for (const row of orderedRows) {
    latestByAddress.set(buildCurrentBalanceKey(row), row);
  }

  return [...latestByAddress.values()].sort(compareBlacklistEvents);
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
  const orderedRows = unambiguousRows(rows).sort(compareBlacklistEvents);

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

  return snapshotRows.sort(compareBlacklistEvents);
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
