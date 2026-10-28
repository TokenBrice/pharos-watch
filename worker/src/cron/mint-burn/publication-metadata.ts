import type { MintBurnPublication } from "@shared/types/mint-burn";

const MAX_PUBLICATION_LEG_SAMPLES = 200;
const MAX_PUBLICATION_LEG_SAMPLE_BYTES = 8 * 1_024;

/** Cron rows need counts and bounded pending evidence, not the full internal roster. */
export function mintBurnPublicationMetadata(publication: MintBurnPublication) {
  const nonAdmitted = publication.legs.filter((leg) => leg.status !== "admitted");
  const legs = [];
  let sampleBytes = 2;
  for (const leg of nonAdmitted) {
    const sample = {
      configKey: leg.configKey,
      status: leg.status,
      reason: leg.reason,
      coveredSeconds: leg.coveredSeconds,
      frontierAgeSec: leg.frontierAgeSec,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(sample)).length + 1;
    if (legs.length >= MAX_PUBLICATION_LEG_SAMPLES || sampleBytes + bytes > MAX_PUBLICATION_LEG_SAMPLE_BYTES) break;
    legs.push(sample);
    sampleBytes += bytes;
  }
  return {
    evaluatedAt: publication.evaluatedAt,
    requiredBaselineSec: publication.requiredBaselineSec,
    freshnessBudgetSec: publication.freshnessBudgetSec,
    legCount: publication.legs.length,
    admittedCount: publication.legs.length - nonAdmitted.length,
    pendingAdmissionCount: nonAdmitted.filter((leg) => leg.status === "pending-admission").length,
    disabledCount: nonAdmitted.filter((leg) => leg.status === "disabled").length,
    nonAdmittedLegCount: nonAdmitted.length,
    legs,
    legsShown: legs.length,
    legsOmitted: nonAdmitted.length - legs.length,
    legsTruncated: legs.length < nonAdmitted.length,
  };
}
