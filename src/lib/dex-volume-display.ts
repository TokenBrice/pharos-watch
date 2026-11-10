import { formatCurrency } from "@shared/lib/format";
import { DEX_VOLUME_BOUND_MIN_USD, resolveDexVolumeView, type DexVolumeView } from "@shared/lib/dex-volume-availability";
import type { DexVolumeAvailability, DexVolumeCompleteness } from "@shared/types/market";

const COMPLETENESS_LABEL: Record<DexVolumeCompleteness, string> = {
  complete: "Measured",
  partial: "Partial coverage",
  missing: "Not observed",
  stale: "Stale observations",
  unknown: "Completeness unknown",
};

interface DexVolumeDisplay {
  /** Headline cell text: the measured (or legacy) total, else an em dash. */
  text: string;
  /** Secondary label for unavailable windows (never a substitute headline). */
  detail: string | null;
  /** Partial-window lower bound as an explicit `≥` claim, for KPIs that headline a bound. */
  lowerBound: { text: string; detail: string } | null;
  /** Accessible explanation of the window's availability. */
  title: string;
  view: DexVolumeView;
}

/**
 * Render one published DEX volume window. Accepts legacy numeric payloads
 * (no availability record) and DEC-19 nullable/partial payloads: a partial
 * gross sum is only ever shown as a labelled lower bound beside the dash.
 */
export function describeDexVolume(
  valueUsd: number | null | undefined,
  availability: DexVolumeAvailability | null | undefined,
): DexVolumeDisplay {
  const view = resolveDexVolumeView(valueUsd, availability);
  const text = view.valueUsd != null ? formatCurrency(view.valueUsd) : "—";
  if (view.status === "measured") {
    return { text, detail: null, lowerBound: null, title: "Measured over every contributing pool", view };
  }
  if (view.status === "legacy-unknown") {
    return { text, detail: null, lowerBound: null, title: "Completeness not recorded for this snapshot", view };
  }
  const partialGrossUsd = view.partialGrossUsd;
  // A bound that prints as $0.00 is indistinguishable from a measured zero.
  const informativeGrossUsd = partialGrossUsd != null && partialGrossUsd >= DEX_VOLUME_BOUND_MIN_USD
    ? partialGrossUsd
    : null;
  // A legacy payload's null (e.g. pre-record 7d volume) carries no completeness record.
  const label = availability == null ? "Not measured" : COMPLETENESS_LABEL[view.completeness];
  const coverage = availability?.volumeCoverage;
  // Floored so a share just under the rating floor never reads as reaching it.
  const coverageClause = typeof coverage === "number" ? ` over pools holding ${Math.floor(coverage * 100)}% of retained TVL` : "";
  return {
    text,
    detail: informativeGrossUsd != null ? `Partial ≥ ${formatCurrency(informativeGrossUsd)}` : label,
    lowerBound: informativeGrossUsd != null
      ? {
          text: `≥ ${formatCurrency(informativeGrossUsd)}`,
          detail: typeof coverage === "number"
            ? `Partial lower bound: pools holding ${Math.floor(coverage * 100)}% of TVL`
            : "Partial lower bound: not every pool measured",
        }
      : null,
    title: partialGrossUsd != null
      ? `${label}: no full-window measurement; admitted observations sum to ${formatCurrency(partialGrossUsd)}${coverageClause}`
      : `${label}: no full-window measurement`,
    view,
  };
}
