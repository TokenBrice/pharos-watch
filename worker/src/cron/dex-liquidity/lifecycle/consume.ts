import { isHourlyDexPriceSlot } from "@shared/lib/cron-cadences";
import type { CronProgressReporter, CronResult } from "../../../lib/cron-logger";
import { createCronResult } from "../../../lib/cron-result";
import type { SlotDeadline } from "../../../lib/cron-timeouts";
import { createD1CostTracker } from "../../../lib/d1-cost";
import { rethrowIfAborted } from "../../../lib/abort";
import { loadCurrentDexScoringGenerationId } from "../scoring";
import { loadDexLiquidityScoringStage, probeDexLiquidityScoringStageSlot, type LoadedDexLiquidityScoringStage } from "../scoring-stage";
import { DEX_D1_COST_EXCLUSIONS, withDexD1CostMetadata } from "./d1-cost";
import {
  decideDexLiquiditySourceSlot,
  dexLiquidityStageSourceSlotForConsumerSlot,
  DexScoringStageProducerRunningError,
  DEX_SCORING_STAGE_PRODUCER_RUNNING_REASON,
} from "./source-slot";
import {
  loadDexLiquidityScoringStageForConsumer,
  type DexLiquidityStageProducer,
  type DexLiquidityStageRecoveryInput,
  type DexLiquidityStageRecoveryOutcome,
} from "./recovery";

export interface DexLiquidityStageConsumerOptions {
  publishShadowTargets?: boolean;
  stageReadyDeadlineMs?: number;
  deadline?: SlotDeadline;
  /** Recovery requires Graph capability, the source-job lease and the
   * inherited invocation deadline; both scheduled roles have Graph access. */
  stageRecovery?: DexLiquidityStageRecoveryInput;
}

export interface DexLiquidityStageLifecycle {
  stage: DexLiquidityStageProducer;
  publish: (
    db: D1Database,
    staged: LoadedDexLiquidityScoringStage,
    options: { publishShadowTargets?: boolean; deadline?: SlotDeadline },
    reportProgress: CronProgressReporter | undefined,
    signal: AbortSignal | undefined,
    recovery: DexLiquidityStageRecoveryOutcome | null,
  ) => Promise<CronResult>;
}

export async function consumeDexLiquidityStage(
  lifecycle: DexLiquidityStageLifecycle,
  db: D1Database,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
  consumerSlotStartedAt?: number,
  options: DexLiquidityStageConsumerOptions = {},
): Promise<CronResult> {
  const d1Cost = createD1CostTracker(db, DEX_D1_COST_EXCLUSIONS);
  db = d1Cost.db;
  const expectedSourceSlotStartedAt = consumerSlotStartedAt == null
    ? undefined
    : dexLiquidityStageSourceSlotForConsumerSlot(consumerSlotStartedAt);
  if (expectedSourceSlotStartedAt != null) {
    const [probe, acceptedGenerationId] = await Promise.all([
      probeDexLiquidityScoringStageSlot(db, expectedSourceSlotStartedAt, signal),
      loadCurrentDexScoringGenerationId(db, signal),
    ]);
    if (decideDexLiquiditySourceSlot(probe, acceptedGenerationId, false).action === "reuse") {
      if (!acceptedGenerationId) throw new Error("Consumed DEX source slot has no accepted generation");
      return withDexD1CostMetadata(createCronResult({
        status: "skipped_neutral",
        itemCount: 0,
        metadata: {
          reason: "liquidity-cadence-reuse",
          cadenceReuse: true,
          sourceSlotStartedAt: expectedSourceSlotStartedAt,
          sourceState: probe.manifestState,
          acceptedGeneration: acceptedGenerationId,
          persistence: { generationId: acceptedGenerationId, skipped: false, skippedReason: "liquidity-cadence-reuse" },
        },
        productivity: { productive: false, reason: "liquidity-cadence-reuse" },
      }), d1Cost);
    }
  }
  let staged: LoadedDexLiquidityScoringStage;
  let recovery: DexLiquidityStageRecoveryOutcome | null = null;
  if (expectedSourceSlotStartedAt != null) {
    try {
      ({ staged, recovery } = await loadDexLiquidityScoringStageForConsumer(
        lifecycle.stage,
        db,
        {
          expectedSourceSlotStartedAt,
          readyDeadlineMs: options.stageReadyDeadlineMs ?? Date.now(),
          recovery: options.stageRecovery ?? null,
          deadline: options.deadline,
        },
        reportProgress,
        signal,
      ));
    } catch (error) {
      rethrowIfAborted(error, signal);
      if (!(error instanceof DexScoringStageProducerRunningError)
        || error.sourceSlotStartedAt !== expectedSourceSlotStartedAt) throw error;
      return withDexD1CostMetadata(createCronResult({
        status: "skipped_neutral",
        itemCount: 0,
        metadata: {
          reason: DEX_SCORING_STAGE_PRODUCER_RUNNING_REASON,
          sourceSlotStartedAt: expectedSourceSlotStartedAt,
          readinessDeadlineMs: options.stageReadyDeadlineMs ?? null,
          persistence: {
            generationId: null,
            skipped: true,
            skippedReason: DEX_SCORING_STAGE_PRODUCER_RUNNING_REASON,
          },
        },
        productivity: { productive: false, reason: DEX_SCORING_STAGE_PRODUCER_RUNNING_REASON },
      }), d1Cost);
    }
  } else {
    staged = await loadDexLiquidityScoringStage(
      db,
      {
        nowSec: Math.floor(Date.now() / 1000),
        expectedSourceSlotStartedAt,
      },
      signal,
    );
  }
  if (recovery == null && consumerSlotStartedAt != null && !isHourlyDexPriceSlot(consumerSlotStartedAt)) {
    recovery = { reason: "stage-unconsumed", sourceSlotStartedAt: staged.sourceSlotStartedAt, generationId: staged.generationId };
  }
  const result = await lifecycle.publish(
    db,
    staged,
    { publishShadowTargets: options.publishShadowTargets, deadline: options.deadline },
    reportProgress,
    signal,
    recovery,
  );
  return withDexD1CostMetadata(result, d1Cost);
}
