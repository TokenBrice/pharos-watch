import { getCache, setCache } from "../db-cache";
import { executeMintBurnMaintenanceMutations } from "./materialization-debt";
import {
  hasMintBurnEventPriceEvidenceSince,
  loadMintBurnPriceContextBatch,
  resolveMintBurnEventPrice,
} from "./context";
import type { MintBurnAffectedHour } from "./types";

const HEAL_PRICE_SOURCE_BY_EVIDENCE = {
  "supply-history": "supply-history-heal",
  "price-cache": "price_cache_heal",
} as const;

const LOOKBACK_SEC = 48 * 3600; // 48 hours
const SCAN_LIMIT = 500;
const SCAN_CURSOR_KEY = "mint-burn-price-heal-cursor:v1";

type PriceHealCursor = Pick<NullPriceEvent, "timestamp" | "id">;

async function loadScanCursor(db: D1Database, cutoff: number): Promise<PriceHealCursor | null> {
  const cached = await getCache(db, SCAN_CURSOR_KEY);
  if (!cached) return null;
  try {
    const cursor: Partial<PriceHealCursor> | null = JSON.parse(cached.value);
    return cursor != null
      && typeof cursor.timestamp === "number" && Number.isSafeInteger(cursor.timestamp) && cursor.timestamp >= cutoff
      && typeof cursor.id === "string" && cursor.id.length > 0
      ? { timestamp: cursor.timestamp, id: cursor.id }
      : null;
  } catch {
    return null;
  }
}

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
 * event-time admission parse uses (`resolveMintBurnEventPrice`: a snapshot or
 * replay-safe, plausible `price_cache` observation observed within ±24h of the
 * event), and update. Coins with no evidence that could value any event in the
 * lookback are skipped before the 500-row budget is applied, so their
 * permanently unpriceable rows cannot starve healable coins. A durable descending
 * keyset advances past ineligible same-coin rows, wrapping only on exhaustion or
 * cutoff expiry. Returns count of healed events and affected hours for re-aggregation.
 */
export async function healNullPrices(
  db: D1Database,
  nowSec: number,
): Promise<PriceHealResult> {
  const cutoff = nowSec - LOOKBACK_SEC;

  const coinRows = await db.prepare(
    `SELECT DISTINCT stablecoin_id
     FROM mint_burn_events
     WHERE amount_usd IS NULL AND timestamp >= ?`,
  ).bind(cutoff).all<{ stablecoin_id: string }>();
  const candidateCoins = [...new Set((coinRows.results ?? []).map((row) => row.stablecoin_id))];
  if (candidateCoins.length === 0) {
    return { healed: 0, affectedHours: new Map() };
  }

  const priceContext = await loadMintBurnPriceContextBatch(db, candidateCoins);
  const healableCoins = candidateCoins.filter((stablecoinId) =>
    hasMintBurnEventPriceEvidenceSince(stablecoinId, cutoff, priceContext));
  if (healableCoins.length === 0) {
    return { healed: 0, affectedHours: new Map() };
  }

  const cursor = await loadScanCursor(db, cutoff);
  const { results } = await db.prepare(
    `SELECT e.id, e.stablecoin_id, e.chain_id, e.amount, e.timestamp
     FROM mint_burn_events e
     WHERE e.amount_usd IS NULL AND e.timestamp >= ?
       AND e.stablecoin_id IN (SELECT value FROM json_each(?))
       ${cursor ? "AND (e.timestamp, e.id) < (?, ?)" : ""}
     ORDER BY e.timestamp DESC, e.id DESC
     LIMIT ?`,
  ).bind(
    cutoff,
    JSON.stringify(healableCoins),
    ...(cursor ? [cursor.timestamp, cursor.id] : []),
    SCAN_LIMIT,
  ).all<NullPriceEvent>();
  const nullEvents: NullPriceEvent[] = results ?? [];
  const lastInspected = nullEvents[nullEvents.length - 1];
  const nextCursor = JSON.stringify(nullEvents.length === SCAN_LIMIT
    ? { timestamp: lastInspected.timestamp, id: lastInspected.id }
    : null);

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
    await setCache(db, SCAN_CURSOR_KEY, nextCursor);
    return { healed: 0, affectedHours: new Map() };
  }

  const mutations = healable.map(({ event, resolution }) => ({
    enqueue: db.prepare(
      `INSERT OR REPLACE INTO mint_burn_dirty_hours (stablecoin_id, chain_id, hour_ts)
       SELECT stablecoin_id, chain_id, (timestamp / 3600) * 3600
       FROM mint_burn_events WHERE id = ? AND amount_usd IS NULL
       RETURNING stablecoin_id, chain_id, hour_ts`,
    ).bind(event.id),
    update: db.prepare(
      `UPDATE mint_burn_events
       SET amount_usd = ?, price_used = ?, price_timestamp = ?, price_source = ?
       WHERE id = ? AND amount_usd IS NULL`,
    ).bind(
      event.amount * resolution.price,
      resolution.price,
      resolution.priceTimestamp,
      resolution.priceSource,
      event.id,
    ),
  }));

  const { changed: healed, affectedHours } = await executeMintBurnMaintenanceMutations(db, mutations);
  // Checkpoint only after successful inspection/writes; failures replay safely
  // and any committed source mutation already carries durable materialization debt.
  await setCache(db, SCAN_CURSOR_KEY, nextCursor);
  return { healed, affectedHours };
}
