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
      `SELECT availability, blocked_status, next_probe_at
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
  return recordProviderBlockedUntil(db, providerId, status, nowSec, nowSec + BINANCE_ENVIRONMENT_BLOCK_TTL_SEC);
}

async function recordProviderBlockedUntil(
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
    ).bind(
      providerId,
      status,
      nowSec,
      nextProbeAt,
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
