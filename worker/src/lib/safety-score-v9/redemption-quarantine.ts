import { canonicalV9RouteKey } from "@shared/lib/safety-score-v9/facts";
import { v9EvidenceCauseScopeKey, type V9EvidenceCauseScope } from "@shared/types/safety-score-v9-causes";
import type { PipelineGapByAssetId } from "@shared/lib/report-cards-fixed-input-identity";
import type { RedemptionQuarantineReason } from "@shared/types/redemption";
import type { EvidenceLossOutcome } from "@shared/types/evidence-loss";
import { createRuntimeGapVerdict } from "./fact-set-context";

/** Scoped missing-capacity proof, independent of operational loss disposition. */
const SOURCE_ID = "redemption-admission";

const MESSAGES: Record<RedemptionQuarantineReason, string> = {
  "config-mismatch": "The redemption row consumed reserve evidence bound to a superseded live-reserve configuration.",
  "freshness-unverified": "The redemption row consumed reserve evidence whose source freshness is not scoring-eligible.",
  stale: "The redemption row consumed reserve evidence that expired before the scoring clock.",
  "sync-error": "The latest redemption attempt failed without an admitted route measurement.",
  "malformed-persisted-row": "The newest redemption row failed persisted evidence validation.",
  "output-stale": "The original redemption output clock expired before the scoring clock.",
  "reserve-invalidated": "The consumed reserve datum was revoked by a subsequent scoped evidence loss.",
};

export function redemptionQuarantineScope(
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

export function captureRedemptionQuarantine(args: {
  assetId: string;
  redemptionGenerationId: string;
  routeFamily: string;
  reason: RedemptionQuarantineReason;
  lossOutcome?: EvidenceLossOutcome;
  clockSec: number;
}): PipelineGapByAssetId[string][number] {
  return createRuntimeGapVerdict({
    assetId: args.assetId,
    scope: redemptionQuarantineScope(args.assetId, args.redemptionGenerationId, args.routeFamily),
    sourceId: args.lossOutcome?.sourceId ?? SOURCE_ID,
    sourceGenerationId: args.reason === "reserve-invalidated"
      ? args.lossOutcome?.attemptId ?? args.redemptionGenerationId : args.redemptionGenerationId,
    observedAtSec: args.lossOutcome?.observedAtSec ?? args.clockSec, asOfSec: args.clockSec,
    producerState: args.reason === "stale" || args.reason === "output-stale" ? "stale-producer" : args.reason === "config-mismatch" ? "config-mismatch" : "producer-failed",
    rejectionCode: `redemption-admission-${args.reason}`, reason: MESSAGES[args.reason],
  });
}

export function findRedemptionQuarantine(
  pipelineGaps: PipelineGapByAssetId | undefined,
  assetId: string,
  scope: V9EvidenceCauseScope,
): PipelineGapByAssetId[string][number] | undefined {
  const key = v9EvidenceCauseScopeKey(assetId, scope);
  return pipelineGaps?.[assetId]?.find(({ verdict }) => v9EvidenceCauseScopeKey(verdict.assetId, verdict.scope) === key);
}
