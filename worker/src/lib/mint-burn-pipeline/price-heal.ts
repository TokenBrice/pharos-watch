import { isReplaySafePriceSource } from "@shared/lib/pricing-source-policy";
import { batchExecute } from "../db";
import { getPriceCache, type PriceCacheEntry } from "../db-cache";
import { findMintBurnHistoricalPrice, loadMintBurnPriceHistoryBatch } from "./context";
import type { MintBurnAffectedHour, MintBurnPriceHistoryPoint } from "./types";

const LOOKBACK_SEC = 48 * 3600; // 48 hours

interface NullPriceEvent {
  id: string;
  stablecoin_id: string;
  chain_id: string;
  amount: number;
  timestamp: number;
}

interface HealPriceResolution {
  price: number;
  priceTimestamp: number;
  priceSource: string;
}

interface PriceHealResult {
  healed: number;
  affectedHours: Map<string, MintBurnAffectedHour>;
}

export interface NullPriceBacklogSummary {
  recent: number;
  historical: number;
}

function resolveHealEventPrice(
  event: NullPriceEvent,
  priceHistory: Map<string, MintBurnPriceHistoryPoint[]>,
  cached: PriceCacheEntry | undefined,
): HealPriceResolution | null {
  const historical = findMintBurnHistoricalPrice(
    priceHistory,
    event.stablecoin_id,
    event.timestamp,
  );
  if (historical?.price != null) {
    return {
      price: historical.price,
      priceTimestamp: historical.snapshotDate,
      priceSource: "supply-history-heal",
    };
  }

  if (!cached || !isReplaySafePriceSource(cached.source ?? null)) {
    return null;
  }

  return {
    price: cached.price,
    priceTimestamp: cached.updatedAt,
    priceSource: "price_cache_heal",
  };
}

export async function getNullPriceBacklog(
  db: D1Database,
  nowSec: number,
): Promise<NullPriceBacklogSummary> {
  const cutoff = nowSec - LOOKBACK_SEC;
  const row = await db.prepare(
    `SELECT
       SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) as recent_count,
       SUM(CASE WHEN timestamp < ? THEN 1 ELSE 0 END) as historical_count
     FROM mint_burn_events
     WHERE amount_usd IS NULL`,
  ).bind(cutoff, cutoff).first<{ recent_count: number | null; historical_count: number | null }>();

  return {
    recent: row?.recent_count ?? 0,
    historical: row?.historical_count ?? 0,
  };
}

/**
 * Find recent mint_burn_events with NULL amount_usd, resolve event-day
 * prices from supply_history before falling back to replay-safe price_cache
 * rows, and update. Returns count of healed events and affected hours for
 * re-aggregation.
 */
export async function healNullPrices(
  db: D1Database,
  nowSec: number,
): Promise<PriceHealResult> {
  const cutoff = nowSec - LOOKBACK_SEC;

  const { results } = await db.prepare(
    `SELECT e.id, e.stablecoin_id, e.chain_id, e.amount, e.timestamp
     FROM mint_burn_events e
     WHERE e.amount_usd IS NULL AND e.timestamp >= ?
     ORDER BY e.timestamp DESC, e.id DESC
     LIMIT 500`,
  ).bind(cutoff).all<{
    id: string;
    stablecoin_id: string;
    chain_id: string;
    amount: number;
    timestamp: number;
  }>();
  const nullEvents: NullPriceEvent[] = results ?? [];

  if (nullEvents.length === 0) {
    return { healed: 0, affectedHours: new Map() };
  }

  const priceHistory = await loadMintBurnPriceHistoryBatch(
    db,
    nullEvents.map((event) => event.stablecoin_id),
  );

  // Load all prices via existing helper (reads price_cache table keyed by asset_id)
  const prices = await getPriceCache(db);

  const healable = nullEvents
    .map((event) => {
      const resolution = resolveHealEventPrice(
        event,
        priceHistory,
        prices.get(event.stablecoin_id),
      );
      return resolution ? { event, resolution } : null;
    })
    .filter(
      (entry): entry is { event: NullPriceEvent; resolution: HealPriceResolution } =>
        entry != null,
    );
  if (healable.length === 0) {
    return { healed: 0, affectedHours: new Map() };
  }

  const updateStmts = healable.map(({ event, resolution }) => {
    return db.prepare(
      `UPDATE mint_burn_events
       SET amount_usd = ?, price_used = ?, price_timestamp = ?, price_source = ?
       WHERE id = ? AND amount_usd IS NULL`,
    ).bind(
      event.amount * resolution.price,
      resolution.price,
      resolution.priceTimestamp,
      resolution.priceSource,
      event.id,
    );
  });

  const healed = await batchExecute(db, updateStmts);

  // Collect affected hours for re-aggregation.
  const affectedHours = new Map<string, MintBurnAffectedHour>();
  for (const { event } of healable) {
    const hourTs = Math.floor(event.timestamp / 3600) * 3600;
    const key = `${event.stablecoin_id}-${event.chain_id}-${hourTs}`;
    affectedHours.set(key, {
      stablecoinId: event.stablecoin_id,
      chainId: event.chain_id,
      hourTs,
    });
  }

  return { healed, affectedHours };
}
