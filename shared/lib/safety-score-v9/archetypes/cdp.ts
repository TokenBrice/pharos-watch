import {
  createV9BackingStructuralReason,
  evaluateV9ArchetypeBacking,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
  type V9BackingStructuralReason,
  type V9CdpLiquidationCapacitySelection,
} from "../backing";
import type {
  V9CdpMechanismRiskReview,
  V9CdpStressCoverageFact,
  V9MechanismFactV1,
  V9MechanismQualityLevel,
} from "../../../types/safety-score-v9-backing";

export type { V9CdpMechanismRiskReview } from "../../../types/safety-score-v9-backing";

const COVERAGE_SCALE = 1_000_000_000_000n;
const MAX_RECONCILIATION_TOLERANCE_PPM = 1_000;

const V9_MECHANISM_QUALITY_ORDER: readonly V9MechanismQualityLevel[] = [
  "strong",
  "adequate",
  "limited",
  "weak",
  "failed",
];

/**
 * Observed bad debt is material only when the shutdown-and-bad-debt mechanism was
 * actually observed (`known`) and its quality is at or worse than the policy-pinned
 * materiality floor. A missing/unknown fact is an evidence gap, never a danger signal —
 * so a thin-but-solvent measurement without observed bad debt does not escalate to
 * `critical`. This never mutates the shutdown-and-bad-debt firing path; it only reads it.
 */
function hasMaterialObservedBadDebt(
  shutdownAndBadDebt: V9MechanismFactV1,
  materialityQuality: V9MechanismQualityLevel,
): boolean {
  if (shutdownAndBadDebt.status.observationState !== "known" || shutdownAndBadDebt.quality === null) {
    return false;
  }
  return (
    V9_MECHANISM_QUALITY_ORDER.indexOf(shutdownAndBadDebt.quality) >=
    V9_MECHANISM_QUALITY_ORDER.indexOf(materialityQuality)
  );
}

function coverageRatioMatches(liquidatableDebt: string, offsetDebt: string, ratio: number): boolean {
  const liquidatable = BigInt(liquidatableDebt);
  const offset = BigInt(offsetDebt);
  if (liquidatable === 0n) return offset === 0n && ratio === 1;
  if (offset > liquidatable) return false;
  return BigInt(Math.round(ratio * Number(COVERAGE_SCALE))) === (offset * COVERAGE_SCALE) / liquidatable;
}

function aggregateFactsReconcile(fact: V9CdpStressCoverageFact): boolean {
  if (
    fact.stressLiquidatableDebt === null ||
    fact.stressPoolOffsetDebt === null ||
    fact.stressLiquidationCoverageRatio === null
  ) {
    return false;
  }
  const branchLiquidatable = fact.branchContributions.reduce(
    (sum, branch) => sum + BigInt(branch.stressLiquidatableDebt),
    0n,
  );
  const branchOffset = fact.branchContributions.reduce((sum, branch) => sum + BigInt(branch.stressPoolOffsetDebt), 0n);
  if (
    branchLiquidatable !== BigInt(fact.stressLiquidatableDebt) ||
    branchOffset !== BigInt(fact.stressPoolOffsetDebt) ||
    !coverageRatioMatches(fact.stressLiquidatableDebt, fact.stressPoolOffsetDebt, fact.stressLiquidationCoverageRatio)
  ) {
    return false;
  }
  return fact.branchContributions.every((branch) =>
    coverageRatioMatches(
      branch.stressLiquidatableDebt,
      branch.stressPoolOffsetDebt,
      branch.stressLiquidationCoverageRatio,
    ),
  );
}

function stressFallbackReason(
  assetId: string,
  fact: V9CdpStressCoverageFact | undefined,
  policy: V9BackingEvaluationPolicy,
  asOfSec: number,
): { reason: string; ageSec: number | null } {
  if (fact === undefined) {
    return {
      reason:
        assetId === "mim-abracadabra"
          ? "no-reconciled-committed-pool-and-no-complete-family-simulator"
          : "unsupported-family-or-missing-complete-measurement",
      ageSec: null,
    };
  }
  if (fact.applicability !== "measured") {
    return { reason: fact.failureReason ?? "stress-measurement-not-applicable", ageSec: null };
  }
  if (!fact.complete) return { reason: "stress-measurement-incomplete", ageSec: null };
  if (!fact.exactReplayPassed || fact.replayVerification === null) {
    return { reason: "stress-measurement-exact-replay-not-passed", ageSec: null };
  }
  if (fact.source === null) return { reason: "stress-measurement-missing-provenance", ageSec: null };
  if (fact.source.block.timestampUnix > asOfSec) return { reason: "stress-measurement-future-dated", ageSec: null };
  const ageSec = asOfSec - fact.source.block.timestampUnix;
  const cdpPolicy = policy.policy.semantic.backing.structural.cdp;
  if (ageSec > cdpPolicy.stressMeasurementFreshness.maxAgeSec) {
    return { reason: "stress-measurement-stale", ageSec };
  }
  if (
    fact.stressShockFraction !== cdpPolicy.instantaneousCollateralShock ||
    fact.shockPolicy.scoreShockFractionPpm !== Math.round(cdpPolicy.instantaneousCollateralShock * 1_000_000)
  ) {
    return { reason: "stress-shock-fraction-mismatch", ageSec };
  }
  if (fact.shockPolicy.debtReconciliationTolerancePpm > MAX_RECONCILIATION_TOLERANCE_PPM) {
    return { reason: "stress-measurement-reconciliation-bound-exceeded", ageSec };
  }
  if (fact.codeHashPins.length === 0 || fact.branchContributions.length === 0 || !aggregateFactsReconcile(fact)) {
    return { reason: "stress-measurement-incomplete-or-inconsistent", ageSec };
  }
  return { reason: "", ageSec };
}

export function selectV9CdpLiquidationCapacity(
  assetId: string,
  review: V9CdpMechanismRiskReview | null,
  fact: V9CdpStressCoverageFact | undefined,
  policy: V9BackingEvaluationPolicy,
  asOfSec: number,
): V9CdpLiquidationCapacitySelection {
  const fallback = stressFallbackReason(assetId, fact, policy, asOfSec);
  const fallbackReason = fallback.reason === "" && review === null ? "mechanism-review-unavailable" : fallback.reason;
  if (fallbackReason === "" && fact !== undefined && fact.stressLiquidationCoverageRatio !== null) {
    return {
      selectedPath: "stress-measurement",
      coverageRatio: fact.stressLiquidationCoverageRatio,
      reason: `Selected complete stress-measurement at shock ${fact.stressShockFraction}.`,
      fallbackReason: null,
      measurementAgeSec: fallback.ageSec,
      selectedEvidenceRefIds: fact.evidenceRefIds,
      stressEvidenceRefIds: fact.evidenceRefIds,
    };
  }
  return {
    selectedPath: "legacyLCR",
    coverageRatio:
      review !== null && review.metricApplicability.liquidationCapacityRatio.state === "measured"
        ? review.liquidationCapacityRatio
        : null,
    reason: `Selected legacyLCR fallback: ${fallbackReason}.`,
    fallbackReason,
    measurementAgeSec: fallback.ageSec,
    selectedEvidenceRefIds: review?.liquidationMechanics.status.evidenceRefIds ?? [],
    stressEvidenceRefIds: fact?.evidenceRefIds ?? [],
  };
}

export function evaluateV9CdpBacking(
  asset: V9BackingAssetInput,
  review: V9CdpMechanismRiskReview,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  const backing = policy.policy.semantic.backing;
  const structuralReasons: V9BackingStructuralReason[] = [];
  const liquidationCapacity =
    asset.cdpLiquidationCapacitySelection ??
    selectV9CdpLiquidationCapacity(asset.assetId, review, undefined, policy, 0);
  const cdpPolicy = backing.structural.cdp;
  // (i) PSM / 1:1-aggregator short-circuit: an evidenced not-applicable collateralization
  // metric means there is no per-token vault to under-collateralize, so no CR signal fires.
  // Keyed off the applicability STATE only (never a ratio epsilon) — the `measured` guard
  // below already excludes `not-applicable`, whose ratio is null by schema.
  if (
    review.metricApplicability.collateralizationRatio.state === "measured" &&
    review.collateralizationRatio !== null &&
    review.collateralizationRatio < cdpPolicy.minimumCollateralizationRatio
  ) {
    // (ii) Proportional bands with a `moderate` rung (no critical->nothing cliff) and
    // (iii) a bad-debt gate: `critical` fires only on genuine insolvency (ratio below the
    // policy solvency floor) OR observed material bad debt, so a solvent-but-thin CDP no
    // longer floors to F.
    const ratio = review.collateralizationRatio;
    const bands = cdpPolicy.collateralizationBands;
    const severity =
      ratio < bands.solvencyFloor ||
      hasMaterialObservedBadDebt(review.shutdownAndBadDebt, cdpPolicy.badDebtMaterialityQuality)
        ? bands.criticalSeverity
        : ratio < bands.moderateFloor
          ? bands.highSeverity
          : bands.moderateSeverity;
    structuralReasons.push(
      createV9BackingStructuralReason(
        policy,
        { kind: cdpPolicy.collateralizationSignal.kind, severity },
        {
          pathKey: "mechanism:collateralization-parameters",
          materialShare: null,
          evidenceRefIds: review.collateralizationParameters.status.evidenceRefIds,
          failureDomains: review.collateralizationParameters.failureDomains,
        },
      ),
    );
  }
  if (
    liquidationCapacity.coverageRatio !== null &&
    liquidationCapacity.coverageRatio < backing.structural.cdp.minimumLiquidationCapacityRatio
  ) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.cdp.liquidationSignal, {
        pathKey:
          liquidationCapacity.selectedPath === "stress-measurement"
            ? "mechanism:liquidation-mechanics:stress-measurement"
            : "mechanism:liquidation-mechanics",
        materialShare: null,
        evidenceRefIds: liquidationCapacity.selectedEvidenceRefIds,
        failureDomains: review.liquidationMechanics.failureDomains,
      }),
    );
  }
  return evaluateV9ArchetypeBacking(
    {
      archetype: review.archetype,
      asset,
      components: [
        { componentKey: "collateralization-parameters", fact: review.collateralizationParameters },
        { componentKey: "liquidation-mechanics", fact: review.liquidationMechanics },
        { componentKey: "backstop", fact: review.backstop },
        { componentKey: "branch-isolation", fact: review.branchIsolation },
        { componentKey: "shutdown-and-bad-debt", fact: review.shutdownAndBadDebt },
        { componentKey: "structural-redemption", fact: review.structuralRedemption },
      ],
      additionalStructuralReasons: structuralReasons,
    },
    policy,
  );
}
