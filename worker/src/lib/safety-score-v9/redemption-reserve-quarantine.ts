import { canonicalV9RouteKey } from "@shared/lib/safety-score-v9/facts";
import { v9EvidenceCauseScopeKey, type V9EvidenceCauseScope } from "@shared/types/safety-score-v9-causes";
import type { PipelineGapByAssetId } from "@shared/lib/report-cards-fixed-input-identity";
import type { RedemptionReserveQuarantineReason } from "../accepted-reserve-generation";
import { createRuntimeGapVerdict } from "./fact-set-context";

/**
 * A redemption row whose consumed reserve evidence lost admission is withheld
 * from the capture, and its rejection travels in `pipelineGapByAssetId` so the
 * exit compiler keeps a producer-failed redemption rail instead of reading the
 * missing row as an absent route (R2, R8).
 */
const SOURCE_ID = "redemption-consumed-reserve-admission";

const MESSAGES: Record<RedemptionReserveQuarantineReason, string> = {
  "config-mismatch": "The redemption row consumed reserve evidence bound to a superseded live-reserve configuration.",
  "freshness-unverified": "The redemption row consumed reserve evidence whose source freshness is not scoring-eligible.",
  stale: "The redemption row consumed reserve evidence that expired before the scoring clock.",
};

export function redemptionReserveQuarantineScope(
  assetId: string,
  redemptionGenerationId: string,
  routeFamily: string,
): V9EvidenceCauseScope {
  return {
    pillar: "exit", componentKey: "exit-route", factorKey: "capacity",
    routeKey: canonicalV9RouteKey("redemption", redemptionGenerationId, `redemption:${assetId}:${routeFamily}`),
    exposureId: null, requiredDatum: "capacity",
  };
}

export function captureRedemptionReserveQuarantine(args: {
  assetId: string;
  redemptionGenerationId: string;
  routeFamily: string;
  reason: RedemptionReserveQuarantineReason;
  clockSec: number;
}): PipelineGapByAssetId[string][number] {
  return createRuntimeGapVerdict({
    assetId: args.assetId,
    scope: redemptionReserveQuarantineScope(args.assetId, args.redemptionGenerationId, args.routeFamily),
    sourceId: SOURCE_ID, sourceGenerationId: args.redemptionGenerationId,
    observedAtSec: args.clockSec, asOfSec: args.clockSec,
    producerState: args.reason === "stale" ? "stale-producer" : args.reason === "config-mismatch" ? "config-mismatch" : "producer-failed",
    rejectionCode: `redemption-reserve-input-${args.reason}`, reason: MESSAGES[args.reason],
  });
}

export function findRedemptionReserveQuarantine(
  pipelineGaps: PipelineGapByAssetId | undefined,
  assetId: string,
  scope: V9EvidenceCauseScope,
): PipelineGapByAssetId[string][number] | undefined {
  const key = v9EvidenceCauseScopeKey(assetId, scope);
  return pipelineGaps?.[assetId]?.find(({ verdict }) => v9EvidenceCauseScopeKey(verdict.assetId, verdict.scope) === key);
}
