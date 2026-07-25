import type {
  V9MethodologySemantic,
  V9QualityPillar,
} from "../../types/safety-score-v9";
import type {
  V9OperationalResilienceClaimConfidence,
  V9OperationalResilienceFact,
} from "../../types/safety-score-v9-operational-resilience";

export type V9OperationalResiliencePolicy = V9MethodologySemantic["operationalResilience"];

/**
 * Runtime market-depth evidence is deliberately separate from the curated
 * operational fact. The scorer derives this claim from a fresh conservative
 * measured-execution history at the policy-relevant notional.
 */
export interface V9OperationalResilienceMeasuredMarketDepth {
  completeProducerCycleCount: number;
  successfulObservationCount: number;
  conservativeCompletionRatio: number;
  evidenceRefIds: readonly string[];
}

/**
 * Canonical launch history can qualify independently measured market depth for
 * resilience credit without requiring an asset-specific editorial overlay.
 * It is eligibility-only and cannot create a scored contribution by itself.
 */
export interface V9OperationalResilienceImplementationHistory {
  minimumLiveHistoryMonths: number;
  evidenceRefIds: readonly string[];
}

export interface V9OperationalResilienceBlockers {
  activeDepeg: boolean;
  globalReserveImpairment: boolean;
  criticalControlFailure: boolean;
  criticalDependency: boolean;
  issuerOpacity: boolean;
}

export type V9OperationalResilienceBlockerCode =
  | keyof V9OperationalResilienceBlockers
  | "activeMaterialIncident";

export type V9OperationalResilienceContributionComponent =
  | "cumulative-redemption"
  | "stress-redemption"
  | "persistent-market-depth"
  | "stress-recovery"
  | "reserve-reconciliation";

export type V9OperationalResilienceContributionConfidence =
  | V9OperationalResilienceClaimConfidence
  | "measured";

export interface V9OperationalResilienceContribution {
  component: V9OperationalResilienceContributionComponent;
  pillar: V9QualityPillar;
  basePoints: number;
  confidence: V9OperationalResilienceContributionConfidence;
  confidenceMultiplier: number;
  points: number;
  evidenceRefIds: readonly string[];
}

export interface V9OperationalResilienceEligibilityTrace {
  requiredLiveHistoryMonths: number;
  documentedLiveHistoryMonths: number | null;
  confidence: V9OperationalResilienceClaimConfidence | "implementation-history" | null;
  evidenceRefIds: readonly string[];
  satisfied: boolean;
}

export interface V9OperationalResilienceResult {
  eligible: boolean;
  eligibility: V9OperationalResilienceEligibilityTrace;
  rawPillarCredits: Readonly<Record<V9QualityPillar, number>>;
  pillarCredits: Readonly<Record<V9QualityPillar, number>>;
  contributions: readonly V9OperationalResilienceContribution[];
  blockerCodes: readonly V9OperationalResilienceBlockerCode[];
}

const ZERO_CREDITS: Readonly<Record<V9QualityPillar, number>> = {
  backing: 0,
  exit: 0,
  control: 0,
};

const COMPONENT_ORDER: Readonly<Record<V9OperationalResilienceContributionComponent, number>> = {
  "cumulative-redemption": 0,
  "stress-redemption": 1,
  "persistent-market-depth": 2,
  "stress-recovery": 3,
  "reserve-reconciliation": 4,
};

const PILLAR_ORDER: Readonly<Record<V9QualityPillar, number>> = {
  backing: 0,
  exit: 1,
  control: 2,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalEvidence(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort(compareText);
}

function roundCredit(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function finiteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Safety Score v9 ${field} must be finite and non-negative`);
  }
}

function finiteRatio(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Safety Score v9 ${field} must be a finite ratio`);
  }
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Safety Score v9 ${field} must be a non-negative integer`);
  }
}

function confidenceMultiplier(
  confidence: V9OperationalResilienceContributionConfidence,
  policy: V9OperationalResiliencePolicy,
): number {
  if (confidence === "unknown") return 0;
  return policy.confidenceMultipliers[confidence];
}

function compareContribution(
  left: V9OperationalResilienceContribution,
  right: V9OperationalResilienceContribution,
): number {
  return (
    COMPONENT_ORDER[left.component] - COMPONENT_ORDER[right.component] ||
    PILLAR_ORDER[left.pillar] - PILLAR_ORDER[right.pillar] ||
    compareText(left.evidenceRefIds.join("\u0000"), right.evidenceRefIds.join("\u0000"))
  );
}

function activeBlockerCodes(
  fact: V9OperationalResilienceFact | null,
  blockers: V9OperationalResilienceBlockers,
): V9OperationalResilienceBlockerCode[] {
  const codes: V9OperationalResilienceBlockerCode[] = (Object.entries(blockers) as Array<
    [keyof V9OperationalResilienceBlockers, boolean]
  >)
    .filter(([, present]) => present)
    .map(([code]) => code);
  if (
    fact?.incidentReview.state === "reviewed" &&
    fact.incidentReview.incidents.some((incident) => incident.state === "active")
  ) {
    codes.push("activeMaterialIncident");
  }
  return [...new Set(codes)].sort(compareText);
}

function eligibilityTrace(
  fact: V9OperationalResilienceFact | null,
  policy: V9OperationalResiliencePolicy,
): V9OperationalResilienceEligibilityTrace {
  const history = fact?.liveHistoryEligibility ?? null;
  const overlayEligible =
    history !== null &&
    history.treatment === "eligibility-only" &&
    history.minimumLiveHistoryMonths >= policy.minimumLiveHistoryMonths &&
    confidenceMultiplier(history.confidence, policy) > 0;
  if (overlayEligible) {
    return {
      requiredLiveHistoryMonths: policy.minimumLiveHistoryMonths,
      documentedLiveHistoryMonths: history.minimumLiveHistoryMonths,
      confidence: history.confidence,
      evidenceRefIds: canonicalEvidence(history.evidenceRefIds),
      satisfied: true,
    };
  }
  return {
    requiredLiveHistoryMonths: policy.minimumLiveHistoryMonths,
    documentedLiveHistoryMonths: history?.minimumLiveHistoryMonths ?? null,
    confidence: history?.confidence ?? null,
    evidenceRefIds: canonicalEvidence(history?.evidenceRefIds ?? []),
    satisfied: false,
  };
}

function implementationEligibilityTrace(
  implementationHistory: V9OperationalResilienceImplementationHistory | null,
  policy: V9OperationalResiliencePolicy,
): V9OperationalResilienceEligibilityTrace {
  if (implementationHistory !== null) {
    nonNegativeInteger(
      implementationHistory.minimumLiveHistoryMonths,
      "implementation live history",
    );
    const evidenceRefIds = canonicalEvidence(implementationHistory.evidenceRefIds);
    return {
      requiredLiveHistoryMonths: policy.minimumLiveHistoryMonths,
      documentedLiveHistoryMonths: implementationHistory.minimumLiveHistoryMonths,
      confidence: "implementation-history",
      evidenceRefIds,
      satisfied:
        implementationHistory.minimumLiveHistoryMonths >= policy.minimumLiveHistoryMonths &&
        evidenceRefIds.length > 0,
    };
  }
  return {
    requiredLiveHistoryMonths: policy.minimumLiveHistoryMonths,
    documentedLiveHistoryMonths: null,
    confidence: null,
    evidenceRefIds: [],
    satisfied: false,
  };
}

/**
 * Produces bounded, pillar-specific credit from normalized operational
 * evidence. Age only establishes eligibility. Missing, unknown-confidence, or
 * below-threshold claims earn no credit and no penalty. Any active blocker,
 * including a reviewed active material incident, disables all credit.
 */
export function evaluateV9OperationalResilience(
  fact: V9OperationalResilienceFact | null,
  measuredMarketDepth: V9OperationalResilienceMeasuredMarketDepth | null,
  policy: V9OperationalResiliencePolicy,
  blockers: V9OperationalResilienceBlockers,
  implementationHistory: V9OperationalResilienceImplementationHistory | null = null,
): V9OperationalResilienceResult {
  const overlayEligibility = eligibilityTrace(fact, policy);
  const depthEligibility = implementationEligibilityTrace(implementationHistory, policy);
  const eligibility =
    !overlayEligibility.satisfied && measuredMarketDepth !== null && depthEligibility.satisfied
      ? depthEligibility
      : overlayEligibility;
  const blockerCodes = activeBlockerCodes(fact, blockers);
  if (
    (!overlayEligibility.satisfied &&
      !(measuredMarketDepth !== null && depthEligibility.satisfied)) ||
    blockerCodes.length > 0
  ) {
    return {
      eligible: false,
      eligibility,
      rawPillarCredits: ZERO_CREDITS,
      pillarCredits: ZERO_CREDITS,
      contributions: [],
      blockerCodes,
    };
  }

  const contributions: V9OperationalResilienceContribution[] = [];
  const add = (
    component: V9OperationalResilienceContributionComponent,
    pillar: V9QualityPillar,
    basePoints: number,
    confidence: V9OperationalResilienceContributionConfidence,
    evidenceRefIds: readonly string[],
  ) => {
    const canonicalIds = canonicalEvidence(evidenceRefIds);
    const multiplier = confidenceMultiplier(confidence, policy);
    const points = roundCredit(basePoints * multiplier);
    if (points <= 0 || canonicalIds.length === 0) return;
    contributions.push({
      component,
      pillar,
      basePoints,
      confidence,
      confidenceMultiplier: multiplier,
      points,
      evidenceRefIds: canonicalIds,
    });
  };

  const cumulativeRatio = overlayEligibility.satisfied
    ? fact?.redemptionThroughput?.cumulativeLifetimeRedeemedSupplyRatio ?? null
    : null;
  if (cumulativeRatio !== null) {
    finiteNonNegative(cumulativeRatio.value, "cumulative redeemed supply ratio");
    if (cumulativeRatio.value >= policy.redemption.minimumCumulativeSupplyRatio) {
      add(
        "cumulative-redemption",
        "exit",
        policy.redemption.cumulativeCredit,
        cumulativeRatio.confidence,
        cumulativeRatio.evidenceRefIds,
      );
    }
  }

  const qualifyingStressWindows = (
    overlayEligibility.satisfied ? fact?.redemptionThroughput?.stressWindows ?? [] : []
  )
    .filter((window) => {
      finiteNonNegative(
        window.redeemedSupplyRatioLowerBound,
        `${window.episodeKey} stress redeemed supply ratio`,
      );
      return (
        window.settlement.state === "settled-in-full" &&
        window.redeemedSupplyRatioLowerBound >= policy.redemption.minimumPeakStressSupplyRatio &&
        confidenceMultiplier(window.confidence, policy) > 0 &&
        window.evidenceRefIds.length > 0
      );
    })
    .sort(
      (left, right) =>
        confidenceMultiplier(right.confidence, policy) -
          confidenceMultiplier(left.confidence, policy) ||
        right.redeemedSupplyRatioLowerBound - left.redeemedSupplyRatioLowerBound ||
        compareText(left.episodeKey, right.episodeKey),
    );
  const strongestStressWindow = qualifyingStressWindows[0];
  if (strongestStressWindow) {
    add(
      "stress-redemption",
      "exit",
      policy.redemption.stressCredit,
      strongestStressWindow.confidence,
      strongestStressWindow.evidenceRefIds,
    );
  }

  if (measuredMarketDepth !== null) {
    nonNegativeInteger(
      measuredMarketDepth.completeProducerCycleCount,
      "complete market-depth producer cycles",
    );
    nonNegativeInteger(
      measuredMarketDepth.successfulObservationCount,
      "successful market-depth observations",
    );
    finiteRatio(
      measuredMarketDepth.conservativeCompletionRatio,
      "conservative market-depth completion ratio",
    );
    if (
      measuredMarketDepth.completeProducerCycleCount >=
        policy.marketDepth.minimumCompleteCycles &&
      measuredMarketDepth.successfulObservationCount >=
        policy.marketDepth.minimumCompleteCycles &&
      measuredMarketDepth.successfulObservationCount <=
        measuredMarketDepth.completeProducerCycleCount &&
      measuredMarketDepth.conservativeCompletionRatio >=
        policy.marketDepth.minimumCompletionRatio
    ) {
      add(
        "persistent-market-depth",
        "exit",
        policy.marketDepth.credit,
        "measured",
        measuredMarketDepth.evidenceRefIds,
      );
    }
  }

  const qualifyingEpisodes = (overlayEligibility.satisfied ? fact?.stressEpisodes ?? [] : [])
    .filter((episode) => {
      if (episode.recoveredWithinSec !== null) {
        finiteNonNegative(
          episode.recoveredWithinSec,
          `${episode.episodeKey} stress recovery duration`,
        );
      }
      return (
        episode.redemptionContinued === true &&
        episode.recoveredWithinSec !== null &&
        episode.recoveredWithinSec <= policy.stressEpisodes.maximumRecoverySec &&
        confidenceMultiplier(episode.confidence, policy) > 0 &&
        episode.evidenceRefIds.length > 0
      );
    })
    .sort(
      (left, right) =>
        confidenceMultiplier(right.confidence, policy) -
          confidenceMultiplier(left.confidence, policy) ||
        left.recoveredWithinSec! - right.recoveredWithinSec! ||
        compareText(left.episodeKey, right.episodeKey),
    )
    .slice(0, policy.stressEpisodes.minimumEpisodes);
  if (qualifyingEpisodes.length >= policy.stressEpisodes.minimumEpisodes) {
    const weakestSelectedEpisode = [...qualifyingEpisodes].sort(
      (left, right) =>
        confidenceMultiplier(left.confidence, policy) -
          confidenceMultiplier(right.confidence, policy) ||
        compareText(left.episodeKey, right.episodeKey),
    )[0]!;
    add(
      "stress-recovery",
      "exit",
      policy.stressEpisodes.credit,
      weakestSelectedEpisode.confidence,
      qualifyingEpisodes.flatMap((episode) => episode.evidenceRefIds),
    );
  }

  const reconciliation = overlayEligibility.satisfied ? fact?.reserveReconciliation ?? null : null;
  if (reconciliation !== null) {
    nonNegativeInteger(
      reconciliation.reportHistory.observedReportHistoryMonths,
      "reserve reconciliation history",
    );
    const claims = [
      reconciliation.reportHistory,
      reconciliation.latestAssurance,
      reconciliation.latestReconciliationProcedures,
    ] as const;
    const weakestClaim = [...claims].sort(
      (left, right) =>
        confidenceMultiplier(left.confidence, policy) -
          confidenceMultiplier(right.confidence, policy) ||
        compareText(left.evidenceRefIds.join("\u0000"), right.evidenceRefIds.join("\u0000")),
    )[0]!;
    const procedures = reconciliation.latestReconciliationProcedures;
    if (
      reconciliation.reportHistory.observedReportHistoryMonths >=
        policy.reconciliation.minimumHistoryMonths &&
      reconciliation.reportHistory.continuityEvidence !== "unknown" &&
      reconciliation.reportHistory.missedMaterialPeriods === 0 &&
      procedures.bankAndDepositaryBalances === true &&
      procedures.blockchainAssetsAndLiabilities === true &&
      confidenceMultiplier(weakestClaim.confidence, policy) > 0
    ) {
      const evidenceRefIds = claims.flatMap((claim) => claim.evidenceRefIds);
      add(
        "reserve-reconciliation",
        "backing",
        policy.reconciliation.credit,
        weakestClaim.confidence,
        evidenceRefIds,
      );
      add(
        "reserve-reconciliation",
        "control",
        policy.reconciliation.credit,
        weakestClaim.confidence,
        evidenceRefIds,
      );
    }
  }

  contributions.sort(compareContribution);
  const rawPillarCredits = contributions.reduce<Record<V9QualityPillar, number>>(
    (credits, contribution) => {
      credits[contribution.pillar] = roundCredit(
        credits[contribution.pillar] + contribution.points,
      );
      return credits;
    },
    { backing: 0, exit: 0, control: 0 },
  );
  return {
    eligible: true,
    eligibility,
    rawPillarCredits,
    pillarCredits: {
      backing: Math.min(rawPillarCredits.backing, policy.maximumCredit.backing),
      exit: Math.min(rawPillarCredits.exit, policy.maximumCredit.exit),
      control: Math.min(rawPillarCredits.control, policy.maximumCredit.control),
    },
    contributions,
    blockerCodes: [],
  };
}
