import { EvidenceLossOutcomeSchema, type EvidenceLossDisposition, type EvidenceLossOutcome } from "@shared/types/evidence-loss";
import type { RedemptionBackstopEntry, RedemptionCapacityRejectionReason, RedemptionQuarantineReason } from "@shared/types/redemption";

type RedemptionAdmissionLossReason = RedemptionCapacityRejectionReason | RedemptionQuarantineReason;
/** Exhaustive domain authority shared by producer rejection and capture quarantine. */
const DISPOSITION_BY_REASON: Record<RedemptionAdmissionLossReason, EvidenceLossDisposition> = {
  unconfigured: "unknown",
  suspended: "unknown",
  "missing-snapshot": "unknown",
  "inconsistent-snapshot": "unknown",
  "config-mismatch": "semantic",
  "non-independent": "unknown",
  stale: "evidential",
  "invalid-freshness": "unknown",
  "degraded-snapshot": "unknown",
  "insufficient-slices": "unknown",
  "refresh-loss-unproved": "unknown",
  "live-scope-invalidated": "unknown",
  "route-output-identity-unobserved": "unknown",
  "redeemable-capacity-unobserved": "unknown",
  "output-valuation-unobserved": "unknown",
  "all-in-cost-unobserved": "unknown",
  "settlement-bound-unproven": "unknown",
  "malformed-telemetry": "semantic",
  "unsupported-capacity-kind": "semantic",
  "missing-source-timestamp": "unknown",
  "future-source-timestamp": "unknown",
  "stale-source-timestamp": "evidential",
  "missing-block-number": "unknown",
  "reserve-semantic-invalidated": "semantic",
  "reserve-evidential-invalidated": "evidential",
  "reserve-unknown-invalidated": "unknown",
  "freshness-unverified": "unknown",
  "sync-error": "unknown",
  "malformed-persisted-row": "semantic",
  "output-stale": "evidential",
  // This label alone cannot classify its parent; capture preserves the exact C0 packet.
  "reserve-invalidated": "unknown",
};

export function classifyRedemptionLossReason(reason: RedemptionAdmissionLossReason): EvidenceLossDisposition {
  return DISPOSITION_BY_REASON[reason];
}

/** A Safety A-cause is not a transport proof. No exception-name heuristics grant operational status. */
export function redemptionLossOutcome(args: {
  assetId: string;
  routeKey: string;
  reason: string;
  disposition: EvidenceLossDisposition;
  runId: string | null;
  observedAtSec: number;
}): EvidenceLossOutcome {
  const sourceId = "redemption-backstops";
  return EvidenceLossOutcomeSchema.parse({
    scope: { assetId: args.assetId, kind: "route", key: args.routeKey },
    disposition: args.disposition,
    reason: args.reason,
    attemptId: args.runId,
    runId: args.runId,
    generationId: args.runId,
    sourceId,
    observedAtSec: args.observedAtSec,
    legs: [{ key: args.routeKey, sourceId, disposition: args.disposition, reason: args.reason, proof: null }],
    proof: null,
    priorEvidence: null,
    legacy: args.runId === null,
  });
}

/** Retain adverse observations in-place; these outcomes describe losses, not replacement evidence. */
export function classifyRedemptionEntryLosses(entry: RedemptionBackstopEntry, runId: string | null): EvidenceLossOutcome[] {
  const routeKey = `redemption:${entry.stablecoinId}:${entry.routeFamily}`;
  const losses = [...(entry.lossOutcomes ?? [])];
  if (entry.resolutionState === "failed" && losses.length === 0) {
    losses.push(redemptionLossOutcome({ assetId: entry.stablecoinId, routeKey, reason: "sync-error", disposition: classifyRedemptionLossReason("sync-error"), runId,
      observedAtSec: entry.updatedAt }));
  } else if (entry.capacityRejectionReason) {
    const reason = entry.capacityRejectionReason;
    const disposition = classifyRedemptionLossReason(reason);
    losses.push(redemptionLossOutcome({ assetId: entry.stablecoinId, routeKey, reason, disposition, runId, observedAtSec: entry.updatedAt }));
  } else if (entry.resolutionState === "missing-cache" || entry.resolutionState === "missing-capacity") {
    losses.push(redemptionLossOutcome({ assetId: entry.stablecoinId, routeKey, reason: entry.resolutionState, disposition: "unknown", runId, observedAtSec: entry.updatedAt }));
  }
  for (const observation of entry.capacityProfile?.exitRouteObservations ?? []) {
    if (observation.scoreEligible) continue;
    losses.push(redemptionLossOutcome({ assetId: entry.stablecoinId, routeKey: observation.routeId, reason: "route-evidence-inadmissible",
      disposition: "unknown", runId, observedAtSec: observation.observedAt }));
  }
  return losses;
}
