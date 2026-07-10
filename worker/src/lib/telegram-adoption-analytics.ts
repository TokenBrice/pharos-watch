import { formatIsoDate } from "@shared/lib/format";
import {
  TELEGRAM_ADOPTION_FEATURES,
  TELEGRAM_ADOPTION_LOW_COUNT_THRESHOLD,
  telegramAdoptionSource,
  type TelegramAdoptionCampaign,
  type TelegramAdoptionFeature,
  type TelegramAdoptionPlacement,
} from "@shared/lib/telegram-adoption-analytics";
import { parseJsonObject } from "./json-parse";

const MINI_APP_SESSION_CACHE_PREFIX = "telegram:adoption-mini-app-session:";
export const TELEGRAM_ADOPTION_SESSION_TTL_SEC = 30 * 60;
const TELEGRAM_ADOPTION_RETENTION_CATCHUP_DAYS = 7;
const RETENTION_WINDOWS = [7, 30] as const;
const RETENTION_FEATURES = ["any", "direct", "preset", "global"] as const;
// July 10 is the partial rollout/backfill day. July 11 is the first complete
// UTC day whose first-follow aggregate can be used as a cohort denominator.
const ADOPTION_COHORT_START_DAY = "2026-07-11";

type AdoptionStage =
  | "bot_start"
  | "setup_complete"
  | "first_follow"
  | "mini_app_session"
  | "first_mutation";
type AdoptionOutcome = "success" | "readonly" | "failure";
type MutationLatencyBucket = "lt_30s" | "30s_2m" | "2m_5m" | "gte_5m" | "unknown";

interface AdoptionDimensions {
  campaign: TelegramAdoptionCampaign;
  placement: TelegramAdoptionPlacement;
}

interface AdoptionEvent extends AdoptionDimensions {
  nowSec: number;
  stage: AdoptionStage;
  feature?: TelegramAdoptionFeature;
  latencyBucket?: MutationLatencyBucket | "";
  outcome?: AdoptionOutcome;
}

interface MiniAppSessionCacheValue extends AdoptionDimensions {
  startedAt: number;
}

interface RetentionMetricRow {
  cohort_size: number | string | null;
  retained_any: number | string | null;
  retained_direct: number | string | null;
  retained_preset: number | string | null;
  retained_global: number | string | null;
}

interface AdoptionDailyRow {
  campaign: string;
  placement: string;
  stage: string;
  feature: string;
  latency_bucket: string;
  outcome: string;
  count: number | string;
  last_seen_at: number | string;
  period: "current" | "previous";
}

interface AdoptionRetentionRow {
  cohort_day: string;
  measurement_day: string;
  window_days: number | string;
  feature: string;
  cohort_size: number | string;
  retained_count: number | string;
  measured_at: number | string;
  quality: string;
}

const FIRST_MUTATION_BUCKET_SECONDS: Readonly<Record<string, number>> = {
  lt_30s: 15,
  "30s_2m": 75,
  "2m_5m": 210,
  gte_5m: 300,
};

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function dayAtOffset(nowSec: number, offsetDays: number): string {
  return formatIsoDate(nowSec + offsetDays * 86_400);
}

function dayStartSec(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1_000);
}

function prepareAdoptionUpsert(db: D1Database, event: AdoptionEvent): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO telegram_adoption_daily (
       day, campaign, placement, stage, feature, latency_bucket, outcome,
       count, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(day, campaign, placement, stage, feature, latency_bucket, outcome)
     DO UPDATE SET count = telegram_adoption_daily.count + 1, last_seen_at = excluded.last_seen_at`,
  ).bind(
    formatIsoDate(event.nowSec),
    event.campaign,
    event.placement,
    event.stage,
    event.feature ?? "",
    event.latencyBucket ?? "",
    event.outcome ?? "success",
    event.nowSec,
    event.nowSec,
  );
}

export async function recordTelegramAdoptionEvent(db: D1Database, event: AdoptionEvent): Promise<void> {
  try {
    await prepareAdoptionUpsert(db, event).run();
  } catch {
    // Adoption telemetry must not block the product action.
  }
}

export function telegramAdoptionDimensionsForStart(raw: string | null | undefined): AdoptionDimensions {
  return telegramAdoptionSource(raw);
}

export async function recordTelegramFirstFollow(
  db: D1Database,
  input: AdoptionDimensions & { chatId: string; feature: "direct" | "preset" | "global"; nowSec: number },
): Promise<void> {
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO telegram_adoption_daily (
           day, campaign, placement, stage, feature, latency_bucket, outcome,
           count, first_seen_at, last_seen_at
         )
         SELECT ?, ?, ?, 'first_follow', ?, '', 'success', 1, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM telegram_subscribers WHERE chat_id = ? AND first_follow_at IS NULL
          )
         ON CONFLICT(day, campaign, placement, stage, feature, latency_bucket, outcome)
         DO UPDATE SET count = telegram_adoption_daily.count + 1, last_seen_at = excluded.last_seen_at`,
      ).bind(formatIsoDate(input.nowSec), input.campaign, input.placement, input.feature, input.nowSec, input.nowSec, input.chatId),
      db.prepare(
        "UPDATE telegram_subscribers SET first_follow_at = ? WHERE chat_id = ? AND first_follow_at IS NULL",
      ).bind(input.nowSec, input.chatId),
    ]);
  } catch {
    // Best-effort aggregate; a later follow can claim an unpersisted milestone.
  }
}

export async function recordTelegramFirstSetupComplete(
  db: D1Database,
  input: AdoptionDimensions & { chatId: string; feature: "direct" | "preset" | "global"; nowSec: number },
): Promise<void> {
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO telegram_adoption_daily (
           day, campaign, placement, stage, feature, latency_bucket, outcome,
           count, first_seen_at, last_seen_at
         )
         SELECT ?, ?, ?, 'setup_complete', ?, '', 'success', 1, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM telegram_subscribers WHERE chat_id = ? AND first_setup_completed_at IS NULL
          )
         ON CONFLICT(day, campaign, placement, stage, feature, latency_bucket, outcome)
         DO UPDATE SET count = telegram_adoption_daily.count + 1, last_seen_at = excluded.last_seen_at`,
      ).bind(formatIsoDate(input.nowSec), input.campaign, input.placement, input.feature, input.nowSec, input.nowSec, input.chatId),
      db.prepare(
        "UPDATE telegram_subscribers SET first_setup_completed_at = ? WHERE chat_id = ? AND first_setup_completed_at IS NULL",
      ).bind(input.nowSec, input.chatId),
    ]);
  } catch {
    // Best-effort aggregate; setup remains user-facing state, not telemetry state.
  }
}

export function telegramAdoptionDimensionsForMiniApp(
  rawStartParam: string | null | undefined,
): AdoptionDimensions {
  const source = telegramAdoptionSource(rawStartParam);
  return source.campaign === "landing"
    ? source
    : { campaign: "organic", placement: "menu" };
}

function miniAppSessionCacheKey(userId: string): string {
  return `${MINI_APP_SESSION_CACHE_PREFIX}${userId}`;
}

export async function recordTelegramMiniAppAdoptionSession(
  db: D1Database,
  input: { userId: string; startParam: string | null; canMutate: boolean; nowSec: number },
): Promise<void> {
  const dimensions = telegramAdoptionDimensionsForMiniApp(input.startParam);
  const statements = [
    prepareAdoptionUpsert(db, {
      ...dimensions,
      nowSec: input.nowSec,
      stage: "mini_app_session",
      outcome: input.canMutate ? "success" : "readonly",
    }),
  ];
  if (input.canMutate) {
    const value: MiniAppSessionCacheValue = { ...dimensions, startedAt: input.nowSec };
    statements.push(
      db.prepare(
        `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(miniAppSessionCacheKey(input.userId), JSON.stringify(value), input.nowSec),
    );
  }
  try {
    await db.batch(statements);
  } catch {
    // Existing Mini App analytics and the session response remain authoritative.
  }
}

function bucketTelegramFirstMutationLatency(seconds: number | null): MutationLatencyBucket {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 30) return "lt_30s";
  if (seconds < 120) return "30s_2m";
  if (seconds < 300) return "2m_5m";
  return "gte_5m";
}

export async function loadTelegramFirstMutationP50(
  db: D1Database,
  day: string,
): Promise<{ p50Sec: number | null; sampleCount: number }> {
  const result = await db.prepare(
    `SELECT latency_bucket, SUM(count) AS count
       FROM telegram_adoption_daily
      WHERE day = ? AND stage = 'first_mutation' AND outcome = 'success'
      GROUP BY latency_bucket`,
  ).bind(day).all<{ latency_bucket: string; count: number | string | null }>();
  const rows = (result.results ?? [])
    .map((row) => ({ bucket: row.latency_bucket, count: count(row.count) }))
    .filter((row) => row.bucket in FIRST_MUTATION_BUCKET_SECONDS && row.count > 0)
    .sort((a, b) => FIRST_MUTATION_BUCKET_SECONDS[a.bucket] - FIRST_MUTATION_BUCKET_SECONDS[b.bucket]);
  const sampleCount = rows.reduce((sum, row) => sum + row.count, 0);
  if (sampleCount === 0) return { p50Sec: null, sampleCount: 0 };
  const midpoint = Math.ceil(sampleCount / 2);
  let cumulative = 0;
  for (const row of rows) {
    cumulative += row.count;
    if (cumulative >= midpoint) {
      return { p50Sec: FIRST_MUTATION_BUCKET_SECONDS[row.bucket], sampleCount };
    }
  }
  return { p50Sec: null, sampleCount };
}

function parseSessionCache(raw: string | null, nowSec: number): MiniAppSessionCacheValue | null {
  if (!raw) return null;
  try {
    const parsed = parseJsonObject<Partial<MiniAppSessionCacheValue>>(raw);
    if (!parsed) return null;
    const featureCampaign = parsed.campaign === "landing" || parsed.campaign === "organic";
    const placement = typeof parsed.placement === "string"
      && (["hero", "setup", "miniapp_setup", "miniapp_home", "miniapp_watchlist", "menu", "unknown"] as string[])
        .includes(parsed.placement);
    if (!featureCampaign || !placement || !Number.isFinite(parsed.startedAt)) return null;
    if (parsed.startedAt! > nowSec || parsed.startedAt! < nowSec - TELEGRAM_ADOPTION_SESSION_TTL_SEC) return null;
    return parsed as MiniAppSessionCacheValue;
  } catch {
    return null;
  }
}

export async function recordTelegramMiniAppFirstMutation(
  db: D1Database,
  input: { userId: string; feature: TelegramAdoptionFeature; nowSec: number },
): Promise<void> {
  const feature = TELEGRAM_ADOPTION_FEATURES.includes(input.feature) ? input.feature : "other";
  const key = miniAppSessionCacheKey(input.userId);
  try {
    const row = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(key).first<{ value: string }>();
    const session = parseSessionCache(row?.value ?? null, input.nowSec);
    if (!session) return;
    const latencyBucket = bucketTelegramFirstMutationLatency(input.nowSec - session.startedAt);
    await db.batch([
      db.prepare(
        `INSERT INTO telegram_adoption_daily (
           day, campaign, placement, stage, feature, latency_bucket, outcome,
           count, first_seen_at, last_seen_at
         )
         SELECT ?, ?, ?, 'first_mutation', ?, ?, 'success', 1, ?, ?
          WHERE EXISTS (SELECT 1 FROM cache WHERE key = ? AND value = ? AND updated_at >= ?)
         ON CONFLICT(day, campaign, placement, stage, feature, latency_bucket, outcome)
         DO UPDATE SET count = telegram_adoption_daily.count + 1, last_seen_at = excluded.last_seen_at`,
      ).bind(
        formatIsoDate(input.nowSec), session.campaign, session.placement, feature, latencyBucket,
        input.nowSec, input.nowSec, key, row!.value, input.nowSec - TELEGRAM_ADOPTION_SESSION_TTL_SEC,
      ),
      db.prepare("DELETE FROM cache WHERE key = ? AND value = ?").bind(key, row!.value),
    ]);
  } catch {
    // Mutation success must not depend on telemetry correlation.
  }
}

const RETENTION_METRICS_SQL = `WITH surviving AS (
  SELECT s.chat_id,
         CASE WHEN s.global_alert_dews = 1 OR s.global_alert_depeg = 1 OR s.global_alert_safety = 1
                    OR s.global_alert_launch = 1 OR s.global_alert_reserve = 1 THEN 1 ELSE 0 END AS has_global,
         CASE WHEN EXISTS (
           SELECT 1 FROM telegram_subscriptions t
            WHERE t.chat_id = s.chat_id
              AND (t.alert_dews = 1 OR t.alert_depeg = 1 OR t.alert_safety = 1 OR t.alert_launch = 1 OR t.alert_reserve = 1)
         ) THEN 1 ELSE 0 END AS has_direct,
         CASE WHEN EXISTS (
           SELECT 1 FROM telegram_preset_subscriptions p
            WHERE p.chat_id = s.chat_id AND (p.alert_dews = 1 OR p.alert_depeg = 1 OR p.alert_safety = 1)
         ) THEN 1 ELSE 0 END AS has_preset
    FROM telegram_subscribers s
   WHERE s.first_follow_at >= ? AND s.first_follow_at < ?
)
SELECT COALESCE((
         SELECT SUM(count) FROM telegram_adoption_daily
          WHERE day = ? AND stage = 'first_follow' AND outcome = 'success'
       ), 0) AS cohort_size,
       COALESCE(SUM(CASE WHEN has_global = 1 OR has_direct = 1 OR has_preset = 1 THEN 1 ELSE 0 END), 0) AS retained_any,
       COALESCE(SUM(has_direct), 0) AS retained_direct,
       COALESCE(SUM(has_preset), 0) AS retained_preset,
       COALESCE(SUM(has_global), 0) AS retained_global
  FROM surviving`;

export async function refreshTelegramAdoptionRetention(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1_000),
): Promise<{ written: number; caughtUp: number }> {
  const earliestDay = dayAtOffset(nowSec, -TELEGRAM_ADOPTION_RETENTION_CATCHUP_DAYS);
  const existing = await db.prepare(
    `SELECT measurement_day, window_days, COUNT(*) AS feature_count
       FROM telegram_adoption_retention_daily
      WHERE measurement_day >= ?
      GROUP BY measurement_day, window_days`,
  ).bind(earliestDay).all<{ measurement_day: string; window_days: number | string; feature_count: number | string }>();
  const complete = new Set(
    (existing.results ?? [])
      .filter((row) => count(row.feature_count) === RETENTION_FEATURES.length)
      .map((row) => `${row.measurement_day}:${count(row.window_days)}`),
  );

  let written = 0;
  let caughtUp = 0;
  // Snapshot only completed UTC days. Persisting today's first pulse would
  // freeze a nearly day-short D7/D30 result behind the immutable insert.
  for (let offset = -TELEGRAM_ADOPTION_RETENTION_CATCHUP_DAYS; offset <= -1; offset += 1) {
    const measurementDay = dayAtOffset(nowSec, offset);
    for (const windowDays of RETENTION_WINDOWS) {
      if (complete.has(`${measurementDay}:${windowDays}`)) continue;
      const cohortDay = dayAtOffset(dayStartSec(measurementDay), -windowDays);
      const cohortStart = dayStartSec(cohortDay);
      const row = await db.prepare(RETENTION_METRICS_SQL)
        .bind(cohortStart, cohortStart + 86_400, cohortDay)
        .first<RetentionMetricRow>();
      const cohortSize = count(row?.cohort_size);
      const values = {
        any: count(row?.retained_any),
        direct: count(row?.retained_direct),
        preset: count(row?.retained_preset),
        global: count(row?.retained_global),
      };
      const quality = cohortDay < ADOPTION_COHORT_START_DAY
        ? "pre_rollout_unavailable"
        : offset === -1
          ? "on_time_snapshot"
          : "catchup_current_state";
      await db.batch(RETENTION_FEATURES.map((feature) => db.prepare(
        `INSERT INTO telegram_adoption_retention_daily (
           cohort_day, measurement_day, window_days, feature, cohort_size,
           retained_count, measured_at, quality
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(measurement_day, window_days, feature) DO NOTHING`,
      ).bind(cohortDay, measurementDay, windowDays, feature, cohortSize, Math.min(cohortSize, values[feature]), nowSec, quality)));
      written += RETENTION_FEATURES.length;
      if (offset < -1) caughtUp += RETENTION_FEATURES.length;
    }
  }
  return { written, caughtUp };
}

function suppressed(value: number): number | null {
  return value > 0 && value < TELEGRAM_ADOPTION_LOW_COUNT_THRESHOLD ? null : value;
}

function rate(numerator: number, denominator: number): number | null {
  if (numerator > 0 && numerator < TELEGRAM_ADOPTION_LOW_COUNT_THRESHOLD) return null;
  if (denominator < TELEGRAM_ADOPTION_LOW_COUNT_THRESHOLD) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

export async function loadTelegramAdoptionWeeklyReport(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1_000),
): Promise<Record<string, unknown>> {
  const currentEnd = dayAtOffset(nowSec, -1);
  const currentStart = dayAtOffset(nowSec, -7);
  const previousStart = dayAtOffset(nowSec, -14);
  const daily = await db.prepare(
    `SELECT campaign, placement, stage, feature, latency_bucket, outcome,
            SUM(count) AS count, MAX(last_seen_at) AS last_seen_at,
            CASE WHEN day >= ? THEN 'current' ELSE 'previous' END AS period
       FROM telegram_adoption_daily
      WHERE day >= ? AND day <= ?
      GROUP BY period, campaign, placement, stage, feature, latency_bucket, outcome`,
  ).bind(currentStart, previousStart, currentEnd).all<AdoptionDailyRow>();

  type PlacementMetrics = {
    clicks: number;
    starts: number;
    setups: number;
    firstFollows: number;
    miniAppSessions: number;
    firstMutations: number;
  };
  const emptyMetrics = (): PlacementMetrics => ({
    clicks: 0,
    starts: 0,
    setups: 0,
    firstFollows: 0,
    miniAppSessions: 0,
    firstMutations: 0,
  });
  const placementMap = new Map<string, PlacementMetrics>();
  const placementNames = new Set<string>();
  const mutationBuckets = new Map<string, number>();
  let latestEventAt = 0;
  for (const row of daily.results ?? []) {
    latestEventAt = Math.max(latestEventAt, count(row.last_seen_at));
    placementNames.add(row.placement);
    const key = `${row.period}:${row.placement}`;
    const placement = placementMap.get(key) ?? emptyMetrics();
    if (row.stage === "cta_click") placement.clicks += count(row.count);
    if (row.stage === "bot_start") placement.starts += count(row.count);
    if (row.stage === "setup_complete") placement.setups += count(row.count);
    if (row.stage === "first_follow") placement.firstFollows += count(row.count);
    if (row.stage === "mini_app_session") placement.miniAppSessions += count(row.count);
    if (row.stage === "first_mutation") placement.firstMutations += count(row.count);
    placementMap.set(key, placement);
    if (row.period === "current" && row.stage === "first_mutation") {
      mutationBuckets.set(row.latency_bucket, (mutationBuckets.get(row.latency_bucket) ?? 0) + count(row.count));
    }
  }

  const retention = await db.prepare(
    `SELECT cohort_day, measurement_day, window_days, feature, cohort_size,
            retained_count, measured_at, quality
       FROM telegram_adoption_retention_daily
      WHERE measurement_day <= ?
        AND measurement_day >= ?
      ORDER BY measurement_day DESC, window_days ASC, feature ASC`,
  ).bind(currentEnd, currentStart).all<AdoptionRetentionRow>();
  let latestRetentionAt = 0;
  const latestRetention = new Map<string, AdoptionRetentionRow>();
  for (const row of retention.results ?? []) {
    latestRetentionAt = Math.max(latestRetentionAt, count(row.measured_at));
    const key = `${count(row.window_days)}:${row.feature}`;
    if (!latestRetention.has(key)) latestRetention.set(key, row);
  }

  return {
    generatedAt: nowSec,
    range: { currentStart, currentEnd, previousStart, previousEnd: dayAtOffset(nowSec, -8) },
    placements: [...placementNames].sort().map((placement) => {
      const current = placementMap.get(`current:${placement}`) ?? emptyMetrics();
      const previous = placementMap.get(`previous:${placement}`) ?? emptyMetrics();
      const clickOnly = placement === "setup";
      const miniAppPlacement = placement === "miniapp_setup"
        || placement === "miniapp_home"
        || placement === "miniapp_watchlist"
        || placement === "menu";
      return {
        placement,
        attributionMode: clickOnly ? "click_only" : "aggregate_directional",
        ctaClicks: suppressed(current.clicks),
        botStarts: clickOnly || miniAppPlacement ? null : suppressed(current.starts),
        setupCompletes: clickOnly || miniAppPlacement ? null : suppressed(current.setups),
        firstFollows: clickOnly ? null : suppressed(current.firstFollows),
        miniAppSessions: miniAppPlacement ? suppressed(current.miniAppSessions) : null,
        firstMutations: miniAppPlacement ? suppressed(current.firstMutations) : null,
        startPerClickPct: clickOnly || miniAppPlacement ? null : rate(current.starts, current.clicks),
        setupPerStartPct: clickOnly || miniAppPlacement ? null : rate(current.setups, current.starts),
        previous: {
          ctaClicks: suppressed(previous.clicks),
          botStarts: clickOnly || miniAppPlacement ? null : suppressed(previous.starts),
          setupCompletes: clickOnly || miniAppPlacement ? null : suppressed(previous.setups),
          firstFollows: clickOnly ? null : suppressed(previous.firstFollows),
          miniAppSessions: miniAppPlacement ? suppressed(previous.miniAppSessions) : null,
          firstMutations: miniAppPlacement ? suppressed(previous.firstMutations) : null,
        },
      };
    }),
    firstMutationLatencyBuckets: [...mutationBuckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
      ([bucket, value]) => ({ bucket, count: suppressed(value) }),
    ),
    retention: [...latestRetention.values()].map((row) => {
      const cohortSize = count(row.cohort_size);
      const retainedCount = count(row.retained_count);
      return {
        cohortDay: row.cohort_day,
        measurementDay: row.measurement_day,
        windowDays: count(row.window_days),
        feature: row.feature,
        cohortSize: suppressed(cohortSize),
        retainedCount: suppressed(retainedCount),
        retentionPct: rate(retainedCount, cohortSize),
        quality: row.quality,
      };
    }),
    freshness: { latestEventAt: latestEventAt || null, latestRetentionAt: latestRetentionAt || null },
    quality: {
      ctaClicks: "best_effort_no_identifier",
      telegramStages: "idempotent_telegram_milestones",
      retention: "daily_snapshot_with_bounded_catchup",
      suppressionThreshold: TELEGRAM_ADOPTION_LOW_COUNT_THRESHOLD,
      warnings: [
        "CTA and Telegram stages are aggregate-only and are not joined users.",
        "Directional start-per-click rates may exceed 100% after retries, shared links, or cross-day activity.",
        "Catch-up retention uses current operational state and is labeled catchup_current_state.",
        "First-follow cohorts before 2026-07-11 are unavailable because they predate complete aggregate collection.",
      ],
    },
  };
}

export const TELEGRAM_ADOPTION_SESSION_CACHE_PREFIX = MINI_APP_SESSION_CACHE_PREFIX;
