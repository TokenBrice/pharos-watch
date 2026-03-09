import { withErrorHandler, buildCacheStatuses, jsonResponse } from "../lib/api-utils";
import { withAdmin } from "../lib/auth";
import { buildInClause } from "../lib/db";
import {
  buildDiscrepancy,
  getDiscrepancyStreak,
  getLatestStatusProbe,
  getStatusStateSnapshot,
  listRecentStatusTransitions,
  reconcileStatusState,
  STATUS_SYSTEM_FRESHNESS_SEC,
  clampConfidence,
  type StatusLevel,
} from "../lib/status-reliability";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../lib/stablecoins-cache";
import { CRON_INTERVALS } from "../lib/cron-schedule";
import {
  BLACKLIST_RECENT_WINDOW_SEC,
  STATUS_BLACKLIST_THRESHOLDS,
  STATUS_ONCHAIN_THRESHOLDS,
} from "../lib/status-thresholds";
import { queryBlacklistGapMetrics } from "../lib/blacklist-gaps";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { CronRun, CronStatus, DataQuality, StatusCause, StatusResponse, TelegramBotStats } from "@shared/types";

// --- Config ---

const STATUS_SEVERITY: Record<StatusLevel, number> = {
  healthy: 0,
  degraded: 1,
  stale: 2,
};

interface RawStatusComputation {
  dbHealthy: boolean;
  availabilityStatus: StatusResponse["availabilityStatus"];
  dataQualityStatus: StatusResponse["dataQualityStatus"];
  rawOverallStatus: StatusLevel;
  confidence: number;
  causes: StatusResponse["causes"];
  caches: StatusResponse["caches"];
  crons: StatusResponse["crons"];
  dataQuality: StatusResponse["dataQuality"];
  telegramBot: StatusResponse["telegramBot"];
  datasetFreshness: StatusResponse["datasetFreshness"];
  summary: StatusResponse["summary"];
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function pushCause(bucket: StatusCause[], cause: StatusCause): void {
  bucket.push(cause);
}

function synthesizeOverallCauses(availability: StatusCause[], dataQuality: StatusCause[]): StatusCause[] {
  const sorted = [...availability, ...dataQuality].sort((a, b) => {
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
  return sorted.slice(0, 12);
}

function scoreConfidence(input: {
  availabilityStatus: StatusLevel;
  dataQualityStatus: StatusLevel;
  unhealthyCrons: number;
  degradedCrons: number;
  missingPriceRatio: number;
  onchainMonitoringActive: boolean;
}): number {
  let confidence = 1;

  if (input.availabilityStatus === "degraded") confidence -= 0.12;
  if (input.availabilityStatus === "stale") confidence -= 0.28;
  if (input.dataQualityStatus === "degraded") confidence -= 0.12;
  if (input.dataQualityStatus === "stale") confidence -= 0.28;

  confidence -= Math.min(0.2, input.unhealthyCrons * 0.03);
  confidence -= Math.min(0.08, input.degradedCrons * 0.01);
  confidence -= Math.min(0.18, input.missingPriceRatio * 0.35);
  if (!input.onchainMonitoringActive) confidence -= 0.03;

  return Math.round(clampConfidence(confidence) * 1000) / 1000;
}

function maxStatus(a: StatusLevel, b: StatusLevel): StatusLevel {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

function coerceCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function coerceNullableTimestamp(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMetric(value: unknown, digits = 2): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function fallbackState(rawOverallStatus: StatusLevel, now: number): StatusResponse["state"] {
  return {
    scope: "global",
    currentStatus: rawOverallStatus,
    rawStatus: rawOverallStatus,
    lastEvaluatedAt: now,
    lastChangedAt: now,
    minDwellSec: 120,
    staleMinDwellSec: 180,
    consecutiveRaw: {
      healthy: rawOverallStatus === "healthy" ? 1 : 0,
      degraded: rawOverallStatus === "degraded" ? 1 : 0,
      stale: rawOverallStatus === "stale" ? 1 : 0,
    },
    thresholds: {
      escalateToDegraded: 2,
      escalateToStale: 1,
      recoverToDegraded: 2,
      recoverToHealthy: 3,
    },
  };
}

export async function evaluateStatusAndPersist(
  db: D1Database,
  now: number,
): Promise<{
  raw: RawStatusComputation;
  effectiveStatus: StatusLevel;
}> {
  const raw = await computeRawStatus(db, now);
  const persisted = await reconcileStatusState(db, now, raw.rawOverallStatus, raw.confidence, raw.causes.overall);
  return {
    raw,
    effectiveStatus: persisted.effectiveStatus,
  };
}

async function computeRawStatus(db: D1Database, now: number): Promise<RawStatusComputation> {
  // 1. Cache freshness
  const { caches, worstRatio: worstCacheRatio } = await buildCacheStatuses(db, now);

  // 2. Cron run history (batch query)
  const cronJobs = Object.keys(CRON_INTERVALS);
  const cronJobInClause = buildInClause(cronJobs);
  const cronRows = await db
    .prepare(
      `SELECT job, started_at, duration_ms, status, error, item_count, metadata
       FROM cron_runs
       WHERE job IN (${cronJobInClause.sql})
       ORDER BY started_at DESC`,
    )
    .bind(...cronJobInClause.binds)
    .all<{
      job: string;
      started_at: number;
      duration_ms: number;
      status: string;
      error: string | null;
      item_count: number | null;
      metadata: string | null;
    }>();

  // Group by job, keeping only the 10 most recent per job
  const cronByJob = new Map<string, CronRun[]>();
  for (const r of cronRows.results ?? []) {
    const runs = cronByJob.get(r.job) ?? [];
    if (runs.length < 10) {
      let parsedMeta: Record<string, unknown> | undefined;
      if (r.metadata) {
        try {
          parsedMeta = JSON.parse(r.metadata);
        } catch {
          // Ignore malformed metadata.
        }
      }
      runs.push({
        startedAt: r.started_at,
        durationMs: r.duration_ms,
        status: r.status,
        ...(r.error ? { error: r.error } : {}),
        ...(r.item_count != null ? { itemCount: r.item_count } : {}),
        ...(parsedMeta ? { metadata: parsedMeta } : {}),
      });
      cronByJob.set(r.job, runs);
    }
  }

  const crons: Record<string, CronStatus> = {};
  let anyCronError = false;
  let unhealthyCrons = 0;
  let degradedCronRuns = 0;
  let cronErrorCount = 0;

  for (const [job, interval] of Object.entries(CRON_INTERVALS)) {
    const runs = cronByJob.get(job) ?? [];
    const lastRun = runs.length > 0 ? runs[0] : null;
    const isFresh = lastRun != null && now - lastRun.startedAt <= interval * 2;
    const hasFreshOk = runs.some((run) => run.status === "ok" && now - run.startedAt <= interval * 2);
    const availabilityUnhealthy =
      !isFresh || lastRun == null || lastRun.status === "error" || (lastRun.status === "skipped_locked" && !hasFreshOk);
    const healthy =
      isFresh &&
      (lastRun!.status === "ok" ||
        lastRun!.status === "degraded" ||
        (lastRun!.status === "skipped_locked" && hasFreshOk));

    if (availabilityUnhealthy) unhealthyCrons++;
    if (lastRun?.status === "degraded" && isFresh) degradedCronRuns++;
    if (lastRun?.status === "error") {
      anyCronError = true;
      cronErrorCount++;
    }

    crons[job] = {
      lastRun,
      recentRuns: runs,
      expectedIntervalSec: interval,
      healthy,
    };
  }

  // 3. DB health sentinel (short-circuits data quality + dataset freshness when unavailable).
  let dbHealthy = true;
  try {
    await db.prepare("SELECT 1").first();
  } catch (err) {
    dbHealthy = false;
    console.error("[status] DB health sentinel failed:", err);
  }

  // 4. Data quality + dataset freshness
  const dataQuality = dbHealthy ? await getDataQuality(db, now) : emptyDataQuality();
  const telegramBot = dbHealthy ? await getTelegramBotStats(db, now) : null;
  const datasetFreshness = dbHealthy ? await getDatasetFreshness(db) : emptyDatasetFreshness();
  const missingPriceRatio =
    dataQuality.totalStablecoins > 0 ? dataQuality.missingPrices / dataQuality.totalStablecoins : 0;
  const blacklistMissingRatio = dataQuality.blacklistMissingRatio;
  const blacklistRecentMissing = dataQuality.blacklistRecentMissingAmounts;
  const hasActiveOnchainMonitor = dataQuality.onchainSupplyMonitoring === "active";
  const trackedOnchainCoins = hasActiveOnchainMonitor ? dataQuality.onchainSupplyTrackedCoins : 0;
  const staleOnchainSupply = hasActiveOnchainMonitor ? dataQuality.staleOnchainSupply : 0;
  const onchainSupplyDivergences = hasActiveOnchainMonitor ? dataQuality.onchainSupplyDivergences : 0;
  const staleOnchainRatio = trackedOnchainCoins > 0 ? staleOnchainSupply / trackedOnchainCoins : 0;
  const onchainDivergenceRatio = trackedOnchainCoins > 0 ? onchainSupplyDivergences / trackedOnchainCoins : 0;

  // 5. Raw status synthesis
  const baseAvailabilityStatus: StatusResponse["availabilityStatus"] =
    worstCacheRatio > 2 || anyCronError || unhealthyCrons >= 3
      ? "stale"
      : worstCacheRatio > 1.5 || unhealthyCrons > 0
        ? "degraded"
        : "healthy";
  const availabilityStatus: StatusResponse["availabilityStatus"] = dbHealthy
    ? baseAvailabilityStatus
    : maxStatus(baseAvailabilityStatus, "degraded");

  const dataQualityStatus: StatusResponse["dataQualityStatus"] =
    dataQuality.stablecoinsCacheStatus === "error" ||
    missingPriceRatio > 0.4 ||
    blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioStale ||
    blacklistRecentMissing >= STATUS_BLACKLIST_THRESHOLDS.missingRecentStale ||
    staleOnchainSupply >= STATUS_ONCHAIN_THRESHOLDS.staleAbsoluteStale ||
    onchainSupplyDivergences >= STATUS_ONCHAIN_THRESHOLDS.divergenceAbsoluteStale ||
    staleOnchainRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioStale ||
    onchainDivergenceRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioStale
      ? "stale"
      : dataQuality.stablecoinsCacheStatus === "degraded" ||
          missingPriceRatio > 0.15 ||
          blacklistRecentMissing > 0 ||
          blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded ||
          staleOnchainRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded ||
          onchainDivergenceRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded
        ? "degraded"
        : "healthy";

  const rawOverallStatus = maxStatus(availabilityStatus, dataQualityStatus);

  const availabilityCauses: StatusCause[] = [];
  if (!dbHealthy) {
    pushCause(availabilityCauses, {
      code: "db_unhealthy",
      layer: "availability",
      severity: "warning",
      message: "Primary database connectivity check failed; data-quality queries were skipped.",
    });
  }
  if (worstCacheRatio > 2) {
    pushCause(availabilityCauses, {
      code: "cache_ratio_stale",
      layer: "availability",
      severity: "critical",
      message: `Cache freshness exceeded stale threshold (${worstCacheRatio.toFixed(2)}x > 2.00x).`,
      metric: "worstCacheRatio",
      value: worstCacheRatio,
      threshold: 2,
    });
  } else if (worstCacheRatio > 1.5) {
    pushCause(availabilityCauses, {
      code: "cache_ratio_degraded",
      layer: "availability",
      severity: "warning",
      message: `Cache freshness exceeded degraded threshold (${worstCacheRatio.toFixed(2)}x > 1.50x).`,
      metric: "worstCacheRatio",
      value: worstCacheRatio,
      threshold: 1.5,
    });
  }
  if (cronErrorCount > 0) {
    pushCause(availabilityCauses, {
      code: "cron_error_runs",
      layer: "availability",
      severity: "critical",
      message: `${cronErrorCount} cron job(s) currently have last-run status=error.`,
      metric: "cronErrors",
      value: cronErrorCount,
      threshold: 1,
    });
  }
  if (unhealthyCrons >= 3) {
    pushCause(availabilityCauses, {
      code: "multiple_unhealthy_crons",
      layer: "availability",
      severity: "critical",
      message: `${unhealthyCrons} cron jobs are unavailable/stale.`,
      metric: "unhealthyCrons",
      value: unhealthyCrons,
      threshold: 3,
    });
  } else if (unhealthyCrons > 0) {
    pushCause(availabilityCauses, {
      code: "unhealthy_crons_present",
      layer: "availability",
      severity: "warning",
      message: `${unhealthyCrons} cron job(s) are unavailable/stale.`,
      metric: "unhealthyCrons",
      value: unhealthyCrons,
      threshold: 1,
    });
  }
  if (degradedCronRuns > 0) {
    pushCause(availabilityCauses, {
      code: "degraded_cron_warning",
      layer: "availability",
      severity: "info",
      message: `${degradedCronRuns} cron job(s) are in fallback/degraded mode (warning-only).`,
      metric: "degradedCrons",
      value: degradedCronRuns,
      threshold: 1,
    });
  }

  const dataQualityCauses: StatusCause[] = [];
  if (dataQuality.stablecoinsCacheStatus === "error") {
    pushCause(dataQualityCauses, {
      code: "stablecoins_cache_unavailable",
      layer: "data-quality",
      severity: "critical",
      message: `Stablecoins cache is unavailable (${dataQuality.stablecoinsCacheReason ?? "unknown"}).`,
    });
  } else if (dataQuality.stablecoinsCacheStatus === "degraded") {
    pushCause(dataQualityCauses, {
      code: "stablecoins_cache_degraded",
      layer: "data-quality",
      severity: "warning",
      message: `Stablecoins cache is degraded (${dataQuality.stablecoinsCacheReason ?? "unknown"}).`,
    });
  }
  if (missingPriceRatio > 0.4) {
    pushCause(dataQualityCauses, {
      code: "missing_prices_stale",
      layer: "data-quality",
      severity: "critical",
      message: `Missing price ratio is stale (${formatRatio(missingPriceRatio)} > 40%).`,
      metric: "missingPriceRatio",
      value: missingPriceRatio,
      threshold: 0.4,
    });
  } else if (missingPriceRatio > 0.15) {
    pushCause(dataQualityCauses, {
      code: "missing_prices_degraded",
      layer: "data-quality",
      severity: "warning",
      message: `Missing price ratio is degraded (${formatRatio(missingPriceRatio)} > 15%).`,
      metric: "missingPriceRatio",
      value: missingPriceRatio,
      threshold: 0.15,
    });
  }
  if (
    blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioStale ||
    blacklistRecentMissing >= STATUS_BLACKLIST_THRESHOLDS.missingRecentStale
  ) {
    pushCause(dataQualityCauses, {
      code: "blacklist_gaps_stale",
      layer: "data-quality",
      severity: "critical",
      message: `Blacklist amount gaps exceed stale thresholds (ratio=${formatRatio(blacklistMissingRatio)}, recent=${blacklistRecentMissing}).`,
      metric: "blacklistMissingRatio",
      value: blacklistMissingRatio,
      threshold: STATUS_BLACKLIST_THRESHOLDS.missingRatioStale,
    });
  } else if (blacklistRecentMissing > 0 || blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded) {
    pushCause(dataQualityCauses, {
      code: "blacklist_gaps_degraded",
      layer: "data-quality",
      severity: "warning",
      message: `Recent or elevated blacklist amount gaps detected (ratio=${formatRatio(blacklistMissingRatio)}, recent=${blacklistRecentMissing}).`,
      metric: "blacklistMissingRatio",
      value: blacklistMissingRatio,
      threshold: STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded,
    });
  }
  if (hasActiveOnchainMonitor) {
    if (
      staleOnchainRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioStale ||
      onchainDivergenceRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioStale
    ) {
      pushCause(dataQualityCauses, {
        code: "onchain_integrity_stale",
        layer: "data-quality",
        severity: "critical",
        message: `On-chain integrity stale (stale=${formatRatio(staleOnchainRatio)}, divergence=${formatRatio(onchainDivergenceRatio)}).`,
        metric: "onchainStaleRatio",
        value: staleOnchainRatio,
        threshold: STATUS_ONCHAIN_THRESHOLDS.ratioStale,
      });
    } else if (
      staleOnchainRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded ||
      onchainDivergenceRatio >= STATUS_ONCHAIN_THRESHOLDS.ratioDegraded
    ) {
      pushCause(dataQualityCauses, {
        code: "onchain_integrity_degraded",
        layer: "data-quality",
        severity: "warning",
        message: `On-chain integrity degraded (stale=${formatRatio(staleOnchainRatio)}, divergence=${formatRatio(onchainDivergenceRatio)}).`,
        metric: "onchainStaleRatio",
        value: staleOnchainRatio,
        threshold: STATUS_ONCHAIN_THRESHOLDS.ratioDegraded,
      });
    }
  } else {
    pushCause(dataQualityCauses, {
      code: "onchain_monitor_unavailable",
      layer: "data-quality",
      severity: "info",
      message: "On-chain supply monitor is unavailable; related checks are suppressed.",
    });
  }

  const confidence = scoreConfidence({
    availabilityStatus,
    dataQualityStatus,
    unhealthyCrons,
    degradedCrons: degradedCronRuns,
    missingPriceRatio,
    onchainMonitoringActive: hasActiveOnchainMonitor,
  });

  return {
    dbHealthy,
    availabilityStatus,
    dataQualityStatus,
    rawOverallStatus,
    confidence,
    causes: {
      availability: availabilityCauses,
      dataQuality: dataQualityCauses,
      overall: synthesizeOverallCauses(availabilityCauses, dataQualityCauses),
    },
    caches,
    crons,
    dataQuality,
    telegramBot,
    datasetFreshness,
    summary: {
      unhealthyCrons,
      degradedCrons: degradedCronRuns,
      cronErrors: cronErrorCount,
      worstCacheRatio,
    },
  };
}

// --- Handler ---

export const handleStatus = withErrorHandler(
  "status",
  async (db: D1Database, adminKey?: string, request?: Request): Promise<Response> => {
    return withAdmin(request, adminKey, async () => {
      const now = Math.floor(Date.now() / 1000);
      const raw = await computeRawStatus(db, now);

      let { state, staleness } = await getStatusStateSnapshot(db, now);

      // Bootstrap or refresh stale state on-demand in case the self-check cron is delayed.
      if (!state || staleness?.isStale) {
        const seeded = await reconcileStatusState(db, now, raw.rawOverallStatus, raw.confidence, raw.causes.overall);
        state = seeded.state;
        staleness = {
          ageSeconds: 0,
          maxAgeSec: STATUS_SYSTEM_FRESHNESS_SEC,
          isStale: false,
        };
      }

      const effectiveOverallStatus = state?.currentStatus ?? raw.rawOverallStatus;
      const probe = await getLatestStatusProbe(db);
      const discrepancyStreak = await getDiscrepancyStreak(db);
      const discrepancy = buildDiscrepancy(effectiveOverallStatus, probe, now, discrepancyStreak);
      const timeline = await listRecentStatusTransitions(db, 40);

      const body: StatusResponse = {
        timestamp: now,
        dbHealthy: raw.dbHealthy,
        availabilityStatus: raw.availabilityStatus,
        dataQualityStatus: raw.dataQualityStatus,
        rawOverallStatus: raw.rawOverallStatus,
        overallStatus: effectiveOverallStatus,
        confidence: raw.confidence,
        causes: raw.causes,
        state: state ?? fallbackState(raw.rawOverallStatus, now),
        staleness: staleness ?? {
          ageSeconds: 0,
          maxAgeSec: STATUS_SYSTEM_FRESHNESS_SEC,
          isStale: false,
        },
        probe,
        discrepancy,
        timeline,
        caches: raw.caches,
        crons: raw.crons,
        dataQuality: raw.dataQuality,
        telegramBot: raw.telegramBot,
        datasetFreshness: raw.datasetFreshness,
        summary: raw.summary,
      };

      return jsonResponse(body, { "Cache-Control": "no-store" });
    });
  },
);

// --- Data quality queries ---

function emptyDataQuality(): DataQuality {
  return {
    stablecoinsCacheStatus: "error",
    stablecoinsCacheReason: "db-unavailable",
    totalStablecoins: 0,
    missingPrices: 0,
    blacklistMissingAmounts: 0,
    blacklistRecentMissingAmounts: 0,
    blacklistRecentWindowSec: BLACKLIST_RECENT_WINDOW_SEC,
    blacklistMissingRatio: 0,
    blacklistTotal: 0,
    onchainSupplyDivergences: 0,
    onchainDivergenceRatio: 0,
    onchainSupplyMonitoring: "unavailable",
    onchainSupplyLatestAt: null,
    onchainSupplyTrackedCoins: 0,
    activeDepegs: 0,
    staleOnchainSupply: 0,
    onchainStaleRatio: 0,
  };
}

function emptyDatasetFreshness(): StatusResponse["datasetFreshness"] {
  return {
    stablecoins: null,
    blacklist: null,
    mintBurn: null,
    supply: null,
    yield: null,
    depegs: null,
    dews: null,
    digest: null,
  };
}

interface TelegramBotAggregateRow {
  total_chats: number | string | null;
  alert_enabled_chats: number | string | null;
  deliverable_chats: number | string | null;
  subscribed_chats: number | string | null;
  empty_alert_chats: number | string | null;
  muted_chats_with_subscriptions: number | string | null;
  dews_chats: number | string | null;
  depeg_chats: number | string | null;
  safety_chats: number | string | null;
  all_types_chats: number | string | null;
  total_subscriptions: number | string | null;
  avg_subscriptions_per_subscribed_chat: number | string | null;
  last_subscriber_activity_at: number | string | null;
}

interface TelegramBotPendingRow {
  pending_count: number | string | null;
}

interface TelegramBotTopStablecoinRow {
  stablecoin_id: string;
  subscribers: number | string | null;
}

async function getTelegramBotStats(db: D1Database, now: number): Promise<TelegramBotStats | null> {
  try {
    const [aggregate, pending, topCoins] = await Promise.all([
      db
        .prepare(
          `SELECT
             COUNT(*) AS total_chats,
             SUM(CASE WHEN s.alert_dews = 1 OR s.alert_depeg = 1 OR s.alert_safety = 1 THEN 1 ELSE 0 END) AS alert_enabled_chats,
             SUM(
               CASE
                 WHEN (s.alert_dews = 1 OR s.alert_depeg = 1 OR s.alert_safety = 1) AND COALESCE(sub.sub_count, 0) > 0
                 THEN 1 ELSE 0
               END
             ) AS deliverable_chats,
             SUM(CASE WHEN COALESCE(sub.sub_count, 0) > 0 THEN 1 ELSE 0 END) AS subscribed_chats,
             SUM(
               CASE
                 WHEN (s.alert_dews = 1 OR s.alert_depeg = 1 OR s.alert_safety = 1) AND COALESCE(sub.sub_count, 0) = 0
                 THEN 1 ELSE 0
               END
             ) AS empty_alert_chats,
             SUM(
               CASE
                 WHEN s.alert_dews = 0 AND s.alert_depeg = 0 AND s.alert_safety = 0 AND COALESCE(sub.sub_count, 0) > 0
                 THEN 1 ELSE 0
               END
             ) AS muted_chats_with_subscriptions,
             SUM(CASE WHEN s.alert_dews = 1 THEN 1 ELSE 0 END) AS dews_chats,
             SUM(CASE WHEN s.alert_depeg = 1 THEN 1 ELSE 0 END) AS depeg_chats,
             SUM(CASE WHEN s.alert_safety = 1 THEN 1 ELSE 0 END) AS safety_chats,
             SUM(CASE WHEN s.alert_dews = 1 AND s.alert_depeg = 1 AND s.alert_safety = 1 THEN 1 ELSE 0 END) AS all_types_chats,
             SUM(COALESCE(sub.sub_count, 0)) AS total_subscriptions,
             AVG(CASE WHEN COALESCE(sub.sub_count, 0) > 0 THEN sub.sub_count END) AS avg_subscriptions_per_subscribed_chat,
             MAX(s.last_active_at) AS last_subscriber_activity_at
           FROM telegram_subscribers s
           LEFT JOIN (
             SELECT chat_id, COUNT(*) AS sub_count
               FROM telegram_subscriptions
              GROUP BY chat_id
           ) sub ON sub.chat_id = s.chat_id`,
        )
        .first<TelegramBotAggregateRow>(),
      db
        .prepare("SELECT COUNT(*) AS pending_count FROM telegram_pending_disambiguation WHERE expires_at > ?")
        .bind(now)
        .first<TelegramBotPendingRow>(),
      db
        .prepare(
          `SELECT stablecoin_id, COUNT(*) AS subscribers
             FROM telegram_subscriptions
            GROUP BY stablecoin_id
            ORDER BY subscribers DESC, stablecoin_id ASC
            LIMIT 5`,
        )
        .all<TelegramBotTopStablecoinRow>()
        .then((result) => result.results ?? []),
    ]);

    return {
      totalChats: coerceCount(aggregate?.total_chats),
      alertEnabledChats: coerceCount(aggregate?.alert_enabled_chats),
      deliverableChats: coerceCount(aggregate?.deliverable_chats),
      subscribedChats: coerceCount(aggregate?.subscribed_chats),
      emptyAlertChats: coerceCount(aggregate?.empty_alert_chats),
      mutedChatsWithSubscriptions: coerceCount(aggregate?.muted_chats_with_subscriptions),
      totalSubscriptions: coerceCount(aggregate?.total_subscriptions),
      avgSubscriptionsPerSubscribedChat: roundMetric(aggregate?.avg_subscriptions_per_subscribed_chat, 1),
      pendingDisambiguations: coerceCount(pending?.pending_count),
      lastSubscriberActivityAt: coerceNullableTimestamp(aggregate?.last_subscriber_activity_at),
      alertTypeChats: {
        dews: coerceCount(aggregate?.dews_chats),
        depeg: coerceCount(aggregate?.depeg_chats),
        safety: coerceCount(aggregate?.safety_chats),
        allTypes: coerceCount(aggregate?.all_types_chats),
      },
      topStablecoins: topCoins.map((row) => ({
        stablecoinId: row.stablecoin_id,
        symbol: TRACKED_META_BY_ID.get(row.stablecoin_id)?.symbol ?? row.stablecoin_id,
        subscribers: coerceCount(row.subscribers),
      })),
    };
  } catch (err) {
    console.warn("[status] Telegram bot stats unavailable:", err);
    return null;
  }
}

interface DatasetFreshnessTarget {
  table: string;
  column: string;
  where?: string;
}

const DATASET_FRESHNESS_TARGETS: Record<keyof StatusResponse["datasetFreshness"], DatasetFreshnessTarget> = {
  stablecoins: { table: "cache", column: "updated_at", where: "key = 'stablecoins'" },
  blacklist: { table: "blacklist_events", column: "timestamp" },
  mintBurn: { table: "mint_burn_events", column: "timestamp" },
  supply: { table: "supply_history", column: "snapshot_date" },
  yield: { table: "yield_data", column: "updated_at" },
  depegs: { table: "depeg_events", column: "started_at" },
  dews: { table: "stress_signals", column: "computed_at" },
  digest: { table: "daily_digest", column: "generated_at" },
};

async function getLastUpdate(db: D1Database, target: DatasetFreshnessTarget): Promise<number | null> {
  const where = target.where ? ` WHERE ${target.where}` : "";
  try {
    // SAFETY: table/column/where values come from DATASET_FRESHNESS_TARGETS (hardcoded, not user input).
    const row = await db
      .prepare(`SELECT MAX(${target.column}) as latest FROM ${target.table}${where}`)
      .first<{ latest: number | null }>();
    return row?.latest ?? null;
  } catch (err) {
    console.error(`[status] Failed dataset freshness query for ${target.table}:`, err);
    return null;
  }
}

async function getDatasetFreshness(db: D1Database): Promise<StatusResponse["datasetFreshness"]> {
  const [stablecoins, blacklist, mintBurn, supply, yieldTs, depegs, dews, digest] = await Promise.all([
    getLastUpdate(db, DATASET_FRESHNESS_TARGETS.stablecoins),
    getLastUpdate(db, DATASET_FRESHNESS_TARGETS.blacklist),
    getLastUpdate(db, DATASET_FRESHNESS_TARGETS.mintBurn),
    getLastUpdate(db, DATASET_FRESHNESS_TARGETS.supply),
    getLastUpdate(db, DATASET_FRESHNESS_TARGETS.yield),
    getLastUpdate(db, DATASET_FRESHNESS_TARGETS.depegs),
    getLastUpdate(db, DATASET_FRESHNESS_TARGETS.dews),
    getLastUpdate(db, DATASET_FRESHNESS_TARGETS.digest),
  ]);

  return {
    stablecoins,
    blacklist,
    mintBurn,
    supply,
    yield: yieldTs,
    depegs,
    dews,
    digest,
  };
}

async function getDataQuality(db: D1Database, now: number): Promise<DataQuality> {
  const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
  if (stablecoinsCacheResult.kind !== "ok") {
    console.warn(`[status] stablecoins cache ${stablecoinsCacheResult.kind} (${stablecoinsCacheResult.reason})`);
  }
  const stablecoinAssets = hasUsableStablecoinsPayload(stablecoinsCacheResult)
    ? stablecoinsCacheResult.payload.peggedAssets as Array<{
        id: string;
        price?: number;
        circulating?: Record<string, number>;
      }>
    : [];
  const stablecoinAssetMap = new Map(stablecoinAssets.map((asset) => [asset.id, asset]));

  // Missing prices: parse stablecoins cache
  const totalStablecoins = stablecoinAssets.length;
  const missingPrices = stablecoinAssets.filter(
    (asset: { price?: number | null }) => asset.price == null || asset.price === 0,
  ).length;

  // Blacklist gaps
  let blacklistTotal = 0;
  let blacklistMissingAmounts = 0;
  let blacklistRecentMissingAmounts = 0;
  try {
    const gaps = await queryBlacklistGapMetrics(db, now, BLACKLIST_RECENT_WINDOW_SEC);
    blacklistTotal = gaps.totalEvents;
    blacklistMissingAmounts = gaps.missingAmounts;
    blacklistRecentMissingAmounts = gaps.recentMissingAmounts;
  } catch (e) {
    console.error("[status] Failed to query blacklist gaps:", e);
  }

  // Active depegs
  let activeDepegs = 0;
  try {
    const dp = await db
      .prepare("SELECT COUNT(*) as cnt FROM depeg_events WHERE ended_at IS NULL")
      .first<{ cnt: number }>();
    if (dp) activeDepegs = dp.cnt;
  } catch (e) {
    console.error("[status] Failed to query active depegs:", e);
  }

  // Stale on-chain supply (rows older than 2h)
  let staleOnchainSupply = 0;
  let onchainSupplyDivergences = 0;
  let onchainSupplyMonitoring: DataQuality["onchainSupplyMonitoring"] = "unavailable";
  let onchainSupplyLatestAt: number | null = null;
  let onchainSupplyTrackedCoins = 0;
  try {
    const monitor = await db
      .prepare("SELECT MAX(updated_at) as latest, COUNT(DISTINCT stablecoin_id) as tracked FROM onchain_supply")
      .first<{ latest: number | null; tracked: number }>();
    onchainSupplyLatestAt = monitor?.latest ?? null;
    onchainSupplyTrackedCoins = monitor?.tracked ?? 0;

    // The on-chain supply monitor is considered active only when rows are recent.
    if (onchainSupplyLatestAt != null && now - onchainSupplyLatestAt <= 3 * 86400) {
      onchainSupplyMonitoring = "active";
    }
  } catch (e) {
    console.error("[status] Failed to query stale on-chain supply:", e);
  }

  if (onchainSupplyMonitoring === "active") {
    try {
      const stale = await db
        .prepare(
          `SELECT COUNT(*) as cnt
           FROM (
             SELECT stablecoin_id, MAX(updated_at) as latest_update
             FROM onchain_supply
             GROUP BY stablecoin_id
             HAVING latest_update < ?
           )`,
        )
        .bind(now - 7200)
        .first<{ cnt: number }>();
      if (stale) staleOnchainSupply = stale.cnt;
    } catch (e) {
      console.error("[status] Failed to query stale on-chain supply:", e);
    }

    // On-chain supply divergences (compare on-chain vs DefiLlama)
    try {
      const onchainRows = await db
        .prepare(
          "SELECT stablecoin_id, SUM(supply) as total_supply FROM onchain_supply WHERE updated_at > ? GROUP BY stablecoin_id",
        )
        .bind(now - 7200)
        .all<{ stablecoin_id: string; total_supply: number }>();

      if (onchainRows.results && onchainRows.results.length > 0) {
        for (const row of onchainRows.results) {
          const asset = stablecoinAssetMap.get(row.stablecoin_id);
          if (!asset?.price || asset.price <= 0 || !asset.circulating) continue;
          // DefiLlama circulating values are in USD.
          const llamaValues = Object.values(asset.circulating);
          const llamaTotal = llamaValues.reduce((sum, value) => sum + (value ?? 0), 0);
          const llamaSupply = llamaTotal / asset.price;
          if (llamaSupply > 0) {
            const divergence = Math.abs(row.total_supply - llamaSupply) / llamaSupply;
            if (divergence > 0.05) onchainSupplyDivergences++;
          }
        }
      }
    } catch (e) {
      console.error("[status] Failed to check on-chain supply divergences:", e);
    }
  }

  return {
    stablecoinsCacheStatus: stablecoinsCacheResult.kind,
    stablecoinsCacheReason: stablecoinsCacheResult.kind === "ok" ? null : stablecoinsCacheResult.reason,
    totalStablecoins,
    missingPrices,
    blacklistMissingAmounts,
    blacklistRecentMissingAmounts,
    blacklistRecentWindowSec: BLACKLIST_RECENT_WINDOW_SEC,
    blacklistMissingRatio: blacklistTotal > 0 ? blacklistMissingAmounts / blacklistTotal : 0,
    blacklistTotal,
    onchainSupplyDivergences,
    onchainDivergenceRatio:
      onchainSupplyMonitoring === "active" && onchainSupplyTrackedCoins > 0
        ? onchainSupplyDivergences / onchainSupplyTrackedCoins
        : 0,
    onchainSupplyMonitoring,
    onchainSupplyLatestAt,
    onchainSupplyTrackedCoins,
    activeDepegs,
    staleOnchainSupply,
    onchainStaleRatio:
      onchainSupplyMonitoring === "active" && onchainSupplyTrackedCoins > 0
        ? staleOnchainSupply / onchainSupplyTrackedCoins
        : 0,
  };
}
