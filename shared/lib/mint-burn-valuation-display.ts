import type { MintBurnSignedNetBound, MintBurnValuation, MintBurnValuationCompleteness } from "../types";
import {
  boundMintBurnSignedNetRange,
  combineMintBurnValuationCompleteness,
  resolveMintBurnValuationCompleteness,
} from "./mint-burn-valuation";

/**
 * Frontend presentation of mint/burn USD valuation completeness (D11-2).
 *
 * - A signed net is shown only when its window valuation is not `partial` and the
 *   wire value is non-null. A partial net is a one-sided bound only when exactly one
 *   side is partial (unpriced mints can only raise it, unpriced burns only lower it);
 *   it then renders as an explicit `≥`/`≤` bound, never as the net itself.
 * - `unknown` (aggregated before completeness was recorded) keeps the value with a
 *   coverage-unknown marker; it is never labelled complete.
 * - Gross mint/burn volumes on a non-complete side are known subtotals: lower bounds.
 */

type UnpricedCounts = Pick<MintBurnValuation, "unpricedMintEventCount" | "unpricedBurnEventCount">;

export interface MintBurnSignedNetView {
  /** Displayable signed net; `null` renders the component's unavailable placeholder, never 0. */
  valueUsd: number | null;
  completeness: MintBurnValuationCompleteness;
  /** Accessible explanation for an unavailable or coverage-unknown value; `null` when complete. */
  note: string | null;
  /** Proven one-sided bound when `valueUsd` is null; never a substitute statistic for sorts or sums. */
  bound?: MintBurnSignedNetBound | null;
}

export const MINT_BURN_COVERAGE_UNKNOWN_NOTE =
  "Coverage unknown: aggregated before valuation completeness was recorded";
const NET_UNAVAILABLE_NOTE = "Signed net unavailable: window evidence incomplete";
const PARTIAL_SUM_NOTE =
  "Partial valuation: a component has unpriced events; summed signed net unavailable";
const SUM_UNAVAILABLE_NOTE = "Summed signed net unavailable: a component net is unavailable";

export function describeUnpricedEvents(counts: UnpricedCounts): string {
  return `${counts.unpricedMintEventCount} mint / ${counts.unpricedBurnEventCount} burn events unpriced`;
}

export function describeMintBurnSignedNetBound(bound: MintBurnSignedNetBound, reason: string): string {
  return bound.kind === "lower"
    ? `Lower bound: ${reason}; unpriced mints can only raise the net`
    : `Upper bound: ${reason}; unpriced burns can only lower the net`;
}

/** Resolve one published signed net against its window completeness (absent → `unknown`). */
export function resolveMintBurnSignedNet(
  valueUsd: number | null,
  completeness: MintBurnValuationCompleteness | null | undefined,
  counts?: UnpricedCounts | null,
  /** Proven one-sided bound on the withheld net (see `mintBurnSignedNetBound`). */
  bound?: MintBurnSignedNetBound | null,
): MintBurnSignedNetView {
  const resolved = resolveMintBurnValuationCompleteness(completeness);
  if (resolved === "partial") {
    if (bound) {
      const reason = counts ? describeUnpricedEvents(counts) : "unpriced events in this window";
      return { valueUsd: null, completeness: resolved, note: describeMintBurnSignedNetBound(bound, reason), bound };
    }
    const note = counts
      ? `Partial valuation: ${describeUnpricedEvents(counts)}; signed net unavailable`
      : "Partial valuation: unpriced events in this window; signed net unavailable";
    return { valueUsd: null, completeness: resolved, note };
  }
  if (valueUsd == null) return { valueUsd: null, completeness: resolved, note: NET_UNAVAILABLE_NOTE };
  if (resolved === "unknown") return { valueUsd, completeness: resolved, note: MINT_BURN_COVERAGE_UNKNOWN_NOTE };
  return { valueUsd, completeness: resolved, note: null };
}

/**
 * Client-side sum of signed nets. Any unavailable component (null or partial) makes the
 * sum unavailable; `unknown` components keep the sum with the coverage-unknown marker.
 * When every unavailable component carries a bound of the same kind and no component is
 * coverage-unknown, the sum keeps that one-sided bound; otherwise it carries none.
 */
export function sumMintBurnSignedNets(parts: readonly MintBurnSignedNetView[]): MintBurnSignedNetView {
  const completeness = combineMintBurnValuationCompleteness(...parts.map((part) => part.completeness));
  let total = 0;
  let lowerUsd = 0;
  let upperUsd = 0;
  let unavailable = false;
  for (const part of parts) {
    if (part.valueUsd != null) {
      total += part.valueUsd;
      // A coverage-unknown value may hide unpriced events on either side: it bounds nothing.
      lowerUsd += part.completeness === "unknown" ? Number.NEGATIVE_INFINITY : part.valueUsd;
      upperUsd += part.completeness === "unknown" ? Number.POSITIVE_INFINITY : part.valueUsd;
      continue;
    }
    unavailable = true;
    lowerUsd += part.bound?.kind === "lower" ? part.bound.valueUsd : Number.NEGATIVE_INFINITY;
    upperUsd += part.bound?.kind === "upper" ? part.bound.valueUsd : Number.POSITIVE_INFINITY;
  }
  if (unavailable) {
    const bound = completeness === "partial" ? boundMintBurnSignedNetRange({ lowerUsd, upperUsd }) : null;
    if (bound) {
      return { valueUsd: null, completeness, note: describeMintBurnSignedNetBound(bound, "a component has unpriced events"), bound };
    }
    return {
      valueUsd: null,
      completeness,
      note: completeness === "partial" ? PARTIAL_SUM_NOTE : SUM_UNAVAILABLE_NOTE,
    };
  }
  return { valueUsd: total, completeness, note: completeness === "unknown" ? MINT_BURN_COVERAGE_UNKNOWN_NOTE : null };
}

/** Tooltip for a lower-bound gross volume; `null` when the side is complete. */
export function describeMintBurnVolumeBound(
  completeness: MintBurnValuationCompleteness | null | undefined,
  unpricedEventCount?: number | null,
  scanComplete = true,
): string | null {
  const resolved = resolveMintBurnValuationCompleteness(completeness);
  if (!scanComplete) {
    const valuationNote = resolved === "complete" ? "" : `; ${describeMintBurnVolumeBound(completeness, unpricedEventCount)}`;
    return `Observed subtotal, lower bound: scan coverage incomplete${valuationNote}`;
  }
  if (resolved === "complete") return null;
  if (resolved === "partial") {
    return unpricedEventCount != null
      ? `Known subtotal, lower bound: ${unpricedEventCount} events unpriced`
      : "Known subtotal, lower bound: unpriced events in this window";
  }
  return `Known subtotal, lower bound: ${MINT_BURN_COVERAGE_UNKNOWN_NOTE.toLowerCase()}`;
}

/** Prefix a formatted gross volume with `≥` when it is a lower bound (known subtotal of a non-complete side). */
export function formatMintBurnVolume(
  valueUsd: number,
  completeness: MintBurnValuationCompleteness | null | undefined,
  format: (value: number) => string,
  scanComplete = true,
): string {
  return scanComplete && resolveMintBurnValuationCompleteness(completeness) === "complete" ? format(valueUsd) : `≥ ${format(valueUsd)}`;
}
