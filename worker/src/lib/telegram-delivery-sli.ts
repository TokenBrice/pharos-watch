import { pendingPrioritySql } from "../cron/telegram-pending/upsert-sql";
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

interface FamilyAttributionRow {
  dews: number | string | null;
  depeg: number | string | null;
  safety: number | string | null;
  launch: number | string | null;
  reserve: number | string | null;
  freeze: number | string | null;
  mixed: number | string | null;
  unknown: number | string | null;
}

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
 * Load a bounded delivery read model from the event/target audit ledger.
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

  const core = await db
    .prepare(
      `WITH recent_sources AS MATERIALIZED (
       SELECT source_event_id, detected_at, expires_at, target_plan_completed_at
         FROM telegram_alert_source_events
        WHERE detected_at >= ? AND detected_at <= ?
     ), recent_targets AS (
       SELECT target.source_event_id, target.created_at, target.alert_type,
              target.target_expires_at, target.final_delivery_state,
              target.final_delivery_at, source.target_plan_completed_at,
              COALESCE(target.target_expires_at, job.expires_at, source.expires_at) AS effective_expires_at
         FROM recent_sources source
         CROSS JOIN telegram_alert_job_targets target INDEXED BY idx_tajt_authoritative_ready
         LEFT JOIN telegram_alert_jobs job ON job.job_id = target.job_id
        WHERE target.source_event_id = source.source_event_id
     )
     SELECT
       (SELECT COUNT(*) FROM recent_sources) AS source_count,
       (SELECT COUNT(*) FROM recent_sources WHERE target_plan_completed_at IS NOT NULL) AS planned_source_count,
       (SELECT SUM(MAX(0, target_plan_completed_at - detected_at)) FROM recent_sources
         WHERE target_plan_completed_at IS NOT NULL) AS detection_plan_sum_sec,
       (SELECT MAX(MAX(0, target_plan_completed_at - detected_at)) FROM recent_sources
         WHERE target_plan_completed_at IS NOT NULL) AS detection_plan_max_sec,
       COUNT(*) AS target_count,
       SUM(CASE WHEN final_delivery_state = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
       SUM(CASE WHEN final_delivery_state = 'failed' THEN 1 ELSE 0 END) AS failed_count,
       SUM(CASE WHEN final_delivery_state = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
       SUM(CASE WHEN final_delivery_state = 'expired' THEN 1 ELSE 0 END) AS expired_count,
       SUM(CASE WHEN final_delivery_state = 'execution_unknown' THEN 1 ELSE 0 END) AS execution_unknown_count,
       SUM(CASE WHEN final_delivery_state IS NULL THEN 1 ELSE 0 END) AS unresolved_count,
       SUM(CASE WHEN final_delivery_state = 'accepted' AND target_plan_completed_at IS NOT NULL
                 AND final_delivery_at IS NOT NULL THEN 1 ELSE 0 END) AS accepted_with_plan_count,
       SUM(CASE WHEN final_delivery_state = 'accepted' AND target_plan_completed_at IS NOT NULL
                 AND final_delivery_at IS NOT NULL
                THEN MAX(0, final_delivery_at - target_plan_completed_at) END) AS plan_accept_sum_sec,
       MAX(CASE WHEN final_delivery_state = 'accepted' AND target_plan_completed_at IS NOT NULL
                 AND final_delivery_at IS NOT NULL
                THEN MAX(0, final_delivery_at - target_plan_completed_at) END) AS plan_accept_max_sec,
       SUM(CASE WHEN final_delivery_state = 'accepted' AND effective_expires_at IS NOT NULL
                 AND final_delivery_at IS NOT NULL THEN 1 ELSE 0 END) AS accepted_known_ttl_count,
       SUM(CASE WHEN final_delivery_state = 'accepted' AND effective_expires_at IS NOT NULL
                 AND final_delivery_at <= effective_expires_at THEN 1 ELSE 0 END) AS accepted_before_ttl_count,
       SUM(CASE WHEN final_delivery_state = 'accepted' AND effective_expires_at IS NOT NULL
                 AND final_delivery_at > effective_expires_at THEN 1 ELSE 0 END) AS accepted_after_ttl_count,
       (SELECT MAX(detected_at) FROM recent_sources) AS latest_source_at,
       MAX(final_delivery_at) AS latest_target_at
     FROM recent_targets`,
    )
    .bind(startsAt, nowSec)
    .first<CoreRow>();

  const familyAttribution = await db
    .prepare(
      `WITH recent_sources AS MATERIALIZED (
       SELECT source_event_id
         FROM telegram_alert_source_events
        WHERE detected_at >= ? AND detected_at <= ?
     ), family_flags AS (
       SELECT target.job_id, target.target_key,
              COALESCE(MAX(item.item_key LIKE 'dews:%'), 0) AS dews,
              COALESCE(MAX(item.item_key LIKE 'depeg-%'), 0) AS depeg,
              COALESCE(MAX(item.item_key LIKE 'safety:%'), 0) AS safety,
              COALESCE(MAX(item.item_key LIKE 'launch:%'), 0) AS launch,
              COALESCE(MAX(item.item_key LIKE 'reserve:%'), 0) AS reserve,
              COALESCE(MAX(item.item_key LIKE 'freeze:%'), 0) AS freeze
         FROM recent_sources source
         CROSS JOIN telegram_alert_job_targets target INDEXED BY idx_tajt_authoritative_ready
         LEFT JOIN telegram_alert_job_target_items item
           ON item.job_id = target.job_id
          AND item.target_key = target.target_key
        WHERE target.source_event_id = source.source_event_id
        GROUP BY target.job_id, target.target_key
     ), attributed AS (
       SELECT *, dews + depeg + safety + launch + reserve + freeze AS family_count FROM family_flags
     )
     SELECT
       SUM(CASE WHEN family_count = 1 AND dews = 1 THEN 1 ELSE 0 END) AS dews,
       SUM(CASE WHEN family_count = 1 AND depeg = 1 THEN 1 ELSE 0 END) AS depeg,
       SUM(CASE WHEN family_count = 1 AND safety = 1 THEN 1 ELSE 0 END) AS safety,
       SUM(CASE WHEN family_count = 1 AND launch = 1 THEN 1 ELSE 0 END) AS launch,
       SUM(CASE WHEN family_count = 1 AND reserve = 1 THEN 1 ELSE 0 END) AS reserve,
       SUM(CASE WHEN family_count = 1 AND freeze = 1 THEN 1 ELSE 0 END) AS freeze,
       SUM(CASE WHEN family_count > 1 THEN 1 ELSE 0 END) AS mixed,
       SUM(CASE WHEN family_count = 0 THEN 1 ELSE 0 END) AS unknown
      FROM attributed`,
    )
    .bind(startsAt, nowSec)
    .first<FamilyAttributionRow>();

  const backlogRows = await db
    .prepare(
      `SELECT ${pendingPrioritySql("target.alert_type")} AS priority,
            CASE
              WHEN target.created_at > ? - 300 THEN 'lt_5m'
              WHEN target.created_at > ? - 900 THEN '5m_15m'
              WHEN target.created_at > ? - 3600 THEN '15m_1h'
              WHEN target.created_at > ? - 21600 THEN '1h_6h'
              ELSE 'gte_6h'
            END AS age_bucket,
            COUNT(*) AS count, MIN(target.created_at) AS oldest_created_at,
            MIN(COALESCE(target.target_expires_at, job.expires_at)) AS nearest_expires_at
       FROM telegram_alert_job_targets target
       LEFT JOIN telegram_alert_jobs job ON job.job_id = target.job_id
      WHERE target.final_delivery_state IS NULL
        AND target.created_at >= ? AND target.created_at <= ?
      GROUP BY priority, age_bucket
      ORDER BY priority, oldest_created_at`,
    )
    .bind(nowSec, nowSec, nowSec, nowSec, startsAt, nowSec)
    .all<BacklogRow>();

  const cancellationRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(cancellation_reason, ''), NULLIF(final_delivery_error, ''),
                    NULLIF(error_class, ''), 'unknown') AS reason,
            COUNT(*) AS count, SUM(COUNT(*)) OVER () AS total_count
       FROM telegram_alert_job_targets
      WHERE final_delivery_state = 'cancelled'
        AND (
          error_class = 'preference_changed'
          OR final_delivery_error = 'preference_changed'
          OR cancellation_reason IN ('scope_disabled', 'preference_changed')
          OR cancellation_reason LIKE 'preference_%'
        )
        AND created_at >= ? AND created_at <= ?
      GROUP BY reason
      ORDER BY count DESC, reason
      LIMIT ?`,
    )
    .bind(startsAt, nowSec, reasonQueryLimit)
    .all<ReasonRow>();

  const targetErrorRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(final_delivery_error, ''), NULLIF(error_class, ''), 'unknown') AS reason,
            COUNT(*) AS count
       FROM telegram_alert_job_targets
      WHERE created_at >= ? AND created_at <= ?
        AND (final_delivery_error IS NOT NULL OR error_class IS NOT NULL)
      GROUP BY reason
      ORDER BY count DESC, reason
      LIMIT ?`,
    )
    .bind(startsAt, nowSec, reasonQueryLimit)
    .all<ReasonRow>();

  const unknown = await db
    .prepare(
      `SELECT COUNT(*) AS count, MIN(final_delivery_at) AS oldest_at,
            SUM(CASE WHEN final_delivery_at <= ? - 900 THEN 1 ELSE 0 END) AS older_than_15m_count
       FROM telegram_alert_job_targets
      WHERE final_delivery_state = 'execution_unknown'
        AND created_at >= ? AND created_at <= ?`,
    )
    .bind(nowSec, startsAt, nowSec)
    .first<UnknownRow>();

  const deadSummary = await db
    .prepare(
      `SELECT COUNT(*) AS count, SUM(attempts) AS total_attempts, MAX(expired_at) AS latest_at
       FROM telegram_alert_dead_letters
      WHERE expired_at >= ? AND expired_at <= ?`,
    )
    .bind(startsAt, nowSec)
    .first<DeadLetterSummaryRow>();
  const deadReasonRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(reason, ''), 'unknown') AS reason, COUNT(*) AS count
       FROM telegram_alert_dead_letters
      WHERE expired_at >= ? AND expired_at <= ?
      GROUP BY reason ORDER BY count DESC, reason LIMIT ?`,
    )
    .bind(startsAt, nowSec, reasonQueryLimit)
    .all<ReasonRow>();
  const deadErrorRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(last_error_class, ''), 'unknown') AS reason, COUNT(*) AS count
       FROM telegram_alert_dead_letters
      WHERE expired_at >= ? AND expired_at <= ?
      GROUP BY reason ORDER BY count DESC, reason LIMIT ?`,
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
      dews: integer(familyAttribution?.dews),
      depeg: integer(familyAttribution?.depeg),
      safety: integer(familyAttribution?.safety),
      launch: integer(familyAttribution?.launch),
      reserve: integer(familyAttribution?.reserve),
      freeze: integer(familyAttribution?.freeze),
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
