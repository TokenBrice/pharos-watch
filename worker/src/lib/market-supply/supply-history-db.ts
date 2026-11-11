import { runWithOverloadRetry } from "../d1-overload-retry";
import { readCacheWithPolicy, writeCacheWithPolicy, type CachePolicy } from "../db-cache";
import { chunkArray, executeAtomicBatch } from "../db";
import { D1_BATCH_SIZE } from "../constants";
import { SNAPSHOT_SUPPLY_LAST_WRITE_KEY } from "./supply-snapshot-completion";

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
 * supply provenance (`supply_provenance` JSON, migration 0287). The admin
 * backfill above leaves both NULL (unknown), so its prices are never
 * mint/burn event-time evidence and its chain coverage is never complete.
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
