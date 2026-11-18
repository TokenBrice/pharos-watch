import { isKinesisWrapperSupplyId } from "@shared/lib/onchain-supply-probe";
import { isAmbiguousSupplyPerimeterDay, isKinesisWrapperSupplyCutoverActive } from "@shared/lib/supply-perimeter-changes";
import { classifySupplyCoverage, parseSupplyObservationProvenance } from "@shared/lib/supply-provenance";
import type { SupplyObservationProvenance } from "@shared/types/supply";
import { isDailyStockObservation } from "./dews/native-quantity";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { readCacheWithPolicy, writeCacheWithPolicy, type CachePolicy } from "./db-cache";
import { chunkArray, executeAtomicBatch } from "./db";
import { D1_BATCH_SIZE } from "./constants";
import { SNAPSHOT_SUPPLY_LAST_WRITE_KEY } from "./supply-snapshot-completion";

/** Daily history must use the same program or wrapper perimeter as the current publication. */
export function matchesCurrentSupplyPerimeter(id: string, day: number, rawProvenance: string | null | undefined, now: number): boolean {
  if (!isKinesisWrapperSupplyId(id)) return true;
  const wrapper = isKinesisWrapperSupplyCutoverActive(id, now);
  const { provenance, invalid } = parseSupplyObservationProvenance(rawProvenance);
  return !invalid && !isAmbiguousSupplyPerimeterDay(id, day) && isKinesisWrapperSupplyCutoverActive(id, day) === wrapper &&
    (provenance?.supplySource === "onchain-total-supply") === wrapper;
}

export interface HistoricalSupplyQuantityRow {
  snapshot_date: number;
  circulating_usd: number;
  circulating_native: number | null;
  valuation_price_usd: number | null;
  valuation_observed_at_sec: number | null;
  price: number | null;
  price_observed_at: number | null;
}

// Assessed-unavailable rows keep the market quote separate from the legacy conversion price.
export const SUPPLY_HISTORY_MARKET_PRICE_SQL =
  "COALESCE(price, CASE WHEN json_valid(supply_provenance) THEN json_extract(supply_provenance, '$.marketQuote.price') END)";
export const SUPPLY_HISTORY_MARKET_PRICE_CLOCK_SQL =
  "CASE WHEN price IS NOT NULL THEN price_observed_at WHEN json_valid(supply_provenance) THEN json_extract(supply_provenance, '$.marketQuote.observedAt') END";

/** A pre-0306 USD cap can recover its units only at its own observed stock and price clock. */
export function historicalSupplyQuantity(
  id: string, pegType: string | undefined, row: HistoricalSupplyQuantityRow,
  provenance: SupplyObservationProvenance | null, through: number,
): number | null {
  if (provenance?.nativeQuantityUnavailable) return null;
  const native = row.circulating_native;
  if (native != null) return Number.isFinite(native) && native >= 0 ? native : null;
  const observedAt = provenance?.supplyObservedAt;
  if (pegType !== "peggedUSD" || id === "xaut-tether" || isKinesisWrapperSupplyId(id) ||
    row.valuation_price_usd != null || row.valuation_observed_at_sec != null ||
    (provenance?.supplySource !== "defillama" && provenance?.supplySource !== "coingecko-fallback") ||
    classifySupplyCoverage(provenance) !== "complete" ||
    observedAt == null || !isDailyStockObservation(id, row.snapshot_date, observedAt, through) ||
    row.price_observed_at !== observedAt || row.price == null || !Number.isFinite(row.price) || row.price <= 0) return null;
  const recovered = row.circulating_usd / row.price;
  return Number.isFinite(recovered) && (recovered > 0 || row.circulating_usd === 0) ? recovered : null;
}

/** Shared D1 SQL for supply_history upserts. */
const SUPPLY_HISTORY_UPSERT_PREFIX =
  "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price)";

export const SUPPLY_HISTORY_UPSERT_SQL = `${SUPPLY_HISTORY_UPSERT_PREFIX} VALUES (?, ?, ?, ?)`;

/**
 * Insert-missing-only variant used by the admin supply backfill: an existing
 * `(stablecoin_id, snapshot_date)` row is left untouched, so a cron-owned
 * snapshot's `price_observed_at`/`supply_provenance` survive a backfill overlap.
 * Replacing an existing row requires the backfill's explicit `overwrite=true`.
 */
export const SUPPLY_HISTORY_INSERT_MISSING_SQL =
  "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?) ON CONFLICT (stablecoin_id, snapshot_date) DO NOTHING";

/**
 * Daily-snapshot upsert: also records the price's actual observation clock
 * (`price_observed_at`, migration 0253) and the observation's validated
 * supply provenance (`supply_provenance` JSON, migration 0287). The operator
 * backfill also records clocks and provenance when its historical observations supply them.
 */
export const SUPPLY_SNAPSHOT_UPSERT_PREFIX =
  "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at, supply_provenance)";

/**
 * Backfills invalidate derived history in the same transaction as each chunk.
 * Returns the number of supply rows actually inserted (D1 `changes`), so an
 * insert-missing backfill can report existing rows it skipped instead of
 * claiming them as inserts.
 */
export async function writeSupplyHistoryBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<number> {
  let inserted = 0;
  for (const chunk of chunkArray(statements, D1_BATCH_SIZE - 1)) {
    const results = await executeAtomicBatch(db, [
      ...chunk,
      db.prepare(
        `UPDATE cache SET value = json_set(value, '$.historyRevision', ?)
         WHERE key = ? AND json_valid(value)`,
      ).bind(crypto.randomUUID(), SNAPSHOT_SUPPLY_LAST_WRITE_KEY),
    ], { returnResults: true });
    for (let index = 0; index < chunk.length; index++) {
      inserted += Number(results[index]?.meta?.changes ?? 0);
    }
  }
  return inserted;
}

// --- Coin first-seen dates (for peg score tracking window) ---

const FIRST_SEEN_CACHE_KEY = "supply-history:first-seen-dates";
const FIRST_SEEN_CACHE_MAX_AGE_SEC = 24 * 60 * 60;

interface FirstSeenCachePayload {
  version: 1;
  firstSeenById: Record<string, number>;
}

export interface FirstSeenObservation {
  id: string;
  observedAtSec: number | null | undefined;
}

interface FirstSeenCacheRead {
  map: Map<string, number>;
  fresh: boolean;
}

function parseFirstSeenCache(value: string): Map<string, number> | null {
  try {
    const payload = JSON.parse(value) as Partial<FirstSeenCachePayload>;
    if (payload.version !== 1 || !payload.firstSeenById || typeof payload.firstSeenById !== "object") {
      return null;
    }
    const map = new Map<string, number>();
    for (const [id, firstSeen] of Object.entries(payload.firstSeenById)) {
      if (typeof id !== "string" || typeof firstSeen !== "number" || !Number.isFinite(firstSeen)) {
        return null;
      }
      map.set(id, firstSeen);
    }
    return map;
  } catch {
    return null;
  }
}

const FIRST_SEEN_CACHE_POLICY: CachePolicy<Map<string, number>> = {
  key: FIRST_SEEN_CACHE_KEY,
  storage: "d1-kv",
  schemaId: "supply-history:first-seen:v1",
  ttlSec: FIRST_SEEN_CACHE_MAX_AGE_SEC,
  stale: "fallback-only",
  invalid: "retain",
  decode: parseFirstSeenCache,
  encode: (value) => JSON.stringify({
    version: 1,
    firstSeenById: Object.fromEntries(value),
  } satisfies FirstSeenCachePayload),
};

async function readFirstSeenCache(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<FirstSeenCacheRead | null> {
  const cached = await readCacheWithPolicy(db, FIRST_SEEN_CACHE_POLICY, nowSec, signal);
  if (cached.state === "missing" || cached.state === "invalid" || cached.value == null) return null;
  return {
    map: cached.value,
    fresh: cached.state === "fresh",
  };
}

async function writeFirstSeenCache(
  db: D1Database,
  firstSeen: Map<string, number>,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  await writeCacheWithPolicy(db, FIRST_SEEN_CACHE_POLICY, firstSeen, nowSec, signal);
}

function mergeFirstSeen(map: Map<string, number>, id: string, firstSeenSec: number): boolean {
  if (!id || !Number.isFinite(firstSeenSec) || firstSeenSec <= 0) return false;
  const current = map.get(id);
  if (current != null && current <= firstSeenSec) return false;
  map.set(id, Math.floor(firstSeenSec));
  return true;
}

function mergeObservedFirstSeen(
  map: Map<string, number>,
  observations: readonly FirstSeenObservation[],
  nowSec: number,
): boolean {
  let changed = false;
  for (const observation of observations) {
    const observedAtSec = observation.observedAtSec;
    if (typeof observedAtSec !== "number" || !Number.isFinite(observedAtSec) || observedAtSec <= 0) continue;
    // Provider timestamps can occasionally skew forward; do not let them create a future tracking anchor.
    const boundedObservedAt = Math.min(Math.floor(observedAtSec), nowSec);
    changed = mergeFirstSeen(map, observation.id, boundedObservedAt) || changed;
  }
  return changed;
}

/** Earliest tracking anchor per coin — used so young coins aren't scored over a phantom 4-year window. */
export async function getFirstSeenDates(
  db: D1Database,
  observations: readonly FirstSeenObservation[] = [],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = await readFirstSeenCache(db, nowSec, signal);
  if (cached?.fresh && observations.length === 0) return cached.map;

  const map = cached?.fresh ? new Map(cached.map) : new Map<string, number>();

  if (!cached?.fresh) {
    for (const [id, firstSeen] of cached?.map ?? []) {
      mergeFirstSeen(map, id, firstSeen);
    }

    const result = await runWithOverloadRetry(() =>
      db
        .prepare("SELECT stablecoin_id, MIN(snapshot_date) as first_seen FROM supply_history GROUP BY stablecoin_id")
        .all<{ stablecoin_id: string; first_seen: number }>(),
      3,
      signal,
    );
    for (const row of result.results ?? []) {
      mergeFirstSeen(map, row.stablecoin_id, row.first_seen);
    }
  }

  const changed = mergeObservedFirstSeen(map, observations, nowSec);
  if (!cached?.fresh || changed) {
    await writeFirstSeenCache(db, map, nowSec, signal);
  }

  return map;
}
