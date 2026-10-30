import { canonicalV9RouteKey } from "@shared/lib/safety-score-v9/facts";
import { resolveV9EvidenceCause } from "@shared/lib/safety-score-v9/evidence";
import {
  V9EvidenceGapClassificationSchema, v9EvidenceCauseScopeKey, v9EvidenceResponsibilityForCauseProof,
  type V9CauseResolutionDiagnostic, type V9EvidenceCauseProof, type V9EvidenceCauseScope,
  type V9EvidenceGapClassification, type V9RuntimeProducerVerdict,
} from "@shared/types/safety-score-v9-causes";
import type { V9EvidenceReferenceV2, V9EvidenceResponsibility } from "@shared/types/safety-score-v9-facts";
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

/**
 * A captured quarantine is a producer failure by construction. Authored
 * research can only relabel the rail when the issuer, not this producer, is
 * withholding the datum: a `config-mismatch` quarantine names our own
 * superseded configuration and must never be re-attributed to the issuer.
 */
const AUTHORED_REVIEWABLE_PRODUCER_STATES: Readonly<
  Partial<Record<V9RuntimeProducerVerdict["proof"]["producerState"], true>>
> = { "producer-failed": true, "stale-producer": true };

export interface RedemptionReserveQuarantineCause {
  causeProof: V9EvidenceCauseProof;
  responsibility: V9EvidenceResponsibility;
  evidenceReferences: readonly V9EvidenceReferenceV2[];
  message: string;
  diagnostics?: readonly V9CauseResolutionDiagnostic[];
}

/**
 * Resolves the rail's cause against authored research for the exact datum.
 * Only a current C proof (researched nondisclosure) for this scope moves the
 * responsibility to the issuer; no classification, a B or U classification, a
 * malformed, future-dated, expired or conflicting entry, or a producer-side
 * configuration failure keeps the captured A proof and its machine-readable
 * rejection verbatim (R2, R4, R8).
 */
export function resolveRedemptionReserveQuarantineCause(args: {
  assetId: string;
  scope: V9EvidenceCauseScope;
  asOfSec: number;
  captured: PipelineGapByAssetId[string][number];
  authoredClassifications?: readonly V9EvidenceGapClassification[];
}): RedemptionReserveQuarantineCause {
  const captured = args.captured;
  if (captured.verdict.assetId !== args.assetId ||
      v9EvidenceCauseScopeKey(captured.verdict.assetId, captured.verdict.scope) !==
        v9EvidenceCauseScopeKey(args.assetId, args.scope)) {
    throw new Error(`Redemption reserve quarantine verdict does not match its exact asset datum for ${args.assetId}`);
  }
  const message = captured.evidence.rejection?.reason ?? captured.verdict.proof.rejectionCode;
  const producerFailure: RedemptionReserveQuarantineCause = {
    causeProof: captured.verdict.proof,
    responsibility: v9EvidenceResponsibilityForCauseProof(captured.verdict.proof),
    evidenceReferences: [captured.evidence],
    message,
  };
  const candidates = authoredCapacityClassifications(args);
  if (candidates.length === 0) return producerFailure;
  if (candidates.length > 1) {
    return { ...producerFailure, diagnostics: [{
      code: "cause-proof-conversion-failed", scope: args.scope,
      message: "Conflicting authored classifications share this redemption capacity datum",
    }] };
  }
  if (AUTHORED_REVIEWABLE_PRODUCER_STATES[captured.verdict.proof.producerState] !== true) return producerFailure;
  const resolved = resolveV9EvidenceCause({
    assetId: args.assetId, scope: args.scope, asOfSec: args.asOfSec,
    sourceGenerationId: captured.verdict.proof.sourceGenerationId,
    evidenceReferences: [captured.evidence], classification: candidates[0],
  });
  if (resolved.causeProof.cause !== "C") {
    return resolved.diagnostics === undefined ? producerFailure : { ...producerFailure, diagnostics: resolved.diagnostics };
  }
  return {
    causeProof: resolved.causeProof,
    responsibility: resolved.responsibility,
    evidenceReferences: resolved.evidenceReferences,
    message,
    ...(resolved.diagnostics === undefined ? {} : { diagnostics: resolved.diagnostics }),
  };
}

function authoredCapacityClassifications(args: {
  assetId: string;
  scope: V9EvidenceCauseScope;
  authoredClassifications?: readonly V9EvidenceGapClassification[];
}): V9EvidenceGapClassification[] {
  if (args.authoredClassifications === undefined || args.authoredClassifications.length === 0) return [];
  const scopeKey = v9EvidenceCauseScopeKey(args.assetId, args.scope, "research");
  return args.authoredClassifications.flatMap((entry) => {
    const parsed = V9EvidenceGapClassificationSchema.safeParse(entry);
    if (!parsed.success || parsed.data.assetId !== args.assetId) return [];
    return v9EvidenceCauseScopeKey(parsed.data.assetId, parsed.data.scope, "research") === scopeKey ? [parsed.data] : [];
  });
}
