import { logWorkerEventArgs } from "../../lib/structured-log";
import { normalizeStringSet } from "../../lib/normalizers";
import { rotateFromCursor } from "../shared/cursor-rotation";
import { getCache, setCache } from "../../lib/db-cache";
import { logWorkerEvent } from "../../lib/structured-log";
import { parseJsonObject } from "../../lib/json-parse";

export interface MintBurnRunStateRow {
  degradedStreak: number;
  resumeConfigKey: string | null;
}

const LEGACY_NEXT_CONFIG_INDEX = 0;

/** Rotate configs so the persisted resume frontier is attempted first. */
export function resolveRotatedConfigs<T>(
  resumeConfigKey: string | null,
  configs: T[],
  keyFn: (config: T) => string,
): T[] {
  return rotateFromCursor(configs, resumeConfigKey, keyFn, { startAfterCursor: false }).items;
}

const CAPACITY_DEFERRED_REASONS = new Set([
  "runtime-budget-exhausted",
  "global-budget-exhausted",
  "extended-deferred-under-pressure",
]);

export function resolveMintBurnResumeConfigKey(
  configBreakdown: ReadonlyArray<{ key: string; skippedReason: string | null }>,
): string | null {
  if (configBreakdown.length === 0) return null;
  const firstDeferred = configBreakdown.find(
    (summary) => summary.skippedReason != null && CAPACITY_DEFERRED_REASONS.has(summary.skippedReason),
  );
  return firstDeferred?.key ?? configBreakdown[0]!.key;
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
        resumeConfigKey: row?.last_config_key ?? null,
      },
      persistenceFailed: false,
    };
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[sync-mint-burn] Failed to load run-state; using defaults:", error);
    return {
      state: { degradedStreak: 0, resumeConfigKey: null },
      persistenceFailed: true,
    };
  }
}

export async function setMintBurnRunState(
  db: D1Database,
  jobName: string,
  degradedStreak: number,
  resumeConfigKey: string | null = null,
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
      .bind(jobName, LEGACY_NEXT_CONFIG_INDEX, degradedStreak, resumeConfigKey, now)
      .run();
    return true;
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[sync-mint-burn] Failed to persist run-state:", error);
    return false;
  }
}

const DEFERRAL_GRACE_SEC = 3600;
const DEFERRAL_API_ERRORS_THRESHOLD = 5;
const DEFERRAL_COVERAGE_THRESHOLD = 0.8;

export async function loadActiveConfigDeferrals(
  db: D1Database,
  nowSec: number,
): Promise<Map<string, number>> {
  const rows = await db
    .prepare("SELECT config_key, deferred_until FROM mint_burn_config_deferral WHERE deferred_until > ?")
    .bind(nowSec)
    .all<{ config_key: string; deferred_until: number }>();
  return new Map(rows.results.map((row) => [row.config_key, row.deferred_until]));
}

export async function loadDeferredConfigs(db: D1Database, nowSec: number): Promise<Set<string>> {
  return new Set((await loadActiveConfigDeferrals(db, nowSec)).keys());
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

const ATTEMPT_STATE_VERSION = 1;
const ATTEMPT_SLO_SEC = 75 * 60;
const ATTEMPT_METADATA_SAMPLE_LIMIT = 6;

interface MintBurnAttemptStateEntry {
  firstObservedAt: number;
  lastAttemptedAt: number | null;
  lastDisposition: string;
  providerDeferredUntil: number | null;
}

interface MintBurnAttemptState {
  version: typeof ATTEMPT_STATE_VERSION;
  updatedAt: number;
  entries: Record<string, MintBurnAttemptStateEntry>;
}

export interface MintBurnAttemptCoverageSummary {
  stateCacheKey: string;
  expectedConfigs: number;
  attemptedThisRun: number;
  providerDeferredThisRun: number;
  neverAttemptedCount: number;
  staleAttemptCount: number;
  oldestAttemptAgeSec: number | null;
  twoCycleCoverageSatisfied: boolean;
  laggingAttemptSamples: Array<{
    key: string;
    ageSec: number;
    lastDisposition: string;
    providerDeferredUntil: number | null;
  }>;
  persistenceFailed: boolean;
}

function parseAttemptState(value: string | undefined): MintBurnAttemptState | null {
  if (!value) return null;
  const parsed = parseJsonObject<Partial<MintBurnAttemptState>>(value);
  if (!parsed || parsed.version !== ATTEMPT_STATE_VERSION || !parsed.entries || typeof parsed.entries !== "object") {
    return null;
  }
  return parsed as MintBurnAttemptState;
}

export async function updateMintBurnAttemptState(input: {
  db: D1Database;
  jobName: string;
  enabledConfigKeys: readonly string[];
  configBreakdown: ReadonlyArray<{
    key: string;
    attempted: boolean;
    skippedReason: string | null;
  }>;
  activeProviderDeferrals: ReadonlyMap<string, number>;
  nowSec: number;
}): Promise<MintBurnAttemptCoverageSummary> {
  const stateCacheKey = `mint-burn:attempt-state:${input.jobName}`;
  let state: MintBurnAttemptState = {
    version: ATTEMPT_STATE_VERSION,
    updatedAt: input.nowSec,
    entries: {},
  };
  let persistenceFailed = false;
  try {
    const cached = await getCache(input.db, stateCacheKey);
    state = parseAttemptState(cached?.value) ?? state;
  } catch (error) {
    persistenceFailed = true;
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "sync_mint_burn.attempt_state_load_failed",
      job: input.jobName,
      message: "Failed to load mint/burn attempt state; using an empty state",
      error,
      metadata: { stateCacheKey },
    });
  }

  const enabledKeySet = new Set(input.enabledConfigKeys);
  for (const key of Object.keys(state.entries)) {
    if (!enabledKeySet.has(key)) delete state.entries[key];
  }
  for (const key of input.enabledConfigKeys) {
    state.entries[key] ??= {
      firstObservedAt: input.nowSec,
      lastAttemptedAt: null,
      lastDisposition: "not-reached",
      providerDeferredUntil: null,
    };
  }

  let attemptedThisRun = 0;
  let providerDeferredThisRun = 0;
  for (const summary of input.configBreakdown) {
    const entry = state.entries[summary.key];
    if (!entry) continue;
    const providerDeferredUntil = input.activeProviderDeferrals.get(summary.key) ?? null;
    if (summary.attempted || summary.skippedReason === "up-to-date") {
      attemptedThisRun++;
      entry.lastAttemptedAt = input.nowSec;
      entry.providerDeferredUntil = null;
      entry.lastDisposition = summary.attempted ? "attempted" : "up-to-date";
    } else if (summary.skippedReason === "deferred" && providerDeferredUntil != null) {
      providerDeferredThisRun++;
      entry.providerDeferredUntil = providerDeferredUntil;
      entry.lastDisposition = "provider-deferred";
    } else {
      entry.providerDeferredUntil = providerDeferredUntil;
      entry.lastDisposition = summary.skippedReason ?? "not-attempted";
    }
  }
  state.updatedAt = input.nowSec;

  const lagging = input.enabledConfigKeys.flatMap((key) => {
    const entry = state.entries[key];
    if (!entry) return [];
    const ageSec = Math.max(0, input.nowSec - (entry.lastAttemptedAt ?? entry.firstObservedAt));
    const activelyDeferred = (entry.providerDeferredUntil ?? 0) > input.nowSec;
    return activelyDeferred ? [] : [{ key, ageSec, entry }];
  }).sort((a, b) => b.ageSec - a.ageSec || a.key.localeCompare(b.key));
  const neverAttemptedCount = input.enabledConfigKeys.filter(
    (key) => state.entries[key]?.lastAttemptedAt == null,
  ).length;
  const staleAttemptCount = lagging.filter((entry) => entry.ageSec > ATTEMPT_SLO_SEC).length;

  try {
    await setCache(input.db, stateCacheKey, JSON.stringify(state));
  } catch (error) {
    persistenceFailed = true;
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "sync_mint_burn.attempt_state_persist_failed",
      job: input.jobName,
      message: "Failed to persist mint/burn attempt state",
      error,
      metadata: { stateCacheKey },
    });
  }

  return {
    stateCacheKey,
    expectedConfigs: input.enabledConfigKeys.length,
    attemptedThisRun,
    providerDeferredThisRun,
    neverAttemptedCount,
    staleAttemptCount,
    oldestAttemptAgeSec: lagging[0]?.ageSec ?? null,
    twoCycleCoverageSatisfied: staleAttemptCount === 0,
    laggingAttemptSamples: lagging.slice(0, ATTEMPT_METADATA_SAMPLE_LIMIT).map(({ key, ageSec, entry }) => ({
      key,
      ageSec,
      lastDisposition: entry.lastDisposition,
      providerDeferredUntil: entry.providerDeferredUntil,
    })),
    persistenceFailed,
  };
}

export async function persistMintBurnRunDrilldown(input: {
  db: D1Database;
  jobName: string;
  observedAt: number;
  configBreakdown: ReadonlyArray<Record<string, unknown>>;
}): Promise<{ cacheKey: string; persistenceFailed: boolean }> {
  const cacheKey = `mint-burn:run-detail:${input.jobName}`;
  const configs = input.configBreakdown.map((summary) => ({
    key: summary.key,
    attempted: summary.attempted,
    skippedReason: summary.skippedReason,
    scanFrom: summary.scanFrom,
    scanTo: summary.scanTo,
    advancedTo: summary.advancedTo,
    rowsRead: summary.rowsRead,
    rowsInserted: summary.rowsInserted,
    rowsDropped: summary.rowsDropped,
    errors: summary.errors,
    failedEventDefs: summary.failedEventDefs,
    coverageFrontier: summary.coverageFrontier,
    advanceReason: summary.advanceReason,
    missingTimestampCount: summary.missingTimestampCount,
    earliestMissingTimestampBlock: summary.earliestMissingTimestampBlock,
    txContextShortfalls: summary.txContextShortfalls,
    bridgeClassificationDeferredRows: summary.bridgeClassificationDeferredRows,
    requestBudgetUsed: summary.requestBudgetUsed,
    requestBudgetLimit: summary.requestBudgetLimit,
  }));
  try {
    await setCache(input.db, cacheKey, JSON.stringify({ observedAt: input.observedAt, configs }));
    return { cacheKey, persistenceFailed: false };
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "sync_mint_burn.run_drilldown_persist_failed",
      job: input.jobName,
      message: "Failed to persist mint/burn run drilldown",
      error,
      metadata: { cacheKey },
    });
    return { cacheKey, persistenceFailed: true };
  }
}
