import { DexMeasuredExecutionProfileSchema, DexMeasuredExecutionTargetSchema, type DexMeasuredExecutionProfile, type DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { rethrowIfAborted } from "../../lib/abort";
import { batchExecute, prepareMultiRowInsertStatements } from "../../lib/db";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { toErrorMessage } from "../../lib/error-utils";
import {
  DEX_MEASURED_QUOTE_SURFACE, DEX_MEASURED_TARGET_SURFACE, DEX_SHADOW_MEASURED_QUOTE_SURFACE,
  DEX_SHADOW_MEASURED_TARGET_SURFACE, hashMeasuredTargetIds, latestPublishedGeneration, markGenerationFailed,
  measuredGenerationId, parsePersistedJson, publishGenerationPointer, type MeasuredQuoteGenerationDependency,
} from "./generation-store";
export { buildDexMeasuredQuoteGenerationId, buildDexShadowMeasuredQuoteGenerationId } from "./generation-store";
export { isOperationalDexMeasuredFailure, loadLatestPublishedDexMeasuredQuoteEvidence, materializeDexMeasuredQuoteProfile } from "./evidence-reader";
export type { LoadedDexMeasuredQuoteEvidence } from "./evidence-reader";
/**
 * Retain the complete scoring window plus one missed producer cycle. This must
 * stay strictly above `DEX_MEASURED_FRESHNESS_MAX_SEC` (three hours): a profile
 * that still reads fresh while its backing generation rows were already pruned
 * would fail closed on read instead of scoring.
 */
const GENERATION_RETENTION_SEC = 4 * 60 * 60;
/** Bound each prune pass so a retention shortening drains gradually instead of one oversized D1 delete in the cron tail. */
const GENERATION_PRUNE_MAX_PER_RUN = 16;
interface TargetRow {
  generation_id: string;
  target_id: string;
  target_json: string;
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
  const id = measuredGenerationId(config.targetGenerationPrefix, input.capturedAt);
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
  const id = input.generationId ?? measuredGenerationId(config.quoteGenerationPrefix, input.quotedAt);
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
