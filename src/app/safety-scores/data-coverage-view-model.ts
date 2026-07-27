import type {
  ReportCardsV9CurrentResponse,
  V9PublicationHoldReason,
} from "@shared/types/report-cards-v9";
import type { V9ReasonCode } from "@shared/types";
import type { V9EvidenceResponsibility } from "@shared/types/safety-score-v9-facts";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

/**
 * Plain-English labels for the public V9 reason codes. The enum values are
 * evaluator identifiers, not reader-facing copy, so every code surfaced in the
 * data-coverage module carries an explicit label instead of a humanized slug.
 */
const REASON_CODE_LABELS: Record<V9ReasonCode, string> = {
  "bounded-mechanism-review": "Mechanism review incomplete",
  "bounded-unknown-reserve-exposure": "Part of the reserve is unidentified",
  "correlated-exit-routes": "Exit routes share the same failure point",
  "critical-unresolved": "A rating-critical input is unresolved",
  "future-dated-input-fact": "An input is dated in the future",
  "historical-critical-input": "A rating-critical input is out of date",
  "immaterial-unrecognized-chain-pool": "Small liquidity pool not recognized",
  "implementation-parent-cycle": "Circular dependency on a parent asset",
  "incomparable-route-requests": "Exit routes cannot be compared like for like",
  "incomplete-dex-route-coverage": "DEX exit routes only partly covered",
  "incomplete-oracle-liquidation-branch": "Oracle liquidation path only partly reviewed",
  "inherited-access-exposure": "Freeze exposure inherited from a reviewed upstream asset",
  "insufficient-evidence": "Not enough evidence to rate this input",
  "material-bridge-supply-unmatched": "Bridged supply does not reconcile",
  "material-dependency-unavailable": "A material dependency could not be scored",
  "material-reserve-slice-unstructured": "Part of the reserve is not itemized",
  "material-unknown-reserve-exposure": "A material reserve holding is unidentified",
  "mint-control-question": "Open question about mint control",
  "missing-applicable-peg": "No applicable peg reference",
  "missing-archetype": "Mechanism archetype not classified",
  "missing-bridge-route-rows": "Bridge route data not available",
  "missing-bridge-routes": "Bridge routes not mapped",
  "missing-custody-profile": "Custody arrangements not published",
  "missing-implementation-date": "Implementation date unknown",
  "missing-latest-assurance-report": "No current attestation or audit",
  "missing-mint-authority": "Mint authority not identified",
  "missing-oracle-profile": "Oracle setup not documented",
  "missing-parent-score": "Parent asset has no score",
  "missing-peg-input": "Peg reference data missing",
  "missing-pillar": "A scoring pillar has no inputs",
  "missing-access-review": "Transfer and freeze powers not reviewed",
  "missing-pillar-evidence": "A scoring pillar has no evidence",
  "missing-required-oracle-branches": "Required oracle paths not documented",
  "missing-reserve-composition": "Reserve composition not published",
  "missing-runtime-route-evidence": "Live exit-route data unavailable",
  "missing-same-notional-route": "No exit route at the tested size",
  "missing-upgrade-control": "Upgrade controls not identified",
  "missing-upgradeability-review": "Contract upgradeability not reviewed",
  "nonmaterial-dependency-unavailable": "A minor dependency could not be scored",
  "no-viable-exit-path": "No viable exit path found",
  "parent-cycle": "Circular dependency between assets",
  "partial-reserve-review": "Reserve review only partly complete",
  "runtime-bridge-materiality-unavailable": "Live bridge exposure unavailable",
  "selected-bridge-route-missing": "Selected bridge route not found",
  "selected-bridge-route-unresolved": "Selected bridge route unresolved",
  "unknown-control-cap-authority": "Supply-cap authority unknown",
  "unknown-control-mint-ability": "Mint ability unknown",
  "unknown-upgrade-authority": "Upgrade authority unknown",
  "unresolved-control-identity": "Controlling entity not identified",
  "unresolved-exit-output": "Exit route payout asset unresolved",
  "unresolved-mint-authority": "Mint authority unresolved",
  "unresolved-oracle-branch-applicability": "Oracle path applicability unresolved",
  "unsupported-same-notional-route": "Exit route cannot be tested at size",
  "unreviewed-dependency-relationships": "Dependency relationships not reviewed",
  "unreviewed-oracle-profile": "Oracle setup not reviewed",
  "unreviewed-reserve-envelope": "Reserve scope not reviewed",
};

/**
 * Reader-facing owner of a gap. `measured-adverse` is excluded from the module:
 * it records a measured negative finding, not an absence of data.
 */
const GAP_OWNERS = [
  {
    responsibility: "issuer-undisclosed",
    label: "Issuer has not disclosed it",
    detail: "The data exists but is not published by the issuer.",
  },
  {
    responsibility: "integration-missing",
    label: "Pharos has not integrated it yet",
    detail: "A source exists; wiring it into the pipeline is our work.",
  },
  {
    responsibility: "producer-failed",
    label: "A data feed failed",
    detail: "An upstream source we rely on did not deliver.",
  },
  {
    responsibility: "method-unsupported",
    label: "No supported method",
    detail: "No method can measure this input for this asset yet.",
  },
] as const satisfies ReadonlyArray<{
  responsibility: V9EvidenceResponsibility;
  label: string;
  detail: string;
}>;

export interface DataCoverageGapOwner {
  responsibility: V9EvidenceResponsibility;
  label: string;
  detail: string;
  count: number;
  share: number;
}

export interface DataCoverageGapType {
  code: V9ReasonCode;
  label: string;
  assetCount: number;
}

export interface DataCoverageHold {
  heldSinceSec: number | null;
  /** One reader-facing sentence per distinct cause. */
  causes: string[];
}

export interface DataCoverageModel {
  assetCount: number;
  ratedCount: number;
  notRatedCount: number;
  inputsEvaluated: number;
  inputsByPillar: Array<{ key: "backing" | "exit" | "control"; label: string; count: number }>;
  backingKnownCount: number;
  backingObservedCount: number;
  openGapCount: number;
  criticalGapCount: number;
  gapOwners: DataCoverageGapOwner[];
  gapTypes: DataCoverageGapType[];
  hold: DataCoverageHold | null;
}

function assetLabel(assetId: string): string {
  return CLIENT_TRACKED_META_BY_ID.get(assetId)?.symbol ?? assetId;
}

function assetListLabel(assetIds: readonly string[]): string {
  const labels = assetIds.map(assetLabel);
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * Collapses the publication hold reasons into reader-facing sentences. Producer
 * failures repeat per asset and per reason code, so they fold into a single
 * asset-scoped sentence. Assessment detail is never echoed: it carries internal
 * validation paths.
 */
export function describeDataCoverageHoldCauses(
  reasons: readonly V9PublicationHoldReason[],
): string[] {
  const causes: string[] = [];
  const producerAssetIds = [
    ...new Set(
      reasons.flatMap((reason) =>
        reason.code === "producer-failed-downgrade" || reason.code === "producer-failed-nr"
          ? [reason.assetId]
          : [],
      ),
    ),
  ].sort();
  if (producerAssetIds.length > 0) {
    causes.push(
      `${producerAssetIds.length} ${producerAssetIds.length === 1 ? "asset" : "assets"} (${assetListLabel(producerAssetIds)}) rely on a data feed that did not deliver.`,
    );
  }
  for (const reason of reasons) {
    if (reason.code === "dex-stale") causes.push("DEX liquidity data is behind schedule.");
    if (reason.code === "dex-unavailable") causes.push("DEX liquidity data is unavailable.");
    if (reason.code === "redemption-stale") causes.push("Redemption data is behind schedule.");
    if (reason.code === "redemption-unavailable") causes.push("Redemption data is unavailable.");
    if (reason.code === "live-reserves-unavailable") causes.push("Live reserve data is unavailable.");
    if (reason.code === "assessment-failed") causes.push("The latest ratings update could not be verified.");
    if (reason.code === "coverage-floor-failed") {
      causes.push(
        `Coverage fell below the required floor for ${reason.floorIds.length} ${reason.floorIds.length === 1 ? "check" : "checks"}.`,
      );
    }
  }
  return [...new Set(causes)];
}

const PILLAR_LABELS = [
  ["backing", "Backing"],
  ["exit", "Exit"],
  ["control", "Econ. control"],
] as const;

export function buildDataCoverageModel(
  response: ReportCardsV9CurrentResponse | null | undefined,
): DataCoverageModel | null {
  if (!response) return null;

  const inputsByPillar = { backing: 0, exit: 0, control: 0 };
  let backingKnownCount = 0;
  let backingObservedCount = 0;
  let openGapCount = 0;
  let criticalGapCount = 0;
  const gapCountByOwner = new Map<V9EvidenceResponsibility, number>();
  const assetCountByCode = new Map<V9ReasonCode, number>();

  // The headline counts MISSING data: only the four gap-owner classes shown
  // in the module's own attribution bar. Measured classifications (adverse or
  // structural findings) are facts we hold, not absences, and stay out of the
  // count just as they stay out of the bar.
  const missingResponsibilities = new Set<V9EvidenceResponsibility>(
    GAP_OWNERS.map((owner) => owner.responsibility),
  );
  for (const card of response.cards) {
    const responsibility = card.scoreTrace.evidenceResponsibility;
    for (const summary of responsibility.summaries) {
      if (missingResponsibilities.has(summary.responsibility)) openGapCount += summary.factCount;
      criticalGapCount += summary.criticalFactCount;
      gapCountByOwner.set(
        summary.responsibility,
        (gapCountByOwner.get(summary.responsibility) ?? 0) + summary.factCount,
      );
      for (const code of summary.reasonCodes) {
        assetCountByCode.set(code, (assetCountByCode.get(code) ?? 0) + 1);
      }
    }

    if (card.breakdowns === null) continue;
    inputsByPillar.backing += card.breakdowns.backing.components.length;
    inputsByPillar.exit += card.breakdowns.exit.primaryRoute?.components.length ?? 0;
    inputsByPillar.control += card.breakdowns.control.components.length;
    for (const component of card.breakdowns.backing.components) {
      backingObservedCount += 1;
      if (component.observationState === "known") backingKnownCount += 1;
    }
  }

  const ownerTotal = GAP_OWNERS.reduce(
    (sum, owner) =>
      sum + (gapCountByOwner.get(owner.responsibility) ?? 0),
    0,
  );

  return {
    assetCount: response.completeness.expectedCount,
    ratedCount: response.completeness.ratedCount,
    notRatedCount: response.completeness.notRatedCount,
    inputsEvaluated: inputsByPillar.backing + inputsByPillar.exit + inputsByPillar.control,
    inputsByPillar: PILLAR_LABELS.map(([key, label]) => ({ key, label, count: inputsByPillar[key] })),
    backingKnownCount,
    backingObservedCount,
    openGapCount,
    criticalGapCount,
    gapOwners: GAP_OWNERS.map((owner) => {
      const count = gapCountByOwner.get(owner.responsibility) ?? 0;
      return { ...owner, count, share: ownerTotal === 0 ? 0 : count / ownerTotal };
    })
      .filter((owner) => owner.count > 0)
      .sort((left, right) => right.count - left.count),
    gapTypes: [...assetCountByCode.entries()]
      .map(([code, assetCount]) => ({ code, label: REASON_CODE_LABELS[code], assetCount }))
      .sort((left, right) => right.assetCount - left.assetCount || left.code.localeCompare(right.code)),
    hold:
      response.publicationHealth.status === "held"
        ? {
            heldSinceSec: response.publicationHealth.heldSinceSec,
            causes: describeDataCoverageHoldCauses(response.publicationHealth.reasons),
          }
        : null,
  };
}
