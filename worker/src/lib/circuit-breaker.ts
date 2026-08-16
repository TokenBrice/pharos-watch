/**
 * Circuit breaker for external data sources.
 * Tracks consecutive failures per source and prevents hammering downed APIs.
 * State is persisted in the D1 cache table under keys like "circuit:defillama-stablecoins".
 */

import {
  getCaches,
  readCacheWithPolicy,
  writeCacheWithPolicy,
  type CachePolicy,
  type CacheRetentionPolicy,
} from "./db-cache";
import { CIRCUIT_OPEN_THRESHOLD, CIRCUIT_PROBE_INTERVAL_SEC } from "@shared/lib/ops-limits";
import { CIRCUIT_SOURCE } from "./constants";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { CircuitRecord as SharedCircuitRecord } from "@shared/types/status";
import { logWorkerEvent } from "./structured-log";

export type CircuitRecord = SharedCircuitRecord;
export type CircuitState = "closed" | "open" | "half-open";
export type CircuitOutcomeDecision = "success" | "failure" | "neutral";
export interface CircuitOutcomeRecord {
  before: CircuitRecord;
  after: CircuitRecord;
}

const DEFAULT_RECORD: CircuitRecord = {
  state: "closed",
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
  openedAt: null,
};
const CIRCUIT_RECORD_MEMO_POLICY = {
  storage: "isolate-memory",
  schemaId: "circuit-record:memo:v1",
  ttlSec: 5,
  maxEntries: null,
  stale: "reject",
  invalid: "delete",
} satisfies CacheRetentionPolicy;

interface CircuitRecordMemoCache {
  records: Map<string, { record: CircuitRecord; expiresAtMs: number }>;
  reads: Map<string, Promise<CircuitRecord>>;
  versions: Map<string, number>;
}

let circuitRecordCacheByDb = new WeakMap<D1Database, CircuitRecordMemoCache>();

function cloneCircuitRecord(record: CircuitRecord): CircuitRecord {
  return { ...record };
}

function getCircuitRecordCache(db: D1Database): CircuitRecordMemoCache {
  let cache = circuitRecordCacheByDb.get(db);
  if (!cache) {
    cache = {
      records: new Map(),
      reads: new Map(),
      versions: new Map(),
    };
    circuitRecordCacheByDb.set(db, cache);
  }
  return cache;
}

function invalidateCircuitRecord(db: D1Database, source: string): void {
  const cache = getCircuitRecordCache(db);
  cache.records.delete(source);
  cache.reads.delete(source);
  cache.versions.set(source, (cache.versions.get(source) ?? 0) + 1);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isCircuitRecord(value: unknown): value is CircuitRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CircuitRecord>;
  return (
    (record.state === "closed" || record.state === "open" || record.state === "half-open") &&
    typeof record.consecutiveFailures === "number" &&
    isNullableNumber(record.lastFailureAt) &&
    isNullableNumber(record.lastSuccessAt) &&
    isNullableNumber(record.openedAt)
  );
}

function cacheKey(source: string): string {
  return `circuit:${source}`;
}

function circuitRecordPolicy(source: string): CachePolicy<CircuitRecord> {
  return {
    key: cacheKey(source),
    storage: "d1-kv",
    schemaId: "circuit-record:v1",
    ttlSec: null,
    maxEntries: null,
    stale: "accept",
    invalid: "retain",
    decode: (value) => {
      try {
        const parsed: unknown = JSON.parse(value);
        return isCircuitRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    encode: JSON.stringify,
  };
}

async function readCircuitRecordFromDb(db: D1Database, source: string): Promise<CircuitRecord> {
  const cached = await readCacheWithPolicy(db, circuitRecordPolicy(source));
  return cached.state === "fresh" || cached.state === "stale"
    ? cloneCircuitRecord(cached.value)
    : cloneCircuitRecord(DEFAULT_RECORD);
}

export async function getCircuitRecord(db: D1Database, source: string): Promise<CircuitRecord> {
  const cache = getCircuitRecordCache(db);
  const nowMs = Date.now();
  const memoized = cache.records.get(source);
  if (memoized && memoized.expiresAtMs > nowMs) {
    return cloneCircuitRecord(memoized.record);
  }

  const pending = cache.reads.get(source);
  if (pending) {
    return cloneCircuitRecord(await pending);
  }

  const version = cache.versions.get(source) ?? 0;
  const read = readCircuitRecordFromDb(db, source)
    .then((record) => {
      if ((cache.versions.get(source) ?? 0) === version) {
        cache.records.set(source, {
          record: cloneCircuitRecord(record),
          expiresAtMs: Date.now() + CIRCUIT_RECORD_MEMO_POLICY.ttlSec * 1_000,
        });
      }
      return record;
    })
    .finally(() => {
      if (cache.reads.get(source) === read) {
        cache.reads.delete(source);
      }
    });
  cache.reads.set(source, read);
  return cloneCircuitRecord(await read);
}

async function setCircuitRecord(db: D1Database, source: string, record: CircuitRecord): Promise<void> {
  invalidateCircuitRecord(db, source);
  await writeCacheWithPolicy(db, circuitRecordPolicy(source), record);
}

const CIRCUIT_RECORD_READ_CHUNK_SIZE = 100;

/**
 * Read authoritative circuit rows for a bounded source allowlist. Status
 * surfaces use these rows so stale or missing secondary summaries cannot
 * report active circuit rows as closed.
 */
export async function getCircuitRecordsForSources(
  db: D1Database,
  sources: readonly string[],
): Promise<Record<string, CircuitRecord>> {
  const records: Record<string, CircuitRecord> = {};
  const uniqueSources = [...new Set(sources)].filter((source) => source.length > 0);
  for (let offset = 0; offset < uniqueSources.length; offset += CIRCUIT_RECORD_READ_CHUNK_SIZE) {
    const chunk = uniqueSources.slice(offset, offset + CIRCUIT_RECORD_READ_CHUNK_SIZE);
    const keys = chunk.map(cacheKey);
    const cached = await getCaches(db, keys);
    for (const source of chunk) {
      const row = cached.get(cacheKey(source));
      if (!row) continue;
      const parsed = circuitRecordPolicy(source).decode(row.value);
      if (parsed) records[source] = cloneCircuitRecord(parsed);
    }
  }
  return records;
}

/**
 * Returns true if a fetch should be attempted for this source.
 * Transitions open -> half-open when the probe interval has elapsed.
 */
export async function shouldAttemptFetch(db: D1Database, source: string): Promise<boolean> {
  const record = await getCircuitRecord(db, source);
  if (record.state === "closed") return true;

  if (record.state === "open" && record.openedAt != null) {
    const now = Math.floor(Date.now() / 1000);
    if (now - record.openedAt >= CIRCUIT_PROBE_INTERVAL_SEC) {
      // Transition to half-open — allow one probe request
      record.state = "half-open";
      await setCircuitRecord(db, source, record);
      logWorkerEvent({ scope: "lib", level: "info", event: "circuit_probe_allowed", message: "Circuit transitioned from open to half-open", provider: source, metadata: { state: "half-open" } });
      return true;
    }
    return false;
  }

  // half-open: allow one probe
  return record.state === "half-open";
}

/**
 * Records the outcome of a fetch attempt and handles state transitions.
 *
 * NOTE: There is a known TOCTOU window between shouldAttemptFetch() and
 * recordOutcome() — concurrent cron jobs could both read "half-open" and
 * both probe. This is accepted as best-effort behavior; the circuit breaker
 * provides probabilistic protection, not strict mutual exclusion.
 * D1 lacks the CAS primitives needed for strict single-probe semantics
 * without adding a separate coordination mechanism.
 */
export async function recordOutcome(
  db: D1Database,
  source: string,
  success: boolean,
): Promise<CircuitOutcomeRecord> {
  const record = await getCircuitRecord(db, source);
  const before = { ...record };
  const now = Math.floor(Date.now() / 1000);

  if (success) {
    const wasOpen = record.state === "open" || record.state === "half-open";
    record.state = "closed";
    record.consecutiveFailures = 0;
    record.lastSuccessAt = now;
    record.openedAt = null;
    await setCircuitRecord(db, source, record);
    if (wasOpen) {
      logWorkerEvent({ scope: "lib", level: "info", event: "circuit_recovered", message: "Circuit closed after recovery", provider: source, metadata: { state: "closed" } });
    }
    return { before, after: { ...record } };
  }

  // Failure
  record.consecutiveFailures++;
  record.lastFailureAt = now;

  if (record.state === "half-open") {
    // Probe failed — reopen
    record.state = "open";
    record.openedAt = now;
    logWorkerEvent({ scope: "lib", level: "info", event: "circuit_probe_failed", message: "Circuit reopened after a failed probe", provider: source, metadata: { state: "open", consecutiveFailures: record.consecutiveFailures } });
  } else if (record.consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD && record.state === "closed") {
    record.state = "open";
    record.openedAt = now;
    logWorkerEvent({ scope: "lib", level: "info", event: "circuit_opened", message: "Circuit opened after consecutive failures", provider: source, metadata: { state: "open", consecutiveFailures: record.consecutiveFailures } });
    await setCircuitRecord(db, source, record);
    return { before, after: { ...record } };
  }

  await setCircuitRecord(db, source, record);
  return { before, after: { ...record } };
}

export function mapCronStatusToCircuitOutcome(status: string | null | undefined): CircuitOutcomeDecision {
  if (status === "error") {
    return "failure";
  }
  if (status === "ok" || status == null) {
    return "success";
  }
  return "neutral";
}

export async function recordOutcomeDecision(
  db: D1Database,
  source: string,
  outcome: CircuitOutcomeDecision,
): Promise<void> {
  if (outcome === "neutral") {
    return;
  }
  await recordOutcome(db, source, outcome === "success");
}

/**
 * When there are no candidates to probe and the breaker is non-closed,
 * record success so the breaker can transition toward closed on the next
 * read. Prevents sources whose candidate set temporarily empties from
 * staying open indefinitely.
 */
export async function recoverBreakerOnNoCandidate(
  db: D1Database,
  source: string,
): Promise<void> {
  const record = await getCircuitRecord(db, source);
  if (record.state !== "closed") {
    await recordOutcome(db, source, true);
  }
}

/** Non-blocking circuit telemetry write for best-effort callers. */
export async function recordOutcomeSafe(
  db: D1Database,
  source: string,
  success: boolean,
): Promise<CircuitOutcomeRecord | null> {
  try {
    return await recordOutcome(db, source, success);
  } catch (err) {
    logWorkerEvent({ scope: "lib", level: "warn", event: "circuit_outcome_write_failed", message: "Failed to record circuit outcome", provider: source, error: err });
    return null;
  }
}

/** Read all known circuit states for health/status endpoints */
export async function getCircuitStates(db: D1Database): Promise<Record<string, CircuitRecord>> {
  const result = await db
    .prepare("SELECT key, value FROM cache WHERE key LIKE 'circuit:%'")
    .all<{ key: string; value: string }>();
  const states: Record<string, CircuitRecord> = {};
  for (const row of result.results ?? []) {
    const source = row.key.replace("circuit:", "");
    try {
      const parsed = JSON.parse(row.value);
      if (isCircuitRecord(parsed)) {
        states[source] = parsed;
      }
    } catch {
      // skip malformed
    }
  }
  return states;
}

function getConfiguredLiveReserveCircuitSources(): Set<string> {
  return new Set(
    ACTIVE_STABLECOINS.map((coin) => coin.liveReservesConfig)
      .filter((config): config is NonNullable<(typeof ACTIVE_STABLECOINS)[number]["liveReservesConfig"]> =>
        Boolean(config),
      )
      .map((config) => `live-reserves:${config.breakerScope ?? config.adapter}`),
  );
}

// ACTIVE_STABLECOINS is static per isolate — memoize to avoid recomputing on
// every /health or /public-status-history request.
let _activeCircuitSources: Set<string> | undefined;

/** @internal Reset per-isolate memoized state so test files can share a process. */
export function resetCircuitBreakerStateForTests(): void {
  circuitRecordCacheByDb = new WeakMap<D1Database, CircuitRecordMemoCache>();
  _activeCircuitSources = undefined;
}

function getActiveCircuitSources(): Set<string> {
  if (!_activeCircuitSources) {
    _activeCircuitSources = new Set([...Object.values(CIRCUIT_SOURCE), ...getConfiguredLiveReserveCircuitSources()]);
  }
  return _activeCircuitSources;
}

export function isActiveCircuitSource(source: string): boolean {
  return getActiveCircuitSources().has(source);
}

export function listActiveCircuitSources(): string[] {
  return [...getActiveCircuitSources()].sort();
}

export function filterStaleLiveReserveCircuitStates(
  circuits: Record<string, CircuitRecord>,
): Record<string, CircuitRecord> {
  const configuredLiveReserveSources = getConfiguredLiveReserveCircuitSources();
  return Object.fromEntries(
    Object.entries(circuits).filter(
      ([source]) => !source.startsWith("live-reserves:") || configuredLiveReserveSources.has(source),
    ),
  );
}

export function filterInactiveCircuitStates(circuits: Record<string, CircuitRecord>): Record<string, CircuitRecord> {
  const activeCircuitSources = getActiveCircuitSources();
  return Object.fromEntries(Object.entries(circuits).filter(([source]) => activeCircuitSources.has(source)));
}
