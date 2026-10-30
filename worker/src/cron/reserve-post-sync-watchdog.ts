import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { resolveLiveReserveSourceAgeBudget } from "@shared/lib/live-reserve-freshness";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { STATUS_RESERVE_ADAPTER_ALERT_THRESHOLDS } from "@shared/lib/status-thresholds";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { LiveReserveAdapterValidationPolicy } from "@shared/types/live-reserve-core";
import { buildAlertReserveSourceEnvelope } from "../lib/alert-reserve-source-cache";
import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import { checkCollateralDrift } from "../lib/collateral-drift";
import type { CronResult } from "../lib/cron-logger";
import { recordCronFailure } from "../lib/cron-logger";
import { buildInClause, chunkArray, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../lib/db";
import { getCache, setCache } from "../lib/db-cache";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { computeReserveCompositionOverview, getMaxSyncAge, loadReserveSyncStateMap } from "../lib/live-reserves/store";
import { LIVE_RESERVE_FRESHNESS_SEC, type ReserveSyncStateRecord } from "../lib/live-reserves/store-shared";
import { resolveAcknowledgedReserveFeedIds } from "../lib/reserve-feed-reviews";
import { logWorkerEventArgs } from "../lib/structured-log";
import { SYNC_ORDERED_CONFIGURED_COINS } from "./sync-live-reserves-shared";
import { SNAPSHOT_KEYS } from "./telegram/sources/telegram-alert-snapshots";
import { resolveScheduledSlotPolicy } from "../lib/scheduled-slot-policy";

const PERSISTENTLY_STALE_WARNING_COUNT_THRESHOLD = 3;
const PERSISTENTLY_STALE_WARNING_MAX_AGE_SEC = 21 * DAY_SECONDS;
const CURATED_FALLBACK_WARNING_COUNT_THRESHOLD = 5;

const RESERVE_ALERT_STATE_KEY = "reserve-post-sync-watchdog:adapter-alerts:v1";
/** Bounded newest-attempt scan: covers the sustain count, a success between stalls, plus margin. */
export const RESERVE_ALERT_ATTEMPT_SCAN_LIMIT = Math.max(
  STATUS_RESERVE_ADAPTER_ALERT_THRESHOLDS.failureSustainedCycles,
  STATUS_RESERVE_ADAPTER_ALERT_THRESHOLDS.sourceClockStalledCycles,
) + 2;

export type ReserveAdapterAlertRuleId =
  | "reserve-adapter-failure-sustained"
  | "reserve-source-clock-stalled";

export interface ReserveAdapterAlertAttempt {
  attemptedAt: number;
  status: string;
  failureCategory: string | null;
  sourceTimestamp: number | null;
  freshnessMode: string | null;
}

interface ReserveAdapterAlertCoinState {
  failureRaised: boolean;
  clockRaised: boolean;
}

export interface ReserveAdapterAlertState {
  version: 1;
  coins: Record<string, ReserveAdapterAlertCoinState>;
}

export interface ReserveAdapterAlertEvaluation {
  state: ReserveAdapterAlertState;
  raised: ReserveAdapterAlertRuleId[];
  recovered: ReserveAdapterAlertRuleId[];
  failedSources: Array<{ stablecoinId: string; failedCycles: number }>;
  stalledSources: Array<{
    stablecoinId: string;
    sourceTimestamp: number;
    sourceAgeSec: number;
    sourceAgeBudgetSec: number;
  }>;
}

/**
 * Transition-only reserve alert predicates. A condition raises once when it
 * crosses its threshold and recovers once when it clears; a matching feed
 * review suppresses a new raise for that exact failure but never reports a
 * recovery. Failed evidence stays failed: a circuit skip withholds an attempt,
 * so it continues the streak, while a budget deferral does not.
 */
export function evaluateReserveAdapterAlerts(params: {
  nowSec: number;
  attemptsByCoin: ReadonlyMap<string, readonly ReserveAdapterAlertAttempt[]>;
  sourceAgeBudgetByCoin: ReadonlyMap<string, number>;
  acknowledgedCoinIds: ReadonlySet<string>;
  previous: ReserveAdapterAlertState;
}): ReserveAdapterAlertEvaluation {
  const coins: Record<string, ReserveAdapterAlertCoinState> = {};
  const raised = new Set<ReserveAdapterAlertRuleId>();
  const recovered = new Set<ReserveAdapterAlertRuleId>();
  const failedSources: ReserveAdapterAlertEvaluation["failedSources"] = [];
  const stalledSources: ReserveAdapterAlertEvaluation["stalledSources"] = [];

  for (const coinId of new Set([
    ...params.attemptsByCoin.keys(),
    ...Object.keys(params.previous.coins),
  ])) {
    const prior = params.previous.coins[coinId] ?? { failureRaised: false, clockRaised: false };
    const attempts = [...(params.attemptsByCoin.get(coinId) ?? [])]
      .sort((left, right) => right.attemptedAt - left.attemptedAt);

    let failedCycles = 0;
    for (const attempt of attempts) {
      if (attempt.status !== "error"
        && !(attempt.status === "skipped" && attempt.failureCategory === "circuit-open")) break;
      failedCycles++;
    }
    const failureCondition =
      failedCycles >= STATUS_RESERVE_ADAPTER_ALERT_THRESHOLDS.failureSustainedCycles;

    const successful = attempts.filter((attempt) =>
      attempt.status === "ok" || attempt.status === "degraded");
    const stalledWindow = successful.slice(
      0,
      STATUS_RESERVE_ADAPTER_ALERT_THRESHOLDS.sourceClockStalledCycles,
    );
    const latestSuccess = stalledWindow[0];
    const latestSourceTimestamp = latestSuccess?.sourceTimestamp ?? null;
    const sourceAgeBudgetSec = params.sourceAgeBudgetByCoin.get(coinId) ?? null;
    const clockCondition =
      stalledWindow.length === STATUS_RESERVE_ADAPTER_ALERT_THRESHOLDS.sourceClockStalledCycles
      && attempts[0] !== undefined
      && (attempts[0].status === "ok" || attempts[0].status === "degraded")
      && stalledWindow.every((attempt) =>
        attempt.freshnessMode === "verified"
        && attempt.sourceTimestamp != null
        && attempt.sourceTimestamp === latestSourceTimestamp)
      && latestSourceTimestamp != null
      && sourceAgeBudgetSec != null
      && params.nowSec - latestSourceTimestamp > sourceAgeBudgetSec;

    const acknowledged = params.acknowledgedCoinIds.has(coinId);
    const failureRaised = failureCondition && (prior.failureRaised || !acknowledged);
    const clockRaised = clockCondition && (prior.clockRaised || !acknowledged);
    if (failureRaised && !prior.failureRaised) raised.add("reserve-adapter-failure-sustained");
    if (clockRaised && !prior.clockRaised) raised.add("reserve-source-clock-stalled");
    // Recovery follows the evidence clearing, never an acknowledgement.
    if (prior.failureRaised && !failureCondition) recovered.add("reserve-adapter-failure-sustained");
    if (prior.clockRaised && !clockCondition) recovered.add("reserve-source-clock-stalled");

    if (failureCondition) failedSources.push({ stablecoinId: coinId, failedCycles });
    if (clockCondition && latestSourceTimestamp != null && sourceAgeBudgetSec != null) {
      stalledSources.push({
        stablecoinId: coinId,
        sourceTimestamp: latestSourceTimestamp,
        sourceAgeSec: params.nowSec - latestSourceTimestamp,
        sourceAgeBudgetSec,
      });
    }
    if (failureRaised || clockRaised) coins[coinId] = { failureRaised, clockRaised };
  }

  return {
    state: { version: 1, coins },
    raised: [...raised],
    recovered: [...recovered],
    failedSources,
    stalledSources,
  };
}

function parseReserveAdapterAlertState(value: string | null | undefined): ReserveAdapterAlertState {
  if (!value) return { version: 1, coins: {} };
  try {
    const parsed = JSON.parse(value) as { coins?: unknown };
    if (!parsed || typeof parsed !== "object" || !parsed.coins || typeof parsed.coins !== "object") {
      return { version: 1, coins: {} };
    }
    const coins: Record<string, ReserveAdapterAlertCoinState> = {};
    for (const [coinId, entry] of Object.entries(parsed.coins as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const { failureRaised, clockRaised } = entry as Record<string, unknown>;
      if (typeof failureRaised !== "boolean" || typeof clockRaised !== "boolean") continue;
      if (!failureRaised && !clockRaised) continue;
      coins[coinId] = { failureRaised, clockRaised };
    }
    return { version: 1, coins };
  } catch {
    return { version: 1, coins: {} };
  }
}

interface ReserveAdapterAlertAttemptRow {
  stablecoin_id: string;
  attempted_at: number;
  status: string;
  failure_category: string | null;
  source_timestamp: number | null;
  freshness_mode: string | null;
}

async function loadReserveAdapterAlertAttempts(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, ReserveAdapterAlertAttempt[]>> {
  const attemptsByCoin = new Map<string, ReserveAdapterAlertAttempt[]>();
  for (const batch of chunkArray([...new Set(stablecoinIds)], D1_SAFE_IN_CLAUSE_BIND_LIMIT)) {
    const inClause = buildInClause(batch);
    const rows = await runWithOverloadRetry(() => db.prepare(
      `WITH ranked AS (
         SELECT stablecoin_id, attempted_at, status,
                json_extract(metadata, '$.failureCategory') AS failure_category,
                json_extract(metadata, '$.sourceTimestamp') AS source_timestamp,
                json_extract(metadata, '$.freshnessMode') AS freshness_mode,
                ROW_NUMBER() OVER (
                  PARTITION BY stablecoin_id ORDER BY attempted_at DESC, id DESC
                ) AS rn
           FROM reserve_sync_attempt_history
          WHERE stablecoin_id IN (${inClause.sql})
       )
       SELECT stablecoin_id, attempted_at, status, failure_category, source_timestamp, freshness_mode
         FROM ranked
        WHERE rn <= ?
        ORDER BY stablecoin_id ASC, rn ASC`,
    ).bind(...inClause.binds, RESERVE_ALERT_ATTEMPT_SCAN_LIMIT).all<ReserveAdapterAlertAttemptRow>());
    for (const row of rows.results ?? []) {
      if (typeof row.stablecoin_id !== "string" || !Number.isFinite(row.attempted_at)
        || typeof row.status !== "string") continue;
      const attempts = attemptsByCoin.get(row.stablecoin_id) ?? [];
      attempts.push({
        attemptedAt: row.attempted_at,
        status: row.status,
        failureCategory: typeof row.failure_category === "string" ? row.failure_category : null,
        sourceTimestamp: typeof row.source_timestamp === "number" && Number.isFinite(row.source_timestamp)
          ? row.source_timestamp
          : null,
        freshnessMode: typeof row.freshness_mode === "string" ? row.freshness_mode : null,
      });
      attemptsByCoin.set(row.stablecoin_id, attempts);
    }
  }
  return attemptsByCoin;
}

/** Effective source-age budget per configured coin; the coin/adapter policy owns the numbers. */
function resolveReserveAdapterSourceAgeBudgets(): Map<string, number> {
  const budgets = new Map<string, number>();
  for (const coin of SYNC_ORDERED_CONFIGURED_COINS) {
    const config = coin.liveReservesConfig;
    if (!config) continue;
    const adapter = getLiveReserveAdapterDefinition(config.adapter);
    const validation: LiveReserveAdapterValidationPolicy | undefined =
      adapter && "validation" in adapter ? adapter.validation : undefined;
    budgets.set(coin.id, resolveLiveReserveSourceAgeBudget(
      config.scoring?.maxSourceAgeSec,
      validation?.maxSourceAgeSec,
      LIVE_RESERVE_FRESHNESS_SEC,
    ).sourceAgeBudgetSec);
  }
  return budgets;
}

export async function runReservePostSyncWatchdog(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  const degradedReasons: string[] = [];
  const firedRuleIds: string[] = [];
  let driftCoinCount = 0;
  let fallbackCoinCount = 0;
  let maxSyncAgeSec: number | null = null;
  let persistentlyStaleIndependentCoinCount = 0;
  let maxPersistentlyStaleAgeSec = 0;

  try {
    throwIfAborted(signal);
    const drift = await checkCollateralDrift(db);
    throwIfAborted(signal);
    driftCoinCount = drift.driftCoins.length;
    fallbackCoinCount = drift.fallbackCoins.length;
    if (drift.driftCoins.length > 0) {
      const driftSummary = drift.driftCoins
        .map((entry) => `${entry.id}: live=${entry.liveScore}, curated=${entry.curatedScore} (Δ${entry.delta})`)
        .join("\n");
      logWorkerEventArgs("handler", "warn", `[live-reserves] Collateral drift detected:\n${driftSummary}`);
      firedRuleIds.push("reserve-collateral-drift");
    }
    if (drift.fallbackCoins.length > CURATED_FALLBACK_WARNING_COUNT_THRESHOLD) {
      logWorkerEventArgs("handler", "warn", `[live-reserves] ${drift.fallbackCoins.length} live-enabled coins using curated fallback`);
      firedRuleIds.push("reserve-curated-fallback");
    }

    const reservePublishedAt = Math.floor(Date.now() / 1000);
    const previousReserveSource = await getCache(db, SNAPSHOT_KEYS.reserve);
    const reserveSourceEnvelope = buildAlertReserveSourceEnvelope(
      drift.driftCoins.map((entry) => entry.id),
      previousReserveSource,
      {
        nowSec: reservePublishedAt,
        producerIntervalSec: CRON_INTERVALS["sync-live-reserves"],
        observedIds: drift.observedIds,
        unavailableIds: drift.fallbackCoins,
      },
    );
    await setCache(db, SNAPSHOT_KEYS.reserve, JSON.stringify(reserveSourceEnvelope), signal);

    maxSyncAgeSec = await getMaxSyncAge(
      db,
      Math.floor(Date.now() / 1000),
      SYNC_ORDERED_CONFIGURED_COINS.map((coin) => coin.id),
    );
    throwIfAborted(signal);
  } catch (error) {
    rethrowIfAborted(error, signal);
    degradedReasons.push("drift-cache-age-check-failed");
    recordCronFailure("reserve-post-sync-watchdog", error, { metadata: { stage: "drift-cache-age" } });
  }

  try {
    throwIfAborted(signal);
    const overview = await computeReserveCompositionOverview(db, Math.floor(Date.now() / 1000), resolveScheduledSlotPolicy("fourHourlyReserveSync"));
    throwIfAborted(signal);
    const persistentlyStale = overview.persistentlyStaleIndependentCoins;
    persistentlyStaleIndependentCoinCount = persistentlyStale.length;
    maxPersistentlyStaleAgeSec = persistentlyStale.length > 0 ? persistentlyStale[0].ageSec : 0;
    const shouldWarn =
      persistentlyStale.length > PERSISTENTLY_STALE_WARNING_COUNT_THRESHOLD
      || maxPersistentlyStaleAgeSec > PERSISTENTLY_STALE_WARNING_MAX_AGE_SEC;
    if (shouldWarn) {
      const staleSummary = persistentlyStale
        .map((entry) => `${entry.stablecoinId}: ${Math.round(entry.ageSec / DAY_SECONDS)}d`)
        .join("\n");
      logWorkerEventArgs("handler", "warn", `[live-reserves] Persistently-stale independent sources:\n${staleSummary}`);
      firedRuleIds.push("reserve-persistent-stale-warning");
    }
  } catch (error) {
    rethrowIfAborted(error, signal);
    degradedReasons.push("persistent-stale-overview-failed");
    recordCronFailure("reserve-post-sync-watchdog", error, { metadata: { stage: "persistent-stale-overview" } });
  }

  let syncDegradedCoinCount = 0;
  let reserveSyncById = new Map<string, ReserveSyncStateRecord>();
  try {
    throwIfAborted(signal);
    const configuredIds = SYNC_ORDERED_CONFIGURED_COINS.map((coin) => coin.id);
    reserveSyncById = await loadReserveSyncStateMap(db, configuredIds);
    throwIfAborted(signal);
    syncDegradedCoinCount = configuredIds.filter((id) => {
      const status = reserveSyncById.get(id)?.lastStatus;
      return status === "degraded" || status === "error";
    }).length;
    if (syncDegradedCoinCount > 0) firedRuleIds.push("reserve-sync-degraded");
  } catch (error) {
    rethrowIfAborted(error, signal);
    degradedReasons.push("reserve-sync-state-read-failed");
    recordCronFailure("reserve-post-sync-watchdog", error, { metadata: { stage: "reserve-sync-state" } });
  }

  let adapterAlert: {
    assessedAt: number;
    failedSources: ReserveAdapterAlertEvaluation["failedSources"];
    stalledSources: ReserveAdapterAlertEvaluation["stalledSources"];
    acknowledgedCoinIds: string[];
    raised: ReserveAdapterAlertRuleId[];
    recovered: ReserveAdapterAlertRuleId[];
  } | null = null;
  try {
    throwIfAborted(signal);
    // No configured state evidence means no alert evaluation either; never let a
    // failed state read above turn into an empty "healthy" assessment here.
    if (reserveSyncById.size > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      const previousState = parseReserveAdapterAlertState(
        (await getCache(db, RESERVE_ALERT_STATE_KEY, signal))?.value,
      );
      throwIfAborted(signal);
      const [attemptsByCoin, acknowledgedCoinIds] = await Promise.all([
        loadReserveAdapterAlertAttempts(db, [...reserveSyncById.keys()]),
        resolveAcknowledgedReserveFeedIds(db, reserveSyncById.values(), nowSec),
      ]);
      throwIfAborted(signal);
      const evaluation = evaluateReserveAdapterAlerts({
        nowSec,
        attemptsByCoin,
        sourceAgeBudgetByCoin: resolveReserveAdapterSourceAgeBudgets(),
        acknowledgedCoinIds,
        previous: previousState,
      });
      await setCache(db, RESERVE_ALERT_STATE_KEY, JSON.stringify(evaluation.state), signal);
      const activeRuleIds = new Set<ReserveAdapterAlertRuleId>();
      for (const state of Object.values(evaluation.state.coins)) {
        if (state.failureRaised) activeRuleIds.add("reserve-adapter-failure-sustained");
        if (state.clockRaised) activeRuleIds.add("reserve-source-clock-stalled");
      }
      for (const ruleId of activeRuleIds) {
        if (!firedRuleIds.includes(ruleId)) firedRuleIds.push(ruleId);
      }
      if (evaluation.failedSources.length > 0 || evaluation.stalledSources.length > 0) {
        logWorkerEventArgs("handler", "warn", `[live-reserves] Reserve adapter alerts: ${evaluation.failedSources.length} sustained failure(s), ${evaluation.stalledSources.length} stalled source clock(s)`);
      }
      adapterAlert = {
        assessedAt: nowSec,
        failedSources: evaluation.failedSources,
        stalledSources: evaluation.stalledSources,
        acknowledgedCoinIds: [...acknowledgedCoinIds].sort(),
        raised: evaluation.raised,
        recovered: evaluation.recovered,
      };
    }
  } catch (error) {
    rethrowIfAborted(error, signal);
    degradedReasons.push("reserve-adapter-alert-evidence-read-failed");
    recordCronFailure("reserve-post-sync-watchdog", error, { metadata: { stage: "reserve-adapter-alerts" } });
  }

  return {
    status: degradedReasons.length > 0 ? "degraded" : "ok",
    itemCount: driftCoinCount + persistentlyStaleIndependentCoinCount,
    metadata: JSON.stringify({
      degradedReasons,
      driftCoinCount,
      fallbackCoinCount,
      maxSyncAgeSec,
      persistentlyStaleIndependentCoinCount,
      maxPersistentlyStaleAgeSec,
      syncDegradedCoinCount,
      reserveAdapterAlert: adapterAlert,
      reserveAdapterAlertThresholds: STATUS_RESERVE_ADAPTER_ALERT_THRESHOLDS,
      firedRuleIds: [...new Set(firedRuleIds)],
    }),
  };
}
