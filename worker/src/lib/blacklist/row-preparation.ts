import { compareBlacklistEvents } from "@shared/lib/blacklist-event-order";
import {
  buildBlacklistContractBalanceKey,
  getBlacklistPriceAssetId,
} from "@shared/lib/blacklist";
import type { BlacklistStablecoin } from "@shared/types/market";
import type { BlacklistRow } from "./shared";

const BLACKLIST_PRICE_CACHE_TTL_SEC = 6 * 60 * 60;

function unambiguousRows(rows: readonly BlacklistRow[]): BlacklistRow[] {
  const effects = new Map<string, Map<string, Set<string>>>();
  const ambiguousBlocks = new Map<string, number>();
  for (const row of rows) {
    if (row.chain_id !== "tron") continue;
    const key = `${buildCurrentBalanceKey(row)}:${row.block_number}`;
    const group = effects.get(key) ?? new Map<string, Set<string>>();
    for (const [effect, transactions] of group) {
      if (effect !== row.event_type
        && (effect === "blacklist" || row.event_type === "blacklist")
        && (transactions.size > 1 || !transactions.has(row.tx_hash))) {
        const identity = buildCurrentBalanceKey(row);
        ambiguousBlocks.set(identity, Math.max(ambiguousBlocks.get(identity) ?? -1, row.block_number));
      }
    }
    const transactions = group.get(row.event_type) ?? new Set<string>();
    transactions.add(row.tx_hash);
    group.set(row.event_type, transactions);
    effects.set(key, group);
  }
  return rows.filter((row) => row.block_number > (ambiguousBlocks.get(buildCurrentBalanceKey(row)) ?? -1));
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
