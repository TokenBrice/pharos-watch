import {
  DexMeasuredExecutionProfileSchema,
  DexMeasuredExecutionTargetSchema,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { batchExecute, prepareMultiRowInsertStatements, runChunkedInRead } from "../../lib/db";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { runCappedPruneFamily } from "../shared/capped-delete";
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
/** Ledger generations and payload rows have different units: a quote cohort contains hundreds of rows. */
const GENERATION_PRUNE_MAX_PER_RUN = 16;
/** Keep physical DELETEs bounded while outpacing the four active quote cohorts per hour. */
const GENERATION_PAYLOAD_PRUNE_BATCH_SIZE = 256;
const GENERATION_PAYLOAD_PRUNE_MAX_ROWS_PER_RUN = 4_096;

// Attribution must be captured while the exact leased child still owns its
// execution fence, including candidates interrupted before publication.
const SCHEDULED_PUBLISHER_INVOCATION_SQL = `
  SELECT CASE WHEN COUNT(*) = 1 THEN MAX(attempt.invocation_id) ELSE NULL END
    FROM scheduled_child_attempts attempt
    JOIN cron_leases lease ON lease.job = attempt.job AND lease.lease_owner = attempt.lease_owner
    JOIN cron_slot_executions slot ON slot.slot_key = attempt.execution_schedule_key
      AND slot.slot_started_at = attempt.execution_slot_started_at
      AND slot.execution_owner = attempt.execution_owner
      AND slot.execution_generation = attempt.execution_generation
      AND slot.invocation_id = attempt.execution_invocation_id
   WHERE attempt.schedule_key = ? AND attempt.job = ? AND attempt.producer_path = ?
     AND attempt.producer_kind = 'scheduled-job' AND attempt.terminal_token IS NULL
     AND slot.state = 'running'`;
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
  observedThisRun?: boolean;
}

export const DEX_MEASURED_EMPTY_POOL_REPROBE_SEC = 2 * CRON_SCHEDULE_CADENCES.halfHourlyMeasuredExecution.intervalSec;

export interface PositiveEmptyPoolProof {
  adapterProfileId: string;
  targetId: string;
  emptyPoolObservation: {
    observedAtSec: number;
    sourceQuoteGenerationId: string;
    blockNumber: number;
    poolId: string;
    liquidity: string;
    sqrtPriceX96: string;
  };
  reprobeEligibleAtSec: number;
  reused: boolean;
}

/** Only successful decoded pool-state reads can suppress a target's RPCs. */
export function readPositiveEmptyPoolProof(value: unknown): PositiveEmptyPoolProof | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const observation = raw.emptyPoolObservation;
  if (!observation || typeof observation !== "object") return null;
  const proof = observation as Record<string, unknown>;
  if (typeof raw.adapterProfileId !== "string" || typeof raw.targetId !== "string"
    || typeof proof.observedAtSec !== "number" || !Number.isSafeInteger(proof.observedAtSec) || proof.observedAtSec <= 0
    || typeof proof.blockNumber !== "number" || !Number.isSafeInteger(proof.blockNumber) || proof.blockNumber < 0
    || typeof proof.sourceQuoteGenerationId !== "string" || !proof.sourceQuoteGenerationId
    || typeof proof.poolId !== "string" || !/^0x[0-9a-f]{64}$/i.test(proof.poolId)
    || typeof proof.liquidity !== "string" || !/^[0-9]{1,78}$/.test(proof.liquidity)
    || typeof proof.sqrtPriceX96 !== "string" || !/^[0-9]{1,78}$/.test(proof.sqrtPriceX96)
    || (BigInt(proof.liquidity) !== 0n && BigInt(proof.sqrtPriceX96) !== 0n)
    || raw.reprobeEligibleAtSec !== proof.observedAtSec + DEX_MEASURED_EMPTY_POOL_REPROBE_SEC
    || typeof raw.reused !== "boolean") return null;
  return value as PositiveEmptyPoolProof;
}

export async function loadPositiveEmptyPoolQuarantines(
  db: D1Database,
  lane: "active" | "shadow",
  targetIds: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, PositiveEmptyPoolProof>> {
  const surface = lane === "shadow" ? DEX_SHADOW_MEASURED_QUOTE_SURFACE : DEX_MEASURED_QUOTE_SURFACE;
  const rows = await runChunkedInRead(
    targetIds,
    (inClause) => `SELECT target_id, status, failure_reason, raw_quote_payload_json FROM (
      SELECT q.target_id, q.status, q.failure_reason, q.raw_quote_payload_json,
        ROW_NUMBER() OVER (PARTITION BY q.target_id ORDER BY g.published_at DESC, g.started_at DESC, g.generation_id DESC) AS outcome_rank
      FROM dex_measured_execution_quotes q
      JOIN surface_publication_generations g ON g.generation_id = q.generation_id
      WHERE g.surface = ? AND g.state IN ('published', 'superseded')
        AND q.target_id IN (${inClause})
    ) WHERE outcome_rank = 1`,
    async (sql, binds) => {
      const result = await runWithOverloadRetry(() => db.prepare(sql).bind(surface, ...binds).all<{
        target_id: string; status: string; failure_reason: string | null; raw_quote_payload_json: string | null;
      }>(), 3, signal);
      return result.results ?? [];
    },
  );
  const held = new Map<string, PositiveEmptyPoolProof>();
  for (const row of rows) {
    if (row.status !== "failed" || row.failure_reason !== "pool-uninitialized-or-empty" || !row.raw_quote_payload_json) continue;
    let raw: unknown;
    try { raw = JSON.parse(row.raw_quote_payload_json); } catch { continue; }
    const proof = readPositiveEmptyPoolProof(raw);
    if (proof && proof.targetId === row.target_id) held.set(row.target_id, proof);
  }
  return held;
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

export type DexActiveMeasuredExecutionScheduleKey =
  | "halfHourlyMeasuredExecution"
  | "halfHourlyMeasuredExecutionSupplemental";

export async function publishDexMeasuredQuoteGeneration(input: {
  db: D1Database;
  targetGeneration: PublishedDexMeasuredTargets;
  outcomes: readonly DexMeasuredQuoteOutcome[];
  quotedAt: number;
  generationId?: string;
  producerScheduleKey?: DexActiveMeasuredExecutionScheduleKey;
  signal?: AbortSignal;
}): Promise<{ generationId: string; measuredCount: number; failedCount: number }> {
  return publishNativeMeasuredQuoteGeneration(
    input.producerScheduleKey === "halfHourlyMeasuredExecutionSupplemental"
      ? DEX_SUPPLEMENTAL_PERSISTENCE : DEX_PERSISTENCE,
    input,
  );
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

const DEX_SUPPLEMENTAL_PERSISTENCE: NativePersistenceConfig<DexMeasuredExecutionTarget, DexMeasuredExecutionProfile> = {
  ...DEX_PERSISTENCE,
  quoteProducer: {
    scheduleKey: "halfHourlyMeasuredExecutionSupplemental",
    job: "sync-cl-exit-depth",
    path: "halfHourlyMeasuredExecutionSupplemental",
  },
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
        producer_schedule_key, producer_job, producer_path, producer_kind, invocation_id)
       VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?, ?, 'scheduled-job', (${SCHEDULED_PUBLISHER_INVOCATION_SQL}))`,
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
    // Idempotent readback: a transient D1 overload after the rows landed must
    // not fail an otherwise complete publication.
    const count = await runWithOverloadRetry(
      () =>
        input.db
          .prepare("SELECT COUNT(*) AS count FROM dex_measured_execution_targets WHERE generation_id = ?")
          .bind(id)
          .first<{ count: number }>(),
      3,
      input.signal,
    );
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
        dependency_snapshot_json, producer_schedule_key, producer_job, producer_path, producer_kind, invocation_id)
       VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, 'scheduled-job', (${SCHEDULED_PUBLISHER_INVOCATION_SQL}))`,
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
    // Idempotent readback: on 2026-09-23 the 15:05 run lost a complete quote
    // generation to this exact read failing once under transient D1 overload.
    const count = await runWithOverloadRetry(
      () =>
        input.db
          .prepare("SELECT COUNT(*) AS count FROM dex_measured_execution_quotes WHERE generation_id = ?")
          .bind(id)
          .first<{ count: number }>(),
      3,
      input.signal,
    );
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
  const cutoff = nowSec - GENERATION_RETENTION_SEC;
  // Missing producer identity is not proof of abandonment. In particular, old
  // provenance-free candidates remain retained until separately diagnosed.
  // The four-hour floor exceeds every scheduled publisher's in-flight budget;
  // ownership and references are still checked atomically at each DELETE.
  const abandonedCandidate = `
    candidate.state = 'candidate'
    AND candidate.published_at IS NULL AND candidate.validated_at IS NULL
    AND candidate.producer_kind = 'scheduled-job'
    AND (
      (candidate.surface = '${DEX_MEASURED_TARGET_SURFACE}'
       AND candidate.producer_job = 'sync-dex-liquidity'
       AND candidate.producer_schedule_key = 'halfHourlyChartsOffset'
       AND candidate.producer_path = 'halfHourlyChartsOffset')
      OR
      (candidate.surface = '${DEX_MEASURED_QUOTE_SURFACE}'
       AND candidate.producer_job = 'sync-cl-exit-depth'
       AND candidate.producer_schedule_key IN ('halfHourlyMeasuredExecution', 'halfHourlyMeasuredExecutionSupplemental')
       AND candidate.producer_path = candidate.producer_schedule_key)
    )
    AND candidate.invocation_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM scheduled_child_attempts completed
      WHERE completed.invocation_id = candidate.invocation_id
        AND completed.job = candidate.producer_job
        AND completed.schedule_key = candidate.producer_schedule_key
        AND completed.producer_path = candidate.producer_path
        AND completed.terminal_token IS NOT NULL AND completed.lease_owner IS NOT NULL)
    AND EXISTS (SELECT 1 FROM cron_runs completed
      WHERE completed.invocation_id = candidate.invocation_id
        AND completed.job = candidate.producer_job
        AND completed.schedule_key = candidate.producer_schedule_key
        AND completed.producer_path = candidate.producer_path
        AND completed.status IN ('ok', 'degraded', 'error'))
    AND NOT EXISTS (SELECT 1 FROM cron_leases owner
      JOIN scheduled_child_attempts attempt ON attempt.job = owner.job
        AND attempt.lease_owner = owner.lease_owner
      WHERE attempt.invocation_id = candidate.invocation_id
        AND attempt.job = candidate.producer_job AND owner.lease_until >= ?)
    AND NOT EXISTS (SELECT 1 FROM cron_run_progress owner
      JOIN scheduled_child_attempts attempt ON attempt.job = owner.job
        AND attempt.lease_owner = owner.lease_owner
      WHERE attempt.invocation_id = candidate.invocation_id AND attempt.job = candidate.producer_job)
    AND NOT EXISTS (SELECT 1 FROM scheduled_child_attempts owner
      WHERE owner.job = candidate.producer_job AND owner.invocation_id = candidate.invocation_id
        AND owner.terminal_token IS NULL)
    AND NOT EXISTS (SELECT 1 FROM cron_slot_executions owner
      WHERE owner.invocation_id = candidate.invocation_id
        AND owner.state IN ('running', 'reconciling'))
    AND NOT EXISTS (SELECT 1 FROM surface_publication_generations reference
      WHERE reference.generation_id != candidate.generation_id
        AND (reference.previous_generation_id = candidate.generation_id
          OR (reference.dependency_snapshot_json IS NOT NULL AND CASE
            WHEN json_valid(reference.dependency_snapshot_json)
            THEN json_extract(reference.dependency_snapshot_json, '$.targetGenerationId') = candidate.generation_id
            ELSE 1 END)))
    AND NOT EXISTS (SELECT 1 FROM dex_measured_execution_quotes reference
      WHERE reference.target_generation_id = candidate.generation_id)`;
  // Preserve current/in-flight pool backing evidence and published manifests.
  // Materialize IDs once per DELETE, not the public JSON tree per candidate.
  const referenceCtes = `WITH retained_evidence AS (
    SELECT top_pools_json AS evidence_json FROM dex_liquidity
    UNION ALL SELECT row.top_pools_json FROM dex_liquidity_run_rows row
      JOIN dex_liquidity_publication_generations generation ON generation.generation_id = row.generation_id
      WHERE generation.state IN ('staged', 'published')
    UNION ALL SELECT dependency_snapshot_json FROM surface_publication_generations
      WHERE state = 'published' AND dependency_snapshot_json IS NOT NULL
  ), protected_generations AS MATERIALIZED (
    SELECT identity.value AS generation_id FROM retained_evidence reference,
      json_tree(CASE WHEN json_valid(reference.evidence_json) THEN reference.evidence_json ELSE '{}' END) identity
      WHERE identity.key IN ('quoteGenerationId', 'targetGenerationId')
    UNION ALL SELECT NULL FROM retained_evidence reference
      WHERE reference.evidence_json IS NOT NULL AND NOT json_valid(reference.evidence_json)
  )`;
  const unreferencedGeneration = `NOT EXISTS (
    SELECT 1 FROM protected_generations reference
    WHERE reference.generation_id IS NULL OR reference.generation_id = candidate.generation_id
  )`;
  const retiredGenerationCandidates = `
         SELECT candidate.generation_id FROM surface_publication_generations candidate
         WHERE candidate.surface IN (?, ?) AND candidate.started_at < ?
           AND (candidate.state IN ('failed', 'rejected', 'superseded') OR (${abandonedCandidate}))
           AND (${unreferencedGeneration})
         ORDER BY candidate.started_at ASC, candidate.generation_id ASC LIMIT ?`;
  const family = await runCappedPruneFamily({
    db,
    signal,
    statements: {
      quotes: {
        sql: `${referenceCtes} DELETE FROM dex_measured_execution_quotes
       WHERE rowid IN (
         SELECT row.rowid FROM dex_measured_execution_quotes row
         JOIN surface_publication_generations generation ON generation.generation_id = row.generation_id
         WHERE row.generation_id IN (${retiredGenerationCandidates})
         ORDER BY generation.started_at ASC, row.generation_id ASC, row.rowid ASC LIMIT ?
       )`,
        bindsForLimit: (limit) => [
          DEX_MEASURED_QUOTE_SURFACE,
          DEX_SHADOW_MEASURED_QUOTE_SURFACE,
          cutoff,
          nowSec,
          GENERATION_PRUNE_MAX_PER_RUN,
          limit,
        ],
        batchLimit: GENERATION_PAYLOAD_PRUNE_BATCH_SIZE,
        runLimit: GENERATION_PAYLOAD_PRUNE_MAX_ROWS_PER_RUN,
      },
      targets: {
        sql: `${referenceCtes} DELETE FROM dex_measured_execution_targets
       WHERE rowid IN (
         SELECT row.rowid FROM dex_measured_execution_targets row
         JOIN surface_publication_generations generation ON generation.generation_id = row.generation_id
         WHERE row.generation_id IN (${retiredGenerationCandidates})
           AND NOT EXISTS (SELECT 1 FROM dex_measured_execution_quotes reference
             WHERE reference.target_generation_id = row.generation_id)
         ORDER BY generation.started_at ASC, row.generation_id ASC, row.rowid ASC LIMIT ?
       )`,
        bindsForLimit: (limit) => [
          DEX_MEASURED_TARGET_SURFACE,
          DEX_SHADOW_MEASURED_TARGET_SURFACE,
          cutoff,
          nowSec,
          GENERATION_PRUNE_MAX_PER_RUN,
          limit,
        ],
        batchLimit: GENERATION_PAYLOAD_PRUNE_BATCH_SIZE,
        runLimit: GENERATION_PAYLOAD_PRUNE_MAX_ROWS_PER_RUN,
      },
      generations: {
        sql: `${referenceCtes} DELETE FROM surface_publication_generations
       WHERE rowid IN (
         SELECT candidate.rowid
           FROM surface_publication_generations candidate
          WHERE candidate.surface IN (?, ?, ?, ?)
            AND candidate.started_at < ?
            AND (candidate.state IN ('failed', 'rejected', 'superseded') OR (${abandonedCandidate}))
            AND (${unreferencedGeneration})
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
        bindsForLimit: (limit) => [
          DEX_MEASURED_TARGET_SURFACE,
          DEX_MEASURED_QUOTE_SURFACE,
          DEX_SHADOW_MEASURED_TARGET_SURFACE,
          DEX_SHADOW_MEASURED_QUOTE_SURFACE,
          cutoff,
          nowSec,
          limit,
        ],
        batchLimit: GENERATION_PRUNE_MAX_PER_RUN,
        runLimit: GENERATION_PRUNE_MAX_PER_RUN,
      },
    },
    probes: {
      oldestRemaining: {
        sql: `SELECT MIN(candidate.started_at) AS oldest_remaining_at
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
        binds: [
          DEX_MEASURED_TARGET_SURFACE,
          DEX_MEASURED_QUOTE_SURFACE,
          DEX_SHADOW_MEASURED_TARGET_SURFACE,
          DEX_SHADOW_MEASURED_QUOTE_SURFACE,
        ],
      },
    },
  });
  return {
    cutoff,
    deletedRows: family.changedRows,
    deletedQuoteRows: family.changed.quotes,
    deletedTargetRows: family.changed.targets,
    deletedGenerationRows: family.changed.generations,
    oldestRemainingAt: family.probes.oldestRemaining.oldest_remaining_at ?? null,
    durationMs: family.durationMs,
    error: family.error,
  };
}
