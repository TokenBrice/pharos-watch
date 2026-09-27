import type { MintBurnPriceContext, MintBurnPriceHistoryPoint, MintBurnPriceObservation } from "./types";
import { buildInClause } from "../db";
import { chunkArray } from "../collections";
import { D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../d1-primitives";
import { buildPriceValidationContext, validatePriceCandidate } from "../price-validation";
import { isObservedPrice, isReplaySafePriceSource } from "@shared/lib/pricing-source-policy";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { DAY_SECONDS } from "@shared/lib/time-constants";

/**
 * Event-time price admission window (DEC-08): a price values an event only when
 * `abs(priceObservedAt - eventTimestamp) <= 86_400` seconds, boundaries inclusive.
 * Parse and heal share this rule through `resolveMintBurnEventPrice`.
 */
const MINT_BURN_PRICE_EVENT_WINDOW_SEC = DAY_SECONDS;

function isWithinMintBurnPriceEventWindow(observedAt: number, eventTimestamp: number): boolean {
  return Math.abs(observedAt - eventTimestamp) <= MINT_BURN_PRICE_EVENT_WINDOW_SEC;
}

/**
 * Same peg-plausibility contract the historical price repair scanner applies
 * before it writes `amount_usd` (`historical_backfill` validation mode).
 */
function isPlausibleEventPrice(stablecoinId: string, price: number): boolean {
  return Number.isFinite(price) && validatePriceCandidate(
    price,
    buildPriceValidationContext({ stablecoinId }),
    "historical_backfill",
  ).accepted;
}

/**
 * Latest plausible `supply_history` snapshot whose recorded observation clock
 * (its UTC snapshot date) is within the event window. Snapshots are dated at or
 * before the event day, so in practice this is the event's own UTC day; the prior
 * day qualifies only for an event at exactly UTC midnight.
 */
function findMintBurnHistoricalPrice(
  priceHistory: Map<string, MintBurnPriceHistoryPoint[]>,
  stablecoinId: string,
  timestamp: number,
): MintBurnPriceHistoryPoint | null {
  const eventDay = bucketUnixSecondsToUtcDay(timestamp);
  const history = priceHistory.get(stablecoinId) ?? [];

  let bestIdx = -1;
  let lo = 0;
  let hi = history.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (history[mid].snapshotDate <= eventDay) {
      bestIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  for (let idx = bestIdx; idx >= 0; idx--) {
    const hit = history[idx];
    if (!isWithinMintBurnPriceEventWindow(hit.snapshotDate, timestamp)) return null;
    if (!isPlausibleEventPrice(stablecoinId, hit.price)) continue;
    return hit;
  }
  return null;
}

export interface MintBurnEventPriceResolution {
  price: number;
  /** Actual observation clock of the admitted evidence, never the run time. */
  priceTimestamp: number;
  evidence: "supply-history" | "price-cache";
}

/**
 * Shared parse/heal event-time valuation. Prefers the daily `supply_history`
 * snapshot, then a `price_cache` observation that is replay-safe, an actual
 * observation (not a nominal reference), peg-plausible and observed within the
 * event window. Invalid, missing and future clocks were already dropped by
 * `projectMintBurnPriceObservation`. `null` leaves the event unpriced, which
 * hourly valuation completeness then marks `partial`.
 */
export function resolveMintBurnEventPrice(
  stablecoinId: string,
  eventTimestamp: number,
  context: MintBurnPriceContext,
): MintBurnEventPriceResolution | null {
  const historical = findMintBurnHistoricalPrice(context.priceHistory, stablecoinId, eventTimestamp);
  if (historical) {
    return { price: historical.price, priceTimestamp: historical.snapshotDate, evidence: "supply-history" };
  }
  const observation = context.priceObservations.get(stablecoinId);
  if (
    observation
    && isReplaySafePriceSource(observation.source)
    && isObservedPrice({ priceSource: observation.source, priceObservedAtMode: observation.observedAtMode })
    && isWithinMintBurnPriceEventWindow(observation.observedAt, eventTimestamp)
    && isPlausibleEventPrice(stablecoinId, observation.price)
  ) {
    return { price: observation.price, priceTimestamp: observation.observedAt, evidence: "price-cache" };
  }
  return null;
}

interface PriceCacheObservationRow {
  asset_id: string;
  price: number | null;
  updated_at: number | null;
  observed_at: number | null;
  observed_at_mode: string | null;
  source: string | null;
}

/**
 * Project one `price_cache` row into an observation. The clock is `observed_at`,
 * falling back to `updated_at` (the writer's effective observation clock, clamped
 * to sync time). Rows with an unusable value, a missing/invalid clock, or a clock
 * after the assessment time are not evidence.
 */
function projectMintBurnPriceObservation(
  row: PriceCacheObservationRow,
  assessedAtSec: number,
): MintBurnPriceObservation | null {
  const observedAt = row.observed_at ?? row.updated_at;
  if (typeof row.price !== "number" || !Number.isFinite(row.price) || row.price <= 0) return null;
  if (typeof observedAt !== "number" || !Number.isSafeInteger(observedAt) || observedAt <= 0) return null;
  if (observedAt > assessedAtSec) return null;
  return {
    price: row.price,
    observedAt,
    source: row.source ?? null,
    observedAtMode: row.observed_at_mode ?? null,
  };
}

async function loadMintBurnPriceHistoryBatch(
  db: D1Database,
  stablecoinIds: string[],
  sqlInChunkSize = D1_SAFE_IN_CLAUSE_BIND_LIMIT,
): Promise<Map<string, MintBurnPriceHistoryPoint[]>> {
  const uniqueIds = [...new Set(stablecoinIds)];
  const priceHistory = new Map<string, MintBurnPriceHistoryPoint[]>();

  if (uniqueIds.length === 0) {
    return priceHistory;
  }

  const idChunks = chunkArray(uniqueIds, sqlInChunkSize);
  for (const idChunk of idChunks) {
    const historyInClause = buildInClause(idChunk);
    const priceHistoryRows = await db
      .prepare(
        `SELECT stablecoin_id, snapshot_date, price FROM supply_history WHERE stablecoin_id IN (${historyInClause.sql}) AND price IS NOT NULL ORDER BY stablecoin_id, snapshot_date ASC`,
      )
      .bind(...historyInClause.binds)
      .all<{ stablecoin_id: string; snapshot_date: number; price: number }>();

    for (const row of priceHistoryRows.results ?? []) {
      const series = priceHistory.get(row.stablecoin_id) ?? [];
      series.push({ snapshotDate: row.snapshot_date, price: row.price });
      priceHistory.set(row.stablecoin_id, series);
    }
  }

  return priceHistory;
}

/**
 * Loads event-time price evidence for parse and heal. Cache observations are
 * assessed against the clock taken after they are read, so a row published
 * during the read is not rejected as future-dated.
 */
export async function loadMintBurnPriceContextBatch(
  db: D1Database,
  stablecoinIds: string[],
  sqlInChunkSize = D1_SAFE_IN_CLAUSE_BIND_LIMIT,
): Promise<MintBurnPriceContext> {
  const uniqueIds = [...new Set(stablecoinIds)];
  const priceObservations = new Map<string, MintBurnPriceObservation>();
  const priceHistory = await loadMintBurnPriceHistoryBatch(db, uniqueIds, sqlInChunkSize);

  if (uniqueIds.length === 0) {
    return { priceObservations, priceHistory };
  }

  const rows: PriceCacheObservationRow[] = [];
  const idChunks = chunkArray(uniqueIds, sqlInChunkSize);
  for (const idChunk of idChunks) {
    const priceInClause = buildInClause(idChunk);
    const priceRows = await db
      .prepare(
        `SELECT asset_id, price, updated_at, observed_at, observed_at_mode, source FROM price_cache WHERE asset_id IN (${priceInClause.sql})`,
      )
      .bind(...priceInClause.binds)
      .all<PriceCacheObservationRow>();
    rows.push(...(priceRows.results ?? []));
  }

  const assessedAtSec = Math.floor(Date.now() / 1000);
  for (const row of rows) {
    const observation = projectMintBurnPriceObservation(row, assessedAtSec);
    if (observation) priceObservations.set(row.asset_id, observation);
  }

  return { priceObservations, priceHistory };
}
