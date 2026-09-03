import {
  evaluateV9ExitAssetFacts,
  resolveV9ExitCapacityAtRequest,
  selectV9ExitStressRequest,
} from "@shared/lib/safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import type {
  V9AssetFactsV2,
  V9DeploymentControlFactV2,
  V9EconomicControlReviewV2,
  V9EffectiveDependenciesV3,
  V9ExitRouteFactV2,
  V9FactStatusV2,
  V9ReserveExposureFactV2,
} from "@shared/types/safety-score-v9-facts";
import {
  V9WrapperLocalFactsSchema,
  type V9ApplicableWrapperLocalFacts,
  type V9WrapperFactDisposition,
  type V9WrapperLocalDimensionFact,
  type V9WrapperLocalFacts,
  type V9WrapperRiskAssessment,
} from "@shared/types/safety-score-v9-wrapper";
import {
  componentResearchEvidence,
  fallbackResearchEvidence,
  type AssetBuildContext,
} from "./fact-set-context";

interface WrapperLocalFactBuildInputs {
  implementation: V9AssetFactsV2["implementation"];
  dependencies: V9EffectiveDependenciesV3;
  reserveStatus: V9FactStatusV2;
  reserveExposures: readonly V9ReserveExposureFactV2[];
  exitStatus: V9FactStatusV2;
  exitRoutes: readonly V9ExitRouteFactV2[];
  controlStatus: V9FactStatusV2;
  controls: readonly V9DeploymentControlFactV2[];
  economicControlReview: V9EconomicControlReviewV2;
  peg: V9AssetFactsV2["peg"];
  supply: V9AssetFactsV2["supply"];
}

export function resolveWrapperForm(
  asset: AssetBuildContext["asset"],
  dependencies?: V9EffectiveDependenciesV3,
): V9ApplicableWrapperLocalFacts["form"] | null {
  if (asset.variantKind === "pure-wrapper") return "pure";
  if (asset.variantKind === "savings-passthrough") return "native-staked";
  if (asset.variantKind === "risk-absorption") {
    return asset.wrapperOperator === "third-party" ? "strategy-vault" : "native-staked";
  }
  if (
    asset.variantKind === "strategy-vault" ||
    dependencies?.edges.some(
      (edge) => edge.pathKind === "serial-dependency" && edge.dependencyType === "wrapper",
    )
  ) {
    return "strategy-vault";
  }
  return null;
}

function uniqueEvidenceRefIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function wrapperFactDisposition(
  context: AssetBuildContext,
  statuses: readonly V9FactStatusV2[],
  fallback: Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable"> = "integration-missing",
): Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable"> {
  const responsibilities = statuses.flatMap((status) =>
    status.gapIds.flatMap((gapId) => {
      const responsibility = context.gaps.get(gapId)?.responsibility;
      return responsibility ? [responsibility] : [];
    }),
  );
  if (responsibilities.includes("issuer-undisclosed")) return "issuer-undisclosed";
  if (responsibilities.includes("method-unsupported")) return "method-unsupported";
  if (
    responsibilities.includes("producer-failed") ||
    statuses.some((status) => status.observationState === "stale")
  ) {
    return "producer-failed";
  }
  return fallback;
}

function reviewedWrapperFact(
  context: AssetBuildContext,
  assessment: V9WrapperRiskAssessment,
  signals: readonly string[],
  evidenceRefIds: readonly string[],
): V9WrapperLocalDimensionFact {
  const evidence = uniqueEvidenceRefIds(evidenceRefIds);
  return {
    disposition: "reviewed",
    assessment,
    signals: [...signals],
    evidenceRefIds: evidence.length > 0 ? evidence : [fallbackResearchEvidence(context)],
  };
}

function unavailableWrapperFact(
  disposition: Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable">,
  signal: string,
  evidenceRefIds: readonly string[] = [],
): V9WrapperLocalDimensionFact {
  return {
    disposition,
    assessment: null,
    signals: [signal],
    evidenceRefIds: uniqueEvidenceRefIds(evidenceRefIds),
  };
}

function notApplicableWrapperFact(signal: string, evidenceRefIds: readonly string[] = []): V9WrapperLocalDimensionFact {
  return {
    disposition: "not-applicable",
    assessment: null,
    signals: [signal],
    evidenceRefIds: uniqueEvidenceRefIds(evidenceRefIds),
  };
}

function isDirectSerialWrapper(
  context: AssetBuildContext,
  form: V9ApplicableWrapperLocalFacts["form"],
  wrapperEdge: V9EffectiveDependenciesV3["edges"][number] | undefined,
): boolean {
  // No tracked serial parent edge means we cannot prove the wrapper is a direct
  // pass-through, so it is NOT treated as one and keeps the conservative
  // `issuer-undisclosed` dispositions. This is the fail-closed path and it is
  // deliberately not an assertion: a missing edge is a registry-completeness
  // condition, and throwing here would abort the whole asset's compilation and
  // take unrelated facts down with it — a wM fixture with no wrapper edge lost
  // its entire supply observation and reported `missing-pillar-evidence` instead
  // of its real bridge-route gap.
  if (wrapperEdge === undefined) return false;
  return (
    (form === "pure" && context.asset.variantKind === "pure-wrapper") ||
    (form === "native-staked" && context.asset.variantKind === "savings-passthrough")
  );
}

function parseLeverageFactor(factor: string): number | null {
  // Kept at star height 1 so the pattern is linear on curated risk-factor prose.
  // Two shapes are deliberately avoided: overlapping `\s*` runs around an
  // alternation that itself matches `\s`, which lets one whitespace run split
  // many ways; and a nested numeric quantifier like `(?:\.\d+)?`. The digits are
  // captured loosely as `[\d.]+` and validated by Number instead, so "1.2.3"
  // parses to NaN and is rejected below rather than by the pattern.
  const match = factor.match(
    /\bleverage[-\s]?(?:factor)?(?:\s*[:=]\s*|\s+)([\d.]+)\s?x?\b/i,
  );
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function leverageFactorAssessment(factor: number): V9WrapperRiskAssessment {
  if (factor <= 1.000001) return "none";
  if (factor <= 1.1) return "low";
  if (factor <= 1.5) return "moderate";
  if (factor <= 2) return "high";
  return "critical";
}

type WrapperAllocationReview = NonNullable<AssetBuildContext["asset"]["wrapperAllocationReview"]>;

function wrapperAllocationLeverageAssessment(
  leverage: WrapperAllocationReview["localLeverage"],
): V9WrapperRiskAssessment {
  switch (leverage) {
    case "no-borrowing-surface":
      return "none";
    case "bounded-up-to-1.1x":
      return "low";
    case "bounded-up-to-1.5x":
      return "moderate";
    case "bounded-up-to-2x":
      return "high";
    case "unbounded-or-above-2x":
      return "critical";
  }
}

function wrapperAllocationReuseAssessment(
  capitalReuse: WrapperAllocationReview["capitalReuse"],
): V9WrapperRiskAssessment {
  switch (capitalReuse) {
    case "none":
      return "none";
    case "bluechip-overcollateralized-lending":
      return "low";
    case "mixed-overcollateralized-lending":
      return "moderate";
    case "long-tail-overcollateralized-lending":
    case "multi-strategy-reuse":
    case "liquidation-loss-absorption":
    case "single-borrower-risk-capital":
      return "high";
  }
}

function allocationCanResolveWrapperFact(fact: V9WrapperLocalDimensionFact): boolean {
  return (
    fact.disposition === "issuer-undisclosed" ||
    fact.disposition === "integration-missing" ||
    fact.disposition === "producer-failed" ||
    fact.disposition === "method-unsupported"
  );
}

function resolveWrapperFactFromAllocation(
  existing: V9WrapperLocalDimensionFact,
  resolution: V9WrapperLocalDimensionFact,
): V9WrapperLocalDimensionFact {
  return allocationCanResolveWrapperFact(existing)
    ? {
        ...resolution,
        evidenceRefIds: uniqueEvidenceRefIds([
          ...existing.evidenceRefIds,
          ...resolution.evidenceRefIds,
        ]),
      }
    : existing;
}

function assertDirectSerialWrapperFactDispositionInvariant(
  context: AssetBuildContext,
  directSerialWrapper: boolean,
  facts: Pick<
    V9ApplicableWrapperLocalFacts["facts"],
    "custodyEscrow" | "leverage" | "rehypothecationCorrelation"
  >,
): void {
  if (!directSerialWrapper || context.asset.wrapperCustodyReview != null) return;
  const issuerUndisclosedFacts = (
    [
      ["custodyEscrow", facts.custodyEscrow],
      ["leverage", facts.leverage],
      ["rehypothecationCorrelation", facts.rehypothecationCorrelation],
    ] as const
  )
    .filter(([, fact]) => fact.disposition === "issuer-undisclosed")
    .map(([factKey]) => factKey);
  if (issuerUndisclosedFacts.length > 0) {
    throw new Error(
      `Safety Score v9 wrapper invariant violated for ${context.asset.assetId}: ` +
        `profileless direct serial wrapper emitted issuer-undisclosed for ${issuerUndisclosedFacts.join(",")}`,
    );
  }
}

function wrapperControlRisk(
  control: V9DeploymentControlFactV2,
): { assessment: V9WrapperRiskAssessment; signals: string[] } {
  if (control.incidentState === "active") {
    return { assessment: "critical", signals: [`active-control-incident:${control.controlKey}`] };
  }
  if (
    control.claimImpairment === "unbounded" ||
    control.economicLossScope === "global-claim" ||
    control.capSemantics.kind === "unbounded"
  ) {
    return { assessment: "high", signals: [`unbounded-claim-control:${control.controlKey}`] };
  }
  if (
    control.claimImpairment === "bounded" ||
    control.economicLossScope === "reserve-claim" ||
    control.capSemantics.kind === "raiseable"
  ) {
    return { assessment: "moderate", signals: [`claim-affecting-control:${control.controlKey}`] };
  }
  return { assessment: "low", signals: [`non-claim-control:${control.controlKey}`] };
}

function worstWrapperRisk(values: readonly V9WrapperRiskAssessment[]): V9WrapperRiskAssessment {
  const rank: Readonly<Record<V9WrapperRiskAssessment, number>> = {
    none: 0,
    low: 1,
    moderate: 2,
    high: 3,
    critical: 4,
  };
  return [...values].sort((left, right) => rank[right] - rank[left])[0] ?? "none";
}

function isReviewableLocalControlStatus(status: V9FactStatusV2): boolean {
  return status.observationState === "known" || status.observationState === "bounded-unknown";
}

interface WrapperLocalBuildState {
  form: V9ApplicableWrapperLocalFacts["form"];
  wrapperEdge: V9EffectiveDependenciesV3["edges"][number] | undefined;
  reviewedFormEvidence: string[];
  controlEvidenceRefIds: string[];
  reserveEvidenceRefIds: string[];
  allocationEvidenceRefIds: string[];
  routeEvidenceRefIds: string[];
}

function buildWrapperStructuralDimensions(
  context: AssetBuildContext,
  input: WrapperLocalFactBuildInputs,
  state: WrapperLocalBuildState,
): {
  contractMutability: V9WrapperLocalDimensionFact;
  custodyEscrow: V9WrapperLocalDimensionFact;
  strategyComplexity: V9WrapperLocalDimensionFact;
  leverage: V9WrapperLocalDimensionFact;
  rehypothecationCorrelation: V9WrapperLocalDimensionFact;
  shareAccountingNavOracle: V9WrapperLocalDimensionFact;
} {
  const {
    form,
    wrapperEdge,
    reviewedFormEvidence,
    controlEvidenceRefIds,
    reserveEvidenceRefIds,
    allocationEvidenceRefIds,
  } = state;
  const directSerialWrapper = isDirectSerialWrapper(context, form, wrapperEdge);
  const allocation = context.asset.wrapperAllocationReview ?? null;
  let contractMutability: V9WrapperLocalDimensionFact;
  const upgrade = input.economicControlReview.mint.upgrade;
  if (input.economicControlReview.mint.status.observationState !== "known") {
    contractMutability = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.economicControlReview.mint.status]),
      "wrapper-upgrade-review-unavailable",
      controlEvidenceRefIds,
    );
  } else if (upgrade.state === "immutable" || upgrade.state === "not-applicable") {
    contractMutability = reviewedWrapperFact(
      context,
      "none",
      [`wrapper-upgrade-state:${upgrade.state}`],
      controlEvidenceRefIds,
    );
  } else if (upgrade.state === "reviewed" && upgrade.controlKey !== null) {
    const upgradeControl = input.controls.find((control) => control.controlKey === upgrade.controlKey);
    if (!upgradeControl || upgradeControl.status.observationState !== "known") {
      contractMutability = unavailableWrapperFact(
        "integration-missing",
        `reviewed-upgrade-control-not-compiled:${upgrade.controlKey}`,
        controlEvidenceRefIds,
      );
    } else {
      const delayAssessment: V9WrapperRiskAssessment =
        upgradeControl.delaySec === null || upgradeControl.delaySec < 86_400
          ? "high"
          : upgradeControl.delaySec < 604_800
            ? "moderate"
            : "low";
      const authorityRisk = wrapperControlRisk(upgradeControl);
      contractMutability = reviewedWrapperFact(
        context,
        worstWrapperRisk([delayAssessment, authorityRisk.assessment]),
        [
          `wrapper-upgrade-authority:${upgradeControl.authority?.model ?? "unknown"}`,
          `wrapper-upgrade-delay-sec:${upgradeControl.delaySec ?? "undisclosed"}`,
          ...authorityRisk.signals,
        ],
        controlEvidenceRefIds,
      );
    }
  } else {
    contractMutability = unavailableWrapperFact(
      "issuer-undisclosed",
      "wrapper-upgrade-authority-undisclosed",
      controlEvidenceRefIds,
    );
  }

  let custodyEscrow: V9WrapperLocalDimensionFact;
  const custody = context.asset.wrapperCustodyReview ?? null;
  if (custody !== null) {
    const custodyEvidence = componentResearchEvidence(context, "wrapper-local:custodyEscrow");
    const hasUnknown =
      custody.segregation === "unknown" ||
      custody.bankruptcyRemoteness === "unknown" ||
      custody.knownUnknownExposureShare === null ||
      custody.knownUnknownExposureShare > 0;
    custodyEscrow = hasUnknown
      ? unavailableWrapperFact(
          "issuer-undisclosed",
          `wrapper-custody-terms-incomplete:${custody.knownUnknownExposureShare ?? "unknown"}`,
          custodyEvidence,
        )
      : reviewedWrapperFact(
          context,
          custody.segregation === "segregated" && custody.bankruptcyRemoteness === "structured"
            ? "low"
            : custody.bankruptcyRemoteness === "none"
              ? "high"
              : "moderate",
          [
            `wrapper-custody-providers:${custody.providers.length}`,
            `wrapper-custody-segregation:${custody.segregation}`,
            `wrapper-custody-bankruptcy-remoteness:${custody.bankruptcyRemoteness}`,
          ],
          custodyEvidence,
        );
  } else if (directSerialWrapper) {
    custodyEscrow = notApplicableWrapperFact(
      form === "pure"
        ? "pure-wrapper-custody-is-the-serial-parent-contract-claim"
        : "savings-passthrough-has-no-local-custody-or-escrow",
      uniqueEvidenceRefIds([...reviewedFormEvidence, ...allocationEvidenceRefIds]),
    );
  } else {
    custodyEscrow = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.reserveStatus], "issuer-undisclosed"),
      "wrapper-custody-or-escrow-review-unavailable",
      reserveEvidenceRefIds,
    );
  }
  if (allocation !== null) {
    custodyEscrow = resolveWrapperFactFromAllocation(
      custodyEscrow,
      notApplicableWrapperFact(
        "reviewed-allocation-is-fully-onchain-with-no-offchain-custodian",
        allocationEvidenceRefIds,
      ),
    );
  }

  let strategyComplexity: V9WrapperLocalDimensionFact;
  if (form === "pure" && wrapperEdge !== undefined) {
    strategyComplexity = reviewedWrapperFact(
      context,
      "none",
      ["pure-wrapper-has-no-local-strategy"],
      reviewedFormEvidence,
    );
  } else if (form === "native-staked") {
    const riskAbsorption = context.asset.variantKind === "risk-absorption";
    strategyComplexity = reviewedWrapperFact(
      context,
      riskAbsorption ? "moderate" : "low",
      [
        riskAbsorption
          ? "native-wrapper-adds-reviewed-loss-absorption-layer"
          : "native-wrapper-is-single-parent-savings-passthrough",
      ],
      reviewedFormEvidence,
    );
  } else if (form === "strategy-vault") {
    const highComplexity =
      input.reserveExposures.some((exposure) => exposure.assetClass === "private-credit") ||
      (custody?.knownUnknownExposureShare ?? 0) > 0;
    strategyComplexity = reviewedWrapperFact(
      context,
      highComplexity ? "high" : "moderate",
      [
        highComplexity
          ? "strategy-vault-has-private-or-unknown-credit-exposure"
          : "strategy-vault-adds-third-party-allocation-layer",
        `wrapper-strategy-reserve-components:${input.reserveExposures.length}`,
      ],
      uniqueEvidenceRefIds([...reviewedFormEvidence, ...reserveEvidenceRefIds]),
    );
  } else {
    strategyComplexity = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.reserveStatus]),
      "wrapper-strategy-complexity-review-unavailable",
      reserveEvidenceRefIds,
    );
  }

  let leverage: V9WrapperLocalDimensionFact;
  if (directSerialWrapper) {
    leverage = notApplicableWrapperFact(
      form === "pure"
        ? "pure-wrapper-has-no-local-strategy-leverage"
        : "savings-passthrough-has-no-local-borrowing-surface",
      reviewedFormEvidence,
    );
  } else if (input.reserveStatus.observationState === "known") {
    const leverageFactorObservations = input.reserveExposures.flatMap((exposure) =>
      exposure.riskFactors.flatMap((factor) => {
        const value = parseLeverageFactor(factor);
        return value === null ? [] : [{ factor, value }];
      }),
    );
    const leverageFactors = input.reserveExposures.flatMap((exposure) =>
      exposure.riskFactors.filter(
        (factor) =>
          parseLeverageFactor(factor) === null &&
          /\b(leverage|leveraged|borrowing|debt-financed)\b/i.test(factor),
      ),
    );
    leverage =
      leverageFactorObservations.length > 0
        ? reviewedWrapperFact(
            context,
            worstWrapperRisk(leverageFactorObservations.map(({ value }) => leverageFactorAssessment(value))),
            leverageFactorObservations.map(({ factor }) => `wrapper-leverage-factor:${factor}`),
            reserveEvidenceRefIds,
          )
        : leverageFactors.length > 0
        ? reviewedWrapperFact(
            context,
            "high",
            leverageFactors.map((factor) => `wrapper-leverage-factor:${factor}`),
            reserveEvidenceRefIds,
          )
        : unavailableWrapperFact(
            "issuer-undisclosed",
            "wrapper-leverage-review-does-not-establish-absence",
            reserveEvidenceRefIds,
          );
  } else {
    leverage = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.reserveStatus], "issuer-undisclosed"),
      "wrapper-leverage-review-unavailable",
      reserveEvidenceRefIds,
    );
  }
  if (allocation !== null) {
    leverage = resolveWrapperFactFromAllocation(
      leverage,
      reviewedWrapperFact(
        context,
        wrapperAllocationLeverageAssessment(allocation.localLeverage),
        [
          `wrapper-allocation-local-leverage:${allocation.localLeverage}`,
          `wrapper-allocation-observation-count:${allocation.observations.length}`,
        ],
        allocationEvidenceRefIds,
      ),
    );
  }

  let rehypothecationCorrelation: V9WrapperLocalDimensionFact;
  if (custody !== null) {
    const custodyEvidence = componentResearchEvidence(context, "wrapper-local:rehypothecationCorrelation");
    rehypothecationCorrelation =
      custody.rehypothecation === "unknown"
        ? unavailableWrapperFact(
            "issuer-undisclosed",
            "wrapper-rehypothecation-terms-undisclosed",
            custodyEvidence,
          )
        : reviewedWrapperFact(
            context,
            custody.rehypothecation === "prohibited"
              ? "low"
              : custody.rehypothecation === "conditional"
                ? "moderate"
                : "high",
            [
              `wrapper-rehypothecation:${custody.rehypothecation}`,
              `wrapper-custody-provider-count:${custody.providers.length}`,
            ],
            custodyEvidence,
          );
  } else if (directSerialWrapper) {
    rehypothecationCorrelation = notApplicableWrapperFact(
      form === "pure"
        ? "pure-wrapper-parent-correlation-is-applied-by-serial-dependency"
        : "savings-passthrough-holds-one-parent-and-reuses-nothing",
      uniqueEvidenceRefIds([...reviewedFormEvidence, ...allocationEvidenceRefIds]),
    );
  } else {
    rehypothecationCorrelation = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.reserveStatus], "issuer-undisclosed"),
      "wrapper-rehypothecation-correlation-review-unavailable",
      reserveEvidenceRefIds,
    );
  }
  if (allocation !== null) {
    rehypothecationCorrelation = resolveWrapperFactFromAllocation(
      rehypothecationCorrelation,
      reviewedWrapperFact(
        context,
        wrapperAllocationReuseAssessment(allocation.capitalReuse),
        [
          `wrapper-allocation-capital-reuse:${allocation.capitalReuse}`,
          `wrapper-allocation-observation-count:${allocation.observations.length}`,
        ],
        allocationEvidenceRefIds,
      ),
    );
  }

  let shareAccountingNavOracle: V9WrapperLocalDimensionFact;
  if (form === "pure") {
    shareAccountingNavOracle = reviewedWrapperFact(
      context,
      "none",
      ["pure-wrapper-fixed-parent-claim-accounting"],
      reviewedFormEvidence,
    );
  } else if (
    (context.asset.variantKind === "savings-passthrough" ||
      context.asset.variantKind === "risk-absorption" ||
      context.asset.variantKind === "strategy-vault") &&
    input.peg.referenceKind === "nav" &&
    input.peg.status.observationState === "known"
  ) {
    const oracleTier = input.economicControlReview.oracle.tier;
    const weakOracle =
      oracleTier === "privileged-internal-pricing" ||
      oracleTier === "single-source-or-laggy" ||
      oracleTier === "opaque-or-unknown";
    shareAccountingNavOracle = reviewedWrapperFact(
      context,
      weakOracle ? "high" : "moderate",
      [
        `wrapper-share-form:${context.asset.variantKind}`,
        `wrapper-share-reference-kind:${input.peg.referenceKind}`,
        `wrapper-share-oracle-tier:${oracleTier ?? "not-applicable"}`,
      ],
      uniqueEvidenceRefIds([
        ...reviewedFormEvidence,
        ...input.peg.status.evidenceRefIds,
        ...input.economicControlReview.oracle.status.evidenceRefIds,
      ]),
    );
  } else {
    shareAccountingNavOracle = unavailableWrapperFact(
      wrapperFactDisposition(
        context,
        [input.peg.status, input.economicControlReview.mint.status],
        "integration-missing",
      ),
      "wrapper-share-accounting-or-nav-oracle-review-unavailable",
      [...input.peg.status.evidenceRefIds, ...input.economicControlReview.mint.status.evidenceRefIds],
    );
  }
  return {
    contractMutability,
    custodyEscrow,
    strategyComplexity,
    leverage,
    rehypothecationCorrelation,
    shareAccountingNavOracle,
  };
}

function buildWrapperExitDimensions(
  context: AssetBuildContext,
  input: WrapperLocalFactBuildInputs,
  state: WrapperLocalBuildState,
): {
  withdrawalTerms: V9WrapperLocalDimensionFact;
  measuredUnwind: V9WrapperLocalDimensionFact;
} {
  const { routeEvidenceRefIds } = state;
  const knownRedemptionRoutes = input.exitRoutes.filter(
    (route) =>
      route.lane === "redemption" &&
      (route.status.observationState === "known" || route.status.observationState === "stale"),
  );
  let withdrawalTerms: V9WrapperLocalDimensionFact;
  if (knownRedemptionRoutes.length === 0) {
    withdrawalTerms = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.exitStatus]),
      "wrapper-withdrawal-fee-or-gate-terms-unavailable",
      routeEvidenceRefIds,
    );
  } else if (knownRedemptionRoutes.some((route) => route.feeEvidence === "undisclosed-reviewed")) {
    withdrawalTerms = unavailableWrapperFact(
      "issuer-undisclosed",
      "wrapper-withdrawal-fee-undisclosed",
      routeEvidenceRefIds,
    );
  } else {
    const termsRisk = knownRedemptionRoutes.map((route): V9WrapperRiskAssessment => {
      if (
        route.holderAccess === "issuer-only" ||
        route.executionModel === "discretionary" ||
        route.executionCertainty === "discretionary"
      ) {
        return "critical";
      }
      if (route.settlementModel === "queued" || route.executionModel === "queued") {
        return (route.settlementSlaSec ?? Number.POSITIVE_INFINITY) > 604_800 ? "high" : "moderate";
      }
      if (
        route.holderAccess === "allowlisted" ||
        route.holderAccess === "institutional-eligible" ||
        route.executionCertainty === "conditional"
      ) {
        return "moderate";
      }
      return "low";
    });
    withdrawalTerms = reviewedWrapperFact(
      context,
      worstWrapperRisk(termsRisk),
      knownRedemptionRoutes.flatMap((route) => [
        `wrapper-withdrawal-access:${route.holderAccess}`,
        `wrapper-withdrawal-execution:${route.executionModel}`,
        `wrapper-withdrawal-settlement:${route.settlementModel}:${route.settlementSlaSec ?? "atomic"}`,
      ]),
      routeEvidenceRefIds,
    );
  }

  const stressRequest =
    input.supply.status.observationState === "known"
      ? selectV9ExitStressRequest(input.supply.circulatingUsd, V9_CANDIDATE_POLICY_V1)
      : null;
  const admittedDocumentedUnwindRouteKeys =
    stressRequest === null
      ? new Set<string>()
      : new Set(
          evaluateV9ExitAssetFacts(
            {
              supply: input.supply,
              exitStatus: input.exitStatus,
              exitRoutes: [...input.exitRoutes],
            },
            V9_CANDIDATE_POLICY_V1,
          ).routes.flatMap((route) => (route.included ? [route.routeKey] : [])),
        );
  const observedUnwindRoutes = input.exitRoutes.filter(
    (route) =>
      (route.status.observationState === "known" && route.scoreEligible && route.capacityCurve.length > 0) ||
      // Undisclosed-fee credit is conditionally withheld by a later danger gate
      // that is unavailable while facts are being compiled.
      (route.feeEvidence !== "undisclosed-reviewed" &&
        admittedDocumentedUnwindRouteKeys.has(route.routeKey)),
  );
  let measuredUnwind: V9WrapperLocalDimensionFact;
  const stressCompletions =
    stressRequest === null
      ? []
      : observedUnwindRoutes.flatMap((route) => {
          const point = resolveV9ExitCapacityAtRequest(route.capacityCurve, stressRequest);
          return point === null ? [] : [point.completionRatio];
        });
  if (stressCompletions.length > 0) {
    const bestCompletion = Math.max(...stressCompletions);
    measuredUnwind = reviewedWrapperFact(
      context,
      bestCompletion >= 0.95
        ? "none"
        : bestCompletion >= 0.8
          ? "low"
          : bestCompletion >= 0.5
            ? "moderate"
            : bestCompletion > 0
              ? "high"
              : "critical",
      [
        `wrapper-measured-unwind-policy-notional:${stressRequest!.requestedNotionalUsd}`,
        `wrapper-measured-unwind-policy-completion:${bestCompletion}`,
        `wrapper-measured-unwind-route-count:${observedUnwindRoutes.length}`,
      ],
      routeEvidenceRefIds,
    );
  } else if (input.exitStatus.observationState === "known" && stressRequest !== null) {
    measuredUnwind = reviewedWrapperFact(
      context,
      "critical",
      ["wrapper-measured-unwind:no-score-eligible-capacity"],
      routeEvidenceRefIds,
    );
  } else {
    measuredUnwind = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.exitStatus], "producer-failed"),
      "wrapper-measured-unwind-unavailable",
      routeEvidenceRefIds,
    );
  }
  return { withdrawalTerms, measuredUnwind };
}

function buildWrapperLossAbsorptionFact(
  context: AssetBuildContext,
  input: WrapperLocalFactBuildInputs,
  state: WrapperLocalBuildState,
): V9WrapperLocalDimensionFact {
  const { reviewedFormEvidence, controlEvidenceRefIds } = state;
  let lossAbsorptionEmergencyControls: V9WrapperLocalDimensionFact;
  if (
    context.asset.variantKind === "pure-wrapper" ||
    context.asset.variantKind === "savings-passthrough"
  ) {
    lossAbsorptionEmergencyControls = notApplicableWrapperFact(
      "wrapper-design-has-no-local-holder-loss-absorption-layer",
      reviewedFormEvidence,
    );
  } else {
    const localControls =
      context.asset.variantKind === "strategy-vault"
        ? input.controls.filter((control) => control.controlKind !== "bridge")
        : [];
    const reviewableLocalControls = localControls.filter((control) =>
      isReviewableLocalControlStatus(control.status),
    );
    if (input.controlStatus.observationState === "known" || reviewableLocalControls.length > 0) {
      const controlsForRisk =
        input.controlStatus.observationState === "known" ? localControls : reviewableLocalControls;
      const controlRisks = controlsForRisk.map(wrapperControlRisk);
      const partialControlReview = input.controlStatus.observationState !== "known";
      lossAbsorptionEmergencyControls =
        controlRisks.length > 0
          ? reviewedWrapperFact(
              context,
              worstWrapperRisk([
                ...controlRisks.map((risk) => risk.assessment),
                ...(context.asset.variantKind === "risk-absorption" ? (["moderate"] as const) : []),
              ]),
              [
                ...controlRisks.flatMap((risk) => risk.signals),
                ...(partialControlReview ? ["wrapper-local-controls-partial-review"] : []),
                ...(context.asset.variantKind === "risk-absorption"
                  ? ["wrapper-holder-bears-protocol-loss-absorption"]
                  : ["strategy-vault-holder-loss-controls-reviewed"]),
              ],
              controlEvidenceRefIds,
            )
          : unavailableWrapperFact(
              "integration-missing",
              "wrapper-emergency-control-review-has-no-local-controls",
              controlEvidenceRefIds,
            );
    } else {
      lossAbsorptionEmergencyControls = unavailableWrapperFact(
        wrapperFactDisposition(context, [input.controlStatus]),
        "wrapper-loss-absorption-or-emergency-control-review-unavailable",
        controlEvidenceRefIds,
      );
    }
  }
  return lossAbsorptionEmergencyControls;
}

export function buildWrapperLocalFacts(
  context: AssetBuildContext,
  input: WrapperLocalFactBuildInputs,
): V9WrapperLocalFacts {
  const wrapperEdge = input.dependencies.edges.find(
    (edge) => edge.pathKind === "serial-dependency" && edge.dependencyType === "wrapper",
  );
  const form = resolveWrapperForm(context.asset, input.dependencies);
  const formEvidenceRefIds = uniqueEvidenceRefIds([
    ...input.implementation.status.evidenceRefIds,
    ...input.dependencies.status.evidenceRefIds,
    ...(wrapperEdge?.evidenceRefIds ?? []),
  ]);
  if (form === null) {
    return V9WrapperLocalFactsSchema.parse({
      schemaVersion: 1,
      applicability: "not-wrapper",
      evidenceRefIds:
        formEvidenceRefIds.length > 0 ? formEvidenceRefIds : [fallbackResearchEvidence(context)],
    });
  }
  const reviewedFormEvidence =
    formEvidenceRefIds.length > 0 ? formEvidenceRefIds : [fallbackResearchEvidence(context)];
  const controlEvidenceRefIds = uniqueEvidenceRefIds([
    ...input.controlStatus.evidenceRefIds,
    ...input.economicControlReview.mint.status.evidenceRefIds,
    ...input.controls.flatMap((control) => control.status.evidenceRefIds),
  ]);
  const reserveEvidenceRefIds = uniqueEvidenceRefIds([
    ...input.reserveStatus.evidenceRefIds,
    ...input.reserveExposures.flatMap((exposure) => exposure.status.evidenceRefIds),
    ...(wrapperEdge?.evidenceRefIds ?? []),
  ]);
  const allocationEvidenceRefIds =
    context.asset.wrapperAllocationReview === null || context.asset.wrapperAllocationReview === undefined
      ? []
      : componentResearchEvidence(context, "wrapper-local:leverage");
  const routeEvidenceRefIds = uniqueEvidenceRefIds([
    ...input.exitStatus.evidenceRefIds,
    ...input.exitRoutes.flatMap((route) => [
      ...route.status.evidenceRefIds,
      ...route.settlementEvidenceRefIds,
      ...route.output.status.evidenceRefIds,
      ...(route.output.valuation?.evidenceRefIds ?? []),
    ]),
  ]);
  const state: WrapperLocalBuildState = {
    form,
    wrapperEdge,
    reviewedFormEvidence,
    controlEvidenceRefIds,
    reserveEvidenceRefIds,
    allocationEvidenceRefIds,
    routeEvidenceRefIds,
  };
  const {
    contractMutability,
    custodyEscrow,
    strategyComplexity,
    leverage,
    rehypothecationCorrelation,
    shareAccountingNavOracle,
  } = buildWrapperStructuralDimensions(context, input, state);
  assertDirectSerialWrapperFactDispositionInvariant(context, isDirectSerialWrapper(context, form, wrapperEdge), {
    custodyEscrow,
    leverage,
    rehypothecationCorrelation,
  });
  const { withdrawalTerms, measuredUnwind } = buildWrapperExitDimensions(
    context,
    input,
    state,
  );
  const lossAbsorptionEmergencyControls = buildWrapperLossAbsorptionFact(
    context,
    input,
    state,
  );

  const facts: V9ApplicableWrapperLocalFacts = {
    schemaVersion: 1,
    applicability: "wrapper",
    form,
    formDisposition: "reviewed",
    formSignals: [
      `wrapper-form:${form}`,
      `wrapper-form-source:${context.asset.variantKind ?? "serial-wrapper-dependency"}`,
      ...(context.asset.wrapperOperator === undefined
        ? []
        : [`wrapper-operator:${context.asset.wrapperOperator}`]),
    ],
    formEvidenceRefIds: reviewedFormEvidence,
    facts: {
      contractMutability,
      custodyEscrow,
      strategyComplexity,
      leverage,
      rehypothecationCorrelation,
      shareAccountingNavOracle,
      withdrawalTerms,
      measuredUnwind,
      lossAbsorptionEmergencyControls,
    },
    riskTransfer: {
      disposition: "not-applicable",
      mechanism: "none",
      maximumParentLossAbsorptionPoints: 0,
      signals: ["no-documented-parent-loss-absorption-credit"],
      evidenceRefIds: [],
    },
  };
  return V9WrapperLocalFactsSchema.parse(facts);
}
