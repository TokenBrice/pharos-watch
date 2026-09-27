import type { MintBurnValuation, MintBurnValuationCompleteness } from "@shared/types";
import {
  combineMintBurnValuationCompleteness,
  resolveMintBurnValuationCompleteness,
} from "@shared/lib/mint-burn-valuation";

/**
 * Frontend presentation of mint/burn USD valuation completeness (D11-2).
 *
 * - A signed net is shown only when its window valuation is not `partial` and the
 *   wire value is non-null: a partial signed net is not a bound in either direction.
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
}

export const MINT_BURN_COVERAGE_UNKNOWN_NOTE =
  "Coverage unknown: aggregated before valuation completeness was recorded";
const NET_UNAVAILABLE_NOTE = "Signed net unavailable: valuation incomplete";
const PARTIAL_SUM_NOTE =
  "Partial valuation: a component has unpriced events; summed signed net unavailable";
const SUM_UNAVAILABLE_NOTE = "Summed signed net unavailable: a component net is unavailable";

export function describeUnpricedEvents(counts: UnpricedCounts): string {
  return `${counts.unpricedMintEventCount} mint / ${counts.unpricedBurnEventCount} burn events unpriced`;
}

/** Resolve one published signed net against its window completeness (absent → `unknown`). */
export function resolveMintBurnSignedNet(
  valueUsd: number | null,
  completeness: MintBurnValuationCompleteness | null | undefined,
  counts?: UnpricedCounts | null,
): MintBurnSignedNetView {
  const resolved = resolveMintBurnValuationCompleteness(completeness);
  if (resolved === "partial") {
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
 */
export function sumMintBurnSignedNets(parts: readonly MintBurnSignedNetView[]): MintBurnSignedNetView {
  const completeness = combineMintBurnValuationCompleteness(...parts.map((part) => part.completeness));
  let total = 0;
  for (const part of parts) {
    if (part.valueUsd == null) {
      return {
        valueUsd: null,
        completeness,
        note: completeness === "partial" ? PARTIAL_SUM_NOTE : SUM_UNAVAILABLE_NOTE,
      };
    }
    total += part.valueUsd;
  }
  return { valueUsd: total, completeness, note: completeness === "unknown" ? MINT_BURN_COVERAGE_UNKNOWN_NOTE : null };
}

/** Tooltip for a lower-bound gross volume; `null` when the side is complete. */
export function describeMintBurnVolumeBound(
  completeness: MintBurnValuationCompleteness | null | undefined,
  unpricedEventCount?: number | null,
): string | null {
  const resolved = resolveMintBurnValuationCompleteness(completeness);
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
): string {
  return resolveMintBurnValuationCompleteness(completeness) === "complete" ? format(valueUsd) : `≥ ${format(valueUsd)}`;
}
