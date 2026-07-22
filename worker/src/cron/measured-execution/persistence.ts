import {
  DexMeasuredExecutionProfileSchema,
  DexMeasuredExecutionTargetSchema,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { batchExecute, executeAtomicBatch, prepareMultiRowInsertStatements } from "../../lib/db";
import { runWithOverloadRetry } from "../../lib/cron-lease";

export const DEX_MEASURED_TARGET_SURFACE = "dex-measured-execution-targets";
export const DEX_MEASURED_QUOTE_SURFACE = "dex-measured-execution-quotes";
/** Superseded/failed generations are operator forensics only; nothing reads them after supersession. */
const GENERATION_RETENTION_SEC = 3 * 24 * 60 * 60;
/** Bound each prune pass so a retention shortening drains gradually instead of one oversized D1 delete in the cron tail. */
const GENERATION_PRUNE_MAX_PER_RUN = 16;

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
  raw_quote_payload_json: string | null;
}

export interface DexMeasuredQuoteOutcome {
  target: DexMeasuredExecutionTarget;
  status: "measured" | "failed";
  failureReason?: string;
  profile?: DexMeasuredExecutionProfile;
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
      rawPayload: unknown;
    }
  >;
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
    DexMeasuredExecutionTargetSchema.parse(JSON.parse(row.target_json)),
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
        outcome.rawPayload == null ? null : JSON.stringify(outcome.rawPayload),
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
  const generation = await latestPublishedGeneration(db, DEX_MEASURED_QUOTE_SURFACE, signal);
  if (!generation) return null;
  const quoteResult = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT generation_id, target_generation_id, target_id, status, failure_reason,
            quote_profile_json, raw_quote_payload_json
     FROM dex_measured_execution_quotes
     WHERE generation_id = ?
     ORDER BY stablecoin_id, target_id`,
        )
        .bind(generation.generation_id)
        .all<QuoteRow>(),
    3,
    signal,
  );
  const quoteRows = quoteResult.results ?? [];
  if (
    (generation.expected_rows != null && generation.expected_rows !== quoteRows.length) ||
    (generation.published_rows != null && generation.published_rows !== quoteRows.length)
  ) {
    throw new Error(`Published measured quote generation ${generation.generation_id} is incomplete`);
  }
  const targetGenerationIds = new Set(quoteRows.map((row) => row.target_generation_id));
  const dependency = generation.dependency_snapshot_json
    ? (JSON.parse(generation.dependency_snapshot_json) as { targetGenerationId?: string })
    : {};
  const targetGenerationId =
    (targetGenerationIds.values().next().value as string | undefined) ?? dependency.targetGenerationId;
  if (!targetGenerationId || targetGenerationIds.size > 1 || dependency.targetGenerationId !== targetGenerationId) {
    throw new Error(`Published measured quote generation ${generation.generation_id} has a torn target dependency`);
  }
  const targetGeneration = await db
    .prepare(
      `SELECT generation_id, state, started_at, published_at, expected_rows, published_rows, dependency_snapshot_json
     FROM surface_publication_generations
     WHERE surface = ? AND generation_id = ? AND state IN ('published', 'superseded')`,
    )
    .bind(DEX_MEASURED_TARGET_SURFACE, targetGenerationId)
    .first<SurfaceGenerationRow>();
  if (!targetGeneration) throw new Error(`Measured quote target generation ${targetGenerationId} was not published`);
  const targetResult = await db
    .prepare(
      `SELECT generation_id, target_id, target_json
     FROM dex_measured_execution_targets
     WHERE generation_id = ?`,
    )
    .bind(targetGenerationId)
    .all<TargetRow>();
  const targets = new Map(
    (targetResult.results ?? []).map((row) => {
      const target = DexMeasuredExecutionTargetSchema.parse(JSON.parse(row.target_json));
      return [target.targetId, target] as const;
    }),
  );
  if (
    (targetGeneration.expected_rows != null && targetGeneration.expected_rows !== targets.size) ||
    (targetGeneration.published_rows != null && targetGeneration.published_rows !== targets.size)
  ) {
    throw new Error(`Measured quote target generation ${targetGenerationId} is incomplete`);
  }
  const byTargetId = new Map<
    string,
    LoadedDexMeasuredQuoteEvidence["byTargetId"] extends Map<string, infer T> ? T : never
  >();
  for (const row of quoteRows) {
    const quotedTarget = targets.get(row.target_id);
    if (!quotedTarget)
      throw new Error(`Measured quote ${row.target_id} has no row in target generation ${targetGenerationId}`);
    const profile = row.quote_profile_json
      ? DexMeasuredExecutionProfileSchema.parse(JSON.parse(row.quote_profile_json))
      : null;
    if (
      (row.status === "measured" &&
        (profile == null ||
          row.failure_reason != null ||
          profile.targetId !== row.target_id ||
          profile.targetGenerationId !== targetGenerationId ||
          profile.quoteGenerationId !== generation.generation_id)) ||
      (row.status === "failed" && (profile != null || !row.failure_reason?.trim()))
    )
      throw new Error(`Measured quote row ${row.target_id} has a torn terminal identity`);
    byTargetId.set(row.target_id, {
      quotedTarget,
      status: row.status,
      failureReason: row.failure_reason,
      profile,
      rawPayload: row.raw_quote_payload_json ? JSON.parse(row.raw_quote_payload_json) : null,
    });
  }
  return {
    quoteGenerationId: generation.generation_id,
    targetGenerationId,
    publishedAt: generation.published_at ?? generation.started_at,
    byTargetId,
  };
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
         WHERE surface = ? AND state IN ('failed', 'rejected', 'superseded') AND started_at < ?
         ORDER BY started_at ASC LIMIT ?
       )`,
        )
        .bind(DEX_MEASURED_QUOTE_SURFACE, cutoff, GENERATION_PRUNE_MAX_PER_RUN),
      db
        .prepare(
          `DELETE FROM dex_measured_execution_targets
       WHERE generation_id IN (
         SELECT generation_id FROM surface_publication_generations
         WHERE surface = ? AND state IN ('failed', 'rejected', 'superseded') AND started_at < ?
         ORDER BY started_at ASC LIMIT ?
       )
       AND generation_id NOT IN (SELECT DISTINCT target_generation_id FROM dex_measured_execution_quotes)`,
        )
        .bind(DEX_MEASURED_TARGET_SURFACE, cutoff, GENERATION_PRUNE_MAX_PER_RUN),
      db
        .prepare(
          `DELETE FROM surface_publication_generations
       WHERE surface IN (?, ?) AND state IN ('failed', 'rejected', 'superseded') AND started_at < ?
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
        .bind(DEX_MEASURED_TARGET_SURFACE, DEX_MEASURED_QUOTE_SURFACE, cutoff),
    ],
    { signal },
  );
}
