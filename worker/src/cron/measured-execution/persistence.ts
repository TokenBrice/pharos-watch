import {
  DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC,
  getDexMeasuredExecutionFreshnessMaxSec,
  DexMeasuredExecutionProfileSchema,
  DexMeasuredExecutionTargetSchema,
  type DexMeasuredExecutionObservationHistory,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import {
  SolanaMeasuredExecutionProfileSchema,
  SolanaMeasuredExecutionTargetSchema,
  type SolanaMeasuredExecutionProfile,
  type SolanaMeasuredExecutionTarget,
} from "@shared/types/solana-measured-execution";
import {
  TronMeasuredExecutionProfileSchema,
  TronMeasuredExecutionTargetSchema,
  type TronMeasuredExecutionProfile,
  type TronMeasuredExecutionTarget,
} from "@shared/types/tron-measured-execution";
import { batchExecute, executeAtomicBatch, prepareMultiRowInsertStatements } from "../../lib/db";
import { runWithOverloadRetry } from "../../lib/cron-lease";
import { parseJson } from "../../lib/json-parse";
import {
  summarizeDexMeasuredExecutionHistory,
  type DexMeasuredExecutionHistoryCycle,
} from "./history";

const DEX_MEASURED_TARGET_SURFACE = "dex-measured-execution-targets";
const DEX_MEASURED_QUOTE_SURFACE = "dex-measured-execution-quotes";
/** Superseded generations remain available for bounded history and operator forensics. */
const GENERATION_RETENTION_SEC = 3 * 24 * 60 * 60;
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

interface CurrentQuoteWithTargetRow extends QuoteRow {
  target_json: string;
}

interface QuoteGenerationSummaryRow {
  row_count: number;
  min_target_generation_id: string | null;
  max_target_generation_id: string | null;
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
  "quote-call-budget-exhausted",
  "quoter-rpc-unavailable",
  "registry-code-unavailable",
  "request-budget-exhausted",
  "rpc-failure",
  "runtime-code-unavailable",
  "runtime-deadline-exceeded",
]);

export function isOperationalDexMeasuredFailure(reason: string | null | undefined): boolean {
  return reason != null && OPERATIONAL_DEX_MEASURED_FAILURE_REASONS.has(reason);
}

function generationId(prefix: string, nowSec: number): string {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${prefix}-${nowSec}-${nonce}`;
}

export function buildDexMeasuredQuoteGenerationId(nowSec: number): string {
  return generationId("dex-measured-quotes", nowSec);
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
      ) as { targetGenerationId?: string })
    : {};
  const targetGenerationId = summary?.min_target_generation_id ?? dependency.targetGenerationId;
  if (
    !targetGenerationId ||
    summary?.min_target_generation_id !== summary?.max_target_generation_id ||
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
  if (
    (targetGeneration.expected_rows != null && targetGeneration.expected_rows !== rowCount) ||
    (targetGeneration.published_rows != null && targetGeneration.published_rows !== rowCount)
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
  let afterTargetId = "";
  while (byTargetId.size < rowCount) {
    const pageResult = await runWithOverloadRetry(
      () =>
        input.db
          .prepare(
            `SELECT q.generation_id, q.target_generation_id, q.target_id, q.status, q.failure_reason,
                    q.quote_profile_json, t.target_json
             FROM dex_measured_execution_quotes q
             JOIN dex_measured_execution_targets t
               ON t.generation_id = q.target_generation_id AND t.target_id = q.target_id
             WHERE q.generation_id = ? AND q.target_generation_id = ? AND q.target_id > ?
             ORDER BY q.target_id
             LIMIT ?`,
          )
          .bind(
            generation.generation_id,
            targetGenerationId,
            afterTargetId,
            DEX_MEASURED_CURRENT_EVIDENCE_PAGE_SIZE,
          )
          .all<CurrentQuoteWithTargetRow>(),
      3,
      input.signal,
    );
    const page: Array<CurrentQuoteWithTargetRow | undefined> = pageResult.results ?? [];
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
      const profile = row.quote_profile_json
        ? input.profileSchema.parse(
            parsePersistedJson(row.quote_profile_json, `${input.label} measured profile JSON`),
          )
        : null;
      if (
        (row.status === "measured" &&
          (profile == null ||
            row.failure_reason != null ||
            profile.targetId !== row.target_id ||
            profile.targetGenerationId !== targetGenerationId ||
            profile.quoteGenerationId !== generation.generation_id)) ||
        (row.status === "failed" && (profile != null || !row.failure_reason?.trim()))
      ) {
        throw new Error(`${input.label} measured quote row ${row.target_id} has a torn terminal identity`);
      }
      byTargetId.set(row.target_id, {
        quotedTarget,
        status: row.status,
        failureReason: row.failure_reason,
        profile,
      });
      afterTargetId = row.target_id;
    }
    page.length = 0;
  }
  if (byTargetId.size !== rowCount) {
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
  const parsedTargets = input.targets.map((target) => DexMeasuredExecutionTargetSchema.parse(target));
  if (parsedTargets.length === 0) {
    throw new Error("Refusing to publish an empty measured target generation");
  }
  const targetIds = new Set(parsedTargets.map((target) => target.targetId));
  if (targetIds.size !== parsedTargets.length)
    throw new Error("Measured target inventory contains duplicate target ids");
  const previous = await latestPublishedGeneration(input.db, DEX_MEASURED_TARGET_SURFACE, input.signal);
  const id = generationId("dex-measured-targets", input.capturedAt);

  try {
    await runWithOverloadRetry(
      () =>
        input.db
          .prepare(
            `INSERT INTO surface_publication_generations
       (surface, generation_id, started_at, state, expected_rows, previous_generation_id,
        producer_schedule_key, producer_job, producer_path, producer_kind)
       VALUES (?, ?, ?, 'candidate', ?, ?, 'halfHourlyOffset', 'sync-dex-liquidity', 'halfHourlyOffset', 'scheduled-job')`,
          )
          .bind(
            DEX_MEASURED_TARGET_SURFACE,
            id,
            input.capturedAt,
            parsedTargets.length,
            previous?.generation_id ?? null,
          )
          .run(),
      3,
      input.signal,
    );

    const rows = parsedTargets.map(
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
    if (Number(count?.count ?? -1) !== parsedTargets.length) {
      throw new Error(
        `Measured target generation row mismatch: expected=${parsedTargets.length} actual=${count?.count ?? -1}`,
      );
    }
    await publishGenerationPointer({
      db: input.db,
      surface: DEX_MEASURED_TARGET_SURFACE,
      generationId: id,
      previousGenerationId: previous?.generation_id ?? null,
      nowSec: input.capturedAt,
      rowCount: parsedTargets.length,
      validationSummary: { exactTargetCount: parsedTargets.length },
      signal: input.signal,
    });
    return { generationId: id, rowCount: parsedTargets.length };
  } catch (error) {
    await markGenerationFailed(input.db, DEX_MEASURED_TARGET_SURFACE, id, String(error));
    throw error;
  }
}

export async function loadLatestPublishedDexMeasuredTargets(
  db: D1Database,
  signal?: AbortSignal,
): Promise<PublishedDexMeasuredTargets | null> {
  const generation = await latestPublishedGeneration(db, DEX_MEASURED_TARGET_SURFACE, signal);
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
    DexMeasuredExecutionTargetSchema.parse(parsePersistedJson(row.target_json, "DEX measured target JSON")),
  );
  if (
    (generation.expected_rows != null && generation.expected_rows !== targets.length) ||
    (generation.published_rows != null && generation.published_rows !== targets.length)
  ) {
    throw new Error(`Published measured target generation ${generation.generation_id} is incomplete`);
  }
  return {
    generationId: generation.generation_id,
    targets,
    publishedAt: generation.published_at ?? generation.started_at,
  };
}

export async function publishDexMeasuredQuoteGeneration(input: {
  db: D1Database;
  targetGeneration: PublishedDexMeasuredTargets;
  outcomes: readonly DexMeasuredQuoteOutcome[];
  quotedAt: number;
  generationId?: string;
  signal?: AbortSignal;
}): Promise<{ generationId: string; measuredCount: number; failedCount: number }> {
  if (input.targetGeneration.targets.length === 0 || input.outcomes.length === 0) {
    throw new Error("Refusing to publish an empty measured quote generation");
  }
  const targetIds = new Set(input.targetGeneration.targets.map((target) => target.targetId));
  const outcomeIds = new Set(input.outcomes.map((outcome) => outcome.target.targetId));
  if (
    outcomeIds.size !== input.outcomes.length ||
    targetIds.size !== outcomeIds.size ||
    [...targetIds].some((targetId) => !outcomeIds.has(targetId))
  )
    throw new Error("Measured quote outcomes do not exactly cover the target generation");

  const previous = await latestPublishedGeneration(input.db, DEX_MEASURED_QUOTE_SURFACE, input.signal);
  const id = input.generationId ?? buildDexMeasuredQuoteGenerationId(input.quotedAt);
  const measuredCount = input.outcomes.filter((outcome) => outcome.status === "measured").length;
  const failedCount = input.outcomes.length - measuredCount;
  try {
    await runWithOverloadRetry(
      () =>
        input.db
          .prepare(
            `INSERT INTO surface_publication_generations
       (surface, generation_id, started_at, state, expected_rows, previous_generation_id,
        dependency_snapshot_json, producer_schedule_key, producer_job, producer_path, producer_kind)
       VALUES (?, ?, ?, 'candidate', ?, ?, ?, 'halfHourlyMeasuredExecution', 'sync-cl-exit-depth',
        'halfHourlyMeasuredExecution', 'scheduled-job')`,
          )
          .bind(
            DEX_MEASURED_QUOTE_SURFACE,
            id,
            input.quotedAt,
            input.outcomes.length,
            previous?.generation_id ?? null,
            JSON.stringify({ targetGenerationId: input.targetGeneration.generationId }),
          )
          .run(),
      3,
      input.signal,
    );

    const rows = input.outcomes.map((outcome) => {
      if (
        (outcome.status === "measured" && (!outcome.profile || outcome.failureReason != null)) ||
        (outcome.status === "failed" && (outcome.profile != null || !outcome.failureReason?.trim()))
      )
        throw new Error(`Measured quote outcome ${outcome.target.targetId} has an invalid terminal state`);
      const profile = outcome.profile ? DexMeasuredExecutionProfileSchema.parse(outcome.profile) : null;
      if (
        profile &&
        (profile.targetId !== outcome.target.targetId ||
          profile.targetGenerationId !== input.targetGeneration.generationId ||
          profile.quoteGenerationId !== id)
      )
        throw new Error(`Measured quote outcome ${outcome.target.targetId} has mismatched generation identity`);
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
        profile?.blockNumber ?? null,
        profile ? JSON.stringify(profile) : null,
        // Raw producer envelopes duplicate the measured profile's quoteProof; persist them
        // only for failed outcomes, where they are the sole structured failure evidence.
        outcome.status === "failed" && outcome.rawPayload != null ? JSON.stringify(outcome.rawPayload) : null,
      ] as const;
    });
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

    const count = await input.db
      .prepare("SELECT COUNT(*) AS count FROM dex_measured_execution_quotes WHERE generation_id = ?")
      .bind(id)
      .first<{ count: number }>();
    if (Number(count?.count ?? -1) !== input.outcomes.length) {
      throw new Error(
        `Measured quote generation row mismatch: expected=${input.outcomes.length} actual=${count?.count ?? -1}`,
      );
    }
    await publishGenerationPointer({
      db: input.db,
      surface: DEX_MEASURED_QUOTE_SURFACE,
      generationId: id,
      previousGenerationId: previous?.generation_id ?? null,
      nowSec: input.quotedAt,
      rowCount: input.outcomes.length,
      validationSummary: { measuredCount, failedCount, targetGenerationId: input.targetGeneration.generationId },
      signal: input.signal,
    });
    return { generationId: id, measuredCount, failedCount };
  } catch (error) {
    await markGenerationFailed(input.db, DEX_MEASURED_QUOTE_SURFACE, id, String(error));
    throw error;
  }
}

export async function loadLatestPublishedDexMeasuredQuoteEvidence(
  db: D1Database,
  signal?: AbortSignal,
): Promise<LoadedDexMeasuredQuoteEvidence | null> {
  const currentEvidence = await loadCurrentMeasuredQuoteEvidence({
    db,
    quoteSurface: DEX_MEASURED_QUOTE_SURFACE,
    targetSurface: DEX_MEASURED_TARGET_SURFACE,
    label: "DEX",
    targetSchema: DexMeasuredExecutionTargetSchema,
    profileSchema: DexMeasuredExecutionProfileSchema,
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
  for (const [targetId, current] of currentEvidence.byTargetId) {
    const entry = {
      ...current,
      quoteGenerationId,
      targetGenerationId,
      resolution: "latest",
      latestFailureReason: current.failureReason,
    } as const;
    byTargetId.set(targetId, entry);
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

  // A transport or runtime-budget failure says nothing about executable depth.
  // Reuse the newest still-fresh measured row for that exact target identity;
  // consumer validation below retains the original quote clock and snapshot.
  try {
    const historyGenerationResult = await runWithOverloadRetry(
      () =>
        db
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
          .bind(DEX_MEASURED_QUOTE_SURFACE, latestPublishedAt - DEX_MEASURED_HISTORY_LOOKBACK_MAX_SEC)
          .all<{ generation_id: string }>(),
      3,
      signal,
    );
    const historyGenerationIds = (historyGenerationResult.results ?? []).map((row) => row.generation_id);
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
          if (
            !targetResult.success ||
            targetResult.data.targetId !== row.target_id ||
            (row.status === "measured" &&
              (profile === null ||
                row.failure_reason !== null ||
                profile.targetId !== row.target_id ||
                profile.targetGenerationId !== row.target_generation_id ||
                profile.quoteGenerationId !== row.generation_id)) ||
            (row.status === "failed" && (profile !== null || !row.failure_reason?.trim()))
          ) {
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
            quotedTarget: targetResult.data,
            status: "measured",
            failureReason: null,
            profile,
            quoteGenerationId: row.generation_id,
            targetGenerationId: row.target_generation_id,
            resolution: "last-known-good",
            latestFailureReason: latest?.failureReason ?? "quote-missing",
          });
        }
        historicalRows.length = 0;
        for (const targetId of targetIdBatch) {
          const entry = byTargetId.get(targetId);
          if (entry?.status === "measured" && entry.profile !== null) {
            const observationHistory = summarizeDexMeasuredExecutionHistory({
              cycles: historyCyclesByTargetId.get(targetId) ?? [],
              nowSec: latestPublishedAt,
              freshnessMaxSec: getDexMeasuredHistoryFreshnessSec(entry.profile.adapterProfileId),
            });
            if (observationHistory) {
              byTargetId.set(targetId, { ...entry, observationHistory });
            }
          }
          historyCyclesByTargetId.delete(targetId);
        }
      }
    }
  } catch {
    // Current-generation evidence remains usable if the optional LKG read fails.
  }

  for (const [targetId, entry] of byTargetId) {
    if (entry.status !== "measured" || entry.profile === null) continue;
    const observationHistory = summarizeDexMeasuredExecutionHistory({
      cycles: historyCyclesByTargetId.get(targetId) ?? [],
      nowSec: latestPublishedAt,
      freshnessMaxSec: getDexMeasuredHistoryFreshnessSec(entry.profile.adapterProfileId),
    });
    if (observationHistory) {
      byTargetId.set(targetId, { ...entry, observationHistory });
    }
  }

  return {
    quoteGenerationId,
    targetGenerationId,
    publishedAt: latestPublishedAt,
    byTargetId,
  };
}

const SOLANA_MEASURED_TARGET_SURFACE = "dex-solana-measured-execution-targets";
const SOLANA_MEASURED_QUOTE_SURFACE = "dex-solana-measured-execution-quotes";

export interface PublishedSolanaMeasuredTargets {
  generationId: string;
  targets: SolanaMeasuredExecutionTarget[];
  publishedAt: number;
}

export interface SolanaMeasuredQuoteOutcome {
  target: SolanaMeasuredExecutionTarget;
  status: "measured" | "failed";
  failureReason?: string;
  profile?: SolanaMeasuredExecutionProfile;
  rawPayload?: unknown;
}

export interface LoadedSolanaMeasuredQuoteEvidence {
  quoteGenerationId: string;
  targetGenerationId: string;
  publishedAt: number;
  byTargetId: Map<
    string,
    {
      quotedTarget: SolanaMeasuredExecutionTarget;
      status: "measured" | "failed";
      failureReason: string | null;
      profile: SolanaMeasuredExecutionProfile | null;
    }
  >;
}

export function buildSolanaMeasuredQuoteGenerationId(nowSec: number): string {
  return generationId("dex-solana-measured-quotes", nowSec);
}

const TRON_MEASURED_TARGET_SURFACE = "dex-tron-measured-execution-targets";
const TRON_MEASURED_QUOTE_SURFACE = "dex-tron-measured-execution-quotes";

export interface PublishedTronMeasuredTargets {
  generationId: string;
  targets: TronMeasuredExecutionTarget[];
  publishedAt: number;
}

export interface TronMeasuredQuoteOutcome {
  target: TronMeasuredExecutionTarget;
  status: "measured" | "failed";
  failureReason?: string;
  profile?: TronMeasuredExecutionProfile;
  rawPayload?: unknown;
}

export interface LoadedTronMeasuredQuoteEvidence {
  quoteGenerationId: string;
  targetGenerationId: string;
  publishedAt: number;
  byTargetId: Map<
    string,
    {
      quotedTarget: TronMeasuredExecutionTarget;
      status: "measured" | "failed";
      failureReason: string | null;
      profile: TronMeasuredExecutionProfile | null;
    }
  >;
}

export function buildTronMeasuredQuoteGenerationId(nowSec: number): string {
  return generationId("dex-tron-measured-quotes", nowSec);
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
  targetSurface: string;
  quoteSurface: string;
  targetGenerationPrefix: string;
  quoteGenerationPrefix: string;
  targetSchema: { parse(value: unknown): TTarget };
  profileSchema: { parse(value: unknown): TProfile };
  profileBlockNumber(profile: TProfile): number;
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

interface NativeLoadedQuoteEvidence<TTarget, TProfile> {
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
    }
  >;
}

const SOLANA_PERSISTENCE: NativePersistenceConfig<SolanaMeasuredExecutionTarget, SolanaMeasuredExecutionProfile> = {
  label: "Solana",
  targetSurface: SOLANA_MEASURED_TARGET_SURFACE,
  quoteSurface: SOLANA_MEASURED_QUOTE_SURFACE,
  targetGenerationPrefix: "dex-solana-measured-targets",
  quoteGenerationPrefix: "dex-solana-measured-quotes",
  targetSchema: SolanaMeasuredExecutionTargetSchema,
  profileSchema: SolanaMeasuredExecutionProfileSchema,
  profileBlockNumber: (profile) => profile.slotWindow.after,
};

const TRON_PERSISTENCE: NativePersistenceConfig<TronMeasuredExecutionTarget, TronMeasuredExecutionProfile> = {
  label: "Tron",
  targetSurface: TRON_MEASURED_TARGET_SURFACE,
  quoteSurface: TRON_MEASURED_QUOTE_SURFACE,
  targetGenerationPrefix: "dex-tron-measured-targets",
  quoteGenerationPrefix: "dex-tron-measured-quotes",
  targetSchema: TronMeasuredExecutionTargetSchema,
  profileSchema: TronMeasuredExecutionProfileSchema,
  profileBlockNumber: (profile) => Math.max(...profile.quoteProof.map((point) => point.route.blockAfter)),
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
       VALUES (?, ?, ?, 'candidate', ?, ?, 'halfHourlyOffset', 'sync-dex-liquidity',
        'halfHourlyOffset', 'scheduled-job')`,
          )
          .bind(config.targetSurface, id, input.capturedAt, targets.length, previous?.generation_id ?? null)
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
      validationSummary: { exactTargetCount: targets.length, activation: "shadow" },
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
  try {
    await runWithOverloadRetry(
      () =>
        input.db
          .prepare(
            `INSERT INTO surface_publication_generations
       (surface, generation_id, started_at, state, expected_rows, previous_generation_id,
        dependency_snapshot_json, producer_schedule_key, producer_job, producer_path, producer_kind)
       VALUES (?, ?, ?, 'candidate', ?, ?, ?, 'halfHourlyMeasuredExecution', 'sync-cl-exit-depth',
        'halfHourlyMeasuredExecution', 'scheduled-job')`,
          )
          .bind(
            config.quoteSurface,
            id,
            input.quotedAt,
            input.outcomes.length,
            previous?.generation_id ?? null,
            JSON.stringify({ targetGenerationId: input.targetGeneration.generationId }),
          )
          .run(),
      3,
      input.signal,
    );
    const rows = input.outcomes.map((outcome) => {
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
        outcome.status === "failed" && outcome.rawPayload != null ? JSON.stringify(outcome.rawPayload) : null,
      ] as const;
    });
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
    const count = await input.db
      .prepare("SELECT COUNT(*) AS count FROM dex_measured_execution_quotes WHERE generation_id = ?")
      .bind(id)
      .first<{ count: number }>();
    if (Number(count?.count ?? -1) !== input.outcomes.length) {
      throw new Error(
        `${config.label} measured quote generation row mismatch: expected=${input.outcomes.length} actual=${count?.count ?? -1}`,
      );
    }
    await publishGenerationPointer({
      db: input.db,
      surface: config.quoteSurface,
      generationId: id,
      previousGenerationId: previous?.generation_id ?? null,
      nowSec: input.quotedAt,
      rowCount: input.outcomes.length,
      validationSummary: {
        measuredCount,
        failedCount,
        targetGenerationId: input.targetGeneration.generationId,
        activation: "shadow",
      },
      signal: input.signal,
    });
    return { generationId: id, measuredCount, failedCount };
  } catch (error) {
    await markGenerationFailed(input.db, config.quoteSurface, id, String(error));
    throw error;
  }
}

async function loadLatestPublishedNativeMeasuredQuoteEvidence<
  TTarget extends NativeMeasuredTarget,
  TProfile extends NativeMeasuredProfile,
>(
  config: NativePersistenceConfig<TTarget, TProfile>,
  db: D1Database,
  signal?: AbortSignal,
): Promise<NativeLoadedQuoteEvidence<TTarget, TProfile> | null> {
  return loadCurrentMeasuredQuoteEvidence({
    db,
    quoteSurface: config.quoteSurface,
    targetSurface: config.targetSurface,
    label: config.label,
    targetSchema: config.targetSchema,
    profileSchema: config.profileSchema,
    signal,
  });
}

export async function publishSolanaMeasuredTargetInventory(input: {
  db: D1Database;
  targets: readonly SolanaMeasuredExecutionTarget[];
  capturedAt: number;
  signal?: AbortSignal;
}): Promise<{ generationId: string; rowCount: number }> {
  return publishNativeMeasuredTargetInventory(SOLANA_PERSISTENCE, input);
}

export async function loadLatestPublishedSolanaMeasuredTargets(
  db: D1Database,
  signal?: AbortSignal,
): Promise<PublishedSolanaMeasuredTargets | null> {
  return loadLatestPublishedNativeMeasuredTargets(SOLANA_PERSISTENCE, db, signal);
}

export async function publishSolanaMeasuredQuoteGeneration(input: {
  db: D1Database;
  targetGeneration: PublishedSolanaMeasuredTargets;
  outcomes: readonly SolanaMeasuredQuoteOutcome[];
  quotedAt: number;
  generationId?: string;
  signal?: AbortSignal;
}): Promise<{ generationId: string; measuredCount: number; failedCount: number }> {
  return publishNativeMeasuredQuoteGeneration(SOLANA_PERSISTENCE, input);
}

export async function loadLatestPublishedSolanaMeasuredQuoteEvidence(
  db: D1Database,
  signal?: AbortSignal,
): Promise<LoadedSolanaMeasuredQuoteEvidence | null> {
  return loadLatestPublishedNativeMeasuredQuoteEvidence(SOLANA_PERSISTENCE, db, signal);
}

export async function publishTronMeasuredTargetInventory(input: {
  db: D1Database;
  targets: readonly TronMeasuredExecutionTarget[];
  capturedAt: number;
  signal?: AbortSignal;
}): Promise<{ generationId: string; rowCount: number }> {
  return publishNativeMeasuredTargetInventory(TRON_PERSISTENCE, input);
}

export async function loadLatestPublishedTronMeasuredTargets(
  db: D1Database,
  signal?: AbortSignal,
): Promise<PublishedTronMeasuredTargets | null> {
  return loadLatestPublishedNativeMeasuredTargets(TRON_PERSISTENCE, db, signal);
}

export async function publishTronMeasuredQuoteGeneration(input: {
  db: D1Database;
  targetGeneration: PublishedTronMeasuredTargets;
  outcomes: readonly TronMeasuredQuoteOutcome[];
  quotedAt: number;
  generationId?: string;
  signal?: AbortSignal;
}): Promise<{ generationId: string; measuredCount: number; failedCount: number }> {
  return publishNativeMeasuredQuoteGeneration(TRON_PERSISTENCE, input);
}

export async function loadLatestPublishedTronMeasuredQuoteEvidence(
  db: D1Database,
  signal?: AbortSignal,
): Promise<LoadedTronMeasuredQuoteEvidence | null> {
  return loadLatestPublishedNativeMeasuredQuoteEvidence(TRON_PERSISTENCE, db, signal);
}

export async function pruneDexMeasuredExecutionGenerations(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  const cutoff = nowSec - GENERATION_RETENTION_SEC;
  await batchExecute(
    db,
    [
      db
        .prepare(
          `DELETE FROM dex_measured_execution_quotes
       WHERE generation_id IN (
         SELECT generation_id FROM surface_publication_generations
         WHERE surface IN (?, ?, ?) AND state IN ('failed', 'rejected', 'superseded') AND started_at < ?
         ORDER BY started_at ASC LIMIT ?
       )`,
        )
        .bind(
          DEX_MEASURED_QUOTE_SURFACE,
          SOLANA_MEASURED_QUOTE_SURFACE,
          TRON_MEASURED_QUOTE_SURFACE,
          cutoff,
          GENERATION_PRUNE_MAX_PER_RUN,
        ),
      db
        .prepare(
          `DELETE FROM dex_measured_execution_targets
       WHERE generation_id IN (
         SELECT generation_id FROM surface_publication_generations
         WHERE surface IN (?, ?, ?) AND state IN ('failed', 'rejected', 'superseded') AND started_at < ?
         ORDER BY started_at ASC LIMIT ?
       )
       AND generation_id NOT IN (SELECT DISTINCT target_generation_id FROM dex_measured_execution_quotes)`,
        )
        .bind(
          DEX_MEASURED_TARGET_SURFACE,
          SOLANA_MEASURED_TARGET_SURFACE,
          TRON_MEASURED_TARGET_SURFACE,
          cutoff,
          GENERATION_PRUNE_MAX_PER_RUN,
        ),
      db
        .prepare(
          `DELETE FROM surface_publication_generations
       WHERE surface IN (?, ?, ?, ?, ?, ?) AND state IN ('failed', 'rejected', 'superseded') AND started_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM dex_measured_execution_quotes q
         WHERE q.generation_id = surface_publication_generations.generation_id
            OR q.target_generation_id = surface_publication_generations.generation_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM dex_measured_execution_targets t
         WHERE t.generation_id = surface_publication_generations.generation_id
       )`,
        )
        .bind(
          DEX_MEASURED_TARGET_SURFACE,
          DEX_MEASURED_QUOTE_SURFACE,
          SOLANA_MEASURED_TARGET_SURFACE,
          SOLANA_MEASURED_QUOTE_SURFACE,
          TRON_MEASURED_TARGET_SURFACE,
          TRON_MEASURED_QUOTE_SURFACE,
          cutoff,
        ),
    ],
    { signal },
  );
}
