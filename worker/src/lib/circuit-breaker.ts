/**
 * Circuit breaker for external data sources.
 * Tracks consecutive failures per source and prevents hammering downed APIs.
 * State is persisted in the D1 cache table under keys like "circuit:defillama-stablecoins".
 */

import { getCache, setCache } from "./db-cache";
import { sendAlert } from "./alerts";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitRecord {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
}

/** Consecutive failures before the circuit opens */
const CIRCUIT_OPEN_THRESHOLD = 3;

/** Seconds to wait before allowing a probe request in open state */
const CIRCUIT_PROBE_INTERVAL_SEC = 1800; // 30 min

const DEFAULT_RECORD: CircuitRecord = {
  state: "closed",
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
  openedAt: null,
};

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

export async function getCircuitRecord(db: D1Database, source: string): Promise<CircuitRecord> {
  const cached = await getCache(db, cacheKey(source));
  if (!cached) return { ...DEFAULT_RECORD };
  try {
    const parsed = JSON.parse(cached.value);
    return isCircuitRecord(parsed) ? parsed : { ...DEFAULT_RECORD };
  } catch {
    return { ...DEFAULT_RECORD };
  }
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
      await setCache(db, cacheKey(source), JSON.stringify(record));
      console.log(`[circuit-breaker] ${source}: open -> half-open (probe allowed)`);
      return true;
    }
    return false;
  }

  // half-open: allow one probe
  return record.state === "half-open";
}

/**
 * Records the outcome of a fetch attempt and handles state transitions.
 * Fires alerts on open/close transitions.
 *
 * NOTE: There is a known TOCTOU window between shouldAttemptFetch() and
 * recordOutcome() — concurrent cron jobs could both read "half-open" and
 * both probe. This is accepted as best-effort behavior; the circuit breaker
 * provides probabilistic protection, not strict mutual exclusion.
 * D1 lacks the CAS primitives needed for strict single-probe semantics
 * without adding a separate coordination mechanism.
 */
export async function recordOutcome(db: D1Database, source: string, success: boolean, webhookUrl?: string | null): Promise<void> {
  const record = await getCircuitRecord(db, source);
  const now = Math.floor(Date.now() / 1000);

  if (success) {
    const wasOpen = record.state === "open" || record.state === "half-open";
    record.state = "closed";
    record.consecutiveFailures = 0;
    record.lastSuccessAt = now;
    record.openedAt = null;
    await setCache(db, cacheKey(source), JSON.stringify(record));
    if (wasOpen) {
      console.log(`[circuit-breaker] ${source}: CLOSED (recovered)`);
      sendAlert(
        webhookUrl ?? null,
        `Circuit closed: ${source}`,
        `Source "${source}" has recovered after being open.`,
      ).catch((err) => { console.warn("[circuit-breaker] alert delivery failed:", err); });
    }
    return;
  }

  // Failure
  record.consecutiveFailures++;
  record.lastFailureAt = now;

  if (record.state === "half-open") {
    // Probe failed — reopen
    record.state = "open";
    record.openedAt = now;
    console.log(`[circuit-breaker] ${source}: half-open -> open (probe failed, ${record.consecutiveFailures} consecutive failures)`);
  } else if (record.consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD && record.state === "closed") {
    record.state = "open";
    record.openedAt = now;
    console.log(`[circuit-breaker] ${source}: closed -> OPEN (${record.consecutiveFailures} consecutive failures)`);
    sendAlert(
      webhookUrl ?? null,
      `Circuit OPEN: ${source}`,
      `Source "${source}" has failed ${record.consecutiveFailures} consecutive times. Circuit opened — requests will be blocked for ${CIRCUIT_PROBE_INTERVAL_SEC / 60} min.`,
    ).catch((err) => { console.warn("[circuit-breaker] alert delivery failed:", err); });
  }

  await setCache(db, cacheKey(source), JSON.stringify(record));
}

/** Non-blocking circuit telemetry write for best-effort callers. */
export async function recordOutcomeSafe(db: D1Database, source: string, success: boolean, webhookUrl?: string | null): Promise<void> {
  try {
    await recordOutcome(db, source, success, webhookUrl);
  } catch (err) {
    console.warn(`[circuit-breaker] Failed to record outcome (${source}):`, err);
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
