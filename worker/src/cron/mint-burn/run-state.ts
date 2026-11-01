import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { normalizeStringSet } from "../../lib/normalizers";
import type { MintBurnLane } from "../../lib/mint-burn-pipeline/types";
import { rotateFromCursor } from "../shared/cursor-rotation";
import { getCache, setCache } from "../../lib/db-cache";
import { logWorkerEvent } from "../../lib/structured-log";
import { parseJsonObject } from "../../lib/json-parse";

export interface MintBurnRunStateRow {
  degradedStreak: number;
  resumeConfigKey: string | null;
}


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
        `INSERT INTO mint_burn_run_state (job, degraded_streak, last_config_key, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job) DO UPDATE SET
           degraded_streak = excluded.degraded_streak,
           last_config_key = excluded.last_config_key,
           updated_at = excluded.updated_at`,
      )
      .bind(jobName, degradedStreak, resumeConfigKey, now)
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
const ATTEMPT_METADATA_SAMPLE_LIMIT = 6;

/**
 * Expected window for one complete extended pass, expressed in the lane's own
 * trigger intervals (the cadence authority owns the seconds).
 *
 * MB-1 (2026-10-18): the extended roster is 129 configs and the 200-request
 * global budget lets a run attempt only 39–44 of them, so a pass needs
 * ceil(129/39) = 4 run intervals; the observed start-to-finish span was ~96 min
 * at 30-minute runs. Four intervals keeps ~25 % margin over that measurement at
 * either cadence (240 min once the lane became hourly, ~192 min expected),
 * including the ~132 s/run slowdown regime, without a per-config clock.
 */
const EXTENDED_PASS_INTERVALS = 4;
export const MINT_BURN_EXTENDED_COVERAGE_WINDOW_SEC =
  EXTENDED_PASS_INTERVALS * CRON_SCHEDULE_CADENCES.halfHourlyMintBurnExtended.intervalSec;

/**
 * An attempted config that failed to advance its frontier this many times is
 * stuck: repeated attempts without progress cannot be explained by rotation.
 */
export const MINT_BURN_EXTENDED_STUCK_STREAK = 2;
const STUCK_CONFIG_SAMPLE_LIMIT = 8;

interface MintBurnAttemptStateEntry {
  firstObservedAt: number;
  lastAttemptedAt: number | null;
  lastDisposition: string;
  providerDeferredUntil: number | null;
  /** Consecutive attempted scans that did not advance; absent on legacy state. */
  consecutiveIncomplete?: number;
}

/**
 * Full-pass bookkeeping for the extended lane, persisted beside the per-config
 * entries. A pass starts at `startedAt` and completes when every enabled config
 * has been attempted (or was already up to date) since then.
 */
interface MintBurnCoverageCycleState {
  startedAt: number;
  lastCompletedAt: number | null;
  lastDurationSec: number | null;
}

interface MintBurnAttemptState {
  version: typeof ATTEMPT_STATE_VERSION;
  updatedAt: number;
  entries: Record<string, MintBurnAttemptStateEntry>;
  cycle?: MintBurnCoverageCycleState;
}

export type MintBurnCoverageCycleStatus = "cycle-in-progress" | "complete" | "stalled";

/**
 * The extended lane's coverage verdict. `cycle-in-progress` is neutral: no full
 * pass has completed since state began, so there is no healthy cycle to prove
 * yet. `complete` means a full pass has finished and the running pass is still
 * inside the window. `stalled` means a full pass did not complete in time.
 */
export interface MintBurnCoverageCycleSummary {
  status: MintBurnCoverageCycleStatus;
  expectedWindowSec: number;
  coverageCycleSec: number | null;
  cycleElapsedSec: number;
  lastCompletedAt: number | null;
  incompleteConfigs: number;
  providerDeferredConfigs: number;
  /** Configs whose repeated attempts did not advance their frontier (bounded sample). */
  stuckConfigs: string[];
  stuckConfigCount: number;
}

export interface MintBurnAttemptCoverageSummary {
  stateCacheKey: string;
  expectedConfigs: number;
  attemptedThisRun: number;
  providerDeferredThisRun: number;
  neverAttemptedCount: number;
  oldestAttemptAgeSec: number | null;
  laggingAttemptSamples: Array<{
    key: string;
    ageSec: number;
    lastDisposition: string;
    providerDeferredUntil: number | null;
  }>;
  persistenceFailed: boolean;
}

export interface MintBurnAttemptStateUpdate {
  summary: MintBurnAttemptCoverageSummary;
  coverageCycle: MintBurnCoverageCycleSummary | null;
}

/** A malformed cached cycle restarts the pass instead of publishing NaN arithmetic. */
function parseCoverageCycle(value: unknown): MintBurnCoverageCycleState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<MintBurnCoverageCycleState>;
  if (typeof candidate.startedAt !== "number" || !Number.isFinite(candidate.startedAt)) return null;
  return {
    startedAt: candidate.startedAt,
    lastCompletedAt:
      typeof candidate.lastCompletedAt === "number" && Number.isFinite(candidate.lastCompletedAt)
        ? candidate.lastCompletedAt
        : null,
    lastDurationSec:
      typeof candidate.lastDurationSec === "number" && Number.isFinite(candidate.lastDurationSec)
        ? candidate.lastDurationSec
        : null,
  };
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
  lane: MintBurnLane;
  enabledConfigKeys: readonly string[];
  configBreakdown: ReadonlyArray<{
    key: string;
    attempted: boolean;
    skippedReason: string | null;
    /** Absent means the caller did not supply progress evidence; do not infer failure. */
    advancedTo?: number | null;
  }>;
  activeProviderDeferrals: ReadonlyMap<string, number>;
  nowSec: number;
}): Promise<MintBurnAttemptStateUpdate> {
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
      if (summary.attempted && summary.advancedTo !== undefined) {
        entry.consecutiveIncomplete = summary.advancedTo == null
          ? (entry.consecutiveIncomplete ?? 0) + 1
          : 0;
      } else if (!summary.attempted && summary.skippedReason === "up-to-date") {
        // A proven up-to-date cursor is positive freshness evidence.
        entry.consecutiveIncomplete = 0;
      }
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

  // Extended-lane verdict: a full pass (every enabled config attempted) replaces
  // the fixed per-config age latch. The critical lane keeps its own coverage rules
  // and no cycle state.
  let coverageCycle: MintBurnCoverageCycleSummary | null = null;
  if (input.lane === "extended") {
    const cycle = parseCoverageCycle(state.cycle) ?? {
      startedAt: input.nowSec,
      lastCompletedAt: null,
      lastDurationSec: null,
    };
    const incompleteConfigs = input.enabledConfigKeys.filter((key) => {
      const entry = state.entries[key];
      // ADR-29: absent or never-attempted evidence is not coverage. A provider
      // deferral is recorded evidence, not an attempt, so it cannot complete the
      // pass either — only an observed attempt (including a proven up-to-date
      // scan) inside the cycle does.
      if (!entry || entry.lastAttemptedAt == null) return true;
      return entry.lastAttemptedAt < cycle.startedAt;
    }).length;
    const providerDeferredConfigs = input.enabledConfigKeys.filter(
      (key) => ((state.entries[key]?.providerDeferredUntil ?? 0) > input.nowSec),
    ).length;

    if (incompleteConfigs === 0) {
      cycle.lastDurationSec = Math.max(0, input.nowSec - cycle.startedAt);
      cycle.lastCompletedAt = input.nowSec;
      cycle.startedAt = input.nowSec;
    }
    state.cycle = cycle;

    const cycleElapsedSec = Math.max(0, input.nowSec - cycle.startedAt);
    const stalled = incompleteConfigs > 0 && cycleElapsedSec > MINT_BURN_EXTENDED_COVERAGE_WINDOW_SEC;
    const stuckConfigs = input.enabledConfigKeys
      .filter((key) => (state.entries[key]?.consecutiveIncomplete ?? 0) >= MINT_BURN_EXTENDED_STUCK_STREAK)
      .sort();
    coverageCycle = {
      status: stalled
        ? "stalled"
        : cycle.lastCompletedAt == null
          ? "cycle-in-progress"
          : "complete",
      expectedWindowSec: MINT_BURN_EXTENDED_COVERAGE_WINDOW_SEC,
      coverageCycleSec: cycle.lastDurationSec,
      cycleElapsedSec,
      lastCompletedAt: cycle.lastCompletedAt,
      incompleteConfigs,
      providerDeferredConfigs,
      stuckConfigs: stuckConfigs.slice(0, STUCK_CONFIG_SAMPLE_LIMIT),
      stuckConfigCount: stuckConfigs.length,
    };
  }

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

  const summary: MintBurnAttemptCoverageSummary = {
    stateCacheKey,
    expectedConfigs: input.enabledConfigKeys.length,
    attemptedThisRun,
    providerDeferredThisRun,
    neverAttemptedCount,
    oldestAttemptAgeSec: lagging[0]?.ageSec ?? null,
    laggingAttemptSamples: lagging.slice(0, ATTEMPT_METADATA_SAMPLE_LIMIT).map(({ key, ageSec, entry }) => ({
      key,
      ageSec,
      lastDisposition: entry.lastDisposition,
      providerDeferredUntil: entry.providerDeferredUntil,
    })),
    persistenceFailed,
  };
  return { summary, coverageCycle };
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
