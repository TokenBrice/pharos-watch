import { getMechanismReviewOverlay } from "./mechanism-overlay.server";

/**
 * Build-time extraction of the reviewed collateralization metrics from the V9
 * mechanism-review overlays (issue #682). Import this module only from server
 * components: the overlay file is ~1 MB and must never enter a client bundle —
 * pages pass the slim view object below as a prop instead.
 */
export interface MechanismCollateralizationView {
  /** Ratio of protocol-priced collateral over supply; null when not applicable. */
  ratio: number | null;
  /** Reviewer rationale when the ratio is ruled structurally not applicable. */
  notApplicableRationale: string | null;
  /** Committed liquidation capacity over supply; null when unmeasured or N/A. */
  liquidationCapacityRatio: number | null;
  /** ISO date the evidence was pinned. */
  reviewedAt: string;
  sourceLabel: string;
  sourceUrl: string;
}

export function buildMechanismCollateralizationView(assetId: string): MechanismCollateralizationView | null {
  const overlay = getMechanismReviewOverlay(assetId);
  // Collateralization ratio is a CDP-archetype metric; other archetypes carry
  // no comparable reviewed number (their backing is scored through components).
  if (!overlay || overlay.archetype !== "cdp") return null;
  const source = overlay.sources[0];
  if (!source) return null;

  const ratio = overlay.metrics["collateralizationRatio"];
  const ratioApplicability = overlay.metricApplicability?.["collateralizationRatio"];
  const ratioNotApplicable = ratioApplicability?.state === "not-applicable";
  if (typeof ratio !== "number" && !ratioNotApplicable) return null;

  const liquidationCapacity = overlay.metrics["liquidationCapacityRatio"];
  const notApplicableRationale =
    ratioApplicability && ratioApplicability.state === "not-applicable"
      ? ratioApplicability.rationale
      : null;
  return {
    ratio: typeof ratio === "number" ? ratio : null,
    notApplicableRationale,
    liquidationCapacityRatio: typeof liquidationCapacity === "number" ? liquidationCapacity : null,
    reviewedAt: overlay.reviewedAt,
    sourceLabel: source.label,
    sourceUrl: source.url,
  };
}
