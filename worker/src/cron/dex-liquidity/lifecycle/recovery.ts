import { toErrorMessage } from "@shared/lib/error-utils";
import { logWorkerEventArgs } from "../../../lib/structured-log";
import type { CronProgressReporter, CronResult } from "../../../lib/cron-logger";
import type { SlotDeadline } from "../../../lib/cron-timeouts";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { rethrowIfAborted, throwIfAborted } from "../../../lib/abort";
import { runWithOverloadRetry } from "../../../lib/d1-overload-retry";
import { acquireCronLease, createLeaseOwner, releaseCronLease } from "../../../lib/cron-lease-primitives";
import {
  MissingDexLiquidityScoringStageError,
  loadDexLiquidityScoringStage,
  loadDexLiquidityScoringStageWhenReady,
  probeDexLiquidityScoringStageSlot,
  type LoadedDexLiquidityScoringStage,
} from "../scoring-stage";
import { projectDexRecoveryStageResult, type DexRecoveryStageResult } from "../route-telemetry";
import {
  decideDexLiquiditySourceSlot,
  DexScoringStageProducerRunningError,
  type DexLiquidityStageRecoveryReason,
} from "./source-slot";

export type DexLiquidityStageProducer = (
  db: D1Database,
  graphApiKey: string | null,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  reportProgress?: CronProgressReporter,
  sourceSlotStartedAt?: number,
  deadline?: SlotDeadline,
) => Promise<CronResult>;

/** Credentials for the bounded same-hour stage re-run a scoring tick performs
 *  when the hourly source stage for its expected slot failed or never started. */
export interface DexLiquidityStageRecoveryInput {
  graphApiKey: string | null;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

export interface DexLiquidityStageRecoveryOutcome {
  reason: DexLiquidityStageRecoveryReason;
  sourceSlotStartedAt: number;
  generationId: string;
  stageResult?: DexRecoveryStageResult;
}

const DEX_LIQUIDITY_STAGE_RECOVERY_JOB = "sync-dex-liquidity-stage";
const DEX_LIQUIDITY_STAGE_RECOVERY_LEASE_TTL_SEC = 14 * 60;

/**
 * Wait for the exact source slot through the shared readiness primitive, but
 * stop waiting the moment the slot's stage is provably terminal: a failed
 * generation, or an errored stage run with no live lease. Terminal slots are
 * either re-run inline by a capability-equipped caller (Graph preflight, stage
 * lease and remaining deadline required), or fail fast. Heavy has Graph access
 * and uses exactly the same recovery admission as the public source lane.
 */
export async function loadDexLiquidityScoringStageForConsumer(
  stage: DexLiquidityStageProducer,
  db: D1Database,
  options: {
    expectedSourceSlotStartedAt: number;
    readyDeadlineMs: number;
    recovery: DexLiquidityStageRecoveryInput | null;
    deadline?: SlotDeadline;
  },
  reportProgress: CronProgressReporter | undefined,
  signal?: AbortSignal,
): Promise<{ staged: LoadedDexLiquidityScoringStage; recovery: DexLiquidityStageRecoveryOutcome | null }> {
  const { expectedSourceSlotStartedAt } = options;
  let stopReason: DexLiquidityStageRecoveryReason | null = null;
  let producerLiveAtLastProbe = false;
  try {
    const staged = await loadDexLiquidityScoringStageWhenReady(
      db,
      {
        expectedSourceSlotStartedAt,
        readyDeadlineMs: options.readyDeadlineMs,
        onMissing: async (waitSignal) => {
          const probe = await probeDexLiquidityScoringStageSlot(db, expectedSourceSlotStartedAt, waitSignal);
          producerLiveAtLastProbe = probe.activeStageRun;
          const decision = decideDexLiquiditySourceSlot(probe, null, Date.now() >= options.readyDeadlineMs);
          if (decision.action === "recover") {
            stopReason = decision.reason;
            return "stop";
          }
          return "wait";
        },
      },
      signal,
    );
    return { staged, recovery: null };
  } catch (error) {
    rethrowIfAborted(error, signal);
    if (
      error instanceof MissingDexLiquidityScoringStageError
      && error.expectedSourceSlotStartedAt === expectedSourceSlotStartedAt
      && stopReason === null
      && producerLiveAtLastProbe
      && Date.now() >= options.readyDeadlineMs
    ) {
      throw new DexScoringStageProducerRunningError(expectedSourceSlotStartedAt);
    }
    const reason = stopReason;
    if (!(error instanceof MissingDexLiquidityScoringStageError) ||
      error.expectedSourceSlotStartedAt !== expectedSourceSlotStartedAt || reason == null) throw error;
    if (options.recovery == null) {
      if (reason === "stage-missing") throw error;
      throw new Error(
        reason === "stage-generation-failed"
            ? `DEX liquidity scoring stage generation failed for source slot ${expectedSourceSlotStartedAt}`
            : `DEX liquidity scoring stage run errored for source slot ${expectedSourceSlotStartedAt}`,
      );
    }
    return await recoverDexLiquidityScoringStageOutput(
      stage,
      db,
      options.recovery,
      expectedSourceSlotStartedAt,
      reason,
      reportProgress,
      signal,
      options.deadline,
    );
  }
}

/** Re-run the source stage for the exact failed slot under the stage job's own
 *  lease (so a late producer invocation can never interleave with the rewrite),
 *  then load the generation the recovery just wrote. */
async function recoverDexLiquidityScoringStageOutput(
  stage: DexLiquidityStageProducer,
  db: D1Database,
  recovery: DexLiquidityStageRecoveryInput,
  expectedSourceSlotStartedAt: number,
  reason: DexLiquidityStageRecoveryReason,
  reportProgress: CronProgressReporter | undefined,
  signal?: AbortSignal,
  deadline?: SlotDeadline,
): Promise<{ staged: LoadedDexLiquidityScoringStage; recovery: DexLiquidityStageRecoveryOutcome }> {
  // Recovery must have the source producer's Graph capability. Without it,
  // subgraphs return empty descriptors and a partial target catalog can publish.
  if (!recovery.graphApiKey?.trim()) {
    throw new Error(
      `DEX liquidity scoring stage recovery refused for source slot ${expectedSourceSlotStartedAt}: missing-graph-api-key`,
    );
  }
  throwIfAborted(signal);
  if (deadline != null && deadline.remainingMs() <= 0) {
    throw new Error("DEX liquidity scoring stage recovery refused: invocation-deadline-exhausted");
  }
  const leaseOwner = createLeaseOwner(DEX_LIQUIDITY_STAGE_RECOVERY_JOB);
  const acquired = await runWithOverloadRetry(
    () => acquireCronLease(db, DEX_LIQUIDITY_STAGE_RECOVERY_JOB, leaseOwner, DEX_LIQUIDITY_STAGE_RECOVERY_LEASE_TTL_SEC),
    3,
    signal,
  );
  if (!acquired) {
    throw new DexScoringStageProducerRunningError(expectedSourceSlotStartedAt);
  }
  let stageResult: CronResult;
  try {
    throwIfAborted(signal);
    if (deadline != null && deadline.remainingMs() <= 0) {
      throw new Error("DEX liquidity scoring stage recovery refused: invocation-deadline-exhausted");
    }
    // A producer may have completed between the missing probe and lease claim.
    const latest = await probeDexLiquidityScoringStageSlot(db, expectedSourceSlotStartedAt, signal);
    if (latest.manifestState === "ready" || latest.manifestState === "consumed") {
      const staged = await loadDexLiquidityScoringStage(db, {
        nowSec: Math.floor(Date.now() / 1000), expectedSourceSlotStartedAt,
      }, signal);
      return {
        staged,
        recovery: { reason: "stage-unconsumed", sourceSlotStartedAt: expectedSourceSlotStartedAt, generationId: staged.generationId },
      };
    }
    stageResult = await stage(
      db,
      recovery.graphApiKey,
      signal,
      recovery.coingeckoApiKey,
      recovery.chainRpcs,
      reportProgress,
      expectedSourceSlotStartedAt,
      deadline,
    );
  } finally {
    try {
      await releaseCronLease(db, DEX_LIQUIDITY_STAGE_RECOVERY_JOB, leaseOwner);
    } catch (error) {
      logWorkerEventArgs("handler", "warn", JSON.stringify({
        scope: "dex-liquidity",
        message: "Failed to release DEX scoring-stage recovery lease",
        error: toErrorMessage(error),
      }));
    }
  }
  const staged = await loadDexLiquidityScoringStage(
    db,
    {
      nowSec: Math.floor(Date.now() / 1000),
      expectedSourceSlotStartedAt,
    },
    signal,
  );
  return {
    staged,
    recovery: {
      reason,
      sourceSlotStartedAt: expectedSourceSlotStartedAt,
      generationId: staged.generationId,
      stageResult: projectDexRecoveryStageResult(stageResult),
    },
  };
}
