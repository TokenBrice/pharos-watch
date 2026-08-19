import {
  DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC,
  getDexMeasuredExecutionFreshnessMaxSec,
  DexMeasuredExecutionProfileSchema,
  DexMeasuredExecutionTargetSchema,
  type DexMeasuredExecutionObservationHistory,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { rethrowIfAborted } from "../../lib/abort";
import { batchExecute, executeAtomicBatch, prepareMultiRowInsertStatements } from "../../lib/db";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { toErrorMessage } from "../../lib/error-utils";
import { parseJson } from "../../lib/json-parse";
import {
  summarizeDexMeasuredExecutionHistory,
  type DexMeasuredExecutionHistoryCycle,
} from "./history";

const DEX_MEASURED_TARGET_SURFACE = "dex-measured-execution-targets";
const DEX_MEASURED_QUOTE_SURFACE = "dex-measured-execution-quotes";
const DEX_SHADOW_MEASURED_TARGET_SURFACE = "dex-shadow-measured-execution-targets";
const DEX_SHADOW_MEASURED_QUOTE_SURFACE = "dex-shadow-measured-execution-quotes";
/** Retain the complete two-hour scoring window plus one missed producer cycle. */
const GENERATION_RETENTION_SEC = 3 * 60 * 60;
/** Bound each prune pass so a retention shortening drains gradually instead of one oversized D1 delete in the cron tail. */
const GENERATION_PRUNE_MAX_PER_RUN = 16;
const DEX_MEASURED_HISTORY_LOOKBACK_MAX_SEC =
  DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC;
/** Preserve the full window while keeping proof-heavy history rows below the scoring graph's heap peak. */
const DEX_MEASURED_HISTORY_TARGET_BATCH_SIZE = 16;
/** Bound raw target/profile JSON beside the assembled DEX pool graph. */
export const DEX_MEASURED_CURRENT_EVIDENCE_PAGE_SIZE = 32;

export function getDexMeasuredHistoryFreshnessSec(adapterProfileId: string): number {
  return getDexMeasuredExecutionFreshnessMaxSec(adapterProfileId);
}

function parsePersistedJson(value: string, context: string): unknown {
  const parsed = parseJson(value, { onFailure: () => undefined });
  if (!parsed.ok) throw new Error(`Invalid ${context}: ${parsed.message}`);
  return parsed.value;
}

interface SurfaceGenerationRow {
  generation_id: string;
  state: string;
  started_at: number;
  published_at: number | null;
  expected_rows: number | null;
  published_rows: number | null;
  dependency_snapshot_json: string | null;
}

interface TargetRow {
  generation_id: string;
  target_id: string;
  target_json: string;
}

interface QuoteRow {
  generation_id: string;
  target_generation_id: string;
  target_id: string;
  status: "measured" | "failed";
  failure_reason: string | null;
  quote_profile_json: string | null;
}

interface HistoricalQuoteRow extends QuoteRow {
  quote_published_at: number;
  target_json: string;
}

interface SparseCurrentQuoteWithTargetRow {
  target_id: string;
  target_json: string;
  /** Compatibility alias retained by test/read adapters built for dense generations. */
  generation_id?: string | null;
  quote_generation_id: string | null;
  target_generation_id: string | null;
  status: "measured" | "failed" | null;
  failure_reason: string | null;
  quote_profile_json: string | null;
}

interface QuoteGenerationSummaryRow {
  row_count: number;
  min_target_generation_id: string | null;
  max_target_generation_id: string | null;
}

interface MeasuredQuoteGenerationDependency {
  targetGenerationId?: string;
  targetCount?: number;
  persistedOutcomeCount?: number;
  omittedBudgetDeferredCount?: number;
  targetIdsSha256?: string;
}

export interface DexMeasuredQuoteOutcome {
  target: DexMeasuredExecutionTarget;
  status: "measured" | "failed";
  failureReason?: string;
  profile?: DexMeasuredExecutionProfile;
  /** Persisted only for failed outcomes; measured rows carry their evidence in the profile's quoteProof. */
  rawPayload?: unknown;
}

export interface PublishedDexMeasuredTargets {
  generationId: string;
  targets: DexMeasuredExecutionTarget[];
  publishedAt: number;
}

export interface LoadedDexMeasuredQuoteEvidence {
  quoteGenerationId: string;
  targetGenerationId: string;
  publishedAt: number;
  byTargetId: Map<
    string,
    {
      quotedTarget: DexMeasuredExecutionTarget;
      status: "measured" | "failed";
      failureReason: string | null;
      profile: DexMeasuredExecutionProfile | null;
      /** Scoring-only lazy form; validated once on read and materialized per consumer target. */
      deferredProfileJson?: string;
      quoteGenerationId: string;
      targetGenerationId: string;
      resolution: "latest" | "last-known-good";
      latestFailureReason: string | null;
      observationHistory?: DexMeasuredExecutionObservationHistory;
    }
  >;
}

const OPERATIONAL_DEX_MEASURED_FAILURE_REASONS = new Set([
  "block-number-unavailable",
  "budget-deferred",
  "chain-circuit-open",
  "block-header-unavailable",
  "block-timestamp-unavailable",
  "factory-code-unavailable",
  "pool-manager-code-unavailable",
  "pool-state-rpc-unavailable",
  "quote-call-budget-exhausted",
  "quoter-rpc-unavailable",
  "quoter-code-unavailable",
  "registry-code-unavailable",
  "request-budget-exhausted",
  "rpc-failure",
  "runtime-code-unavailable",
  "runtime-binding-unavailable",
  "runtime-deadline-exceeded",
  "state-view-code-unavailable",
]);

export function isOperationalDexMeasuredFailure(reason: string | null | undefined): boolean {
  return reason != null && OPERATIONAL_DEX_MEASURED_FAILURE_REASONS.has(reason);
}

export function materializeDexMeasuredQuoteProfile(
  entry: LoadedDexMeasuredQuoteEvidence["byTargetId"] extends Map<string, infer T> ? T : never,
): DexMeasuredExecutionProfile | null {
  if (entry.profile) return entry.profile;
  if (!entry.deferredProfileJson) return null;
  return DexMeasuredExecutionProfileSchema.parse(
    parsePersistedJson(entry.deferredProfileJson, "DEX measured deferred profile JSON"),
  );
}

function generationId(prefix: string, nowSec: number): string {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${prefix}-${nowSec}-${nonce}`;
}

async function hashMeasuredTargetIds(targetIds: readonly string[]): Promise<string> {
  const canonical = JSON.stringify([...targetIds].sort());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildDexMeasuredQuoteGenerationId(nowSec: number): string {
  return generationId("dex-measured-quotes", nowSec);
}

export function buildDexShadowMeasuredQuoteGenerationId(nowSec: number): string {
  return generationId("dex-shadow-measured-quotes", nowSec);
}

async function latestPublishedGeneration(
  db: D1Database,
  surface: string,
  signal?: AbortSignal,
): Promise<SurfaceGenerationRow | null> {
  return runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT generation_id, state, started_at, published_at, expected_rows, published_rows, dependency_snapshot_json
       FROM surface_publication_generations
       WHERE surface = ? AND state = 'published'
       ORDER BY published_at DESC, started_at DESC
       LIMIT 1`,
        )
        .bind(surface)
        .first<SurfaceGenerationRow>(),
    3,
    signal,
  );
}

/** Superseded quote generations inside the lookback whose row count still matches the published ledger, newest first. */
async function loadSupersededQuoteGenerationIds(input: {
  db: D1Database;
  quoteSurface: string;
  publishedAtFloor: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const result = await runWithOverloadRetry(
    () =>
      input.db
        .prepare(
          `SELECT history_generation.generation_id
       FROM surface_publication_generations history_generation
       WHERE history_generation.surface = ? AND history_generation.state = 'superseded'
         AND history_generation.published_at IS NOT NULL AND history_generation.published_at >= ?
         AND history_generation.expected_rows IS NOT NULL
         AND history_generation.published_rows = history_generation.expected_rows
         AND history_generation.expected_rows = (
           SELECT COUNT(*)
           FROM dex_measured_execution_quotes complete_quotes
           WHERE complete_quotes.generation_id = history_generation.generation_id
         )
       ORDER BY history_generation.published_at DESC, history_generation.generation_id DESC`,
        )
        .bind(input.quoteSurface, input.publishedAtFloor)
        .all<{ generation_id: string }>(),
    3,
    input.signal,
  );
  return (result.results ?? []).map((row) => row.generation_id);
}

/**
 * A historical quote row is reusable only when its target parses back to the same
 * identity and its terminal state is internally consistent: measured rows carry a
 * profile bound to the same target and quote generation, failed rows carry a reason.
 */
function isCoherentHistoricalQuoteRow(
  row: QuoteRow,
  target: { targetId: string },
  profile: NativeMeasuredProfile | null,
): boolean {
  if (target.targetId !== row.target_id) return false;
  if (row.status === "measured") {
    return (
      profile != null &&
      row.failure_reason == null &&
      profile.targetId === row.target_id &&
      profile.targetGenerationId === row.target_generation_id &&
      profile.quoteGenerationId === row.generation_id
    );
  }
  return profile == null && Boolean(row.failure_reason?.trim());
}

async function loadCurrentMeasuredQuoteEvidence<
  TTarget extends { targetId: string },
  TProfile extends {
    targetId: string;
    targetGenerationId: string;
    quoteGenerationId: string;
  },
>(input: {
  db: D1Database;
  quoteSurface: string;
  targetSurface: string;
  label: string;
  targetSchema: { parse(value: unknown): TTarget };
  profileSchema: { parse(value: unknown): TProfile };
  deferProfiles?: boolean;
  targetIds?: readonly string[];
  signal?: AbortSignal;
}): Promise<{
  quoteGenerationId: string;
  targetGenerationId: string;
  publishedAt: number;
  byTargetId: Map<
    string,
    {
      quotedTarget: TTarget;
      status: "measured" | "failed";
      failureReason: string | null;
      profile: TProfile | null;
      deferredProfileJson?: string;
    }
  >;
} | null> {
  const generation = await latestPublishedGeneration(input.db, input.quoteSurface, input.signal);
  if (!generation) return null;
  const summary = await runWithOverloadRetry(
    () =>
      input.db
        .prepare(
          `SELECT COUNT(*) AS row_count,
                  MIN(target_generation_id) AS min_target_generation_id,
                  MAX(target_generation_id) AS max_target_generation_id
           FROM dex_measured_execution_quotes
           WHERE generation_id = ?`,
        )
        .bind(generation.generation_id)
        .first<QuoteGenerationSummaryRow>(),
    3,
    input.signal,
  );
  const rowCount = Number(summary?.row_count ?? -1);
  if (
    rowCount < 0 ||
    (generation.expected_rows != null && generation.expected_rows !== rowCount) ||
    (generation.published_rows != null && generation.published_rows !== rowCount)
  ) {
    throw new Error(`Published ${input.label} measured quote generation ${generation.generation_id} is incomplete`);
  }
  const dependency = generation.dependency_snapshot_json
    ? (parsePersistedJson(
        generation.dependency_snapshot_json,
        `${input.label} measured dependency JSON`,
      ) as MeasuredQuoteGenerationDependency)
    : {};
  const targetGenerationId = summary?.min_target_generation_id ?? dependency.targetGenerationId;
  if (
    !targetGenerationId ||
    (rowCount > 0 && summary?.min_target_generation_id !== summary?.max_target_generation_id) ||
    (rowCount > 0 && summary?.min_target_generation_id !== targetGenerationId) ||
    dependency.targetGenerationId !== targetGenerationId
  ) {
    throw new Error(
      `Published ${input.label} measured quote generation ${generation.generation_id} has a torn target dependency`,
    );
  }
  const targetGeneration = await input.db
    .prepare(
      `SELECT generation_id, state, started_at, published_at, expected_rows, published_rows, dependency_snapshot_json
       FROM surface_publication_generations
       WHERE surface = ? AND generation_id = ? AND state IN ('published', 'superseded')`,
    )
    .bind(input.targetSurface, targetGenerationId)
    .first<SurfaceGenerationRow>();
  if (!targetGeneration) {
    throw new Error(`${input.label} measured target generation ${targetGenerationId} was not published`);
  }
  const targetCount = dependency.targetCount ?? targetGeneration.expected_rows ?? rowCount;
  const persistedOutcomeCount = dependency.persistedOutcomeCount ?? rowCount;
  const omittedBudgetDeferredCount = dependency.omittedBudgetDeferredCount ?? 0;
  const sparseTargetDigest = dependency.targetIdsSha256?.trim().toLowerCase() ?? null;
  if (
    !Number.isInteger(targetCount) || targetCount <= 0 ||
    !Number.isInteger(persistedOutcomeCount) || persistedOutcomeCount < 0 ||
    !Number.isInteger(omittedBudgetDeferredCount) || omittedBudgetDeferredCount < 0 ||
    persistedOutcomeCount !== rowCount ||
    persistedOutcomeCount + omittedBudgetDeferredCount !== targetCount ||
    (omittedBudgetDeferredCount > 0 && !/^[0-9a-f]{64}$/.test(sparseTargetDigest ?? "")) ||
    (targetGeneration.expected_rows != null && targetGeneration.expected_rows !== targetCount) ||
    (targetGeneration.published_rows != null && targetGeneration.published_rows !== targetCount)
  ) {
    throw new Error(`${input.label} measured quote generation ${generation.generation_id} has incomplete targets`);
  }

  const byTargetId = new Map<
    string,
    {
      quotedTarget: TTarget;
      status: "measured" | "failed";
      failureReason: string | null;
      profile: TProfile | null;
    }
  >();
  if (input.targetIds) {
    const allTargetResult = await runWithOverloadRetry(
      () =>
        input.db
          .prepare(
            `SELECT target_id
             FROM dex_measured_execution_targets
             WHERE generation_id = ?
             ORDER BY target_id`,
          )
          .bind(targetGenerationId)
          .all<{ target_id: string }>(),
      3,
      input.signal,
    );
    const allTargetIds = (allTargetResult.results ?? []).map((row) => row.target_id);
    const allTargetIdsSha256 = await hashMeasuredTargetIds(allTargetIds);
    if (
      allTargetIds.length !== targetCount ||
      (sparseTargetDigest != null && sparseTargetDigest !== allTargetIdsSha256)
    ) {
      throw new Error(`Published ${input.label} measured quote generation ${generation.generation_id} is incomplete`);
    }

    const available = new Set(allTargetIds);
    const selectedTargetIds = [...new Set(input.targetIds)].filter((targetId) => available.has(targetId));
    for (let offset = 0; offset < selectedTargetIds.length; offset += DEX_MEASURED_HISTORY_TARGET_BATCH_SIZE) {
      const targetIdBatch = selectedTargetIds.slice(offset, offset + DEX_MEASURED_HISTORY_TARGET_BATCH_SIZE);
      const selectedResult: { results?: SparseCurrentQuoteWithTargetRow[] } = await runWithOverloadRetry(
        () =>
          input.db
            .prepare(
              `/* JOIN dex_measured_execution_targets: selected score-facing evidence scan */
               SELECT t.target_id, t.target_json,
                      q.generation_id AS quote_generation_id, q.target_generation_id,
                      q.status, q.failure_reason, q.quote_profile_json
               FROM dex_measured_execution_targets t
               LEFT JOIN dex_measured_execution_quotes q
                 ON q.generation_id = ?
                AND q.target_generation_id = t.generation_id
                AND q.target_id = t.target_id
               WHERE t.generation_id = ?
                 AND t.target_id IN (SELECT value FROM json_each(?))
               ORDER BY t.target_id`,
            )
            .bind(generation.generation_id, targetGenerationId, JSON.stringify(targetIdBatch))
            .all<SparseCurrentQuoteWithTargetRow>(),
        3,
        input.signal,
      );
      for (const row of selectedResult.results ?? []) {
        const quotedTarget = input.targetSchema.parse(
          parsePersistedJson(row.target_json, `${input.label} measured target JSON`),
        );
        if (quotedTarget.targetId !== row.target_id) {
          throw new Error(`${input.label} measured quote ${row.target_id} has a mismatched target row`);
        }
        const quoteGenerationId = row.quote_generation_id ?? row.generation_id ?? null;
        if (quoteGenerationId == null) {
          byTargetId.set(row.target_id, {
            quotedTarget,
            status: "failed",
            failureReason: "budget-deferred",
            profile: null,
          });
          continue;
        }
        const profile = row.quote_profile_json
          ? input.profileSchema.parse(
              parsePersistedJson(row.quote_profile_json, `${input.label} measured profile JSON`),
            )
          : null;
        if (
          (row.status === "measured" &&
            (row.target_generation_id !== targetGenerationId ||
              profile == null ||
              row.failure_reason != null ||
              profile.targetId !== row.target_id ||
              profile.targetGenerationId !== targetGenerationId ||
              profile.quoteGenerationId !== generation.generation_id)) ||
          (row.status === "failed" &&
            (row.target_generation_id !== targetGenerationId || profile != null || !row.failure_reason?.trim())) ||
          row.status == null
        ) {
          throw new Error(`${input.label} measured quote row ${row.target_id} has a torn terminal identity`);
        }
        byTargetId.set(row.target_id, {
          quotedTarget,
          status: row.status,
          failureReason: row.failure_reason,
          profile,
        });
      }
    }
    if (byTargetId.size !== selectedTargetIds.length) {
      throw new Error(`Published ${input.label} measured quote generation ${generation.generation_id} is incomplete`);
    }
    return {
      quoteGenerationId: generation.generation_id,
      targetGenerationId,
      publishedAt: generation.published_at ?? generation.started_at,
      byTargetId,
    };
  }
  const targetIds: string[] = [];
  let persistedRowsSeen = 0;
  let omittedRowsSeen = 0;
  let afterTargetId = "";
  while (byTargetId.size < targetCount) {
    const pageResult = await runWithOverloadRetry(
      () =>
        input.db
          .prepare(
            `/* JOIN dex_measured_execution_targets: sparse target-first evidence scan */
             SELECT t.target_id, t.target_json,
                    q.generation_id AS quote_generation_id, q.target_generation_id,
                    q.status, q.failure_reason, q.quote_profile_json
             FROM dex_measured_execution_targets t
             LEFT JOIN dex_measured_execution_quotes q
               ON q.generation_id = ?
              AND q.target_generation_id = t.generation_id
              AND q.target_id = t.target_id
             WHERE t.generation_id = ? AND t.target_id > ?
             ORDER BY t.target_id
             LIMIT ?`,
          )
          .bind(
            generation.generation_id,
            targetGenerationId,
            afterTargetId,
            DEX_MEASURED_CURRENT_EVIDENCE_PAGE_SIZE,
          )
          .all<SparseCurrentQuoteWithTargetRow>(),
      3,
      input.signal,
    );
    const page: Array<SparseCurrentQuoteWithTargetRow | undefined> = pageResult.results ?? [];
    if (page.length === 0) break;
    for (let rowIndex = 0; rowIndex < page.length; rowIndex++) {
      const row = page[rowIndex];
      page[rowIndex] = undefined;
      if (!row) continue;
      if (row.target_id <= afterTargetId || byTargetId.has(row.target_id)) {
        throw new Error(`${input.label} measured quote evidence pagination did not advance`);
      }
      const quotedTarget = input.targetSchema.parse(
        parsePersistedJson(row.target_json, `${input.label} measured target JSON`),
      );
      if (quotedTarget.targetId !== row.target_id) {
        throw new Error(`${input.label} measured quote ${row.target_id} has a mismatched target row`);
      }
      targetIds.push(row.target_id);
      const quoteGenerationId = row.quote_generation_id ?? row.generation_id ?? null;
      if (quoteGenerationId == null) {
        omittedRowsSeen++;
        byTargetId.set(row.target_id, {
          quotedTarget,
          status: "failed",
          failureReason: "budget-deferred",
          profile: null,
        });
        afterTargetId = row.target_id;
        continue;
      }
      persistedRowsSeen++;
      const profile = row.quote_profile_json
        ? input.profileSchema.parse(
            parsePersistedJson(row.quote_profile_json, `${input.label} measured profile JSON`),
          )
        : null;
      if (
        (row.status === "measured" &&
          (row.target_generation_id !== targetGenerationId ||
            profile == null ||
            row.failure_reason != null ||
            profile.targetId !== row.target_id ||
            profile.targetGenerationId !== targetGenerationId ||
            profile.quoteGenerationId !== generation.generation_id)) ||
        (row.status === "failed" &&
          (row.target_generation_id !== targetGenerationId || profile != null || !row.failure_reason?.trim())) ||
        row.status == null
      ) {
        throw new Error(`${input.label} measured quote row ${row.target_id} has a torn terminal identity`);
      }
      byTargetId.set(row.target_id, {
        quotedTarget,
        status: row.status,
        failureReason: row.failure_reason,
        profile: input.deferProfiles ? null : profile,
        ...(input.deferProfiles && row.quote_profile_json
          ? { deferredProfileJson: row.quote_profile_json }
          : {}),
      });
      afterTargetId = row.target_id;
    }
    page.length = 0;
  }
  const targetIdsSha256 = await hashMeasuredTargetIds(targetIds);
  if (
    byTargetId.size !== targetCount ||
    persistedRowsSeen !== persistedOutcomeCount ||
    omittedRowsSeen !== omittedBudgetDeferredCount ||
    (sparseTargetDigest != null && sparseTargetDigest !== targetIdsSha256)
  ) {
    throw new Error(`Published ${input.label} measured quote generation ${generation.generation_id} is incomplete`);
  }
  return {
    quoteGenerationId: generation.generation_id,
    targetGenerationId,
    publishedAt: generation.published_at ?? generation.started_at,
    byTargetId,
  };
}

async function markGenerationFailed(db: D1Database, surface: string, id: string, reason: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE surface_publication_generations
       SET state = 'failed', failure_reason = ?
       WHERE surface = ? AND generation_id = ? AND state IN ('candidate', 'validated')`,
      )
      .bind(reason.slice(0, 500), surface, id)
      .run();
  } catch {
    // The original publication error remains authoritative.
  }
}

async function publishGenerationPointer(input: {
  db: D1Database;
  surface: string;
  generationId: string;
  previousGenerationId: string | null;
  nowSec: number;
  rowCount: number;
  validationSummary: unknown;
  signal?: AbortSignal;
}): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  const previousGuard =
    input.previousGenerationId == null
      ? ""
      : ` AND EXISTS (
          SELECT 1 FROM surface_publication_generations
          WHERE surface = ? AND generation_id = ? AND state = 'published'
        )`;
  statements.push(
    input.db
      .prepare(
        `UPDATE surface_publication_generations
     SET state = 'published', validated_at = ?, published_at = ?, published_rows = ?, validation_summary_json = ?
     WHERE surface = ? AND generation_id = ? AND state = 'candidate'${previousGuard}`,
      )
      .bind(
        input.nowSec,
        input.nowSec,
        input.rowCount,
        JSON.stringify(input.validationSummary),
        input.surface,
        input.generationId,
        ...(input.previousGenerationId == null ? [] : [input.surface, input.previousGenerationId]),
      ),
  );
  if (input.previousGenerationId != null) {
    statements.push(
      input.db
        .prepare(
          `UPDATE surface_publication_generations
       SET state = 'superseded'
       WHERE surface = ? AND generation_id = ? AND state = 'published'
         AND EXISTS (
           SELECT 1 FROM surface_publication_generations
           WHERE surface = ? AND generation_id = ? AND state = 'published'
         )`,
        )
        .bind(input.surface, input.previousGenerationId, input.surface, input.generationId),
    );
  }
  const changes = await executeAtomicBatch(input.db, statements, { signal: input.signal });
  const expectedChanges = input.previousGenerationId == null ? 1 : 2;
  if (changes !== expectedChanges) {
    throw new Error(`Publication pointer update failed for ${input.surface}/${input.generationId}`);
  }
}

export async function publishDexMeasuredTargetInventory(input: {
  db: D1Database;
  targets: readonly DexMeasuredExecutionTarget[];
  capturedAt: number;
  signal?: AbortSignal;
}): Promise<{ generationId: string; rowCount: number }> {
  return publishNativeMeasuredTargetInventory(DEX_PERSISTENCE, input);
}

export async function loadLatestPublishedDexMeasuredTargets(
  db: D1Database,
  signal?: AbortSignal,
): Promise<PublishedDexMeasuredTargets | null> {
  return loadLatestPublishedNativeMeasuredTargets(DEX_PERSISTENCE, db, signal);
}

export async function publishDexShadowMeasuredTargetInventory(input: {
  db: D1Database;
  targets: readonly DexMeasuredExecutionTarget[];
  capturedAt: number;
  signal?: AbortSignal;
}): Promise<{ generationId: string; rowCount: number }> {
  return publishNativeMeasuredTargetInventory(DEX_SHADOW_PERSISTENCE, input);
}

export async function loadLatestPublishedDexShadowMeasuredTargets(
  db: D1Database,
  signal?: AbortSignal,
): Promise<PublishedDexMeasuredTargets | null> {
  return loadLatestPublishedNativeMeasuredTargets(DEX_SHADOW_PERSISTENCE, db, signal);
}

export async function publishDexMeasuredQuoteGeneration(input: {
  db: D1Database;
  targetGeneration: PublishedDexMeasuredTargets;
  outcomes: readonly DexMeasuredQuoteOutcome[];
  quotedAt: number;
  generationId?: string;
  signal?: AbortSignal;
}): Promise<{ generationId: string; measuredCount: number; failedCount: number }> {
  return publishNativeMeasuredQuoteGeneration(DEX_PERSISTENCE, input);
}

export async function publishDexShadowMeasuredQuoteGeneration(input: {
  db: D1Database;
  targetGeneration: PublishedDexMeasuredTargets;
  outcomes: readonly DexMeasuredQuoteOutcome[];
  quotedAt: number;
  generationId?: string;
  signal?: AbortSignal;
}): Promise<{ generationId: string; measuredCount: number; failedCount: number }> {
  return publishNativeMeasuredQuoteGeneration(DEX_SHADOW_PERSISTENCE, input);
}

export async function loadLatestPublishedDexMeasuredQuoteEvidence(
  db: D1Database,
  signal?: AbortSignal,
  options: { deferProfiles?: boolean } = {},
): Promise<LoadedDexMeasuredQuoteEvidence | null> {
  const currentEvidence = await loadCurrentMeasuredQuoteEvidence({
    db,
    quoteSurface: DEX_MEASURED_QUOTE_SURFACE,
    targetSurface: DEX_MEASURED_TARGET_SURFACE,
    label: "DEX",
    targetSchema: DexMeasuredExecutionTargetSchema,
    profileSchema: DexMeasuredExecutionProfileSchema,
    deferProfiles: options.deferProfiles,
    signal,
  });
  if (!currentEvidence) return null;
  const {
    quoteGenerationId,
    targetGenerationId,
    publishedAt: latestPublishedAt,
  } = currentEvidence;
  const byTargetId = new Map<
    string,
    LoadedDexMeasuredQuoteEvidence["byTargetId"] extends Map<string, infer T> ? T : never
  >();
  const historyCyclesByTargetId = new Map<string, DexMeasuredExecutionHistoryCycle[]>();
  const currentProfileJsonByTargetId = new Map<string, string>();
  const historyFinalizedTargetIds = new Set<string>();
  for (const [targetId, current] of currentEvidence.byTargetId) {
    const entry = {
      ...current,
      quoteGenerationId,
      targetGenerationId,
      resolution: "latest",
      latestFailureReason: current.failureReason,
    } as const;
    byTargetId.set(targetId, entry);
    if (current.deferredProfileJson) {
      currentProfileJsonByTargetId.set(targetId, current.deferredProfileJson);
    }
    historyCyclesByTargetId.set(targetId, [
      {
        generationId: quoteGenerationId,
        publishedAt: latestPublishedAt,
        status: current.status,
        operationalFailure:
          current.status === "failed" && isOperationalDexMeasuredFailure(current.failureReason),
        profile: current.profile,
      },
    ]);
  }
  currentEvidence.byTargetId.clear();
  const populateCurrentHistoryProfile = (targetId: string) => {
    const profileJson = currentProfileJsonByTargetId.get(targetId);
    if (!profileJson) return;
    const cycles = historyCyclesByTargetId.get(targetId);
    const currentCycle = cycles?.find((cycle) => cycle.generationId === quoteGenerationId);
    if (currentCycle?.status === "measured" && currentCycle.profile === null) {
      currentCycle.profile = DexMeasuredExecutionProfileSchema.parse(
        parsePersistedJson(profileJson, "DEX measured deferred history profile JSON"),
      );
    }
    currentProfileJsonByTargetId.delete(targetId);
  };

  // A transport or runtime-budget failure says nothing about executable depth.
  // Reuse the newest still-fresh measured row for that exact target identity;
  // consumer validation below retains the original quote clock and snapshot.
  try {
    const historyGenerationIds = await loadSupersededQuoteGenerationIds({
      db,
      quoteSurface: DEX_MEASURED_QUOTE_SURFACE,
      publishedAtFloor: latestPublishedAt - DEX_MEASURED_HISTORY_LOOKBACK_MAX_SEC,
      signal,
    });
    if (historyGenerationIds.length > 0) {
      const historyGenerationIdsJson = JSON.stringify(historyGenerationIds);
      const historicalTargetResult = await runWithOverloadRetry(
        () =>
          db
            .prepare(
              `SELECT DISTINCT target_id
         FROM dex_measured_execution_quotes
         WHERE generation_id IN (SELECT value FROM json_each(?))
         ORDER BY target_id`,
            )
            .bind(historyGenerationIdsJson)
            .all<{ target_id: string }>(),
        3,
        signal,
      );
      const historicalTargetIds = (historicalTargetResult.results ?? []).map((row) => row.target_id);
      for (let offset = 0; offset < historicalTargetIds.length; offset += DEX_MEASURED_HISTORY_TARGET_BATCH_SIZE) {
        const targetIdBatch = historicalTargetIds.slice(offset, offset + DEX_MEASURED_HISTORY_TARGET_BATCH_SIZE);
        const lkgBlockedTargetIds = new Set<string>();
        const historicalResult = await runWithOverloadRetry(
          () =>
            db
              .prepare(
                `SELECT q.generation_id, q.target_generation_id, q.target_id, q.status, q.failure_reason,
                  q.quote_profile_json, g.published_at AS quote_published_at, t.target_json
           FROM dex_measured_execution_quotes q
           JOIN surface_publication_generations g ON g.surface = ? AND g.generation_id = q.generation_id
           JOIN dex_measured_execution_targets t
             ON t.generation_id = q.target_generation_id AND t.target_id = q.target_id
           WHERE q.generation_id IN (SELECT value FROM json_each(?))
             AND q.target_id IN (SELECT value FROM json_each(?))
           ORDER BY q.target_id, g.published_at DESC, q.generation_id DESC`,
              )
              .bind(
                DEX_MEASURED_QUOTE_SURFACE,
                historyGenerationIdsJson,
                JSON.stringify(targetIdBatch),
              )
              .all<HistoricalQuoteRow>(),
          3,
          signal,
        );
        const historicalRows: Array<HistoricalQuoteRow | undefined> = historicalResult.results ?? [];
        for (let rowIndex = 0; rowIndex < historicalRows.length; rowIndex++) {
          const row = historicalRows[rowIndex];
          historicalRows[rowIndex] = undefined;
          if (!row) continue;
          const currentTarget = byTargetId.get(row.target_id)?.quotedTarget;
          if (
            currentTarget &&
            latestPublishedAt - row.quote_published_at >
              getDexMeasuredHistoryFreshnessSec(currentTarget.adapterProfileId)
          ) {
            continue;
          }
          const recordCycle = (cycle: DexMeasuredExecutionHistoryCycle) => {
            const cycles = historyCyclesByTargetId.get(row.target_id) ?? [];
            cycles.push(cycle);
            historyCyclesByTargetId.set(row.target_id, cycles);
          };
          const recordIntegrityBarrier = () => {
            recordCycle({
              generationId: row.generation_id,
              publishedAt: row.quote_published_at,
              status: "failed",
              operationalFailure: false,
              profile: null,
            });
            lkgBlockedTargetIds.add(row.target_id);
          };
          const targetJson = parseJson(row.target_json, { onFailure: () => undefined });
          const profileJson = row.quote_profile_json
            ? parseJson(row.quote_profile_json, { onFailure: () => undefined })
            : null;
          if (!targetJson.ok || (row.quote_profile_json != null && !profileJson?.ok)) {
            recordIntegrityBarrier();
            continue;
          }
          const targetResult = DexMeasuredExecutionTargetSchema.safeParse(targetJson.value);
          const profileResult = profileJson?.ok
            ? DexMeasuredExecutionProfileSchema.safeParse(profileJson.value)
            : null;
          const profile = profileResult?.success ? profileResult.data : null;
          const quotedTarget = targetResult.success ? targetResult.data : null;
          if (quotedTarget === null || !isCoherentHistoricalQuoteRow(row, quotedTarget, profile)) {
            recordIntegrityBarrier();
            continue;
          }
          recordCycle({
            generationId: row.generation_id,
            publishedAt: row.quote_published_at,
            status: row.status,
            operationalFailure: row.status === "failed" && isOperationalDexMeasuredFailure(row.failure_reason),
            profile,
          });
          if (row.status === "failed" && !isOperationalDexMeasuredFailure(row.failure_reason)) {
            lkgBlockedTargetIds.add(row.target_id);
          }

          const latest = byTargetId.get(row.target_id);
          if (
            row.status !== "measured" ||
            profile === null ||
            lkgBlockedTargetIds.has(row.target_id) ||
            latest?.resolution === "last-known-good" ||
            (latest != null && (latest.status === "measured" || !isOperationalDexMeasuredFailure(latest.failureReason)))
          ) {
            continue;
          }
          byTargetId.set(row.target_id, {
            quotedTarget,
            status: "measured",
            failureReason: null,
            profile: options.deferProfiles ? null : profile,
            ...(options.deferProfiles && row.quote_profile_json
              ? { deferredProfileJson: row.quote_profile_json }
              : {}),
            quoteGenerationId: row.generation_id,
            targetGenerationId: row.target_generation_id,
            resolution: "last-known-good",
            latestFailureReason: latest?.failureReason ?? "quote-missing",
          });
        }
        historicalRows.length = 0;
        for (const targetId of targetIdBatch) {
          populateCurrentHistoryProfile(targetId);
          const entry = byTargetId.get(targetId);
          const profile = entry ? materializeDexMeasuredQuoteProfile(entry) : null;
          if (entry?.status === "measured" && profile !== null) {
            const observationHistory = summarizeDexMeasuredExecutionHistory({
              cycles: historyCyclesByTargetId.get(targetId) ?? [],
              nowSec: latestPublishedAt,
              freshnessMaxSec: getDexMeasuredHistoryFreshnessSec(profile.adapterProfileId),
            });
            if (observationHistory) {
              byTargetId.set(targetId, { ...entry, observationHistory });
            }
          }
          historyCyclesByTargetId.delete(targetId);
          historyFinalizedTargetIds.add(targetId);
        }
      }
    }
  } catch {
    // Current-generation evidence remains usable if the optional LKG read fails.
  }

  for (const [targetId, entry] of byTargetId) {
    if (historyFinalizedTargetIds.has(targetId)) continue;
    populateCurrentHistoryProfile(targetId);
    const profile = materializeDexMeasuredQuoteProfile(entry);
    if (entry.status !== "measured" || profile === null) {
      historyCyclesByTargetId.delete(targetId);
      continue;
    }
    const observationHistory = summarizeDexMeasuredExecutionHistory({
      cycles: historyCyclesByTargetId.get(targetId) ?? [],
      nowSec: latestPublishedAt,
      freshnessMaxSec: getDexMeasuredHistoryFreshnessSec(profile.adapterProfileId),
    });
    if (observationHistory) {
      byTargetId.set(targetId, { ...entry, observationHistory });
    }
    historyCyclesByTargetId.delete(targetId);
  }

  return {
    quoteGenerationId,
    targetGenerationId,
    publishedAt: latestPublishedAt,
    byTargetId,
  };
}

interface NativeMeasuredTarget {
  targetId: string;
  stablecoinId: string;
  adapterProfileId: string;
  protocol: string;
  chain: string;
  poolId: string;
  capturedAt: number;
}

interface NativeMeasuredProfile {
  targetId: string;
  targetGenerationId: string;
  quoteGenerationId: string;
  quotedAt: number;
}

interface NativePersistenceConfig<TTarget extends NativeMeasuredTarget, TProfile extends NativeMeasuredProfile> {
  label: string;
  activation: "active" | "shadow" | "target-ratified";
  targetSurface: string;
  quoteSurface: string;
  targetGenerationPrefix: string;
  quoteGenerationPrefix: string;
  targetSchema: { parse(value: unknown): TTarget };
  profileSchema: { parse(value: unknown): TProfile };
  profileBlockNumber(profile: TProfile): number;
  targetProducer: { scheduleKey: string; job: string; path: string };
  quoteProducer: { scheduleKey: string; job: string; path: string };
}

interface NativePublishedTargets<TTarget> {
  generationId: string;
  targets: TTarget[];
  publishedAt: number;
}

interface NativeQuoteOutcome<TTarget, TProfile> {
  target: TTarget;
  status: "measured" | "failed";
  failureReason?: string;
  profile?: TProfile;
  rawPayload?: unknown;
}

const DEX_PERSISTENCE: NativePersistenceConfig<DexMeasuredExecutionTarget, DexMeasuredExecutionProfile> = {
  label: "DEX",
  activation: "active",
  targetSurface: DEX_MEASURED_TARGET_SURFACE,
  quoteSurface: DEX_MEASURED_QUOTE_SURFACE,
  targetGenerationPrefix: "dex-measured-targets",
  quoteGenerationPrefix: "dex-measured-quotes",
  targetSchema: DexMeasuredExecutionTargetSchema,
  profileSchema: DexMeasuredExecutionProfileSchema,
  profileBlockNumber: (profile) => profile.blockNumber,
  targetProducer: { scheduleKey: "halfHourlyChartsOffset", job: "sync-dex-liquidity", path: "halfHourlyChartsOffset" },
  quoteProducer: { scheduleKey: "halfHourlyMeasuredExecution", job: "sync-cl-exit-depth", path: "halfHourlyMeasuredExecution" },
};

const DEX_SHADOW_PERSISTENCE: NativePersistenceConfig<DexMeasuredExecutionTarget, DexMeasuredExecutionProfile> = {
  label: "DEX shadow",
  activation: "shadow",
  targetSurface: DEX_SHADOW_MEASURED_TARGET_SURFACE,
  quoteSurface: DEX_SHADOW_MEASURED_QUOTE_SURFACE,
  targetGenerationPrefix: "dex-shadow-measured-targets",
  quoteGenerationPrefix: "dex-shadow-measured-quotes",
  targetSchema: DexMeasuredExecutionTargetSchema,
  profileSchema: DexMeasuredExecutionProfileSchema,
  profileBlockNumber: (profile) => profile.blockNumber,
  targetProducer: { scheduleKey: "halfHourlyChartsOffset", job: "sync-dex-liquidity", path: "halfHourlyChartsOffset" },
  quoteProducer: { scheduleKey: "daily0810Utc", job: "sync-cl-exit-depth", path: "daily0810Utc" },
};

async function publishNativeMeasuredTargetInventory<
  TTarget extends NativeMeasuredTarget,
  TProfile extends NativeMeasuredProfile,
>(
  config: NativePersistenceConfig<TTarget, TProfile>,
  input: {
    db: D1Database;
    targets: readonly TTarget[];
    capturedAt: number;
    signal?: AbortSignal;
  },
): Promise<{ generationId: string; rowCount: number }> {
  const targets = input.targets.map((target) => config.targetSchema.parse(target));
  if (targets.length === 0) {
    throw new Error(`Refusing to publish an empty ${config.label} measured target generation`);
  }
  if (new Set(targets.map((target) => target.targetId)).size !== targets.length) {
    throw new Error(`${config.label} measured target inventory contains duplicate target ids`);
  }
  const previous = await latestPublishedGeneration(input.db, config.targetSurface, input.signal);
  const id = generationId(config.targetGenerationPrefix, input.capturedAt);
  try {
    await runWithOverloadRetry(
      () =>
        input.db
          .prepare(
            `INSERT INTO surface_publication_generations
       (surface, generation_id, started_at, state, expected_rows, previous_generation_id,
        producer_schedule_key, producer_job, producer_path, producer_kind)
       VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?, ?, 'scheduled-job')`,
          )
          .bind(
            config.targetSurface,
            id,
            input.capturedAt,
            targets.length,
            previous?.generation_id ?? null,
            config.targetProducer.scheduleKey,
            config.targetProducer.job,
            config.targetProducer.path,
          )
          .run(),
      3,
      input.signal,
    );
    const rows = targets.map(
      (target) =>
        [
          id,
          target.targetId,
          target.stablecoinId,
          target.adapterProfileId,
          target.protocol,
          target.chain,
          target.poolId,
          target.capturedAt,
          JSON.stringify(target),
        ] as const,
    );
    await batchExecute(
      input.db,
      prepareMultiRowInsertStatements(
        input.db,
        `INSERT INTO dex_measured_execution_targets
       (generation_id, target_id, stablecoin_id, adapter_profile_id, protocol, chain, pool_id, captured_at, target_json)`,
        rows,
      ),
      { signal: input.signal },
    );
    const count = await input.db
      .prepare("SELECT COUNT(*) AS count FROM dex_measured_execution_targets WHERE generation_id = ?")
      .bind(id)
      .first<{ count: number }>();
    if (Number(count?.count ?? -1) !== targets.length) {
      throw new Error(
        `${config.label} measured target generation row mismatch: expected=${targets.length} actual=${count?.count ?? -1}`,
      );
    }
    await publishGenerationPointer({
      db: input.db,
      surface: config.targetSurface,
      generationId: id,
      previousGenerationId: previous?.generation_id ?? null,
      nowSec: input.capturedAt,
      rowCount: targets.length,
      validationSummary: { exactTargetCount: targets.length, activation: config.activation },
      signal: input.signal,
    });
    return { generationId: id, rowCount: targets.length };
  } catch (error) {
    await markGenerationFailed(input.db, config.targetSurface, id, String(error));
    throw error;
  }
}

async function loadLatestPublishedNativeMeasuredTargets<
  TTarget extends NativeMeasuredTarget,
  TProfile extends NativeMeasuredProfile,
>(
  config: NativePersistenceConfig<TTarget, TProfile>,
  db: D1Database,
  signal?: AbortSignal,
): Promise<NativePublishedTargets<TTarget> | null> {
  const generation = await latestPublishedGeneration(db, config.targetSurface, signal);
  if (!generation) return null;
  const result = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT generation_id, target_id, target_json
       FROM dex_measured_execution_targets
       WHERE generation_id = ?
       ORDER BY stablecoin_id, target_id`,
        )
        .bind(generation.generation_id)
        .all<TargetRow>(),
    3,
    signal,
  );
  const targets = (result.results ?? []).map((row) =>
    config.targetSchema.parse(parsePersistedJson(row.target_json, `${config.label} measured target JSON`)),
  );
  if (
    (generation.expected_rows != null && generation.expected_rows !== targets.length) ||
    (generation.published_rows != null && generation.published_rows !== targets.length)
  ) {
    throw new Error(`Published ${config.label} measured target generation ${generation.generation_id} is incomplete`);
  }
  return {
    generationId: generation.generation_id,
    targets,
    publishedAt: generation.published_at ?? generation.started_at,
  };
}

async function publishNativeMeasuredQuoteGeneration<
  TTarget extends NativeMeasuredTarget,
  TProfile extends NativeMeasuredProfile,
>(
  config: NativePersistenceConfig<TTarget, TProfile>,
  input: {
    db: D1Database;
    targetGeneration: NativePublishedTargets<TTarget>;
    outcomes: readonly NativeQuoteOutcome<TTarget, TProfile>[];
    quotedAt: number;
    generationId?: string;
    signal?: AbortSignal;
  },
): Promise<{ generationId: string; measuredCount: number; failedCount: number }> {
  if (input.targetGeneration.targets.length === 0 || input.outcomes.length === 0) {
    throw new Error(`Refusing to publish an empty ${config.label} measured quote generation`);
  }
  const targetIds = new Set(input.targetGeneration.targets.map((target) => target.targetId));
  const outcomeIds = new Set(input.outcomes.map((outcome) => outcome.target.targetId));
  if (
    outcomeIds.size !== input.outcomes.length ||
    targetIds.size !== outcomeIds.size ||
    [...targetIds].some((targetId) => !outcomeIds.has(targetId))
  ) {
    throw new Error(`${config.label} measured quote outcomes do not exactly cover the target generation`);
  }

  const previous = await latestPublishedGeneration(input.db, config.quoteSurface, input.signal);
  const id = input.generationId ?? generationId(config.quoteGenerationPrefix, input.quotedAt);
  const measuredCount = input.outcomes.filter((outcome) => outcome.status === "measured").length;
  const failedCount = input.outcomes.length - measuredCount;
  const parsedOutcomes = input.outcomes.map((outcome) => {
    if (
      (outcome.status === "measured" && (!outcome.profile || outcome.failureReason != null)) ||
      (outcome.status === "failed" && (outcome.profile != null || !outcome.failureReason?.trim()))
    ) {
      throw new Error(
        `${config.label} measured quote outcome ${outcome.target.targetId} has an invalid terminal state`,
      );
    }
    const profile = outcome.profile ? config.profileSchema.parse(outcome.profile) : null;
    if (
      profile &&
      (profile.targetId !== outcome.target.targetId ||
        profile.targetGenerationId !== input.targetGeneration.generationId ||
        profile.quoteGenerationId !== id)
    ) {
      throw new Error(
        `${config.label} measured quote outcome ${outcome.target.targetId} has mismatched generation identity`,
      );
    }
    return { outcome, profile };
  });
  const persistedOutcomes = parsedOutcomes.filter(
    ({ outcome }) => !(outcome.status === "failed" && outcome.failureReason === "budget-deferred"),
  );
  const omittedBudgetDeferredCount = parsedOutcomes.length - persistedOutcomes.length;
  const targetIdsSha256 = await hashMeasuredTargetIds(input.targetGeneration.targets.map((target) => target.targetId));
  const dependencyManifest: MeasuredQuoteGenerationDependency = {
    targetGenerationId: input.targetGeneration.generationId,
    targetCount: input.targetGeneration.targets.length,
    persistedOutcomeCount: persistedOutcomes.length,
    omittedBudgetDeferredCount,
    targetIdsSha256,
  };
  try {
    await runWithOverloadRetry(
      () =>
        input.db
          .prepare(
            `INSERT INTO surface_publication_generations
       (surface, generation_id, started_at, state, expected_rows, previous_generation_id,
        dependency_snapshot_json, producer_schedule_key, producer_job, producer_path, producer_kind)
       VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, 'scheduled-job')`,
          )
          .bind(
            config.quoteSurface,
            id,
            input.quotedAt,
            persistedOutcomes.length,
            previous?.generation_id ?? null,
            JSON.stringify(dependencyManifest),
            config.quoteProducer.scheduleKey,
            config.quoteProducer.job,
            config.quoteProducer.path,
          )
          .run(),
      3,
      input.signal,
    );
    const rows = persistedOutcomes.map(({ outcome, profile }) => {
      return [
        id,
        input.targetGeneration.generationId,
        outcome.target.targetId,
        outcome.target.stablecoinId,
        outcome.target.adapterProfileId,
        outcome.target.protocol,
        outcome.target.chain,
        outcome.target.poolId,
        outcome.status,
        outcome.failureReason ?? null,
        profile?.quotedAt ?? null,
        profile ? config.profileBlockNumber(profile) : null,
        profile ? JSON.stringify(profile) : null,
        // Raw producer envelopes duplicate the measured profile's quoteProof; persist them
        // only for failed outcomes, where they are the sole structured failure evidence.
        outcome.status === "failed" && outcome.rawPayload != null ? JSON.stringify(outcome.rawPayload) : null,
      ] as const;
    });
    if (rows.length > 0) {
      await batchExecute(
        input.db,
        prepareMultiRowInsertStatements(
          input.db,
          `INSERT INTO dex_measured_execution_quotes
       (generation_id, target_generation_id, target_id, stablecoin_id, adapter_profile_id, protocol, chain,
        pool_id, status, failure_reason, quoted_at, block_number, quote_profile_json, raw_quote_payload_json)`,
          rows,
        ),
        { signal: input.signal },
      );
    }
    const count = await input.db
      .prepare("SELECT COUNT(*) AS count FROM dex_measured_execution_quotes WHERE generation_id = ?")
      .bind(id)
      .first<{ count: number }>();
    if (Number(count?.count ?? -1) !== persistedOutcomes.length) {
      throw new Error(
        `${config.label} measured quote generation row mismatch: expected=${persistedOutcomes.length} actual=${count?.count ?? -1}`,
      );
    }
    await publishGenerationPointer({
      db: input.db,
      surface: config.quoteSurface,
      generationId: id,
      previousGenerationId: previous?.generation_id ?? null,
      nowSec: input.quotedAt,
      rowCount: persistedOutcomes.length,
      validationSummary: {
        measuredCount,
        failedCount,
        persistedOutcomeCount: persistedOutcomes.length,
        omittedBudgetDeferredCount,
        targetGenerationId: input.targetGeneration.generationId,
        activation: config.activation,
      },
      signal: input.signal,
    });
    return { generationId: id, measuredCount, failedCount };
  } catch (error) {
    await markGenerationFailed(input.db, config.quoteSurface, id, String(error));
    throw error;
  }
}

export interface DexMeasuredExecutionRetentionResult {
  cutoff: number;
  deletedRows: number;
  deletedQuoteRows: number;
  deletedTargetRows: number;
  deletedGenerationRows: number;
  oldestRemainingAt: number | null;
  durationMs: number;
  error: string | null;
}

export async function pruneDexMeasuredExecutionGenerations(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<DexMeasuredExecutionRetentionResult> {
  const startedAtMs = Date.now();
  const cutoff = nowSec - GENERATION_RETENTION_SEC;
  const result: DexMeasuredExecutionRetentionResult = {
    cutoff,
    deletedRows: 0,
    deletedQuoteRows: 0,
    deletedTargetRows: 0,
    deletedGenerationRows: 0,
    oldestRemainingAt: null,
    durationMs: 0,
    error: null,
  };
  try {
    const quotes = await runWithOverloadRetry(
      () => db
        .prepare(
          `DELETE FROM dex_measured_execution_quotes
       WHERE generation_id IN (
         SELECT generation_id FROM surface_publication_generations
         WHERE surface IN (?, ?) AND state IN ('failed', 'rejected', 'superseded') AND started_at < ?
         ORDER BY started_at ASC LIMIT ?
       )`,
        )
        .bind(
          DEX_MEASURED_QUOTE_SURFACE,
          DEX_SHADOW_MEASURED_QUOTE_SURFACE,
          cutoff,
          GENERATION_PRUNE_MAX_PER_RUN,
        )
        .run(),
      3,
      signal,
    );
    result.deletedQuoteRows = Number(quotes.meta?.changes ?? 0);

    const targets = await runWithOverloadRetry(
      () => db
        .prepare(
          `DELETE FROM dex_measured_execution_targets
       WHERE generation_id IN (
         SELECT generation_id FROM surface_publication_generations
         WHERE surface IN (?, ?) AND state IN ('failed', 'rejected', 'superseded') AND started_at < ?
         ORDER BY started_at ASC LIMIT ?
       )
       AND generation_id NOT IN (SELECT DISTINCT target_generation_id FROM dex_measured_execution_quotes)`,
        )
        .bind(
          DEX_MEASURED_TARGET_SURFACE,
          DEX_SHADOW_MEASURED_TARGET_SURFACE,
          cutoff,
          GENERATION_PRUNE_MAX_PER_RUN,
        )
        .run(),
      3,
      signal,
    );
    result.deletedTargetRows = Number(targets.meta?.changes ?? 0);

    const generations = await runWithOverloadRetry(
      () => db
        .prepare(
          `DELETE FROM surface_publication_generations
       WHERE rowid IN (
         SELECT candidate.rowid
           FROM surface_publication_generations candidate
          WHERE candidate.surface IN (?, ?, ?, ?)
            AND candidate.state IN ('failed', 'rejected', 'superseded')
            AND candidate.started_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM dex_measured_execution_quotes q
               WHERE q.generation_id = candidate.generation_id
                  OR q.target_generation_id = candidate.generation_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM dex_measured_execution_targets t
               WHERE t.generation_id = candidate.generation_id
            )
          ORDER BY candidate.started_at ASC, candidate.generation_id ASC
          LIMIT ?
       )`,
        )
        .bind(
          DEX_MEASURED_TARGET_SURFACE,
          DEX_MEASURED_QUOTE_SURFACE,
          DEX_SHADOW_MEASURED_TARGET_SURFACE,
          DEX_SHADOW_MEASURED_QUOTE_SURFACE,
          cutoff,
          GENERATION_PRUNE_MAX_PER_RUN,
        )
        .run(),
      3,
      signal,
    );
    result.deletedGenerationRows = Number(generations.meta?.changes ?? 0);

    const oldest = await runWithOverloadRetry(
      () => db
        .prepare(
          `SELECT MIN(candidate.started_at) AS oldest_remaining_at
             FROM surface_publication_generations candidate
            WHERE candidate.surface IN (?, ?, ?, ?)
              AND (
                EXISTS (
                  SELECT 1 FROM dex_measured_execution_quotes q
                   WHERE q.generation_id = candidate.generation_id
                      OR q.target_generation_id = candidate.generation_id
                )
                OR EXISTS (
                  SELECT 1 FROM dex_measured_execution_targets t
                   WHERE t.generation_id = candidate.generation_id
                )
              )`,
        )
        .bind(
          DEX_MEASURED_TARGET_SURFACE,
          DEX_MEASURED_QUOTE_SURFACE,
          DEX_SHADOW_MEASURED_TARGET_SURFACE,
          DEX_SHADOW_MEASURED_QUOTE_SURFACE,
        )
        .first<{ oldest_remaining_at: number | null }>(),
      3,
      signal,
    );
    result.oldestRemainingAt = oldest?.oldest_remaining_at ?? null;
  } catch (error) {
    rethrowIfAborted(error, signal);
    result.error = toErrorMessage(error).slice(0, 500);
  }
  result.deletedRows =
    result.deletedQuoteRows + result.deletedTargetRows + result.deletedGenerationRows;
  result.durationMs = Math.max(0, Date.now() - startedAtMs);
  return result;
}
