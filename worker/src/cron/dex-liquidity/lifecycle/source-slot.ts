import { DEX_LIQUIDITY_STAGE_LEAD_SEC } from "@shared/lib/cron-jobs";
import { CRON_SCHEDULE_CADENCES, isHourlyDexPriceSlot } from "@shared/lib/cron-cadences";
import { buildDexLiquidityPublicationGenerationId } from "../persistence";
import type { DexLiquidityScoringStageSlotProbe } from "../scoring-stage";

export type DexLiquidityStageRecoveryReason =
  | "stage-generation-failed"
  | "stage-run-errored"
  | "stage-missing"
  | "stage-unconsumed";

export const DEX_SCORING_STAGE_PRODUCER_RUNNING_REASON = "scoring-stage-producer-running";

/** The existing readiness deadline expired while the source lease was live. */
export class DexScoringStageProducerRunningError extends Error {
  constructor(readonly sourceSlotStartedAt: number) {
    super(`DEX scoring source producer is still running for source slot ${sourceSlotStartedAt}`);
    this.name = "DexScoringStageProducerRunningError";
  }
}

/** One source-slot transition policy for both consumer deliveries and readiness probes. */
export function decideDexLiquiditySourceSlot(
  probe: DexLiquidityScoringStageSlotProbe,
  acceptedGenerationId: string | null,
  readinessExpired: boolean,
): { action: "reuse" | "consume" | "wait" } | { action: "recover"; reason: DexLiquidityStageRecoveryReason } {
  if (probe.manifestState === "consumed"
    || (probe.syncStartedAt != null
      && acceptedGenerationId === buildDexLiquidityPublicationGenerationId(probe.syncStartedAt))) {
    return { action: "reuse" };
  }
  if (probe.manifestState === "ready") return { action: "consume" };
  // Even a failed manifest can belong to a new live rewrite; never overwrite it.
  if (probe.activeStageRun) return { action: "wait" };
  if (probe.manifestState === "failed") return { action: "recover", reason: "stage-generation-failed" };
  if (probe.lastStageRunStatus === "error") return { action: "recover", reason: "stage-run-errored" };
  return readinessExpired ? { action: "recover", reason: "stage-missing" } : { action: "wait" };
}

/** The hour's :10 source slot a charts-offset consumer occurrence maps to:
 *  :16 leads it by the registered stage lead; the half-hour :46 occurrence
 *  leads it by one further consumer cadence. */
export function dexLiquidityStageSourceSlotForConsumerSlot(consumerSlotStartedAt: number): number {
  const publicationLeadSlot = consumerSlotStartedAt - DEX_LIQUIDITY_STAGE_LEAD_SEC;
  return isHourlyDexPriceSlot(consumerSlotStartedAt)
    ? publicationLeadSlot
    : publicationLeadSlot - CRON_SCHEDULE_CADENCES.halfHourlyChartsOffset.intervalSec;
}
