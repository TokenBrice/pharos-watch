import { sendAlert } from "../lib/alerts";
import type { CronResult } from "../lib/cron-logger";
import { CRON_TIMEOUT_MS, runWithOverloadRetry } from "../lib/cron-lease";
import { getCache, setCache } from "../lib/db-cache";
import { throwIfAborted } from "../lib/abort";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";

/**
 * Duration-trend watchdog for status-tracked cron jobs with explicit app-level
 * timeouts (`CRON_TIMEOUT_MS`). sync-stablecoins already averages ~70% of its
 * 8-min ceiling and has hit the cap in production; adding the next provider
 * to a near-budget slot would tip it over with no warning. Alerts when a
 * job's 7-day average crosses 80% of its ceiling or it hits the cap 3+ times
 * in a week, so capacity is budgeted before the timeout starts truncating
 * runs. Per-job stats are always emitted in cron metadata for trend review, and
 * the scheduled-runner contract requires every status-tracked job to appear in
 * the timeout map.
 */
const DURATION_ALERT_AVG_RATIO = 0.8;
const DURATION_ALERT_CAP_HITS = 3;
const DURATION_ALERT_BUDGET_TRUNCATIONS = 3;
const SLOT_ABANDONMENT_ALERT_COUNT = 3;
const SLOT_ABANDONMENT_ALERT_RATIO = 0.1;
const SLOT_ABANDONMENT_RECENT_WINDOW_SEC = 24 * 3600;
const RUNTIME_CAP_RECENT_WINDOW_SEC = 24 * 3600;
const LOOKBACK_SEC = 7 * 86400;
// Skip jobs with too few recent runs (fresh deploys, paused lanes) — a 7d
// average over a handful of runs is noise, not a trend.
const MIN_RUNS_FOR_TREND = 20;
const MIN_SLOTS_FOR_ABANDONMENT_TREND = 20;
const ALERT_COOLDOWN_SEC = 7 * 86400;
const ALERT_MARKER_KEY = "cron-duration-watchdog:alert:direct:v1";
const STALE_SLOT_CHILD_ERROR = "scheduled slot heartbeat stale; child job progress abandoned";
const STALE_SLOT_ERROR = "scheduled slot heartbeat stale; marked expired by later invocation";
const STALE_SLOT_METADATA_REASON = "stale-slot-reconciled";

interface JobDurationStats {
  job: string;
  runs: number;
  avgMs: number;
  maxMs: number;
  capHits: number;
  budgetTruncations: number;
  latestCapHitAt: number | null;
  latestBudgetTruncationAt: number | null;
  timeoutMs: number;
  avgRatio: number;
}

interface DurationStageBreakdown {
  stage: string;
  runs: number;
  avgMs: number;
  maxMs: number;
  capHits: number;
  budgetTruncations: number;
}

interface DurationCapHitSample {
  startedAt: number;
  durationMs: number;
  status: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

interface DurationDiagnostic {
  job: string;
  timeoutMs: number;
  stageBreakdown: DurationStageBreakdown[];
  samples: DurationCapHitSample[];
}

interface SlotAbandonmentStats {
  scheduleKey: string;
  slots: number;
  errorSlots: number;
  abandonedSlots: number;
  latestAbandonedAt: number | null;
  abandonmentRatio: number;
}

interface StatsRow {
  n: number;
  avg_ms: number | null;
  max_ms: number | null;
  cap_hits: number | null;
  budget_truncations: number | null;
  latest_cap_hit_at: number | null;
  latest_budget_truncation_at: number | null;
}

interface SlotStatsRow {
  slot_key: string;
  slots: number;
  error_slots: number | null;
  abandoned_slots: number | null;
  latest_abandoned_at: number | null;
}

interface DurationStageBreakdownRow {
  stage_label: string | null;
  runs: number;
  avg_ms: number | null;
  max_ms: number | null;
  cap_hits: number | null;
  budget_truncations: number | null;
}

interface DurationSampleRow {
  started_at: number;
  duration_ms: number;
  status: string | null;
  error: string | null;
  metadata: string | null;
}

const DURATION_DIAGNOSTIC_METADATA_KEYS = [
  "stage",
  "phase",
  "runBudgetTruncated",
  "runBudgetTruncationCount",
  "runtimeBudgetHit",
  "deferredCoins",
  "nextCursorStablecoinId",
  "cursorStablecoinId",
  "budgetMs",
  "d1FinalizeTimeoutMs",
  "d1TailBudgetExhausted",
  "provider",
  "source",
  "breakerKey",
  "failureCategory",
] as const;

function isRecent(timestampSec: number | null, nowSec: number, windowSec: number): boolean {
  return timestampSec != null && timestampSec >= nowSec - windowSec;
}

function isRuntimeBreaching(stats: JobDurationStats, nowSec: number): boolean {
  const hasRecentCapHits =
    stats.capHits >= DURATION_ALERT_CAP_HITS && isRecent(stats.latestCapHitAt, nowSec, RUNTIME_CAP_RECENT_WINDOW_SEC);
  const hasRecentBudgetTruncations =
    stats.budgetTruncations >= DURATION_ALERT_BUDGET_TRUNCATIONS &&
    isRecent(stats.latestBudgetTruncationAt, nowSec, RUNTIME_CAP_RECENT_WINDOW_SEC);
  const hasAverageTrend = stats.runs >= MIN_RUNS_FOR_TREND && stats.avgRatio >= DURATION_ALERT_AVG_RATIO;
  return hasAverageTrend || hasRecentCapHits || hasRecentBudgetTruncations;
}

function isSlotAbandonmentBreaching(stats: SlotAbandonmentStats, nowSec: number): boolean {
  if (stats.slots < MIN_SLOTS_FOR_ABANDONMENT_TREND) return false;
  if (stats.latestAbandonedAt == null || stats.latestAbandonedAt < nowSec - SLOT_ABANDONMENT_RECENT_WINDOW_SEC) {
    return false;
  }
  return stats.abandonedSlots >= SLOT_ABANDONMENT_ALERT_COUNT && stats.abandonmentRatio >= SLOT_ABANDONMENT_ALERT_RATIO;
}

function readLastAlertedAt(value: string | null | undefined): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value) as { lastAlertedAt?: unknown };
    return typeof parsed.lastAlertedAt === "number" ? parsed.lastAlertedAt : 0;
  } catch {
    return 0;
  }
}

function readDiagnosticMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const picked: Record<string, unknown> = {};
    for (const key of DURATION_DIAGNOSTIC_METADATA_KEYS) {
      if (parsed[key] !== undefined) picked[key] = parsed[key];
    }
    const keys = Object.keys(parsed).sort();
    if (keys.length > 0) picked.metadataKeys = keys.slice(0, 40);
    return picked;
  } catch {
    return {};
  }
}

async function loadDurationDiagnostics(
  db: D1Database,
  breachingStats: readonly JobDurationStats[],
  sinceSec: number,
  signal?: AbortSignal,
): Promise<DurationDiagnostic[]> {
  const diagnostics: DurationDiagnostic[] = [];
  for (const stats of breachingStats) {
    throwIfAborted(signal);
    const stageRows = await runWithOverloadRetry(
      () =>
        db
          .prepare(
            `SELECT
             CASE
               WHEN json_valid(metadata) AND json_extract(metadata, '$.stage') IS NOT NULL
                 THEN CAST(json_extract(metadata, '$.stage') AS TEXT)
               WHEN json_valid(metadata) AND json_extract(metadata, '$.phase') IS NOT NULL
                 THEN CAST(json_extract(metadata, '$.phase') AS TEXT)
               WHEN json_valid(metadata) AND json_extract(metadata, '$.runBudgetTruncated') = 1
                 THEN 'run-budget-truncated'
               ELSE 'unknown'
             END AS stage_label,
             COUNT(*) AS runs,
             CAST(AVG(duration_ms) AS INT) AS avg_ms,
             MAX(duration_ms) AS max_ms,
             SUM(CASE WHEN duration_ms >= ? THEN 1 ELSE 0 END) AS cap_hits,
             SUM(
               CASE
                 WHEN json_valid(metadata) THEN
                   CASE WHEN json_extract(metadata, '$.runBudgetTruncated') = 1 THEN 1 ELSE 0 END
                 ELSE 0
               END
             ) AS budget_truncations
           FROM cron_runs
           WHERE job = ?
             AND started_at > ?
             AND (error IS NULL OR error <> ?)
             AND (
               metadata IS NULL
               OR CASE
                 WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata, '$.reason') <> ?, 1)
                 ELSE 1
               END
             )
             AND (
               duration_ms >= ?
               OR (
                 json_valid(metadata)
                 AND json_extract(metadata, '$.runBudgetTruncated') = 1
               )
             )
           GROUP BY stage_label
           ORDER BY cap_hits DESC, budget_truncations DESC, max_ms DESC
           LIMIT 8`,
          )
          .bind(
            stats.timeoutMs,
            stats.job,
            sinceSec,
            STALE_SLOT_CHILD_ERROR,
            STALE_SLOT_METADATA_REASON,
            stats.timeoutMs,
          )
          .all<DurationStageBreakdownRow>(),
      3,
      signal,
    );
    throwIfAborted(signal);
    const sampleRows = await runWithOverloadRetry(
      () =>
        db
          .prepare(
            `SELECT started_at, duration_ms, status, error, metadata
             FROM cron_runs
            WHERE job = ?
              AND started_at > ?
              AND (error IS NULL OR error <> ?)
              AND (
                metadata IS NULL
                OR CASE
                  WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata, '$.reason') <> ?, 1)
                  ELSE 1
                END
              )
              AND (
                duration_ms >= ?
                OR (
                  json_valid(metadata)
                  AND json_extract(metadata, '$.runBudgetTruncated') = 1
                )
              )
            ORDER BY started_at DESC
            LIMIT 5`,
          )
          .bind(stats.job, sinceSec, STALE_SLOT_CHILD_ERROR, STALE_SLOT_METADATA_REASON, stats.timeoutMs)
          .all<DurationSampleRow>(),
      3,
      signal,
    );
    diagnostics.push({
      job: stats.job,
      timeoutMs: stats.timeoutMs,
      stageBreakdown: (stageRows.results ?? []).map((row) => ({
        stage: row.stage_label ?? "unknown",
        runs: row.runs,
        avgMs: row.avg_ms ?? 0,
        maxMs: row.max_ms ?? 0,
        capHits: row.cap_hits ?? 0,
        budgetTruncations: row.budget_truncations ?? 0,
      })),
      samples: (sampleRows.results ?? []).map((row) => ({
        startedAt: row.started_at,
        durationMs: row.duration_ms,
        status: row.status,
        error: row.error,
        metadata: readDiagnosticMetadata(row.metadata),
      })),
    });
  }
  return diagnostics;
}

export async function runCronDurationWatchdog(
  db: D1Database,
  alertWebhookUrl: string | null,
  signal?: AbortSignal,
): Promise<CronResult> {
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - LOOKBACK_SEC;
  const watchedJobs = Object.entries(CRON_TIMEOUT_MS);

  const statements = watchedJobs.map(([job, timeoutMs]) =>
    db
      .prepare(
        `SELECT
           COUNT(*) AS n,
           CAST(AVG(duration_ms) AS INT) AS avg_ms,
           MAX(duration_ms) AS max_ms,
           SUM(CASE WHEN duration_ms >= ? THEN 1 ELSE 0 END) AS cap_hits,
           MAX(CASE WHEN duration_ms >= ? THEN started_at ELSE NULL END) AS latest_cap_hit_at,
           SUM(
             CASE
               WHEN json_valid(metadata) THEN
                 CASE WHEN json_extract(metadata, '$.runBudgetTruncated') = 1 THEN 1 ELSE 0 END
               ELSE 0
             END
           ) AS budget_truncations,
           MAX(
             CASE
               WHEN json_valid(metadata) AND json_extract(metadata, '$.runBudgetTruncated') = 1
                 THEN started_at
               ELSE NULL
             END
           ) AS latest_budget_truncation_at
         FROM cron_runs
         WHERE job = ?
           AND started_at > ?
           AND (error IS NULL OR error <> ?)
           AND (
             metadata IS NULL
             OR CASE
               WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata, '$.reason') <> ?, 1)
               ELSE 1
             END
           )`,
      )
      .bind(timeoutMs, timeoutMs, job, sinceSec, STALE_SLOT_CHILD_ERROR, STALE_SLOT_METADATA_REASON),
  );
  const results = await db.batch<StatsRow>(statements);
  throwIfAborted(signal);

  const stats: JobDurationStats[] = watchedJobs.map(([job, timeoutMs], index) => {
    const row = results[index]?.results?.[0];
    const avgMs = row?.avg_ms ?? 0;
    return {
      job,
      runs: row?.n ?? 0,
      avgMs,
      maxMs: row?.max_ms ?? 0,
      capHits: row?.cap_hits ?? 0,
      budgetTruncations: row?.budget_truncations ?? 0,
      latestCapHitAt: row?.latest_cap_hit_at ?? null,
      latestBudgetTruncationAt: row?.latest_budget_truncation_at ?? null,
      timeoutMs,
      avgRatio: timeoutMs > 0 ? avgMs / timeoutMs : 0,
    };
  });

  const slotRows = await db
    .prepare(
      `SELECT
         slot_key,
         COUNT(*) AS slots,
         SUM(CASE WHEN result_status = 'error' THEN 1 ELSE 0 END) AS error_slots,
         SUM(CASE WHEN is_abandoned = 1 THEN 1 ELSE 0 END) AS abandoned_slots,
         MAX(CASE WHEN is_abandoned = 1 THEN slot_started_at ELSE NULL END) AS latest_abandoned_at
       FROM (
         SELECT
           slot_key,
           slot_started_at,
           result_status,
           CASE
             WHEN result_status = 'error' AND json_valid(metadata) THEN
               CASE WHEN json_extract(metadata, '$.error') = ? THEN 1 ELSE 0 END
             ELSE 0
           END AS is_abandoned
         FROM cron_slot_executions
         WHERE slot_started_at > ?
       )
       GROUP BY slot_key`,
    )
    .bind(STALE_SLOT_ERROR, sinceSec)
    .all<SlotStatsRow>();
  throwIfAborted(signal);

  const slotStatsByKey = new Map((slotRows.results ?? []).map((row) => [row.slot_key, row]));
  const slotStats: SlotAbandonmentStats[] = Object.keys(SCHEDULED_SLOT_PLANS).map((scheduleKey) => {
    const row = slotStatsByKey.get(scheduleKey);
    const slots = row?.slots ?? 0;
    const abandonedSlots = row?.abandoned_slots ?? 0;
    return {
      scheduleKey,
      slots,
      errorSlots: row?.error_slots ?? 0,
      abandonedSlots,
      latestAbandonedAt: row?.latest_abandoned_at ?? null,
      abandonmentRatio: slots > 0 ? abandonedSlots / slots : 0,
    };
  });

  const runtimeBreaching = stats.filter((entry) => isRuntimeBreaching(entry, nowSec));
  const slotAbandonmentBreaching = slotStats.filter((entry) => isSlotAbandonmentBreaching(entry, nowSec));
  const durationDiagnostics = await loadDurationDiagnostics(db, runtimeBreaching, sinceSec, signal);

  if (runtimeBreaching.length === 0 && slotAbandonmentBreaching.length === 0) {
    return {
      itemCount: stats.length + slotStats.length,
      metadata: JSON.stringify({
        stats,
        slotStats,
        slotAbandonmentRecentWindowSec: SLOT_ABANDONMENT_RECENT_WINDOW_SEC,
        runtimeCapRecentWindowSec: RUNTIME_CAP_RECENT_WINDOW_SEC,
        runtimeBreaching: [],
        durationDiagnostics,
        slotAbandonmentBreaching: [],
        breaching: [],
      }),
    };
  }

  const marker = await getCache(db, ALERT_MARKER_KEY);
  throwIfAborted(signal);
  const dueForAlert = nowSec - readLastAlertedAt(marker?.value) >= ALERT_COOLDOWN_SEC;
  let alerted = false;
  if (dueForAlert) {
    const diagnosticsByJob = new Map(durationDiagnostics.map((entry) => [entry.job, entry]));
    const runtimeLines = runtimeBreaching.map(
      (entry) =>
        `- ${entry.job}: 7d avg ${Math.round(entry.avgMs / 1000)}s of ${Math.round(entry.timeoutMs / 1000)}s ceiling ` +
        `(${Math.round(entry.avgRatio * 100)}%), ${entry.capHits} run(s) at cap, ` +
        `${entry.budgetTruncations} budget truncation(s), ${entry.runs} runs` +
        (() => {
          const stages = diagnosticsByJob.get(entry.job)?.stageBreakdown ?? [];
          if (stages.length === 0) return "";
          return `; cap/trunc stages: ${stages
            .map((stage) => `${stage.stage} (${stage.capHits} cap, ${stage.budgetTruncations} trunc)`)
            .join(", ")}`;
        })(),
    );
    const slotLines = slotAbandonmentBreaching.map(
      (entry) =>
        `- ${entry.scheduleKey}: ${entry.abandonedSlots}/${entry.slots} slot(s) abandoned ` +
        `(${Math.round(entry.abandonmentRatio * 100)}%), ${entry.errorSlots} total error slot(s)`,
    );
    alerted = await sendAlert(
      alertWebhookUrl,
      "Cron runtime budget or slot abandonment breach",
      [
        "Cron runtime pressure and scheduled-slot abandonment are reported separately.",
        ...(runtimeLines.length > 0 ? ["Runtime budget pressure:", ...runtimeLines] : []),
        ...(slotLines.length > 0 ? ["Scheduled slot abandonment:", ...slotLines] : []),
        "Treat runtime budget pressure as capacity work; treat slot abandonment as worker infrastructure/platform interruption.",
      ].join("\n"),
    );
    if (alerted) {
      await setCache(db, ALERT_MARKER_KEY, JSON.stringify({ lastAlertedAt: nowSec }));
    }
  }

  return {
    status: "degraded",
    itemCount: stats.length + slotStats.length,
    metadata: JSON.stringify({
      stats,
      durationDiagnostics,
      slotStats,
      slotAbandonmentRecentWindowSec: SLOT_ABANDONMENT_RECENT_WINDOW_SEC,
      runtimeCapRecentWindowSec: RUNTIME_CAP_RECENT_WINDOW_SEC,
      runtimeBreaching: runtimeBreaching.map((entry) => entry.job),
      slotAbandonmentBreaching: slotAbandonmentBreaching.map((entry) => entry.scheduleKey),
      breaching: [
        ...runtimeBreaching.map((entry) => entry.job),
        ...slotAbandonmentBreaching.map((entry) => entry.scheduleKey),
      ],
      alerted,
      suppressedByCooldown: !dueForAlert,
    }),
  };
}
