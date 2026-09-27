import { batchExecute } from "../db";
import { loadMintBurnPriceContextBatch, resolveMintBurnEventPrice } from "./context";
import type { MintBurnAffectedHour } from "./types";

const HEAL_PRICE_SOURCE_BY_EVIDENCE = {
  "supply-history": "supply-history-heal",
  "price-cache": "price_cache_heal",
} as const;

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
 * Find recent mint_burn_events with NULL amount_usd, value them with the same
 * event-time admission parse uses (`resolveMintBurnEventPrice`: event-window
 * `supply_history` snapshot, else a replay-safe, plausible `price_cache`
 * observation within ±24h of the event), and update. Returns count of healed
 * events and affected hours for re-aggregation.
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

  const priceContext = await loadMintBurnPriceContextBatch(
    db,
    nullEvents.map((event) => event.stablecoin_id),
  );

  const healable: Array<{ event: NullPriceEvent; resolution: HealPriceResolution }> = [];
  for (const event of nullEvents) {
    const resolution = resolveMintBurnEventPrice(event.stablecoin_id, event.timestamp, priceContext);
    if (!resolution) continue;
    healable.push({
      event,
      resolution: {
        price: resolution.price,
        priceTimestamp: resolution.priceTimestamp,
        priceSource: HEAL_PRICE_SOURCE_BY_EVIDENCE[resolution.evidence],
      },
    });
  }
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
