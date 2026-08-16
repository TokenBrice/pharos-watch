import { logWorkerEventArgs } from "./structured-log";
import { isMissingTableError } from "./db";

export const BINANCE_ENVIRONMENT_BLOCK_TTL_SEC = 6 * 60 * 60;

export interface ProviderAvailabilityDecision {
  shouldFetch: boolean;
  probeOnly: boolean;
  blockedStatus: number | null;
  nextProbeAt: number | null;
}

interface ProviderRuntimeStateRow {
  availability: string;
  blocked_status: number | null;
  next_probe_at: number | null;
  target_cursor: number | null;
}

function tolerateStateTableError(error: unknown): void {
  if (!isMissingTableError(error)) {
    logWorkerEventArgs("lib", "warn", "[pricing-provider-state] runtime state unavailable; using stateless fallback");
  }
}

export async function readProviderAvailability(
  db: D1Database,
  providerId: string,
  nowSec: number,
): Promise<ProviderAvailabilityDecision> {
  try {
    const row = await db.prepare(
      `SELECT availability, blocked_status, next_probe_at, target_cursor
         FROM pricing_provider_runtime_state
        WHERE provider_id = ?`,
    ).bind(providerId).first<ProviderRuntimeStateRow>();
    if (!row || row.availability !== "blocked") {
      return { shouldFetch: true, probeOnly: false, blockedStatus: null, nextProbeAt: null };
    }
    const nextProbeAt = row.next_probe_at ?? 0;
    return {
      shouldFetch: nowSec >= nextProbeAt,
      probeOnly: nowSec >= nextProbeAt,
      blockedStatus: row.blocked_status,
      nextProbeAt,
    };
  } catch (error) {
    tolerateStateTableError(error);
    return { shouldFetch: true, probeOnly: false, blockedStatus: null, nextProbeAt: null };
  }
}

export async function recordProviderEnvironmentBlocked(
  db: D1Database,
  providerId: string,
  status: number,
  nowSec: number,
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO pricing_provider_runtime_state
         (provider_id, availability, blocked_status, blocked_at, next_probe_at, last_probe_at,
          consecutive_blocked, target_cursor, updated_at)
       VALUES (?, 'blocked', ?, ?, ?, ?, 1, 0, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         availability = 'blocked',
         blocked_status = excluded.blocked_status,
         blocked_at = excluded.blocked_at,
         next_probe_at = excluded.next_probe_at,
         last_probe_at = excluded.last_probe_at,
         consecutive_blocked = pricing_provider_runtime_state.consecutive_blocked + 1,
         updated_at = excluded.updated_at`,
    ).bind(
      providerId,
      status,
      nowSec,
      nowSec + BINANCE_ENVIRONMENT_BLOCK_TTL_SEC,
      nowSec,
      nowSec,
    ).run();
  } catch (error) {
    tolerateStateTableError(error);
  }
}

export async function recordProviderEnvironmentAvailable(
  db: D1Database,
  providerId: string,
  nowSec: number,
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO pricing_provider_runtime_state
         (provider_id, availability, blocked_status, blocked_at, next_probe_at, last_probe_at,
          consecutive_blocked, target_cursor, updated_at)
       VALUES (?, 'available', NULL, NULL, NULL, ?, 0, 0, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         availability = 'available',
         blocked_status = NULL,
         blocked_at = NULL,
         next_probe_at = NULL,
         last_probe_at = excluded.last_probe_at,
         consecutive_blocked = 0,
         updated_at = excluded.updated_at`,
    ).bind(providerId, nowSec, nowSec).run();
  } catch (error) {
    tolerateStateTableError(error);
  }
}

export async function suppressProviderUntil(
  db: D1Database,
  providerId: string,
  status: number,
  nowSec: number,
  nextProbeAt: number,
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO pricing_provider_runtime_state
         (provider_id, availability, blocked_status, blocked_at, next_probe_at, last_probe_at,
          consecutive_blocked, target_cursor, updated_at)
       VALUES (?, 'blocked', ?, ?, ?, ?, 1, 0, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         availability = 'blocked',
         blocked_status = excluded.blocked_status,
         blocked_at = excluded.blocked_at,
         next_probe_at = excluded.next_probe_at,
         last_probe_at = excluded.last_probe_at,
         consecutive_blocked = pricing_provider_runtime_state.consecutive_blocked + 1,
         updated_at = excluded.updated_at`,
    ).bind(providerId, status, nowSec, Math.max(nowSec + 1, nextProbeAt), nowSec, nowSec).run();
  } catch (error) {
    tolerateStateTableError(error);
  }
}

export async function readProviderNegativeCache(
  db: D1Database | undefined,
  providerId: string,
  nowSec: number,
): Promise<Set<string>> {
  if (!db) return new Set();
  try {
    const rows = await db.prepare(
      `SELECT target_key
         FROM pricing_provider_negative_cache
        WHERE provider_id = ? AND expires_at > ?`,
    ).bind(providerId, nowSec).all<{ target_key: string }>();
    return new Set((rows.results ?? []).map((row) => row.target_key));
  } catch (error) {
    tolerateStateTableError(error);
    return new Set();
  }
}

export async function writeProviderNegativeCache(
  db: D1Database | undefined,
  providerId: string,
  targetKey: string,
  status: number,
  nowSec: number,
  ttlSec: number,
): Promise<void> {
  if (!db) return;
  try {
    await db.prepare(
      `INSERT INTO pricing_provider_negative_cache
         (provider_id, target_key, status, first_observed_at, last_observed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, target_key) DO UPDATE SET
         status = excluded.status,
         last_observed_at = excluded.last_observed_at,
         expires_at = excluded.expires_at`,
    ).bind(providerId, targetKey, status, nowSec, nowSec, nowSec + Math.max(1, ttlSec)).run();
  } catch (error) {
    tolerateStateTableError(error);
  }
}

export async function readProviderTargetCursor(
  db: D1Database | undefined,
  providerId: string,
  fallbackCursor: number,
): Promise<number> {
  if (!db) return fallbackCursor;
  try {
    const row = await db.prepare(
      "SELECT target_cursor FROM pricing_provider_runtime_state WHERE provider_id = ?",
    ).bind(providerId).first<{ target_cursor: number | null }>();
    return typeof row?.target_cursor === "number" && Number.isFinite(row.target_cursor)
      ? Math.max(0, Math.floor(row.target_cursor))
      : fallbackCursor;
  } catch (error) {
    tolerateStateTableError(error);
    return fallbackCursor;
  }
}

export async function writeProviderTargetCursor(
  db: D1Database | undefined,
  providerId: string,
  targetCursor: number,
  nowSec: number,
): Promise<void> {
  if (!db) return;
  try {
    await db.prepare(
      `INSERT INTO pricing_provider_runtime_state
         (provider_id, availability, consecutive_blocked, target_cursor, updated_at)
       VALUES (?, 'available', 0, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         target_cursor = excluded.target_cursor,
         updated_at = excluded.updated_at`,
    ).bind(providerId, Math.max(0, Math.floor(targetCursor)), nowSec).run();
  } catch (error) {
    tolerateStateTableError(error);
  }
}

export function rotateTargets<T>(targets: readonly T[], cursor: number): T[] {
  if (targets.length <= 1) return [...targets];
  const offset = ((Math.floor(cursor) % targets.length) + targets.length) % targets.length;
  return [...targets.slice(offset), ...targets.slice(0, offset)];
}
