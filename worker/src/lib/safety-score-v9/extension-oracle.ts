/** Compiles reviewed oracle inventory without assigning borrower risk to allocations. */
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { lenderBookAdmissionReason, lenderOracleBranchKey } from "@shared/lib/safety-score-v9/lender-book-registry";
import type { LenderBookObservation } from "@shared/types/safety-score-v9-lender-book";
import type { OracleRiskBranch, OracleRiskProfile, OracleRiskTier } from "@shared/types/core";
import {
  confidenceForResearch,
  requiredStatus,
  researchReviewObservationState,
  reviewedObservationState,
  notApplicableStatus,
  type ExtensionAsset,
  type V9ExtensionRegistryMeta,
} from "./extension-shared";
import type { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";

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
  return tier === "single-source-or-laggy";
}

function worstOracleTier(worst: OracleRiskTier, candidate: OracleRiskTier): OracleRiskTier {
  const quality = V9_CANDIDATE_POLICY_V1.policy.semantic.control.oracleTierQuality;
  return quality[candidate] < quality[worst] ||
    (quality[candidate] === quality[worst] &&
      ((isWeakOracleTier(candidate) && !isWeakOracleTier(worst)) ||
        (isWeakOracleTier(candidate) === isWeakOracleTier(worst) && candidate < worst)))
    ? candidate : worst;
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
  const tier = materialTiers.length === 0 ? authoredTier : materialTiers.reduce(worstOracleTier);
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

/**
 * NAV materiality is separate from CDP debt materiality. This consumes an
 * admitted complete book; it neither changes reviewed debt shares nor prices
 * collateral quality. Unjoined reviewed weights remain material; an unmatched
 * positive claim disables relief and diagnoses the unchanged reviewed aggregate.
 */
export function deriveMorphoOracleBranchMateriality(
  branches: readonly OracleRiskBranch[],
  authoredTier: OracleRiskTier,
  book: Extract<LenderBookObservation, { status: "ok" }>,
  paths: NonNullable<OracleRiskProfile["paths"]>,
): { tier: OracleRiskTier; missingBranch: boolean } {
  const materialTiers: OracleRiskTier[] = [];
  const joinedPaths = new Set<string>();
  let hasBorrowerExposure = false;
  // The policy literal is admitted as exactly .01. Use its reciprocal for the
  // exact integer comparison, never a float/display-rounded NAV percentage.
  const thresholdScale = BigInt(1 / V9_CANDIDATE_POLICY_V1.policy.semantic.backing.lenderCollateralBook.oracleMaterialNavShare);
  for (const deployment of book.deployments) {
    const claims = new Map<string, { marketId: string; oracle: string; assets: bigint; ambiguousOracle: boolean }>();
    for (const market of deployment.markets) {
      const key = lenderOracleBranchKey(deployment.chain, market.morpho, market.marketId);
      const existing = claims.get(key);
      if (existing) {
        existing.assets += BigInt(market.includedAssetsRaw);
        existing.ambiguousOracle ||= existing.oracle !== canonicalEvmAddress(market.oracle);
      } else {
        claims.set(key, { marketId: market.marketId, oracle: canonicalEvmAddress(market.oracle) ?? market.oracle,
          assets: BigInt(market.includedAssetsRaw), ambiguousOracle: false });
      }
    }
    const nav = BigInt(deployment.realAssetsRaw ?? deployment.totalAssetsRaw);
    for (const [key, claim] of claims) {
      if (claim.assets > 0n) hasBorrowerExposure = true;
      const matching = branches.filter((branch) => {
        const id = branch.id.toLowerCase();
        return (id === `market-${claim.marketId.slice(2)}` || id === claim.marketId ||
          id === key || id === `oracle-${claim.oracle}`) &&
          (!branch.chains || branch.chains.includes(deployment.chain)) &&
          paths.some((path) => path.branchId === branch.id && path.chain === deployment.chain &&
            canonicalEvmAddress(path.address) === claim.oracle &&
            path.applicability?.disposition === "branches-required");
      });
      // A core-qualified key disambiguates otherwise identical markets. Bare
      // market/oracle reviews cannot establish which core owns the NAV weight.
      const unambiguousCore = matching[0]?.id.toLowerCase() === key ||
        [...claims.values()].filter((candidate) =>
          candidate.marketId === claim.marketId && candidate.oracle === claim.oracle,
        ).length === 1;
      if (matching.length !== 1 || !unambiguousCore || claim.ambiguousOracle) {
        if (claim.assets > 0n) return { tier: authoredTier, missingBranch: true };
        continue;
      }
      const branch = matching[0]!;
      for (const path of paths) {
        if (path.branchId === branch.id && path.chain === deployment.chain &&
            canonicalEvmAddress(path.address) === claim.oracle) joinedPaths.add(path.id);
      }
      if (thresholdScale * claim.assets >= nav) materialTiers.push(branch.tier);
    }
  }
  // All-idle is not proof of an oracleless mechanism.
  if (!hasBorrowerExposure) return { tier: authoredTier, missingBranch: false };
  for (const branch of branches) {
    const branchPaths = paths.filter((path) => path.branchId === branch.id);
    if (branchPaths.length === 0 || branchPaths.some((path) => !joinedPaths.has(path.id))) {
      materialTiers.push(branch.tier);
    }
  }
  const tier = materialTiers.length === 0 ? authoredTier : materialTiers.reduce(worstOracleTier);
  return { tier, missingBranch: false };
}

export function adaptOracleReview(
  meta: V9ExtensionRegistryMeta,
  archetype: string,
  evidence: ReviewEvidenceBuilder,
  clockSec: number,
  lenderBook?: LenderBookObservation,
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
        liquidationBranchesApplicable: false,
        branches: [],
      };
    }
    return {
      status: requiredStatus("v9.control.oracle-review", "missing", `oracle:${meta.id}`),
      tier: null,
      liquidationBranchesApplicable: true,
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
    publishedBy: "unknown",
    confidence,
    sources: profile.sources,
    payload: profile,
    maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
  });
  if (researchReviewObservationState(profile.reviewedAt, clockSec) === "stale") {
    return {
      status: requiredStatus("v9.control.oracle-review", "stale", `oracle:${meta.id}`, evidenceKeys),
      tier: null,
      liquidationBranchesApplicable: true,
      branches: [],
    };
  }
  // Explicit paths take precedence over the aggregate inventory disposition.
  // A new/unreviewed facilitator cannot inherit another path's exemption.
  const paths = profile.paths?.map((path) => {
    const review = path.applicability;
    const pathEvidenceKeys = review ? evidence.add({
      componentKeys: ["economic-control:oracle"],
      sourceId: "stablecoin-meta.oracle-risk",
      reviewedAt: review.reviewedAt,
      publishedBy: "unknown",
      confidence: confidenceForResearch(review.confidence),
      sources: review.sources,
      payload: path,
      maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
    }) : [];
    const current = review && researchReviewObservationState(review.reviewedAt, clockSec) === "current";
    const known = current && reviewedObservationState(confidenceForResearch(review.confidence)) === "known";
    const exempt = review != null && known && review.confidence === "verified" &&
      review.disposition === "not-applicable" && path.pricingAuthority === "none";
    const applicable = review != null && known &&
      (review.disposition === "branches-required" || review.disposition === "top-level-only") &&
      (path.pricingAuthority === "external-price" || path.pricingAuthority === "internal-price");
    const status = exempt
      ? notApplicableStatus("v9.control.oracle-review", review.rationale, pathEvidenceKeys)
      : requiredStatus(
          "v9.control.oracle-review",
          applicable ? "known" : current ? "bounded-unknown" : review ? "stale" : "missing",
          `oracle:${meta.id}:path:${path.id}`,
          pathEvidenceKeys,
        );
    return {
      id: path.id,
      chain: path.chain,
      address: path.address,
      branchId: path.branchId ?? null,
      applicability: status.applicability,
      observationState: status.observationState,
    };
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (paths?.every((path) => path.applicability.state === "not-applicable")) {
    return {
      status: notApplicableStatus(
        "v9.control.oracle-review",
        "Every identified path is reviewed as having no price-sensitive oracle or internal valuation authority.",
        evidenceKeys,
      ),
      tier: null,
      liquidationBranchesApplicable: false,
      branches: [],
      paths,
    };
  }
  const aggregateApplicability = !paths ? profile.branchApplicability : undefined;
  if (aggregateApplicability) {
    const applicabilityEvidenceKeys = evidence.add({
      componentKeys: ["economic-control:oracle"],
      sourceId: "stablecoin-meta.oracle-risk-applicability",
      reviewedAt: aggregateApplicability.reviewedAt,
      publishedBy: "unknown",
      confidence,
      sources: aggregateApplicability.sources,
      payload: aggregateApplicability,
      maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
    });
    if (researchReviewObservationState(aggregateApplicability.reviewedAt, clockSec) === "stale") {
      return {
        status: requiredStatus("v9.control.oracle-review", "stale", `oracle:${meta.id}`, applicabilityEvidenceKeys),
        tier: null,
        liquidationBranchesApplicable: true,
        branches: [],
      };
    }
    if (aggregateApplicability.disposition === "not-applicable" && profile.confidence === "verified") {
      return {
        status: notApplicableStatus("v9.control.oracle-review", aggregateApplicability.rationale, applicabilityEvidenceKeys),
        tier: null,
        liquidationBranchesApplicable: false,
        branches: [],
      };
    }
  }
  const unresolvedPaths = paths?.some((path) => path.observationState !== "known");
  const applicableBranches = paths
    ? profile.branches?.filter((branch) => paths.some((path) =>
        path.branchId === branch.id && path.applicability.state === "required" && path.observationState === "known",
      )) ?? []
    : profile.branches ?? [];
  const lendingPaths = profile.paths?.filter((path) =>
    path.applicability?.disposition === "branches-required" &&
    paths?.some((compiled) => compiled.id === path.id && compiled.applicability.state === "required" && compiled.observationState === "known"),
  );
  const lenderPolicy = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.lenderCollateralBook;
  const admittedBook = lenderBook?.status === "ok" &&
    lenderBookAdmissionReason(lenderBook, meta.id, clockSec, lenderPolicy) === null
    ? lenderBook : undefined;
  const topLevelPaths = profile.paths?.filter((path) =>
    path.applicability?.disposition === "top-level-only" &&
    paths?.some((compiled) => compiled.id === path.id && compiled.applicability.state === "required" && compiled.observationState === "known"),
  ) ?? [];
  const onlyShareAccounting = admittedBook && topLevelPaths.every((path) =>
    path.id === "vault-nav" && path.pricingAuthority === "internal-price" &&
    admittedBook.deployments.some((deployment) => deployment.chain === path.chain &&
      deployment.vault === canonicalEvmAddress(path.address)),
  );
  const morphoMateriality = admittedBook && !unresolvedPaths && onlyShareAccounting && lendingPaths
    ? deriveMorphoOracleBranchMateriality(applicableBranches, profile.tier, admittedBook, lendingPaths)
    : undefined;
  const missingPathBranch = (lendingPaths?.some((path) =>
    !path.branchId || !applicableBranches.some((branch) => branch.id === path.branchId),
  ) ?? false);
  const topState = unresolvedPaths || missingPathBranch
    ? "bounded-unknown"
    : paths || profile.branchApplicability?.disposition === "branches-required" ||
        profile.branchApplicability?.disposition === "top-level-only"
      ? reviewedObservationState(confidence)
      : "bounded-unknown";
  const branchesRequired = paths
    ? (lendingPaths?.length ?? 0) > 0
    : profile.branchApplicability?.disposition === "branches-required" && !!profile.branches?.length;
  const materiality: { tier: OracleRiskTier; subMaterialWeakBand?: "moderate" | "low" } =
    admittedBook
      ? morphoMateriality
        // The NAV lever may only remove reviewed constraints, never create a
        // worse aggregate than the pre-v10.19 top-level NAV guard.
        ? { tier: worstOracleTier(profile.tier, morphoMateriality.tier) === morphoMateriality.tier
            ? profile.tier : morphoMateriality.tier }
        : { tier: profile.tier }
      : branchesRequired && topState !== "missing" && topLevelPaths.length === 0
        ? deriveOracleBranchMateriality(applicableBranches, profile.tier)
        : { tier: profile.tier };
  if (morphoMateriality && admittedBook) {
    evidenceKeys.push(...evidence.add({
      componentKeys,
      sourceId: morphoMateriality.missingBranch
        ? "live-reserves.morpho-lender-book-oracle-materiality-unjoined-claim-fallback"
        : "live-reserves.morpho-lender-book-oracle-materiality",
      reviewedAtSec: admittedBook.acquiredAtSec,
      observedAtSec: Math.min(admittedBook.acquiredAtSec, ...admittedBook.deployments.map((deployment) => deployment.pin.timestampSec)),
      publishedBy: "unknown",
      confidence: "verified",
      payload: { book: admittedBook, materiality: morphoMateriality },
      maxAgeSec: lenderPolicy.observationMaxAgeSec,
    }));
  }
  const branches = branchesRequired
      ? ORACLE_BRANCH_ADAPTERS.map(([branchKind, predicate]) => {
          // An explicit review owns this kind's confidence and census. It cannot
          // promote another kind (in particular, unresolved nested feed facts).
          const review = profile.branchKindReviews?.find((candidate) => candidate.kind === branchKind);
          const kindBranches = review ? profile.branches ?? [] : applicableBranches;
          const complete = !missingPathBranch && kindBranches.length > 0 && kindBranches.every(predicate) &&
            (!review || kindBranches.every((branch) => review.branchIds.includes(branch.id)));
          const kindEvidenceKeys = review ? evidence.add({
            componentKeys: [`economic-control:oracle:${branchKind}`],
            sourceId: "stablecoin-meta.oracle-risk-kind",
            reviewedAt: review.reviewedAt,
            publishedBy: "unknown",
            confidence: confidenceForResearch(review.confidence),
            sources: review.sources,
            payload: { review, branches: kindBranches },
            maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
          }) : evidenceKeys;
          const state = !complete
            ? "missing"
            : review && researchReviewObservationState(review.reviewedAt, clockSec) === "stale"
              ? "stale"
              : reviewedObservationState(review ? confidenceForResearch(review.confidence) : confidence);
          return {
            branch: branchKind,
            status: requiredStatus(
              "v9.control.oracle-review",
              state,
              `oracle:${meta.id}:${branchKind}`,
              state === "known" || state === "bounded-unknown" || state === "stale" ? kindEvidenceKeys : [],
            ),
            controlKey: null,
            mechanismKey: complete
              ? `oracle-mechanism:${meta.id}:${branchKind}:${domainDigest("safety-score-v9.oracle-branch.v1", {
                  branchKind,
                  branches: kindBranches,
                }).slice(0, 16)}`
              : null,
            inheritedFromAssetId: null,
          };
        })
      : [];
  return {
    status: unresolvedPaths
      ? {
          ...requiredStatus("v9.control.oracle-review", "bounded-unknown", `oracle:${meta.id}`, evidenceKeys),
          applicability: {
            state: "unresolved",
            policyRuleId: "v9.control.oracle-review",
            rationale: "At least one identified path lacks current verified pricing applicability.",
            gapId: `extension-gap:oracle:${meta.id}`,
          },
        }
      : requiredStatus(
          "v9.control.oracle-review",
          topState,
          `oracle:${meta.id}`,
          topState === "known" || topState === "bounded-unknown" ? evidenceKeys : [],
        ),
    tier: topState === "missing" ? null : materiality.tier,
    ...(unresolvedPaths && reviewedObservationState(confidence) === "known" &&
        paths?.some((path) => path.applicability.state === "required" && path.observationState === "known")
      ? { knownPathTier: materiality.tier }
      : {}),
    liquidationBranchesApplicable: paths ? branchesRequired : profile.branchApplicability?.disposition !== "top-level-only",
    ...(materiality.subMaterialWeakBand !== undefined
      ? { subMaterialWeakBand: materiality.subMaterialWeakBand }
      : {}),
    branches,
    ...(paths ? { paths } : {}),
  };
}
