import { normalizeStringSet } from "../../lib/normalizers";
import { rotateFromCursor } from "../shared/cursor-rotation";

export interface MintBurnRunStateRow {
  degradedStreak: number;
  lastConfigKey: string | null;
}

const LEGACY_NEXT_CONFIG_INDEX = 0;

/** Rotate configs so that the item after lastConfigKey comes first. */
export function resolveRotatedConfigs<T>(
  lastConfigKey: string | null,
  configs: T[],
  keyFn: (config: T) => string,
): T[] {
  return rotateFromCursor(configs, lastConfigKey, keyFn, { startAfterCursor: true }).items;
}

export function normalizeDisabledConfigIdSet(values?: Iterable<string>): Set<string> {
  return normalizeStringSet(values, (value) => value.toLowerCase());
}

export function normalizeDisabledSymbolSet(values?: Iterable<string>): Set<string> {
  return normalizeStringSet(values, (value) => value.toUpperCase());
}

export async function getMintBurnRunState(
  db: D1Database,
  jobName: string,
): Promise<{ state: MintBurnRunStateRow; persistenceFailed: boolean }> {
  try {
    const row = await db
      .prepare("SELECT degraded_streak, last_config_key FROM mint_burn_run_state WHERE job = ?")
      .bind(jobName)
      .first<{ degraded_streak: number; last_config_key: string | null }>();

    return {
      state: {
        degradedStreak: row?.degraded_streak ?? 0,
        lastConfigKey: row?.last_config_key ?? null,
      },
      persistenceFailed: false,
    };
  } catch (error) {
    console.warn("[sync-mint-burn] Failed to load run-state; using defaults:", error);
    return {
      state: { degradedStreak: 0, lastConfigKey: null },
      persistenceFailed: true,
    };
  }
}

export async function setMintBurnRunState(
  db: D1Database,
  jobName: string,
  degradedStreak: number,
  lastConfigKey: string | null = null,
): Promise<boolean> {
  try {
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare(
        `INSERT INTO mint_burn_run_state (job, next_config_index, degraded_streak, last_config_key, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(job) DO UPDATE SET
           next_config_index = excluded.next_config_index,
           degraded_streak = excluded.degraded_streak,
           last_config_key = excluded.last_config_key,
           updated_at = excluded.updated_at`,
      )
      .bind(jobName, LEGACY_NEXT_CONFIG_INDEX, degradedStreak, lastConfigKey, now)
      .run();
    return true;
  } catch (error) {
    console.warn("[sync-mint-burn] Failed to persist run-state:", error);
    return false;
  }
}

const DEFERRAL_GRACE_SEC = 3600;
const DEFERRAL_API_ERRORS_THRESHOLD = 5;
const DEFERRAL_COVERAGE_THRESHOLD = 0.8;

export async function loadDeferredConfigs(db: D1Database, nowSec: number): Promise<Set<string>> {
  const rows = await db
    .prepare("SELECT config_key FROM mint_burn_config_deferral WHERE deferred_until > ?")
    .bind(nowSec)
    .all<{ config_key: string }>();
  return new Set(rows.results.map((r) => r.config_key));
}

export async function deferConfig(
  db: D1Database,
  configKey: string,
  nowSec: number,
  apiErrors: number,
  coverage: number | null,
  reason: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO mint_burn_config_deferral
         (config_key, deferred_until, reason, api_errors, coverage, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(configKey, nowSec + DEFERRAL_GRACE_SEC, reason, apiErrors, coverage, nowSec)
    .run();
}

export function shouldDeferConfig(apiErrors: number, coverage: number | null): boolean {
  if (apiErrors <= DEFERRAL_API_ERRORS_THRESHOLD) return false;
  if (coverage == null) return true;
  return coverage < DEFERRAL_COVERAGE_THRESHOLD;
}
