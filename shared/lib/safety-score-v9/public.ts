import {
  SafetyScoreV9CurrentCardSchema,
  SafetyScoreV9CurrentResponseSchema,
  type SafetyScoreV9EvidenceFreshness,
  type SafetyScoreV9NrReason,
  type SafetyScoreV9PublicReason,
  type SafetyScoreV9CurrentResponse,
  type SafetyScoreV9CurrentCard,
  type SafetyScoreV9PillarAdjustment,
} from "../../types/safety-score-v9-public";
import type {
  V9EvidenceLevel,
  V9QualityPillar,
  V9ReasonCode,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import type { V9EvidenceResponsibility } from "../../types/safety-score-v9-facts";
import type { V9DependencyEconomicRole } from "../../types/dependency-types";
import type { V9AccessPostureResult } from "./access-posture";
import type { V9BackingResult } from "./backing";
import type { V9EconomicControlResult } from "./control";
import type { V9ResolvedDependencyInputs } from "./dependencies";
import type { V9ExitEvaluationResult, V9ExitHolderEligibility } from "./exit";
import type { V9PillarReason, V9ProductionScoreInput, V9ProductionScoreTrace } from "./score";
import { computeV9ResultDigest } from "./trace";
import { compareText, uniqueSorted } from "./primitives";

type V9PublicAccessProjectionInput = V9AccessPostureResult & {
  reasons?: readonly V9PillarReason[];
};

export interface V9PublicCardProjectionInput {
  trace: V9ProductionScoreTrace;
  /** Exact fact-set provenance; absent only in compatibility/test callers. */
  backingFromLiveReserves?: boolean;
  scoreInput: Pick<V9ProductionScoreInput, "pillars" | "peg" | "dependencyReasons" | "methodologyReasons">;
  access: V9PublicAccessProjectionInput;
  dependencyInputs: V9ResolvedDependencyInputs;
  policy: V9ValidatedPolicyEnvelope;
  backing?: Pick<V9BackingResult, "archetype" | "score" | "contributions">;
  exit?: Pick<
    V9ExitEvaluationResult,
    | "score"
    | "stressRequest"
    | "primaryRouteKey"
    | "diversificationRouteKey"
    | "diversificationBonus"
    | "routes"
  >;
  control?: Pick<V9EconomicControlResult, "score" | "components">;
  display?: {
    labels?: Readonly<Record<string, string>>;
    exitHolderEligibility?: Readonly<Record<string, V9ExitHolderEligibility>>;
    exitRouteDetails?: Readonly<Record<string, {
      chain: string | null;
      protocol: string | null;
      poolId: string | null;
      evidenceKind: string;
      observedAtSec: number | null;
    }>>;
  };
  freshness?: Partial<Record<V9QualityPillar, SafetyScoreV9EvidenceFreshness>>;
  evidenceReasons?: readonly V9PillarReason[];
  reasonCodes?: readonly V9ReasonCode[];
}

export interface BuildSafetyScoreV9ResponseArgs {
  candidateId: string;
  policyVersion: string;
  publicationGenerationId: string;
  publishedAtSec: number;
  results: readonly V9PublicCardProjectionInput[];
}

const PILLARS = ["backing", "exit", "control"] as const satisfies readonly V9QualityPillar[];
const EVIDENCE_RANK: Readonly<Record<V9EvidenceLevel, number>> = {
  strong: 0,
  adequate: 1,
  limited: 2,
  insufficient: 3,
};
const RESPONSIBILITIES = [
  "integration-missing",
  "issuer-undisclosed",
  "measured-adverse",
  "method-unsupported",
  "producer-failed",
] as const satisfies readonly V9EvidenceResponsibility[];
const EXIT_COMPONENTS = [
  ["access", "Access"],
  ["settlement", "Settlement"],
  ["executionCertainty", "Execution certainty"],
  ["capacity", "Capacity"],
  ["outputAssetQuality", "Output asset quality"],
  ["cost", "Cost"],
] as const;
const ROUTE_FAMILY_LABELS: Readonly<Record<string, string>> = {
  "dex-amm": "DEX AMM",
  "dex-orderbook": "DEX order book",
  "issuer-redemption": "Issuer redemption",
  "protocol-redemption": "Protocol redemption",
  "eventual-redemption": "Eventual redemption",
};

function humanizeLabel(value: string): string {
  const tail = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
  const text = tail.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (text.length === 0) return value;
  return text.replace(/\b\w/g, (character) => character.toUpperCase());
}

function publicLabel(input: V9PublicCardProjectionInput, key: string): string {
  return input.display?.labels?.[key] ?? humanizeLabel(key);
}

function routeLabel(
  input: V9PublicCardProjectionInput,
  route: NonNullable<V9PublicCardProjectionInput["exit"]>["routes"][number],
): string {
  return input.display?.labels?.[route.routeKey] ?? ROUTE_FAMILY_LABELS[route.routeFamily] ?? humanizeLabel(route.routeFamily);
}

function aggregationWeight(input: V9PublicCardProjectionInput, pillar: V9QualityPillar): number {
  const contribution = input.trace.pillarContributions.find((item) => item.pillar === pillar);
  if (contribution === undefined) {
    throw new Error(`Safety Score v9 ${input.trace.assetId} lacks a ${pillar} aggregation weight`);
  }
  return contribution.weight;
}

function projectPillarAdjustments(
  input: V9PublicCardProjectionInput,
  pillar: V9QualityPillar,
  evaluatedScore: number,
): SafetyScoreV9PillarAdjustment[] {
  const adjustments: SafetyScoreV9PillarAdjustment[] = [];
  let score = evaluatedScore;
  const configuredCredit = input.trace.operationalResilience?.pillarCredits[pillar] ?? 0;
  const creditedScore = Math.min(100, score + configuredCredit);
  if (creditedScore > score) {
    adjustments.push({
      kind: "operational-resilience-credit",
      scoreBefore: score,
      scoreAfter: creditedScore,
      delta: creditedScore - score,
    });
    score = creditedScore;
  }
  const publishedScore = input.scoreInput.pillars[pillar].score;
  if (publishedScore === null) {
    throw new Error(`Safety Score v9 ${input.trace.assetId} rated breakdown has a missing ${pillar} pillar`);
  }
  if (publishedScore < score) {
    adjustments.push({
      kind: "dependency-limit",
      scoreBefore: score,
      scoreAfter: publishedScore,
      delta: publishedScore - score,
    });
  } else if (publishedScore > score) {
    throw new Error(
      `Safety Score v9 ${input.trace.assetId} ${pillar} pillar has an unexplained positive adjustment`,
    );
  }
  return adjustments;
}

function projectBackingBreakdown(
  input: V9PublicCardProjectionInput,
): NonNullable<SafetyScoreV9CurrentCard["breakdowns"]>["backing"] {
  const backing = input.backing;
  if (backing?.score === null || backing?.score === undefined) {
    throw new Error(`Safety Score v9 ${input.trace.assetId} rated card lacks a backing evaluation`);
  }
  const policy = input.policy.policy.semantic.backing;
  const archetype =
    policy.archetypes[backing.archetype as keyof typeof policy.archetypes];
  if (archetype === undefined) {
    throw new Error(`Safety Score v9 ${input.trace.assetId} lacks backing policy for ${backing.archetype}`);
  }
  const reserveContributions = backing.contributions.filter((item) => item.source !== "mechanism");
  const mechanismContributions = backing.contributions.filter((item) => item.source === "mechanism");
  const reserveAvailable = reserveContributions.length > 0;
  const mechanismAvailable = mechanismContributions.length > 0;
  const activeReserveWeight = reserveAvailable ? archetype.reserveWeight : 0;
  const activeMechanismWeight = mechanismAvailable ? 1 - activeReserveWeight : 0;
  const combinedWeight = activeReserveWeight + activeMechanismWeight;
  if (combinedWeight <= 0) {
    throw new Error(`Safety Score v9 ${input.trace.assetId} backing breakdown has no active component weight`);
  }
  const reserveGroupWeight = activeReserveWeight / combinedWeight;
  const mechanismGroupWeight = activeMechanismWeight / combinedWeight;
  const concentrationWeight = policy.reserve.concentrationWeight;
  const hasConcentrationComponent = reserveContributions.some(
    (contribution) => contribution.source === "reserve-concentration",
  );
  const effectiveWeight = (contribution: V9BackingResult["contributions"][number]): number => {
    if (contribution.source === "mechanism") {
      return contribution.normalizedWeight * mechanismGroupWeight;
    }
    const reserveLocalWeight =
      contribution.source === "reserve-concentration"
        ? contribution.normalizedWeight
        : contribution.normalizedWeight *
          (hasConcentrationComponent ? 1 - concentrationWeight : 1);
    return reserveLocalWeight * reserveGroupWeight;
  };
  const components = [...backing.contributions]
    .sort((left, right) => compareText(left.componentKey, right.componentKey))
    .map((contribution) => {
      const weight = effectiveWeight(contribution);
      return {
        key: contribution.componentKey,
        label: publicLabel(input, contribution.componentKey),
        source: contribution.source,
        score: contribution.score,
        effectiveWeight: weight,
        weightedContribution: contribution.score * weight,
        observationState: contribution.observationState,
      };
    });
  const group = (
    key: "reserves" | "mechanism",
    label: string,
    sourceComponents: typeof components,
    weight: number,
  ) => ({
    key,
    label,
    score: sourceComponents.reduce((sum, component) => sum + component.weightedContribution, 0) / weight,
    effectiveWeight: weight,
  });
  const groups = [
    ...(reserveGroupWeight > 0
      ? [group("reserves", "Reserves", components.filter((item) => item.source !== "mechanism"), reserveGroupWeight)]
      : []),
    ...(mechanismGroupWeight > 0
      ? [group("mechanism", "Mechanism", components.filter((item) => item.source === "mechanism"), mechanismGroupWeight)]
      : []),
  ];
  const publishedScore = input.scoreInput.pillars.backing.score!;
  return {
    evaluatedScore: backing.score,
    publishedScore,
    aggregationWeight: aggregationWeight(input, "backing"),
    groups,
    components,
    adjustments: projectPillarAdjustments(input, "backing", backing.score),
  };
}

function projectExitBreakdown(
  input: V9PublicCardProjectionInput,
): NonNullable<SafetyScoreV9CurrentCard["breakdowns"]>["exit"] {
  const exit = input.exit;
  if (exit?.score === null || exit?.score === undefined) {
    throw new Error(`Safety Score v9 ${input.trace.assetId} rated card lacks an exit evaluation`);
  }
  const policy = input.policy.policy.semantic.exit;
  const primary = exit.routes.find((route) => route.routeKey === exit.primaryRouteKey) ?? null;
  const completePrimary =
    primary !== null &&
    primary.score !== null &&
    primary.components !== null &&
    primary.confidenceFactor !== null
      ? primary
      : null;
  const holderEligibility =
    completePrimary === null
      ? undefined
      : input.display?.exitHolderEligibility?.[completePrimary.routeKey];
  const primaryRouteDetails =
    completePrimary === null
      ? undefined
      : input.display?.exitRouteDetails?.[completePrimary.routeKey];
  if (completePrimary !== null && holderEligibility === undefined) {
    throw new Error(`Safety Score v9 ${input.trace.assetId} primary exit route lacks holder eligibility metadata`);
  }
  const components =
    completePrimary === null
      ? []
      : EXIT_COMPONENTS.map(([key, label]) => {
          const score = completePrimary.components![key];
          if (score === null) {
            throw new Error(`Safety Score v9 ${input.trace.assetId} primary exit route lacks ${key}`);
          }
          const weight = policy.componentWeights[key];
          return { key, label, score, weight, weightedContribution: score * weight };
        });
  const diversificationRoute =
    exit.diversificationRouteKey === null
      ? null
      : exit.routes.find((route) => route.routeKey === exit.diversificationRouteKey) ?? null;
  const alternatives = exit.routes
    .filter((route) => route.routeKey !== completePrimary?.routeKey)
    .sort((left, right) => compareText(left.routeKey, right.routeKey))
    .map((route) => ({
      ...(route.capacityPoint === null
        ? { capacity: null }
        : {
            capacity: {
              executableUsd: route.capacityPoint.executableUsd,
              requestedNotionalUsd: route.capacityPoint.requestedNotionalUsd,
              completionRatio: route.capacityPoint.completionRatio,
            },
          }),
      key: route.routeKey,
      label: routeLabel(input, route),
      routeFamily: route.routeFamily,
      score: route.score,
      included: route.included,
      exclusionReason: route.exclusionReason,
      confidenceFactor: route.confidenceFactor,
      capacityScoringHorizon: route.capacityScoringHorizon,
      settlementDelaySec: route.settlementDelaySec,
    }));
  const publishedScore = input.scoreInput.pillars.exit.score!;
  return {
    evaluatedScore: exit.score,
    publishedScore,
    aggregationWeight: aggregationWeight(input, "exit"),
    stressRequest:
      exit.stressRequest === null
        ? null
        : {
            requestedNotionalUsd: exit.stressRequest.requestedNotionalUsd,
            maxCostBps: exit.stressRequest.maxCostBps,
            comparisonWindowSec: exit.stressRequest.comparisonWindowSec,
          },
    primaryRoute:
      completePrimary === null
        ? null
        : {
            key: completePrimary.routeKey,
            label: routeLabel(input, completePrimary),
            routeFamily: completePrimary.routeFamily,
            score: completePrimary.score!,
            components,
            confidenceFactor: completePrimary.confidenceFactor!,
            eligibilityMultiplier: policy.holderEligibilityMultipliers[holderEligibility!],
            capsApplied: uniqueSorted(completePrimary.capsApplied),
            capacity:
              completePrimary.capacityPoint === null
                ? null
                : {
                    executableUsd: completePrimary.capacityPoint.executableUsd,
                    requestedNotionalUsd: completePrimary.capacityPoint.requestedNotionalUsd,
                    completionRatio: completePrimary.capacityPoint.completionRatio,
                    maxCostBps: completePrimary.capacityPoint.maxCostBps,
                    executionCostBps: completePrimary.capacityPoint.executionCostBps,
                    settlementDelaySec: completePrimary.settlementDelaySec,
                    capacityScoringHorizon: completePrimary.capacityScoringHorizon,
                    chain: primaryRouteDetails?.chain ?? null,
                    protocol: primaryRouteDetails?.protocol ?? null,
                    poolId: primaryRouteDetails?.poolId ?? null,
                    evidenceKind: primaryRouteDetails?.evidenceKind ?? "unknown",
                    observedAtSec: primaryRouteDetails?.observedAtSec ?? null,
                  },
          },
    diversification:
      diversificationRoute === null || exit.diversificationBonus <= 0
        ? null
        : {
            routeKey: diversificationRoute.routeKey,
            routeLabel: routeLabel(input, diversificationRoute),
            bonus: exit.diversificationBonus,
          },
    alternatives,
    adjustments: projectPillarAdjustments(input, "exit", exit.score),
  };
}

function projectControlBreakdown(
  input: V9PublicCardProjectionInput,
): NonNullable<SafetyScoreV9CurrentCard["breakdowns"]>["control"] {
  const control = input.control;
  if (control?.score === null || control?.score === undefined) {
    throw new Error(`Safety Score v9 ${input.trace.assetId} rated card lacks a control evaluation`);
  }
  const publishedScore = input.scoreInput.pillars.control.score!;
  return {
    evaluatedScore: control.score,
    publishedScore,
    aggregationWeight: aggregationWeight(input, "control"),
    method: "minimum-binding-component",
    components: [...control.components]
      .sort((left, right) => compareText(left.componentKey, right.componentKey))
      .map((component) => ({
        key: component.componentKey,
        label:
          component.kind === "oracle" && component.posture === "privileged-internal-pricing"
            ? "Privileged internal pricing"
            : component.kind === "oracle" && component.posture === "oracleless"
              ? "Oracleless design"
              : publicLabel(input, component.componentKey),
        kind: component.kind,
        score: component.score,
        binding: component.binding,
        posture: component.posture,
      })),
    adjustments: projectPillarAdjustments(input, "control", control.score),
  };
}

function projectBreakdowns(
  input: V9PublicCardProjectionInput,
): SafetyScoreV9CurrentCard["breakdowns"] {
  if (input.trace.finalGrade === "NR") return null;
  return {
    backing: projectBackingBreakdown(input),
    exit: projectExitBreakdown(input),
    control: projectControlBreakdown(input),
  };
}

function publicReason(reason: V9PillarReason): SafetyScoreV9PublicReason {
  return { code: reason.code, message: reason.message, path: reason.path || null };
}

function canonicalPublicReasons(reasons: readonly V9PillarReason[]): SafetyScoreV9PublicReason[] {
  return [
    ...new Map(
      reasons.map((reason) => [`${reason.code}\u0000${reason.path}\u0000${reason.message}`, publicReason(reason)]),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path ?? "", right.path ?? "") ||
      compareText(left.message, right.message),
  );
}

function canonicalNrReasons(trace: V9ProductionScoreTrace): SafetyScoreV9NrReason[] {
  const reasons: SafetyScoreV9NrReason[] = [
    ...trace.nrReasons.map((reason) => ({
      code: reason.code,
      message: reason.message,
      field: reason.field ?? null,
      origin: "asset" as const,
    })),
    ...trace.propagatedParentReasons.map((reason) => ({
      code: reason.code,
      message: reason.message,
      field: reason.field ?? null,
      origin: "upstream" as const,
    })),
  ];
  return [
    ...new Map(
      reasons.map((reason) => [
        `${reason.origin}\u0000${reason.code}\u0000${reason.field ?? ""}\u0000${reason.message}`,
        reason,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.origin, right.origin) ||
      compareText(left.code, right.code) ||
      compareText(left.field ?? "", right.field ?? "") ||
      compareText(left.message, right.message),
  );
}

function pillarComponents(input: V9PublicCardProjectionInput, pillar: V9QualityPillar): string[] {
  if (pillar === "backing") return uniqueSorted(input.backing?.contributions.map((item) => item.componentKey) ?? []);
  if (pillar === "exit") {
    return uniqueSorted(input.exit?.routes.filter((route) => route.included).map((route) => route.routeKey) ?? []);
  }
  return uniqueSorted(input.control?.components.map((item) => item.componentKey) ?? []);
}

function overallEvidenceLevel(input: V9PublicCardProjectionInput): V9EvidenceLevel {
  return [...PILLARS]
    .map((pillar) => input.scoreInput.pillars[pillar].evidenceLevel)
    .sort((left, right) => EVIDENCE_RANK[right] - EVIDENCE_RANK[left])[0]!;
}

function overallFreshness(input: V9PublicCardProjectionInput): SafetyScoreV9EvidenceFreshness {
  const freshness = PILLARS.map((pillar) => input.freshness?.[pillar] ?? "unknown");
  if (freshness.includes("stale")) return "stale";
  return freshness.every((value) => value === "current") ? "current" : "unknown";
}

function projectPillars(input: V9PublicCardProjectionInput): SafetyScoreV9CurrentCard["pillars"] {
  const contributions = new Map(
    input.trace.pillarContributions.map((contribution) => [contribution.pillar, contribution.score]),
  );
  const project = (pillar: V9QualityPillar) => {
    const evaluation = input.scoreInput.pillars[pillar];
    const contribution = contributions.get(pillar);
    if (evaluation.score !== null && contribution !== evaluation.score) {
      throw new Error(`Safety Score v9 ${input.trace.assetId} ${pillar} pillar does not match its score trace`);
    }
    if (evaluation.score === null && contribution !== undefined) {
      throw new Error(`Safety Score v9 ${input.trace.assetId} ${pillar} trace contains a missing pillar`);
    }
    return {
      score: evaluation.score,
      evidenceLevel: evaluation.evidenceLevel,
      freshness: input.freshness?.[pillar] ?? "unknown",
      components: pillarComponents(input, pillar),
      reasons: canonicalPublicReasons(evaluation.reasons),
    };
  };
  return { backing: project("backing"), exit: project("exit"), control: project("control") };
}

function projectDependencies(input: V9PublicCardProjectionInput): SafetyScoreV9CurrentCard["dependencies"] {
  const targetPillar = (role: V9DependencyEconomicRole): "exit" | "control" | null => {
    if (role === "exit-dependency") return "exit";
    if (role === "control-operator" || role === "oracle-nav") return "control";
    return null;
  };
  const projections = input.dependencyInputs.rolePillarProjections;
  const publicProjection = (pillar: "exit" | "control") => {
    const projection = projections![pillar];
    return {
      limit: projection.limit,
      knownLossPoints: projection.knownLossPoints,
      boundedUnknownLossPoints: projection.boundedUnknownLossPoints,
      unresolvedExposureShare: projection.unresolvedExposureShare,
      materialUnresolvedExposure: projection.materialUnresolvedExposure,
    };
  };
  return {
    serial: [...input.dependencyInputs.serial]
      .sort((left, right) => compareText(left.upstreamAssetId, right.upstreamAssetId))
      .map((dependency) => ({ ...dependency })),
    basket: [...input.dependencyInputs.basket]
      .sort((left, right) => compareText(left.upstreamAssetId, right.upstreamAssetId))
      .map((dependency) => ({ ...dependency })),
    roles: [...(input.dependencyInputs.roleInputs ?? [])]
      .sort(
        (left, right) =>
          compareText(left.role, right.role) ||
          compareText(left.upstreamAssetId, right.upstreamAssetId) ||
          compareText(left.edgeKey, right.edgeKey),
      )
      .map((dependency) => {
        const pillar = targetPillar(dependency.role);
        const event =
          pillar === null
            ? undefined
            : projections?.[pillar].events.find((candidate) =>
                candidate.edgeKeys.includes(dependency.edgeKey),
              );
        return {
          edgeKey: dependency.edgeKey,
          exposureKey: dependency.exposureKey,
          riskEventKey: dependency.riskEventKey,
          upstreamAssetId: dependency.upstreamAssetId,
          role: dependency.role,
          weight: dependency.weight,
          targetPillar: pillar,
          propagationEventEdgeKeys: [...(event?.edgeKeys ?? [])],
          propagationEventExposureKey: event?.exposureKey ?? null,
          propagationEventRiskEventKey: event?.riskEventKey ?? null,
          propagationEventNominalExposureShare: event?.nominalExposureShare ?? null,
          propagationEventExposureShare: event?.exposureShare ?? null,
          propagationEventInheritedScore: event?.inheritedScore ?? null,
          propagationEventModeledLossPoints: event?.modeledLossPoints ?? null,
          inheritedDimensions: [...dependency.inheritedDimensions],
          unavailableDimensions: [...dependency.unavailableDimensions],
          score: dependency.score,
          boundedUnknown: dependency.boundedUnknown,
          cycleBlocked: dependency.cycleBlocked,
          evidenceRefIds: [...dependency.evidenceRefIds].sort(compareText),
          failureDomains: [...dependency.failureDomains].sort((left, right) =>
            compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
          ),
        };
      }),
    ...(projections === undefined
      ? {}
      : {
          rolePillarLimits: {
            exit: publicProjection("exit"),
            control: publicProjection("control"),
          },
        }),
    cycleBlocked: input.dependencyInputs.cycleBlocked,
    reasonCodes: uniqueSorted(input.scoreInput.dependencyReasons.map((reason) => reason.code)),
  };
}

function roundTrace(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function projectScoreTrace(input: V9PublicCardProjectionInput): SafetyScoreV9CurrentCard["scoreTrace"] {
  const trace = input.trace;
  if (trace.aggregation !== null && trace.aggregation.method !== "smooth-bounded-headroom") {
    throw new Error(
      `Safety Score v9 ${trace.assetId} uses aggregation ${trace.aggregation.method}, which requires a new public trace schema`,
    );
  }
  const adjustments = [...trace.deploymentAdjustments]
    .sort(
      (left, right) =>
        compareText(left.exposureKey, right.exposureKey) ||
        compareText(left.riskEventKey, right.riskEventKey) ||
        compareText(left.failureDomainKey, right.failureDomainKey) ||
        compareText(left.signalKey, right.signalKey),
    )
    .map((adjustment) => ({
      ...adjustment,
      sourceSignalKeys: uniqueSorted(adjustment.sourceSignalKeys),
      adjustmentPoints: roundTrace(adjustment.scoreBefore - adjustment.scoreAfter),
      modeledLossPoints: adjustment.adjustmentPoints,
    }));
  const unresolvedExposures = [...trace.unresolvedDeploymentSignals]
    .sort(
      (left, right) =>
        compareText(left.exposureKey, right.exposureKey) ||
        compareText(left.riskEventKey, right.riskEventKey) ||
        compareText(left.failureDomainKeys.join("+"), right.failureDomainKeys.join("+")) ||
        compareText(left.signalKey, right.signalKey),
    )
    .map((signal) => {
      if (signal.economicLossScope !== "deployment" || signal.exposureShare !== null) {
        throw new Error(
          `Safety Score v9 ${trace.assetId} has an invalid unresolved deployment exposure ${signal.signalKey}`,
        );
      }
      return {
        signalKey: signal.signalKey,
        exposureKey: signal.exposureKey,
        riskEventKey: signal.riskEventKey,
        failureDomainKeys: uniqueSorted(signal.failureDomainKeys),
        economicLossScope: signal.economicLossScope,
        exposedScore: signal.exposedScore,
        exposureShare: signal.exposureShare,
        reason: signal.reason,
      };
    });
  const responsibilitySummaries = RESPONSIBILITIES.map((responsibility) => {
    const facts = trace.unresolvedFacts.filter((fact) => {
      if (fact.responsibility === undefined) {
        throw new Error(
          `Safety Score v9 ${trace.assetId} unresolved fact ${fact.code} lacks evidence responsibility`,
        );
      }
      return fact.responsibility === responsibility;
    });
    return {
      responsibility,
      factCount: facts.length,
      criticalFactCount: facts.filter((fact) => fact.critical).length,
      reasonCodes: uniqueSorted(facts.map((fact) => fact.code)),
    };
  });
  const responsibilityFacts = trace.unresolvedFacts.map((fact) => {
    if (fact.path === undefined) {
      throw new Error(
        `Safety Score v9 ${trace.assetId} unresolved fact ${fact.code} lacks an exact fact path`,
      );
    }
    return {
      reasonCode: fact.code,
      exactFactPath: fact.path,
      sourceGapId: fact.sourceGapId ?? null,
      responsibility: fact.responsibility,
      critical: fact.critical,
    };
  });
  const deploymentAdjustmentPoints =
    trace.baseAssetScore === null || trace.deploymentAdjustedScore === null
      ? null
      : roundTrace(trace.baseAssetScore - trace.deploymentAdjustedScore);

  return {
    schemaVersion: 3,
    legacyAliases: {
      qualityScore: "weighted-pillar-mean",
      pegAdjustedScore: "post-deployment-pre-cap-score",
      score: "post-cap-public-score",
    },
    aggregation:
      trace.aggregation === null
        ? null
        : {
            method: "smooth-bounded-headroom",
            score: trace.aggregation.score,
            weightedPillarMean: trace.aggregation.weightedQuality,
            weakestPillar: trace.aggregation.weakestPillar,
            weakestScore: trace.aggregation.weakestScore,
            headroom: trace.aggregation.headroom,
          },
    stages: {
      weightedPillarMean: trace.weightedQuality,
      aggregatedQualityScore: trace.aggregation?.score ?? null,
      pegMultiplier: trace.pegMultiplier,
      baseAssetScore: trace.baseAssetScore,
      deploymentAdjustedScore: trace.deploymentAdjustedScore,
      deploymentAdjustmentPoints,
      preCapScore: trace.preCapScore,
      publishedScore: trace.finalScore,
    },
    deploymentRisk: {
      method: "holder-slice-exposure-weighted-v2",
      totalAdjustmentPoints: deploymentAdjustmentPoints,
      adjustments,
      unresolvedExposures,
    },
    adverseAttribution: {
      semantics: "causal-measured-adverse-v1",
      items: [...trace.adverseAttribution]
        .sort(
          (left, right) =>
            compareText(left.source, right.source) ||
            compareText(left.path, right.path) ||
            compareText(left.message, right.message),
        )
        .map((attribution) => ({ ...attribution })),
    },
    boundedUncertaintyAttribution: {
      semantics: "causal-bounded-uncertainty-v1",
      items: [...trace.boundedUncertaintyAttribution]
        .sort(
          (left, right) =>
            compareText(left.source, right.source) ||
            compareText(left.code, right.code) ||
            compareText(left.path, right.path) ||
            compareText(left.message, right.message) ||
            compareText(left.responsibility, right.responsibility) ||
            compareText(left.boundedness, right.boundedness),
        )
        .map(({ boundedness: _boundedness, ...attribution }) => attribution),
    },
    evidenceResponsibility: {
      semantics: "limiting-fact-owner-v1",
      totalFactCount: trace.unresolvedFacts.length,
      facts: responsibilityFacts,
      summaries: responsibilitySummaries,
    },
    scoreAdjustments: trace.scoreAdjustments.map((adjustment) => ({
      ...adjustment,
      capRelief: { ...adjustment.capRelief },
    })),
    wrapperParentLimit:
      trace.wrapperParentLimit === null
        ? null
        : {
            ...trace.wrapperParentLimit,
            missingFacts: trace.wrapperParentLimit.missingFacts.map((fact) => ({ ...fact })),
            adjustments: trace.wrapperParentLimit.adjustments.map((adjustment) => ({ ...adjustment })),
            riskTransfer: { ...trace.wrapperParentLimit.riskTransfer },
          },
  };
}

function allPublicReasonCodes(input: V9PublicCardProjectionInput): V9ReasonCode[] {
  return uniqueSorted([
    ...input.trace.nrReasons.map((reason) => reason.code),
    ...input.trace.propagatedParentReasons.map((reason) => reason.code),
    ...PILLARS.flatMap((pillar) => input.scoreInput.pillars[pillar].reasons.map((reason) => reason.code)),
    ...input.scoreInput.peg.reasons.map((reason) => reason.code),
    ...input.scoreInput.dependencyReasons.map((reason) => reason.code),
    ...(input.scoreInput.methodologyReasons ?? []).map((reason) => reason.code),
    ...(input.evidenceReasons ?? []).map((reason) => reason.code),
    ...(input.access.reasons ?? []).map((reason) => reason.code),
    ...(input.reasonCodes ?? []),
  ]);
}

// Test seam (keep exported): the public-projection suite asserts single-card
// output without assembling a whole response envelope. Production callers go
// through `buildSafetyScoreV9Response`.
export function projectSafetyScoreV9Card(input: V9PublicCardProjectionInput): SafetyScoreV9CurrentCard {
  const isRateable = input.trace.finalScore !== null;
  const caps = input.trace.caps.map((cap) => ({
    kind: cap.kind,
    limit: cap.limit,
    source: cap.source,
    reason: cap.reason,
    binding: isRateable && cap.binding,
  }));
  const bindingCap = isRateable ? (caps.find((cap) => cap.binding) ?? null) : null;
  return SafetyScoreV9CurrentCardSchema.parse({
    id: input.trace.assetId,
    ...(input.backingFromLiveReserves === undefined
      ? {}
      : { backingFromLiveReserves: input.backingFromLiveReserves }),
    score: input.trace.finalScore,
    grade: input.trace.finalGrade,
    qualityScore: input.trace.weightedQuality,
    pegMultiplier: input.trace.pegMultiplier,
    pegAdjustedScore: input.trace.preCapScore,
    pillars: projectPillars(input),
    weakestPillar: input.trace.weakestPillar,
    caps,
    bindingCap,
    nrReasons: canonicalNrReasons(input.trace),
    reasonCodes: allPublicReasonCodes(input),
    evidence: {
      level: overallEvidenceLevel(input),
      freshness: overallFreshness(input),
      reasons: canonicalPublicReasons(input.evidenceReasons ?? []),
    },
    accessPosture: {
      transfer: input.access.transfer,
      freezeExposure: input.access.freezeExposure,
      primaryExit: input.access.primaryExit,
      governance: input.access.governance,
      unknownFields: uniqueSorted(input.access.unknownFields),
      signals: uniqueSorted(input.access.signals),
      reasons: canonicalPublicReasons(input.access.reasons ?? []),
    },
    dependencies: projectDependencies(input),
    scoreTrace: projectScoreTrace(input),
    breakdowns: projectBreakdowns(input),
  });
}

function canonicalSourceGenerations(sourceGenerations: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(sourceGenerations).sort(([left], [right]) => compareText(left, right)));
}

function assertConsistentResultIdentity(results: readonly V9PublicCardProjectionInput[]): void {
  if (results.length === 0) throw new Error("Safety Score v9 publication requires at least one result");
  const first = results[0]!.trace;
  const firstSourceGenerations = JSON.stringify(canonicalSourceGenerations(first.sourceGenerations));
  const seen = new Set<string>();
  for (const { trace } of results) {
    if (seen.has(trace.assetId)) throw new Error(`Duplicate Safety Score v9 result ${trace.assetId}`);
    seen.add(trace.assetId);
    for (const [label, actual, expected] of [
      ["fact-set digest", trace.factSetDigest, first.factSetDigest],
      ["base input generation", trace.baseInputGenerationId, first.baseInputGenerationId],
      ["evaluation build", trace.evaluationBuildDigest, first.evaluationBuildDigest],
      ["policy ID", trace.policyId, first.policyId],
      ["policy digest", trace.policyDigest, first.policyDigest],
      ["evidence clock", String(trace.asOfSec), String(first.asOfSec)],
      [
        "source generations",
        JSON.stringify(canonicalSourceGenerations(trace.sourceGenerations)),
        firstSourceGenerations,
      ],
    ] as const) {
      if (actual !== expected) {
        throw new Error(`Safety Score v9 publication mixes ${label}: ${actual} != ${expected}`);
      }
    }
  }
}

export function buildSafetyScoreV9Response(args: BuildSafetyScoreV9ResponseArgs): SafetyScoreV9CurrentResponse {
  assertConsistentResultIdentity(args.results);
  const ordered = [...args.results].sort((left, right) => compareText(left.trace.assetId, right.trace.assetId));
  const traces = ordered.map((result) => result.trace);
  const first = traces[0]!;
  const cards = ordered.map(projectSafetyScoreV9Card);
  const notRatedIds = cards.filter((card) => card.grade === "NR").map((card) => card.id);
  return SafetyScoreV9CurrentResponseSchema.parse({
    model: "v9-critical-path",
    schemaVersion: 5,
    lifecycle: "active",
    candidateId: args.candidateId,
    policyVersion: args.policyVersion,
    publicationGenerationId: args.publicationGenerationId,
    baseInputGenerationId: first.baseInputGenerationId,
    factSetDigest: first.factSetDigest,
    resultDigest: computeV9ResultDigest(traces),
    policy: { id: first.policyId, semanticDigest: first.policyDigest },
    evaluationBuildDigest: first.evaluationBuildDigest,
    sourceGenerations: canonicalSourceGenerations(first.sourceGenerations),
    asOfSec: first.asOfSec,
    publishedAtSec: args.publishedAtSec,
    completeness: {
      expectedCount: cards.length,
      ratedCount: cards.length - notRatedIds.length,
      notRatedCount: notRatedIds.length,
      notRatedIds,
    },
    cards,
  });
}
