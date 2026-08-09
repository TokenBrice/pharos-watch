/**
 * Safety Score v9 oracle-review adapter. Extracted verbatim from
 * `safety-score-v9-extension.ts`; no behaviour change.
 */
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import type { OracleRiskBranch, OracleRiskProfile, OracleRiskTier } from "@shared/types/core";
import { ORACLE_RISK_TIER_VALUES } from "@shared/types/core";
import {
  confidenceForResearch,
  requiredStatus,
  researchReviewObservationState,
  reviewedObservationState,
  notApplicableStatus,
  type ExtensionAsset,
  type ReviewEvidenceBuilder,
  type V9ExtensionRegistryMeta,
} from "./safety-score-v9-extension-shared";

const ORACLE_BRANCH_ADAPTERS = [
  ["feed", (branch: OracleRiskBranch) => (branch.feeds?.length ?? 0) > 0 || branch.fallbackBehavior != null],
  ["collateral-parameter", (branch: OracleRiskBranch) => (branch.collateralParameters?.length ?? 0) > 0],
  [
    "liquidation",
    (branch: OracleRiskBranch) => branch.liquidationMechanism != null || branch.liquidationDelaySec != null,
  ],
  ["backstop", (branch: OracleRiskBranch) => branch.backstop != null],
  ["shutdown-bad-debt", (branch: OracleRiskBranch) => branch.shutdownOrBadDebtBehavior != null],
] as const;

// A claim on identified metal has no oracle- or liquidation-dependent
// stabilization path any more than a custodial cash claim does: nothing is
// liquidated against a price feed, and the token-versus-metal spread is the peg
// layer's measurement. `commodity-claim` was added here at the v9.14 phase-2
// migration — phase 1 could not have caught the omission, because its
// zero-coin guard meant no asset ever reached this branch on the new archetype.
const ORACLE_FREE_ARCHETYPES = new Set(["fiat-cash", "tbill", "rwa-credit-fund", "commodity-claim"]);

// V9 oracle branch-materiality lever (owner ruling 2026-07-23). A multi-branch
// CDP should be graded on the per-market oracle branches that carry material
// debt, not dragged to its worst branch regardless of that branch's size. The
// lever is active only once at least one branch carries a measured share;
// otherwise the reviewed aggregate tier stands (fail-safe for unmeasured
// multi-branch profiles, so byte-held assets never move). Within an active
// profile a branch is material when its measured share reaches the shared
// deployment-materiality floor OR its share is unmeasured (fail-closed). Weak
// branches below the floor stop driving the top tier but leave a graded,
// non-binding diagnostic: >= the moderate floor -> moderate@74, else low.
const ORACLE_BRANCH_MATERIAL_SHARE_PCT = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct;
const ORACLE_SUB_MATERIAL_MODERATE_MIN_SHARE_PCT = 5;

function isWeakOracleTier(tier: OracleRiskTier): boolean {
  return tier === "single-source-or-laggy" || tier === "opaque-or-unknown";
}

export function deriveOracleBranchMateriality(
  branches: readonly OracleRiskBranch[],
  authoredTier: OracleRiskTier,
): { tier: OracleRiskTier; subMaterialWeakBand?: "moderate" | "low" } {
  const measured = branches.some((branch) => branch.debtSharePct !== undefined);
  if (!measured) return { tier: authoredTier };
  const isMaterial = (branch: OracleRiskBranch): boolean =>
    branch.debtSharePct === undefined || branch.debtSharePct >= ORACLE_BRANCH_MATERIAL_SHARE_PCT;
  const materialTiers = branches.filter(isMaterial).map((branch) => branch.tier);
  const tier =
    materialTiers.length === 0
      ? authoredTier
      : materialTiers.reduce((worst, candidate) =>
          ORACLE_RISK_TIER_VALUES.indexOf(candidate) > ORACLE_RISK_TIER_VALUES.indexOf(worst) ? candidate : worst,
        );
  const subMaterialWeak = branches.filter(
    (branch) => branch.debtSharePct !== undefined && !isMaterial(branch) && isWeakOracleTier(branch.tier),
  );
  if (subMaterialWeak.length === 0) return { tier };
  const subMaterialWeakBand = subMaterialWeak.some(
    (branch) => branch.debtSharePct! >= ORACLE_SUB_MATERIAL_MODERATE_MIN_SHARE_PCT,
  )
    ? "moderate"
    : "low";
  return { tier, subMaterialWeakBand };
}

export function adaptOracleReview(
  meta: V9ExtensionRegistryMeta,
  archetype: string,
  evidence: ReviewEvidenceBuilder,
  clockSec: number,
): NonNullable<ExtensionAsset["economicControlReview"]>["oracle"] {
  const profile: OracleRiskProfile | undefined = meta.oracleRisk;
  if (!profile?.reviewedAt || !profile.reviewer || !profile.confidence) {
    if (!profile && ORACLE_FREE_ARCHETYPES.has(archetype)) {
      return {
        status: notApplicableStatus(
          "v9.control.oracle-review",
          `The ${archetype} mechanism archetype has no oracle- or liquidation-dependent stabilization path.`,
          [],
        ),
        tier: null,
        branches: [],
      };
    }
    return {
      status: requiredStatus("v9.control.oracle-review", "missing", `oracle:${meta.id}`),
      tier: null,
      branches: [],
    };
  }
  const confidence = confidenceForResearch(profile.confidence);
  const componentKeys = [
    "economic-control:oracle",
    ...ORACLE_BRANCH_ADAPTERS.map(([branch]) => `economic-control:oracle:${branch}`),
  ];
  const evidenceKeys = evidence.add({
    componentKeys,
    sourceId: "stablecoin-meta.oracle-risk",
    reviewedAt: profile.reviewedAt,
    confidence,
    sources: profile.sources,
    payload: profile,
    maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
  });
  if (researchReviewObservationState(profile.reviewedAt, clockSec) === "stale") {
    return {
      status: requiredStatus("v9.control.oracle-review", "stale", `oracle:${meta.id}`, evidenceKeys),
      tier: null,
      branches: [],
    };
  }
  if (profile.branchApplicability?.disposition === "not-applicable") {
    return {
      status: notApplicableStatus("v9.control.oracle-review", profile.branchApplicability.rationale, evidenceKeys),
      tier: null,
      branches: [],
    };
  }
  const topState =
    profile.branchApplicability?.disposition === "branches-required"
      ? reviewedObservationState(confidence)
      : "bounded-unknown";
  const branchesRequired =
    profile.branchApplicability?.disposition === "branches-required" && !!profile.branches?.length;
  const materiality =
    branchesRequired && topState !== "missing"
      ? deriveOracleBranchMateriality(profile.branches!, profile.tier)
      : { tier: profile.tier };
  const branches =
    profile.branchApplicability?.disposition === "branches-required" && profile.branches?.length
      ? ORACLE_BRANCH_ADAPTERS.map(([branchKind, predicate]) => {
          const complete = profile.branches!.every(predicate);
          const state = complete ? reviewedObservationState(confidence) : "missing";
          return {
            branch: branchKind,
            status: requiredStatus(
              "v9.control.oracle-review",
              state,
              `oracle:${meta.id}:${branchKind}`,
              state === "known" || state === "bounded-unknown" ? evidenceKeys : [],
            ),
            controlKey: null,
            mechanismKey: complete
              ? `oracle-mechanism:${meta.id}:${branchKind}:${domainDigest("safety-score-v9.oracle-branch.v1", {
                  branchKind,
                  branches: profile.branches,
                }).slice(0, 16)}`
              : null,
            inheritedFromAssetId: null,
          };
        })
      : [];
  return {
    status: requiredStatus(
      "v9.control.oracle-review",
      topState,
      `oracle:${meta.id}`,
      topState === "known" || topState === "bounded-unknown" ? evidenceKeys : [],
    ),
    tier: topState === "missing" ? null : materiality.tier,
    ...(materiality.subMaterialWeakBand !== undefined
      ? { subMaterialWeakBand: materiality.subMaterialWeakBand }
      : {}),
    branches,
  };
}
