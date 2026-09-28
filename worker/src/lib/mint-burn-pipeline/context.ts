import type { MintBurnPriceContext, MintBurnPriceHistoryPoint, MintBurnPriceObservation } from "./types";
import { buildInClause } from "../db";
import { chunkArray } from "../collections";
import { D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../d1-primitives";
import { buildPriceValidationContext, validatePriceCandidate } from "../price-validation";
import { isObservedPrice, isReplaySafePriceSource } from "@shared/lib/pricing-source-policy";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { protocolParProvider } from "../authoritative-price-sources/protocol-par";
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
 * Snapshot days scanned around the event day. A snapshot is written during its
 * UTC day with a clock no later than that write, so an observation inside the
 * event window can only sit in a nearby snapshot; the margin also covers a
 * same-day retry that carried an older observation.
 */
const SNAPSHOT_SCAN_MARGIN_SEC = 2 * DAY_SECONDS;

/**
 * Plausible `supply_history` snapshot whose actual price observation clock
 * (`price_observed_at`) is closest to the event and within the event window;
 * ties prefer the later snapshot. The snapshot's UTC day label is never used as
 * an observation time, and rows without a recorded clock never reach here (see
 * `loadMintBurnPriceHistoryBatch`).
 */
function findMintBurnHistoricalPrice(
  priceHistory: Map<string, MintBurnPriceHistoryPoint[]>,
  stablecoinId: string,
  timestamp: number,
): MintBurnPriceHistoryPoint | null {
  const eventDay = bucketUnixSecondsToUtcDay(timestamp);
  const history = priceHistory.get(stablecoinId) ?? [];
  const firstDay = eventDay - SNAPSHOT_SCAN_MARGIN_SEC;
  const lastDay = eventDay + SNAPSHOT_SCAN_MARGIN_SEC;

  let lo = 0;
  let hi = history.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (history[mid].snapshotDate < firstDay) lo = mid + 1;
    else hi = mid;
  }

  let best: MintBurnPriceHistoryPoint | null = null;
  for (let idx = lo; idx < history.length && history[idx].snapshotDate <= lastDay; idx++) {
    const hit = history[idx];
    if (!isWithinMintBurnPriceEventWindow(hit.observedAt, timestamp)) continue;
    if (!isPlausibleEventPrice(stablecoinId, hit.price)) continue;
    if (best == null || Math.abs(hit.observedAt - timestamp) <= Math.abs(best.observedAt - timestamp)) best = hit;
  }
  return best;
}

export interface MintBurnEventPriceResolution {
  price: number;
  /** Actual observation clock of the admitted evidence, never the run time. */
  priceTimestamp: number;
  evidence: "supply-history" | "price-cache";
}

/**
 * Shared parse/heal event-time valuation. Candidates are a daily
 * `supply_history` snapshot price admitted through its actual observation clock
 * and a `price_cache` observation that is replay-safe, an actual observation
 * (not a nominal reference, including a legacy par row), and peg-plausible;
 * each must be observed within the event window. The candidate observed closest
 * to the event wins (a tie keeps the snapshot). Invalid, missing and future
 * clocks were already dropped by the loaders. `null` leaves the event unpriced,
 * which hourly valuation completeness then marks `partial`.
 */
export function resolveMintBurnEventPrice(
  stablecoinId: string,
  eventTimestamp: number,
  context: MintBurnPriceContext,
): MintBurnEventPriceResolution | null {
  const historical = findMintBurnHistoricalPrice(context.priceHistory, stablecoinId, eventTimestamp);
  const observation = context.priceObservations.get(stablecoinId);
  const cached = observation
    && isUsableCacheObservation(stablecoinId, observation)
    && isWithinMintBurnPriceEventWindow(observation.observedAt, eventTimestamp)
    ? observation
    : null;
  if (
    cached
    && (!historical || Math.abs(cached.observedAt - eventTimestamp) < Math.abs(historical.observedAt - eventTimestamp))
  ) {
    return { price: cached.price, priceTimestamp: cached.observedAt, evidence: "price-cache" };
  }
  if (historical) {
    return { price: historical.price, priceTimestamp: historical.observedAt, evidence: "supply-history" };
  }
  return null;
}

/**
 * Clock-independent `price_cache` admission: replay-safe source, actual
 * observation, plausible value. Nominal-par routes wrote par under the
 * observed `protocol-redeem` source before their cutover; such legacy rows are
 * not observations, so they are rejected for those route IDs.
 */
function isUsableCacheObservation(stablecoinId: string, observation: MintBurnPriceObservation): boolean {
  if (
    protocolParProvider.matches(stablecoinId)
    && normalizePricingSourceKeys(observation.source).includes("protocol-redeem")
  ) {
    return false;
  }
  return isReplaySafePriceSource(observation.source)
    && isObservedPrice({ priceSource: observation.source, priceObservedAtMode: observation.observedAtMode })
    && isPlausibleEventPrice(stablecoinId, observation.price);
}

/**
 * Whether any evidence could value an event at or after `sinceSec`: a usable
 * snapshot or cache observation observed no earlier than one event window
 * before it. `false` proves every such event of the coin stays unpriced, so
 * heal can skip the coin instead of spending its row budget on it.
 */
export function hasMintBurnEventPriceEvidenceSince(
  stablecoinId: string,
  sinceSec: number,
  context: MintBurnPriceContext,
): boolean {
  const earliestObservedAt = sinceSec - MINT_BURN_PRICE_EVENT_WINDOW_SEC;
  const history = context.priceHistory.get(stablecoinId) ?? [];
  if (history.some((point) => point.observedAt >= earliestObservedAt && isPlausibleEventPrice(stablecoinId, point.price))) {
    return true;
  }
  const observation = context.priceObservations.get(stablecoinId);
  return observation != null
    && observation.observedAt >= earliestObservedAt
    && isUsableCacheObservation(stablecoinId, observation);
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

interface SupplyHistoryPriceRow {
  stablecoin_id: string;
  snapshot_date: number;
  price: number;
  price_observed_at: number;
}

/**
 * Snapshot prices with a recorded observation clock (migration 0253). Rows with
 * a NULL `price_observed_at` (legacy, prior-Worker or admin-backfill rows) have
 * no known observation time and are never event evidence.
 */
async function loadMintBurnPriceHistoryRows(
  db: D1Database,
  idChunks: string[][],
): Promise<SupplyHistoryPriceRow[]> {
  const rows: SupplyHistoryPriceRow[] = [];
  for (const idChunk of idChunks) {
    const historyInClause = buildInClause(idChunk);
    const priceHistoryRows = await db
      .prepare(
        `SELECT stablecoin_id, snapshot_date, price, price_observed_at FROM supply_history WHERE stablecoin_id IN (${historyInClause.sql}) AND price IS NOT NULL AND price_observed_at IS NOT NULL ORDER BY stablecoin_id, snapshot_date ASC`,
      )
      .bind(...historyInClause.binds)
      .all<SupplyHistoryPriceRow>();
    rows.push(...(priceHistoryRows.results ?? []));
  }
  return rows;
}

/**
 * Loads event-time price evidence for parse and heal. Observations are assessed
 * against the clock taken after they are read, so a row published during the
 * read is not rejected as future-dated; a clock after that is not evidence.
 */
export async function loadMintBurnPriceContextBatch(
  db: D1Database,
  stablecoinIds: string[],
  sqlInChunkSize = D1_SAFE_IN_CLAUSE_BIND_LIMIT,
): Promise<MintBurnPriceContext> {
  const uniqueIds = [...new Set(stablecoinIds)];
  const priceObservations = new Map<string, MintBurnPriceObservation>();
  const priceHistory = new Map<string, MintBurnPriceHistoryPoint[]>();

  if (uniqueIds.length === 0) {
    return { priceObservations, priceHistory };
  }

  const idChunks = chunkArray(uniqueIds, sqlInChunkSize);
  const historyRows = await loadMintBurnPriceHistoryRows(db, idChunks);
  const rows: PriceCacheObservationRow[] = [];
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
  for (const row of historyRows) {
    const observedAt = row.price_observed_at;
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || observedAt > assessedAtSec) continue;
    const series = priceHistory.get(row.stablecoin_id) ?? [];
    series.push({ snapshotDate: row.snapshot_date, price: row.price, observedAt });
    priceHistory.set(row.stablecoin_id, series);
  }
  for (const row of rows) {
    const observation = projectMintBurnPriceObservation(row, assessedAtSec);
    if (observation) priceObservations.set(row.asset_id, observation);
  }

  return { priceObservations, priceHistory };
}
