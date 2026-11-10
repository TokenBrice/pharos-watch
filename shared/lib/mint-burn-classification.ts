import type { MintBurnClassification } from "../types/mint-burn";

export interface MintBurnClassificationTally {
  unresolvedMintEventCount: number;
  unresolvedBurnEventCount: number;
  unknownMintHours: number;
  unknownBurnHours: number;
}

export function emptyMintBurnClassificationTally(): MintBurnClassificationTally {
  return { unresolvedMintEventCount: 0, unresolvedBurnEventCount: 0, unknownMintHours: 0, unknownBurnHours: 0 };
}

export function addMintBurnClassificationTally(target: MintBurnClassificationTally, source: MintBurnClassificationTally): void {
  target.unresolvedMintEventCount += source.unresolvedMintEventCount;
  target.unresolvedBurnEventCount += source.unresolvedBurnEventCount;
  target.unknownMintHours += source.unknownMintHours;
  target.unknownBurnHours += source.unknownBurnHours;
}

/** NULL classifies the entire historical side as unknown, including zero counted events. */
export function tallyMintBurnClassificationBucket(bucket: {
  unresolvedMintEventCount: number | null | undefined;
  unresolvedBurnEventCount: number | null | undefined;
}, hasReviewProducer: boolean): MintBurnClassificationTally {
  return {
    unresolvedMintEventCount: typeof bucket.unresolvedMintEventCount === "number" ? bucket.unresolvedMintEventCount : 0,
    unresolvedBurnEventCount: typeof bucket.unresolvedBurnEventCount === "number" ? bucket.unresolvedBurnEventCount : 0,
    unknownMintHours: hasReviewProducer && bucket.unresolvedMintEventCount == null ? 1 : 0,
    unknownBurnHours: hasReviewProducer && bucket.unresolvedBurnEventCount == null ? 1 : 0,
  };
}

/** All exact derived claims share this verdict; no classification bounds are inferred. */
export function summarizeMintBurnClassification(tally: MintBurnClassificationTally): MintBurnClassification {
  const side = (unresolved: number, unknown: number) => unresolved > 0 ? "partial" as const : unknown > 0 ? "unknown" as const : "complete" as const;
  const mintCompleteness = side(tally.unresolvedMintEventCount, tally.unknownMintHours);
  const burnCompleteness = side(tally.unresolvedBurnEventCount, tally.unknownBurnHours);
  const completeness = mintCompleteness === "partial" || burnCompleteness === "partial" ? "partial"
    : mintCompleteness === "unknown" || burnCompleteness === "unknown" ? "unknown" : "complete";
  return {
    completeness, mintCompleteness, burnCompleteness,
    unresolvedMintEventCount: tally.unresolvedMintEventCount,
    unresolvedBurnEventCount: tally.unresolvedBurnEventCount,
    unavailableReason: completeness === "partial" ? "classification-unresolved" : completeness === "unknown" ? "classification-unknown" : null,
  };
}
