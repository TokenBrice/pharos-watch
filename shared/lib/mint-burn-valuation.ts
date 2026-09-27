import { getNetFlowDirection24h } from "./mint-burn-signals";
import type { NetFlowDirection24h } from "../types/mint-burn-signals";
import type { MintBurnValuation, MintBurnValuationCompleteness } from "../types/mint-burn";

/**
 * Mint/burn USD valuation completeness (D11-2).
 *
 * Hourly buckets store known-valuation subtotals beside per-side unpriced event
 * counts. A bucket written before the counts existed (NULL columns) has unknown
 * coverage on each side that counted events; a side with no counted events is
 * provably complete. Missing valuation is never read as zero dollars: a known
 * gross subtotal is a lower bound, and a signed partial net is not a bound.
 */
export interface MintBurnValuationTally {
  /** Counted mints without a USD valuation, in hours whose coverage was recorded. */
  unpricedMintEventCount: number;
  /** Counted effective burns without a USD valuation, in hours whose coverage was recorded. */
  unpricedBurnEventCount: number;
  /** Hours with counted mints whose valuation coverage was never recorded. */
  unknownMintHours: number;
  /** Hours with counted effective burns whose valuation coverage was never recorded. */
  unknownBurnHours: number;
}

export function emptyMintBurnValuationTally(): MintBurnValuationTally {
  return { unpricedMintEventCount: 0, unpricedBurnEventCount: 0, unknownMintHours: 0, unknownBurnHours: 0 };
}

export function addMintBurnValuationTally(target: MintBurnValuationTally, source: MintBurnValuationTally): void {
  target.unpricedMintEventCount += source.unpricedMintEventCount;
  target.unpricedBurnEventCount += source.unpricedBurnEventCount;
  target.unknownMintHours += source.unknownMintHours;
  target.unknownBurnHours += source.unknownBurnHours;
}

/** Tally one stored hourly bucket; absent/`null` unpriced counts mark a bucket aggregated before coverage was recorded. */
export function tallyMintBurnHourlyBucket(bucket: {
  mintCount: number;
  burnCount: number;
  unpricedMintEventCount: number | null | undefined;
  unpricedBurnEventCount: number | null | undefined;
}): MintBurnValuationTally {
  return {
    unpricedMintEventCount: bucket.unpricedMintEventCount ?? 0,
    unpricedBurnEventCount: bucket.unpricedBurnEventCount ?? 0,
    unknownMintHours: bucket.unpricedMintEventCount == null && bucket.mintCount > 0 ? 1 : 0,
    unknownBurnHours: bucket.unpricedBurnEventCount == null && bucket.burnCount > 0 ? 1 : 0,
  };
}

function sideCompleteness(unpricedEventCount: number, unknownHours: number): MintBurnValuationCompleteness {
  if (unpricedEventCount > 0) return "partial";
  if (unknownHours > 0) return "unknown";
  return "complete";
}

/** `partial` wins over `unknown`, which wins over `complete`. */
export function combineMintBurnValuationCompleteness(
  ...values: readonly MintBurnValuationCompleteness[]
): MintBurnValuationCompleteness {
  if (values.includes("partial")) return "partial";
  if (values.includes("unknown")) return "unknown";
  return "complete";
}

export function summarizeMintBurnValuation(tally: MintBurnValuationTally): MintBurnValuation {
  const mintCompleteness = sideCompleteness(tally.unpricedMintEventCount, tally.unknownMintHours);
  const burnCompleteness = sideCompleteness(tally.unpricedBurnEventCount, tally.unknownBurnHours);
  return {
    completeness: combineMintBurnValuationCompleteness(mintCompleteness, burnCompleteness),
    mintCompleteness,
    burnCompleteness,
    unpricedMintEventCount: tally.unpricedMintEventCount,
    unpricedBurnEventCount: tally.unpricedBurnEventCount,
  };
}

/**
 * Proven range of the true signed net. Missing mint valuation can only raise the
 * net and missing burn valuation can only lower it, so each incomplete side opens
 * one end of the range. Infinite ends mean no bound exists on that side.
 */
export function mintBurnSignedNetRange(
  knownNetUsd: number,
  valuation: Pick<MintBurnValuation, "mintCompleteness" | "burnCompleteness">,
): { lowerUsd: number; upperUsd: number } {
  return {
    lowerUsd: valuation.burnCompleteness === "complete" ? knownNetUsd : Number.NEGATIVE_INFINITY,
    upperUsd: valuation.mintCompleteness === "complete" ? knownNetUsd : Number.POSITIVE_INFINITY,
  };
}

/**
 * 24h direction that missing valuation cannot alter, or `null` when it could.
 * No counted activity stays `inactive` (genuine empty); `flat` requires complete
 * valuation; `minting`/`burning` survive only when the proven range excludes zero.
 */
export function provenNetFlowDirection24h(input: {
  knownNetUsd: number;
  has24hActivity: boolean;
  valuation: Pick<MintBurnValuation, "mintCompleteness" | "burnCompleteness">;
}): NetFlowDirection24h | null {
  if (!input.has24hActivity) return "inactive";
  const { lowerUsd, upperUsd } = mintBurnSignedNetRange(input.knownNetUsd, input.valuation);
  if (lowerUsd === upperUsd) {
    return getNetFlowDirection24h({ netFlow24hUsd: input.knownNetUsd, has24hActivity: true });
  }
  if (lowerUsd > 0) return "minting";
  if (upperUsd < 0) return "burning";
  return null;
}

const UNKNOWN_VALUATION: MintBurnValuation = {
  completeness: "unknown",
  mintCompleteness: "unknown",
  burnCompleteness: "unknown",
  unpricedMintEventCount: 0,
  unpricedBurnEventCount: 0,
};

/** Consumer view of a published valuation: absent (payload predates completeness) is `unknown`, never complete. */
export function resolveMintBurnValuation(valuation: MintBurnValuation | null | undefined): MintBurnValuation {
  return valuation ?? UNKNOWN_VALUATION;
}

export function resolveMintBurnValuationCompleteness(
  completeness: MintBurnValuationCompleteness | null | undefined,
): MintBurnValuationCompleteness {
  return completeness ?? "unknown";
}
