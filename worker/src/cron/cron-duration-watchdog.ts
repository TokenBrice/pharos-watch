import { sendAlert } from "../lib/alerts";
import type { CronResult } from "../lib/cron-logger";
import { CRON_TIMEOUT_MS } from "../lib/cron-lease";
import { getCache, setCache } from "../lib/db-cache";
import { throwIfAborted } from "../lib/abort";

/**
 * Duration-trend watchdog for fetch-heavy cron jobs with explicit app-level
 * timeouts (`CRON_TIMEOUT_MS`). sync-stablecoins already averages ~70% of its
 * 8-min ceiling and has hit the cap in production; adding the next provider
 * to a near-budget slot would tip it over with no warning. Alerts when a
 * job's 7-day average crosses 80% of its ceiling or it hits the cap 3+ times
 * in a week, so capacity is budgeted before the timeout starts truncating
 * runs. Per-job stats are always emitted in cron metadata for trend review.
 */
const DURATION_ALERT_AVG_RATIO = 0.8;
const DURATION_ALERT_CAP_HITS = 3;
const LOOKBACK_SEC = 7 * 86400;
// Skip jobs with too few recent runs (fresh deploys, paused lanes) — a 7d
// average over a handful of runs is noise, not a trend.
const MIN_RUNS_FOR_TREND = 20;
const ALERT_COOLDOWN_SEC = 7 * 86400;
const ALERT_MARKER_KEY = "cron-duration-watchdog:alert";

interface JobDurationStats {
  job: string;
  runs: number;
  avgMs: number;
  maxMs: number;
  capHits: number;
  timeoutMs: number;
  avgRatio: number;
}

interface StatsRow {
  n: number;
  avg_ms: number | null;
  max_ms: number | null;
  cap_hits: number | null;
}

function isBreaching(stats: JobDurationStats): boolean {
  if (stats.runs < MIN_RUNS_FOR_TREND) return false;
  return stats.avgRatio >= DURATION_ALERT_AVG_RATIO || stats.capHits >= DURATION_ALERT_CAP_HITS;
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
        "SELECT COUNT(*) AS n, CAST(AVG(duration_ms) AS INT) AS avg_ms, MAX(duration_ms) AS max_ms, " +
        "SUM(CASE WHEN duration_ms >= ? THEN 1 ELSE 0 END) AS cap_hits " +
        "FROM cron_runs WHERE job = ? AND started_at > ?",
      )
      .bind(timeoutMs, job, sinceSec),
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
      timeoutMs,
      avgRatio: timeoutMs > 0 ? avgMs / timeoutMs : 0,
    };
  });
  const breaching = stats.filter(isBreaching);

  if (breaching.length === 0) {
    return { itemCount: stats.length, metadata: JSON.stringify({ stats }) };
  }

  const marker = await getCache(db, ALERT_MARKER_KEY);
  throwIfAborted(signal);
  const dueForAlert = nowSec - readLastAlertedAt(marker?.value) >= ALERT_COOLDOWN_SEC;
  let alerted = false;
  if (dueForAlert) {
    const lines = breaching.map((entry) =>
      `- ${entry.job}: 7d avg ${Math.round(entry.avgMs / 1000)}s of ${Math.round(entry.timeoutMs / 1000)}s ceiling ` +
      `(${Math.round(entry.avgRatio * 100)}%), ${entry.capHits} run(s) at cap, ${entry.runs} runs`,
    );
    alerted = await sendAlert(
      alertWebhookUrl,
      "Cron duration budget breach",
      [
        "Fetch-heavy cron jobs are trending into their app-level timeout ceilings.",
        ...lines,
        "Budget the next provider/feature addition into a different trigger slot before the timeout truncates runs.",
      ].join("\n"),
    );
    if (alerted) {
      await setCache(db, ALERT_MARKER_KEY, JSON.stringify({ lastAlertedAt: nowSec }));
    }
  }

  return {
    status: "degraded",
    itemCount: stats.length,
    metadata: JSON.stringify({
      stats,
      breaching: breaching.map((entry) => entry.job),
      alerted,
      suppressedByCooldown: !dueForAlert,
    }),
  };
}
