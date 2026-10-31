import { TELEGRAM_ALERT_TYPES, type TelegramAlertType } from "@shared/types/status/telegram";
import type {
  TelegramDeliverySliBacklogBucket,
  TelegramDeliverySliEvidenceQuality,
  TelegramDeliveryLatencySli,
  TelegramDeliverySliReasonCount,
  TelegramDeliverySliRollup,
} from "@shared/types/status";

const MIN_LOOKBACK_SEC = 5 * 60;
const MAX_LOOKBACK_SEC = 7 * 24 * 60 * 60;
const DEFAULT_LOOKBACK_SEC = 24 * 60 * 60;
const DEFAULT_FRESHNESS_SEC = 15 * 60;
const DEFAULT_REASON_LIMIT = 12;
const MAX_REASON_LIMIT = 25;

export interface TelegramDeliverySliOptions {
  nowSec: number;
  lookbackSec?: number;
  freshnessSec?: number;
  reasonLimit?: number;
}

interface CoreRow {
  source_count: number | string | null;
  planned_source_count: number | string | null;
  detection_plan_sum_sec: number | string | null;
  detection_plan_max_sec: number | string | null;
  target_count: number | string | null;
  accepted_count: number | string | null;
  failed_count: number | string | null;
  cancelled_count: number | string | null;
  expired_count: number | string | null;
  execution_unknown_count: number | string | null;
  unresolved_count: number | string | null;
  accepted_with_plan_count: number | string | null;
  plan_accept_sum_sec: number | string | null;
  plan_accept_max_sec: number | string | null;
  accepted_known_ttl_count: number | string | null;
  accepted_before_ttl_count: number | string | null;
  accepted_after_ttl_count: number | string | null;
  latest_source_at: number | string | null;
  latest_target_at: number | string | null;
}

interface BacklogRow {
  priority: number | string;
  age_bucket: TelegramDeliverySliBacklogBucket["ageBucket"];
  count: number | string;
  oldest_created_at: number | string;
  nearest_expires_at: number | string | null;
}

interface UnknownRow {
  count: number | string | null;
  oldest_at: number | string | null;
  older_than_15m_count: number | string | null;
}

type FamilyAttributionRow = Record<TelegramAlertType | "mixed" | "unknown", number | string | null>;

interface DeadLetterSummaryRow {
  count: number | string | null;
  total_attempts: number | string | null;
  latest_at: number | string | null;
}

interface ReasonRow {
  reason: string | null;
  count: number | string;
  total_count?: number | string | null;
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function nullableInteger(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function quality(observed: number, eligible: number): TelegramDeliverySliEvidenceQuality {
  if (eligible === 0) return "empty";
  return observed === eligible ? "complete" : "partial";
}

function latency(
  eligibleCount: number,
  observedCount: number,
  sumSec: unknown,
  maximumSec: unknown,
): TelegramDeliveryLatencySli {
  const sum = nullableInteger(sumSec);
  return {
    eligibleCount,
    observedCount,
    averageSec: observedCount > 0 && sum != null ? Math.round(sum / observedCount) : null,
    maximumSec: observedCount > 0 ? nullableInteger(maximumSec) : null,
    quality: quality(observedCount, eligibleCount),
  };
}

function reasons(
  rows: readonly ReasonRow[],
  limit: number,
): {
  values: TelegramDeliverySliReasonCount[];
  truncated: boolean;
} {
  return {
    values: rows.slice(0, limit).map((row) => ({
      reason: row.reason?.trim() || "unknown",
      count: integer(row.count),
    })),
    truncated: rows.length > limit,
  };
}

/**
 * Load a bounded delivery read model from `telegram_jobs`/`telegram_deliveries`.
 * "Accepted" means Telegram's Bot API accepted the send, not that a person
 * opened or read the message.
 */
export async function loadTelegramDeliverySliRollup(
  db: D1Database,
  options: TelegramDeliverySliOptions,
): Promise<TelegramDeliverySliRollup> {
  if (!Number.isSafeInteger(options.nowSec) || options.nowSec < 0) {
    throw new Error("Telegram delivery SLI nowSec is invalid");
  }
  const nowSec = options.nowSec;
  const lookbackSec = boundedInteger(options.lookbackSec, DEFAULT_LOOKBACK_SEC, MIN_LOOKBACK_SEC, MAX_LOOKBACK_SEC);
  const freshnessSec = boundedInteger(options.freshnessSec, DEFAULT_FRESHNESS_SEC, 60, MAX_LOOKBACK_SEC);
  const reasonLimit = boundedInteger(options.reasonLimit, DEFAULT_REASON_LIMIT, 1, MAX_REASON_LIMIT);
  const startsAt = nowSec - lookbackSec;
  const reasonQueryLimit = reasonLimit + 1;

  // Delivery v2: alert-family jobs (broadcast and digest excluded) and their
  // per-chat rows. "Plan" is the latest row insert of a job (fan-out end).
  const core = await db
    .prepare(
      `WITH recent_jobs AS MATERIALIZED (
       SELECT job_id, created_at AS detected_at, state,
              CASE WHEN state IN ('ready', 'done')
                   THEN (SELECT MAX(created_at) FROM telegram_deliveries d WHERE d.job_id = j.job_id) END
                AS target_plan_completed_at
         FROM telegram_jobs j
        WHERE created_at >= ? AND created_at <= ? AND kind NOT IN ('broadcast', 'digest')
     ), recent_targets AS (
       SELECT d.state, d.created_at, d.expires_at, d.done_at,
              job.target_plan_completed_at
         FROM recent_jobs job
         JOIN telegram_deliveries d ON d.job_id = job.job_id
     )
     SELECT
       (SELECT COUNT(*) FROM recent_jobs) AS source_count,
       (SELECT COUNT(*) FROM recent_jobs WHERE target_plan_completed_at IS NOT NULL) AS planned_source_count,
       (SELECT SUM(MAX(0, target_plan_completed_at - detected_at)) FROM recent_jobs
         WHERE target_plan_completed_at IS NOT NULL) AS detection_plan_sum_sec,
       (SELECT MAX(MAX(0, target_plan_completed_at - detected_at)) FROM recent_jobs
         WHERE target_plan_completed_at IS NOT NULL) AS detection_plan_max_sec,
       COUNT(*) AS target_count,
       SUM(CASE WHEN state = 'sent' THEN 1 ELSE 0 END) AS accepted_count,
       SUM(CASE WHEN state IN ('failed', 'blocked') THEN 1 ELSE 0 END) AS failed_count,
       SUM(CASE WHEN state IN ('cancelled', 'suppressed_duplicate') THEN 1 ELSE 0 END) AS cancelled_count,
       SUM(CASE WHEN state = 'expired' THEN 1 ELSE 0 END) AS expired_count,
       SUM(CASE WHEN state = 'unknown' THEN 1 ELSE 0 END) AS execution_unknown_count,
       SUM(CASE WHEN state IN ('pending', 'retry', 'sending') THEN 1 ELSE 0 END) AS unresolved_count,
       SUM(CASE WHEN state = 'sent' AND done_at IS NOT NULL THEN 1 ELSE 0 END) AS accepted_with_plan_count,
       SUM(CASE WHEN state = 'sent' AND done_at IS NOT NULL THEN MAX(0, done_at - created_at) END) AS plan_accept_sum_sec,
       MAX(CASE WHEN state = 'sent' AND done_at IS NOT NULL THEN MAX(0, done_at - created_at) END) AS plan_accept_max_sec,
       SUM(CASE WHEN state = 'sent' AND done_at IS NOT NULL THEN 1 ELSE 0 END) AS accepted_known_ttl_count,
       SUM(CASE WHEN state = 'sent' AND done_at <= expires_at THEN 1 ELSE 0 END) AS accepted_before_ttl_count,
       SUM(CASE WHEN state = 'sent' AND done_at > expires_at THEN 1 ELSE 0 END) AS accepted_after_ttl_count,
       (SELECT MAX(detected_at) FROM recent_jobs) AS latest_source_at,
       MAX(done_at) AS latest_target_at
     FROM recent_targets`,
    )
    .bind(startsAt, nowSec)
    .first<CoreRow>();

  const familyAttribution = await db
    .prepare(
      // SAFETY: Family identifiers come only from the canonical roster.
      `SELECT
       ${TELEGRAM_ALERT_TYPES.map((family) => `SUM(CASE WHEN families = '${family}' THEN 1 ELSE 0 END) AS ${family}`).join(",\n       ")},
       SUM(CASE WHEN families LIKE '%,%' THEN 1 ELSE 0 END) AS mixed,
       SUM(CASE WHEN families IS NULL THEN 1 ELSE 0 END) AS unknown
      FROM telegram_deliveries
     WHERE created_at >= ? AND created_at <= ? AND kind NOT IN ('broadcast', 'digest')`,
    )
    .bind(startsAt, nowSec)
    .first<FamilyAttributionRow>();

  const backlogRows = await db
    .prepare(
      `SELECT priority,
            CASE
              WHEN created_at > ? - 300 THEN 'lt_5m'
              WHEN created_at > ? - 900 THEN '5m_15m'
              WHEN created_at > ? - 3600 THEN '15m_1h'
              WHEN created_at > ? - 21600 THEN '1h_6h'
              ELSE 'gte_6h'
            END AS age_bucket,
            COUNT(*) AS count, MIN(created_at) AS oldest_created_at,
            MIN(expires_at) AS nearest_expires_at
       FROM telegram_deliveries
      WHERE state IN ('pending', 'retry', 'sending')
        AND kind NOT IN ('broadcast', 'digest')
        AND created_at >= ? AND created_at <= ?
      GROUP BY priority, age_bucket
      ORDER BY priority, oldest_created_at`,
    )
    .bind(nowSec, nowSec, nowSec, nowSec, startsAt, nowSec)
    .all<BacklogRow>();

  const cancellationRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(reason, ''), 'unknown') AS reason,
            COUNT(*) AS count, SUM(COUNT(*)) OVER () AS total_count
       FROM telegram_deliveries
      WHERE state IN ('cancelled', 'retry')
        AND reason IN ('subscriber_missing', 'coin_snoozed', 'chat_snoozed')
        AND kind NOT IN ('broadcast', 'digest')
        AND created_at >= ? AND created_at <= ?
      GROUP BY reason
      ORDER BY count DESC, reason
      LIMIT ?`,
    )
    .bind(startsAt, nowSec, reasonQueryLimit)
    .all<ReasonRow>();

  const targetErrorRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(reason, ''), NULLIF(error_class, ''), 'unknown') AS reason,
            COUNT(*) AS count
       FROM telegram_deliveries
      WHERE created_at >= ? AND created_at <= ?
        AND kind NOT IN ('broadcast', 'digest')
        AND (reason IS NOT NULL OR error_class IS NOT NULL)
      GROUP BY 1
      ORDER BY count DESC, reason
      LIMIT ?`,
    )
    .bind(startsAt, nowSec, reasonQueryLimit)
    .all<ReasonRow>();

  const unknown = await db
    .prepare(
      `SELECT COUNT(*) AS count, MIN(done_at) AS oldest_at,
            SUM(CASE WHEN done_at <= ? - 900 THEN 1 ELSE 0 END) AS older_than_15m_count
       FROM telegram_deliveries
      WHERE state = 'unknown'
        AND kind NOT IN ('broadcast', 'digest')
        AND created_at >= ? AND created_at <= ?`,
    )
    .bind(nowSec, startsAt, nowSec)
    .first<UnknownRow>();

  // Terminal non-deliveries stay in telegram_deliveries (no dead-letter copy).
  const deadSummary = await db
    .prepare(
      `SELECT COUNT(*) AS count, SUM(attempts) AS total_attempts, MAX(done_at) AS latest_at
       FROM telegram_deliveries
      WHERE state IN ('failed', 'blocked', 'expired') AND done_at >= ? AND done_at <= ?
        AND kind NOT IN ('broadcast', 'digest')`,
    )
    .bind(startsAt, nowSec)
    .first<DeadLetterSummaryRow>();
  const deadReasonRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(reason, ''), 'unknown') AS reason, COUNT(*) AS count
       FROM telegram_deliveries
      WHERE state IN ('failed', 'blocked', 'expired') AND done_at >= ? AND done_at <= ?
        AND kind NOT IN ('broadcast', 'digest')
      GROUP BY 1 ORDER BY count DESC, reason LIMIT ?`,
    )
    .bind(startsAt, nowSec, reasonQueryLimit)
    .all<ReasonRow>();
  const deadErrorRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(error_class, ''), 'unknown') AS reason, COUNT(*) AS count
       FROM telegram_deliveries
      WHERE state IN ('failed', 'blocked', 'expired') AND done_at >= ? AND done_at <= ?
        AND kind NOT IN ('broadcast', 'digest')
      GROUP BY 1 ORDER BY count DESC, reason LIMIT ?`,
    )
    .bind(startsAt, nowSec, reasonQueryLimit)
    .all<ReasonRow>();

  const row = core ?? ({} as CoreRow);
  const sourceCount = integer(row.source_count);
  const plannedSourceCount = integer(row.planned_source_count);
  const targetCount = integer(row.target_count);
  const acceptedCount = integer(row.accepted_count);
  const acceptedWithPlanCount = integer(row.accepted_with_plan_count);
  const knownTtlCount = integer(row.accepted_known_ttl_count);
  const beforeTtlCount = integer(row.accepted_before_ttl_count);
  const cancellation = reasons(cancellationRows.results ?? [], reasonLimit);
  const targetErrors = reasons(targetErrorRows.results ?? [], reasonLimit);
  const deadReasons = reasons(deadReasonRows.results ?? [], reasonLimit);
  const deadErrors = reasons(deadErrorRows.results ?? [], reasonLimit);
  const latestAt = Math.max(
    nullableInteger(row.latest_source_at) ?? -1,
    nullableInteger(row.latest_target_at) ?? -1,
    nullableInteger(deadSummary?.latest_at) ?? -1,
  );
  const evidenceAt = latestAt >= 0 ? latestAt : null;
  const evidenceAgeSec = evidenceAt == null ? null : Math.max(0, nowSec - evidenceAt);
  const backlog = (backlogRows.results ?? []).map((item): TelegramDeliverySliBacklogBucket => ({
    priority: integer(item.priority),
    ageBucket: item.age_bucket,
    count: integer(item.count),
    oldestAgeSec: Math.max(0, nowSec - integer(item.oldest_created_at)),
    nearestTtlSec: item.nearest_expires_at == null ? null : integer(item.nearest_expires_at) - nowSec,
  }));

  return {
    window: { generatedAt: nowSec, startsAt, endsAt: nowSec, lookbackSec, bounded: true },
    evidence: {
      latestAt: evidenceAt,
      ageSec: evidenceAgeSec,
      freshness: evidenceAgeSec == null ? "empty" : evidenceAgeSec <= freshnessSec ? "fresh" : "stale",
      freshnessThresholdSec: freshnessSec,
    },
    detectionToPlan: latency(sourceCount, plannedSourceCount, row.detection_plan_sum_sec, row.detection_plan_max_sec),
    planToTelegramAcceptance: latency(
      acceptedCount,
      acceptedWithPlanCount,
      row.plan_accept_sum_sec,
      row.plan_accept_max_sec,
    ),
    telegramAcceptanceBeforeTtl: {
      telegramAcceptedCount: acceptedCount,
      knownTtlCount,
      acceptedBeforeTtlCount: beforeTtlCount,
      acceptedAfterTtlCount: integer(row.accepted_after_ttl_count),
      rate: ratio(beforeTtlCount, knownTtlCount),
      quality: quality(knownTtlCount, acceptedCount),
    },
    authoritativeTargetOutcomes: {
      total: targetCount,
      telegramAccepted: acceptedCount,
      failed: integer(row.failed_count),
      cancelled: integer(row.cancelled_count),
      expired: integer(row.expired_count),
      executionUnknown: integer(row.execution_unknown_count),
      unresolved: integer(row.unresolved_count),
      telegramAcceptanceRate: ratio(acceptedCount, targetCount),
    },
    familyAttribution: {
      ...Object.fromEntries(TELEGRAM_ALERT_TYPES.map((family) => [
        family, integer(familyAttribution?.[family]),
      ])) as Record<TelegramAlertType, number>,
      mixed: integer(familyAttribution?.mixed),
      unknown: integer(familyAttribution?.unknown),
    },
    preferenceChangeCancellations: {
      count: integer((cancellationRows.results ?? [])[0]?.total_count),
      reasons: cancellation.values,
      reasonsTruncated: cancellation.truncated,
    },
    backlog: {
      windowStartsAt: startsAt,
      windowBounded: true,
      count: backlog.reduce((sum, item) => sum + item.count, 0),
      oldestAgeSec: backlog.length > 0 ? Math.max(...backlog.map((item) => item.oldestAgeSec)) : null,
      buckets: backlog,
    },
    observedTargetErrorReasons: { reasons: targetErrors.values, truncated: targetErrors.truncated },
    executionUnknown: {
      count: integer(unknown?.count),
      oldestAgeSec: unknown?.oldest_at == null ? null : Math.max(0, nowSec - integer(unknown.oldest_at)),
      olderThan15mCount: integer(unknown?.older_than_15m_count),
    },
    deadLetters: {
      count: integer(deadSummary?.count),
      totalAttempts: integer(deadSummary?.total_attempts),
      reasons: deadReasons.values,
      reasonsTruncated: deadReasons.truncated,
      lastErrorReasons: deadErrors.values,
      lastErrorReasonsTruncated: deadErrors.truncated,
    },
  };
}
