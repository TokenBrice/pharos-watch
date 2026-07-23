import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { z } from "zod";
import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./cron-lease";
import { executeAtomicBatch } from "./db";
import { parseJson } from "./json-parse";
import {
  parseSafetyScoreV9DiffReportCacheValue,
  parseSafetyScoreV9ShadowEnvelopeCacheValue,
  serializeSafetyScoreV9DiffReportCacheValue,
  serializeSafetyScoreV9ShadowEnvelopeCacheValue,
} from "./safety-score-v9-cache-codec";
import {
  SafetyScoreV9DiffReportSchema,
  SafetyScoreV9ShadowDailySchema,
  SafetyScoreV9ShadowEnvelopeSchema,
  computeSafetyScoreV9ShadowEnvelopeDigest,
  type SafetyScoreV9DiffReport,
  type SafetyScoreV9ShadowDaily,
  type SafetyScoreV9ShadowEnvelope,
} from "./safety-score-v9-shadow";

export const SAFETY_SCORE_V9_SHADOW_CACHE_KEYS = {
  envelope: "report-cards:v9-shadow",
  diff: "report-cards:v9-shadow:diff",
} as const;

const SAFETY_SCORE_V9_SHADOW_HISTORY_DEFAULT_LIMIT = 45;
const SAFETY_SCORE_V9_SHADOW_HISTORY_MAX_LIMIT = 400;

class SafetyScoreV9StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyScoreV9StoreConflictError";
  }
}

interface DailyRow {
  utc_day: string;
  updated_at_sec: number;
  successful_attempt_count: number;
  failed_attempt_count: number;
  selected_run_at_sec: number | null;
  publication_generation_id: string | null;
  base_input_generation_id: string | null;
  fact_set_digest: string | null;
  policy_digest: string | null;
  evaluation_build_digest: string | null;
  producer_capability_digest: string | null;
  release_coverage_policy_digest: string | null;
  consumer_threshold_registry_digest: string | null;
  result_digest: string | null;
  diff_report_digest: string | null;
  active_asset_count: number | null;
  rateable_count: number | null;
  nr_count: number | null;
  present_active_count: number | null;
  missing_active_count: number | null;
  unexpected_active_count: number | null;
  duplicate_active_count: number | null;
  grade_nr_transition_count: number | null;
  large_score_movement_count: number | null;
  top_cutoff_movement_count: number | null;
  binding_cap_change_count: number | null;
  downstream_crossing_count: number | null;
  unresolved_review_count: number | null;
  qualifying: number;
  blockers_json: string;
  archive_selection_reasons_json: string;
  latest_error_code: string | null;
  latest_error_message: string | null;
  daily_json: string;
}

function parseCanonicalJson<T>(raw: string, schema: z.ZodType<T>, label: string): T {
  const parsed = parseJson(raw);
  if (!parsed.ok) throw new Error(`Malformed ${label} JSON: ${parsed.message}`);
  const value = schema.parse(parsed.value);
  if (stableJsonStringifyV1(value) !== raw) throw new Error(`${label} JSON is not canonical`);
  return value;
}

function expectedDailyColumns(daily: SafetyScoreV9ShadowDaily) {
  const selected = daily.selectedRun;
  return {
    updatedAtSec: daily.updatedAtSec,
    successfulAttemptCount: daily.attemptCounts.successful,
    failedAttemptCount: daily.attemptCounts.failed,
    selectedRunAtSec: selected?.selectedAtSec ?? null,
    publicationGenerationId: selected?.identity.publicationGenerationId ?? null,
    baseInputGenerationId: selected?.identity.baseInputGenerationId ?? null,
    factSetDigest: selected?.identity.factSetDigest ?? null,
    policyDigest: selected?.identity.policyDigest ?? null,
    evaluationBuildDigest: selected?.identity.evaluationBuildDigest ?? null,
    producerCapabilityDigest: selected?.identity.producerCapabilityDigest ?? null,
    releaseCoveragePolicyDigest: selected?.identity.releaseCoveragePolicyDigest ?? null,
    consumerThresholdRegistryDigest: selected?.identity.consumerThresholdRegistryDigest ?? null,
    resultDigest: selected?.identity.resultDigest ?? null,
    diffReportDigest: selected?.diffReportDigest ?? null,
    activeAssetCount: selected?.coverage.expectedActiveCount ?? null,
    rateableCount: selected?.coverage.ratedResultCount ?? null,
    nrCount: selected?.coverage.notRatedResultCount ?? null,
    presentActiveCount: selected?.coverage.presentExpectedCount ?? null,
    missingActiveCount: selected?.coverage.missingIds.length ?? null,
    unexpectedActiveCount: selected?.coverage.unexpectedIds.length ?? null,
    duplicateActiveCount: selected?.coverage.duplicateIds.length ?? null,
    gradeNrTransitionCount: selected?.movement.gradeOrNrTransitionCount ?? null,
    largeScoreMovementCount: selected?.movement.largeScoreMovementCount ?? null,
    topCutoffMovementCount: selected?.movement.topCutoffMovementCount ?? null,
    bindingCapChangeCount: selected?.movement.bindingCapChangeCount ?? null,
    downstreamCrossingCount: selected?.movement.downstreamCrossingCount ?? null,
    unresolvedReviewCount: selected?.movement.pendingReviewCount ?? null,
    qualifying: selected?.qualification.qualifies ? 1 : 0,
    blockersJson: stableJsonStringifyV1(selected?.qualification.blockers ?? []),
    archiveSelectionReasonsJson: stableJsonStringifyV1(selected?.archiveSelectionReasons ?? []),
    latestErrorCode: daily.latestError?.code ?? null,
    latestErrorMessage: daily.latestError?.message ?? null,
  };
}

function parseDailyRow(row: DailyRow): SafetyScoreV9ShadowDaily {
  const daily = parseCanonicalJson(row.daily_json, SafetyScoreV9ShadowDailySchema, "Safety Score v9 shadow daily");
  if (daily.utcDay !== row.utc_day) throw new Error("Safety Score v9 shadow daily row date mismatch");
  const expected = expectedDailyColumns(daily);
  const observed = {
    updatedAtSec: row.updated_at_sec,
    successfulAttemptCount: row.successful_attempt_count,
    failedAttemptCount: row.failed_attempt_count,
    selectedRunAtSec: row.selected_run_at_sec,
    publicationGenerationId: row.publication_generation_id,
    baseInputGenerationId: row.base_input_generation_id,
    factSetDigest: row.fact_set_digest,
    policyDigest: row.policy_digest,
    evaluationBuildDigest: row.evaluation_build_digest,
    producerCapabilityDigest: row.producer_capability_digest,
    releaseCoveragePolicyDigest: row.release_coverage_policy_digest,
    consumerThresholdRegistryDigest: row.consumer_threshold_registry_digest,
    resultDigest: row.result_digest,
    diffReportDigest: row.diff_report_digest,
    activeAssetCount: row.active_asset_count,
    rateableCount: row.rateable_count,
    nrCount: row.nr_count,
    presentActiveCount: row.present_active_count,
    missingActiveCount: row.missing_active_count,
    unexpectedActiveCount: row.unexpected_active_count,
    duplicateActiveCount: row.duplicate_active_count,
    gradeNrTransitionCount: row.grade_nr_transition_count,
    largeScoreMovementCount: row.large_score_movement_count,
    topCutoffMovementCount: row.top_cutoff_movement_count,
    bindingCapChangeCount: row.binding_cap_change_count,
    downstreamCrossingCount: row.downstream_crossing_count,
    unresolvedReviewCount: row.unresolved_review_count,
    qualifying: row.qualifying,
    blockersJson: row.blockers_json,
    archiveSelectionReasonsJson: row.archive_selection_reasons_json,
    latestErrorCode: row.latest_error_code,
    latestErrorMessage: row.latest_error_message,
  };
  if (stableJsonStringifyV1(observed) !== stableJsonStringifyV1(expected)) {
    throw new Error(`Safety Score v9 shadow daily row projection mismatch for ${daily.utcDay}`);
  }
  return daily;
}

const SAFETY_SCORE_V9_SHADOW_DAILY_SELECT = `
  utc_day, updated_at_sec, successful_attempt_count, failed_attempt_count, selected_run_at_sec,
  publication_generation_id, base_input_generation_id, fact_set_digest, policy_digest,
  evaluation_build_digest, producer_capability_digest, release_coverage_policy_digest,
  consumer_threshold_registry_digest, result_digest, diff_report_digest,
  active_asset_count, rateable_count, nr_count, present_active_count, missing_active_count,
  unexpected_active_count, duplicate_active_count, grade_nr_transition_count,
  large_score_movement_count, top_cutoff_movement_count, binding_cap_change_count,
  downstream_crossing_count, unresolved_review_count, qualifying, blockers_json,
  archive_selection_reasons_json, latest_error_code, latest_error_message, daily_json
`;

export async function loadSafetyScoreV9ShadowDaily(
  db: D1Database,
  utcDay: string,
  signal?: AbortSignal,
): Promise<SafetyScoreV9ShadowDaily | null> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare(`SELECT ${SAFETY_SCORE_V9_SHADOW_DAILY_SELECT} FROM safety_score_v9_shadow_daily WHERE utc_day = ?`)
        .bind(utcDay)
        .first<DailyRow>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return row ? parseDailyRow(row) : null;
}

function validateSuccessfulState(input: {
  daily: SafetyScoreV9ShadowDaily;
  envelope: SafetyScoreV9ShadowEnvelope;
  diff: SafetyScoreV9DiffReport;
}): void {
  const selected = input.daily.selectedRun;
  if (selected === null) throw new Error("Latest Safety Score v9 state requires a selected successful run");
  const identity = selected.identity;
  if (identity.envelopeDigest !== computeSafetyScoreV9ShadowEnvelopeDigest(input.envelope)) {
    throw new Error("Safety Score v9 daily and candidate envelope digests do not match");
  }
  if (
    input.diff.reportDigest !== selected.diffReportDigest ||
    input.diff.v9Identity.publicationGenerationId !== identity.publicationGenerationId ||
    input.diff.v9Identity.baseInputGenerationId !== identity.baseInputGenerationId ||
    input.diff.v9Identity.factSetDigest !== identity.factSetDigest ||
    input.diff.v9Identity.policyDigest !== identity.policyDigest ||
    input.diff.v9Identity.evaluationBuildDigest !== identity.evaluationBuildDigest ||
    input.diff.v9Identity.resultDigest !== identity.resultDigest
  ) {
    throw new Error("Safety Score v9 diff identity does not match its selected daily run");
  }
}

export interface PersistSafetyScoreV9ShadowStateInput {
  daily: SafetyScoreV9ShadowDaily;
  envelope?: SafetyScoreV9ShadowEnvelope;
  diff?: SafetyScoreV9DiffReport;
  signal?: AbortSignal;
}

export async function persistSafetyScoreV9ShadowState(
  db: D1Database,
  input: PersistSafetyScoreV9ShadowStateInput,
): Promise<void> {
  throwIfAborted(input.signal);
  const daily = SafetyScoreV9ShadowDailySchema.parse(input.daily);
  const hasCanonicalState = input.envelope !== undefined || input.diff !== undefined;
  let envelopeJson: string | null = null;
  let diffJson: string | null = null;
  if (hasCanonicalState) {
    if (input.envelope === undefined || input.diff === undefined) {
      throw new Error("Safety Score v9 canonical envelope and diff must be persisted together");
    }
    const envelope = SafetyScoreV9ShadowEnvelopeSchema.parse(input.envelope);
    const diff = SafetyScoreV9DiffReportSchema.parse(input.diff);
    validateSuccessfulState({ daily, envelope, diff });
    envelopeJson = await serializeSafetyScoreV9ShadowEnvelopeCacheValue(envelope, input.signal);
    diffJson = await serializeSafetyScoreV9DiffReportCacheValue(diff, input.signal);
  } else if (daily.selectedRun !== null) {
    const existing = await loadSafetyScoreV9ShadowDaily(db, daily.utcDay, input.signal);
    if (existing?.selectedRun === null || existing === null) {
      throw new Error("A newly selected Safety Score v9 daily run must persist its canonical envelope and diff");
    }
    if (stableJsonStringifyV1(existing.selectedRun) !== stableJsonStringifyV1(daily.selectedRun)) {
      throw new Error("A re-selected Safety Score v9 daily run must persist its canonical envelope and diff");
    }
  }
  const dailyJson = stableJsonStringifyV1(daily);
  const dailyColumns = expectedDailyColumns(daily);
  const existingDaily = await loadSafetyScoreV9ShadowDaily(db, daily.utcDay, input.signal);
  if (existingDaily) {
    const oldAttempts = existingDaily.attemptCounts.successful + existingDaily.attemptCounts.failed;
    const newAttempts = daily.attemptCounts.successful + daily.attemptCounts.failed;
    const existingDailyJson = stableJsonStringifyV1(existingDaily);
    if (existingDailyJson !== dailyJson) {
      if (newAttempts <= oldAttempts || daily.updatedAtSec < existingDaily.updatedAtSec) {
        throw new SafetyScoreV9StoreConflictError(`Stale Safety Score v9 daily update for ${daily.utcDay}`);
      }
      if (existingDaily.selectedRun !== null) {
        const selected = daily.selectedRun;
        if (
          selected === null ||
          selected.selectedAtSec < existingDaily.selectedRun.selectedAtSec ||
          (selected.selectedAtSec === existingDaily.selectedRun.selectedAtSec &&
            stableJsonStringifyV1(selected) !== stableJsonStringifyV1(existingDaily.selectedRun))
        ) {
          throw new SafetyScoreV9StoreConflictError(`Selected Safety Score v9 daily run conflict for ${daily.utcDay}`);
        }
      }
    }
  }

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO safety_score_v9_shadow_daily
         (utc_day, updated_at_sec, successful_attempt_count, failed_attempt_count, selected_run_at_sec,
          publication_generation_id, base_input_generation_id, fact_set_digest, policy_digest,
          evaluation_build_digest, producer_capability_digest, release_coverage_policy_digest,
          consumer_threshold_registry_digest, result_digest, diff_report_digest,
          active_asset_count, rateable_count, nr_count, present_active_count, missing_active_count,
          unexpected_active_count, duplicate_active_count, grade_nr_transition_count,
          large_score_movement_count, top_cutoff_movement_count, binding_cap_change_count,
          downstream_crossing_count, unresolved_review_count, qualifying, blockers_json,
          archive_selection_reasons_json, latest_error_code, latest_error_message, daily_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(utc_day) DO UPDATE SET
           successful_attempt_count = excluded.successful_attempt_count,
           failed_attempt_count = excluded.failed_attempt_count,
           selected_run_at_sec = excluded.selected_run_at_sec,
           publication_generation_id = excluded.publication_generation_id,
           base_input_generation_id = excluded.base_input_generation_id,
           fact_set_digest = excluded.fact_set_digest,
           policy_digest = excluded.policy_digest,
           evaluation_build_digest = excluded.evaluation_build_digest,
           producer_capability_digest = excluded.producer_capability_digest,
           release_coverage_policy_digest = excluded.release_coverage_policy_digest,
           consumer_threshold_registry_digest = excluded.consumer_threshold_registry_digest,
           result_digest = excluded.result_digest,
           diff_report_digest = excluded.diff_report_digest,
           active_asset_count = excluded.active_asset_count,
           rateable_count = excluded.rateable_count,
           nr_count = excluded.nr_count,
           present_active_count = excluded.present_active_count,
           missing_active_count = excluded.missing_active_count,
           unexpected_active_count = excluded.unexpected_active_count,
           duplicate_active_count = excluded.duplicate_active_count,
           grade_nr_transition_count = excluded.grade_nr_transition_count,
           large_score_movement_count = excluded.large_score_movement_count,
           top_cutoff_movement_count = excluded.top_cutoff_movement_count,
           binding_cap_change_count = excluded.binding_cap_change_count,
           downstream_crossing_count = excluded.downstream_crossing_count,
           unresolved_review_count = excluded.unresolved_review_count,
           qualifying = excluded.qualifying,
           blockers_json = excluded.blockers_json,
           archive_selection_reasons_json = excluded.archive_selection_reasons_json,
           latest_error_code = excluded.latest_error_code,
           latest_error_message = excluded.latest_error_message,
           daily_json = CASE
             WHEN safety_score_v9_shadow_daily.daily_json = excluded.daily_json
                  OR (
                    safety_score_v9_shadow_daily.successful_attempt_count
                      + safety_score_v9_shadow_daily.failed_attempt_count
                      < excluded.successful_attempt_count + excluded.failed_attempt_count
                    AND safety_score_v9_shadow_daily.updated_at_sec <= excluded.updated_at_sec
                    AND (
                      safety_score_v9_shadow_daily.selected_run_at_sec IS NULL
                      OR (
                        excluded.selected_run_at_sec IS NOT NULL
                        AND (
                          safety_score_v9_shadow_daily.selected_run_at_sec < excluded.selected_run_at_sec
                          OR (
                            safety_score_v9_shadow_daily.selected_run_at_sec = excluded.selected_run_at_sec
                            AND json_extract(safety_score_v9_shadow_daily.daily_json, '$.selectedRun')
                              = json_extract(excluded.daily_json, '$.selectedRun')
                          )
                        )
                      )
                    )
                  )
               THEN excluded.daily_json
             ELSE NULL
           END,
           updated_at_sec = CASE
             WHEN safety_score_v9_shadow_daily.daily_json = excluded.daily_json
                  OR (
                    safety_score_v9_shadow_daily.successful_attempt_count
                      + safety_score_v9_shadow_daily.failed_attempt_count
                      < excluded.successful_attempt_count + excluded.failed_attempt_count
                    AND safety_score_v9_shadow_daily.updated_at_sec <= excluded.updated_at_sec
                    AND (
                      safety_score_v9_shadow_daily.selected_run_at_sec IS NULL
                      OR (
                        excluded.selected_run_at_sec IS NOT NULL
                        AND (
                          safety_score_v9_shadow_daily.selected_run_at_sec < excluded.selected_run_at_sec
                          OR (
                            safety_score_v9_shadow_daily.selected_run_at_sec = excluded.selected_run_at_sec
                            AND json_extract(safety_score_v9_shadow_daily.daily_json, '$.selectedRun')
                              = json_extract(excluded.daily_json, '$.selectedRun')
                          )
                        )
                      )
                    )
                  )
               THEN excluded.updated_at_sec
             ELSE -1
           END`,
      )
      .bind(
        daily.utcDay,
        dailyColumns.updatedAtSec,
        dailyColumns.successfulAttemptCount,
        dailyColumns.failedAttemptCount,
        dailyColumns.selectedRunAtSec,
        dailyColumns.publicationGenerationId,
        dailyColumns.baseInputGenerationId,
        dailyColumns.factSetDigest,
        dailyColumns.policyDigest,
        dailyColumns.evaluationBuildDigest,
        dailyColumns.producerCapabilityDigest,
        dailyColumns.releaseCoveragePolicyDigest,
        dailyColumns.consumerThresholdRegistryDigest,
        dailyColumns.resultDigest,
        dailyColumns.diffReportDigest,
        dailyColumns.activeAssetCount,
        dailyColumns.rateableCount,
        dailyColumns.nrCount,
        dailyColumns.presentActiveCount,
        dailyColumns.missingActiveCount,
        dailyColumns.unexpectedActiveCount,
        dailyColumns.duplicateActiveCount,
        dailyColumns.gradeNrTransitionCount,
        dailyColumns.largeScoreMovementCount,
        dailyColumns.topCutoffMovementCount,
        dailyColumns.bindingCapChangeCount,
        dailyColumns.downstreamCrossingCount,
        dailyColumns.unresolvedReviewCount,
        dailyColumns.qualifying,
        dailyColumns.blockersJson,
        dailyColumns.archiveSelectionReasonsJson,
        dailyColumns.latestErrorCode,
        dailyColumns.latestErrorMessage,
        dailyJson,
      ),
  ];
  if (envelopeJson !== null && diffJson !== null) {
    const cacheStatement = db.prepare(
      `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CASE WHEN cache.updated_at <= excluded.updated_at THEN excluded.value ELSE NULL END,
         updated_at = excluded.updated_at`,
    );
    statements.push(
      cacheStatement.bind(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope, envelopeJson, daily.updatedAtSec),
      cacheStatement.bind(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.diff, diffJson, daily.updatedAtSec),
    );
  }
  await executeAtomicBatch(db, statements, { signal: input.signal });
  throwIfAborted(input.signal);
}

async function loadCanonicalCacheValue<T>(
  db: D1Database,
  key: string,
  parse: (storedValue: string, signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T | null> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () => db.prepare("SELECT value FROM cache WHERE key = ?").bind(key).first<{ value: string }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  if (!row) return null;
  return parse(row.value, signal);
}

export async function loadLatestSafetyScoreV9ShadowEnvelope(
  db: D1Database,
  signal?: AbortSignal,
): Promise<SafetyScoreV9ShadowEnvelope | null> {
  return loadCanonicalCacheValue(
    db,
    SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope,
    parseSafetyScoreV9ShadowEnvelopeCacheValue,
    signal,
  );
}

export async function loadLatestSafetyScoreV9DiffReport(
  db: D1Database,
  signal?: AbortSignal,
): Promise<SafetyScoreV9DiffReport | null> {
  return loadCanonicalCacheValue(
    db,
    SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.diff,
    parseSafetyScoreV9DiffReportCacheValue,
    signal,
  );
}

export interface LoadSafetyScoreV9ShadowHistoryOptions {
  fromUtcDay?: string;
  toUtcDay?: string;
  limit?: number;
  signal?: AbortSignal;
}

export async function loadSafetyScoreV9ShadowHistory(
  db: D1Database,
  options: LoadSafetyScoreV9ShadowHistoryOptions = {},
): Promise<SafetyScoreV9ShadowDaily[]> {
  throwIfAborted(options.signal);
  const limit = options.limit ?? SAFETY_SCORE_V9_SHADOW_HISTORY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > SAFETY_SCORE_V9_SHADOW_HISTORY_MAX_LIMIT) {
    throw new RangeError(`Safety Score v9 shadow history limit must be 1-${SAFETY_SCORE_V9_SHADOW_HISTORY_MAX_LIMIT}`);
  }
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (options.fromUtcDay !== undefined) {
    conditions.push("utc_day >= ?");
    bindings.push(options.fromUtcDay);
  }
  if (options.toUtcDay !== undefined) {
    conditions.push("utc_day <= ?");
    bindings.push(options.toUtcDay);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT ${SAFETY_SCORE_V9_SHADOW_DAILY_SELECT}
           FROM safety_score_v9_shadow_daily
           ${where}
           ORDER BY utc_day DESC
           LIMIT ?`,
        )
        .bind(...bindings, limit)
        .all<DailyRow>(),
    3,
    options.signal,
  );
  throwIfAborted(options.signal);
  return (rows.results ?? []).map(parseDailyRow);
}
