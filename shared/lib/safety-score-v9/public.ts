import { z } from "zod";
import { strFromU8, strToU8 } from "fflate";
import { internV9PublicCauseGaps, finalizeV9PublicCauseGaps, finalizeV9PublicCauseGapCard, type V9InternedPublicCardDraft, type V9UninternedPublic, type V9UninternedPublicCard } from "./public-cause-interning";
import { createV9PublicCardShardViewFactory } from "./public-card-shard";
import { resolveV9PublicWitnessText, resolveV9PublicWitnessTexts } from "../../types/safety-score-v9-public-witness-texts";
import {
  SafetyScoreV9CurrentCardSchema,
  type SafetyScoreV9EvidenceFreshness,
  type SafetyScoreV9NrReason,
  type SafetyScoreV9PublicReason,
  type SafetyScoreV9CurrentCard,
  type SafetyScoreV9CommonModeGroups,
} from "../../types/safety-score-v9-public";
import {
  SafetyScoreV9CurrentResponseSchema,
  type SafetyScoreV9CurrentResponse,
} from "../../types/safety-score-v9-publication-response";
import { computeV9UnknownPricedWeightShare, type SafetyScoreV9IssuanceSummary } from "../../types/safety-score-v9-public-breakdowns";
import type {
  V9DocumentationReason,
  V9EvidenceLevel,
  V9QualityPillar,
  V9ReasonCode,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import type {
  V1005ProcessDiagnostic,
  V1005AssetIssuanceFacts,
  V9DeploymentControlFactV2,
  V9EvidenceResponsibility,
} from "../../types/safety-score-v9-facts";
import {
  documentationGapIds,
  documentationOnlyLimitedPillars,
  type V9DocumentationAssetFacts,
  type V9DocumentationClassification,
  type V9DocumentationPillarWitness,
} from "./documentation";
import { projectV9CompactPartialEvidence } from "../../types/safety-score-v9-causes";
import { projectExitExecutionCertificate } from "./exit-execution";
import { V9_PUBLIC_EVIDENCE_RESPONSIBILITIES as RESPONSIBILITIES } from "../../types/safety-score-v9-vocabulary";
import { countV9EvidenceObligations } from "../../types/safety-score-v9-public-evidence-facts";
import { round4 } from "../math";
import type { V9DependencyEconomicRole } from "../../types/dependency-types";
import type { V9AccessPostureResult } from "./access-posture";
import type { V9BackingResult } from "./backing-primitives";
import type { V9EconomicControlResult, V9MintPosture } from "./control-primitives";
import type { V9CommonModeGroup, V9ResolvedDependencyInputs } from "./dependencies";
import type { V9ExitEvaluationResult, V9ExitHolderEligibility } from "./exit";
import type { V9PillarReason, V9ProductionScoreInput, V9ProductionScoreTrace } from "./score";
import { computeV9CompactResultDigest, projectCompactV9ScoreTrace, type V9CompactScoreTrace } from "./trace";
import { compareText, uniqueSorted } from "./primitives";
import { effectiveAuthoritySignatureRequirement } from "./control-scope";
import { v9BridgeMintControlKey, v9ControlChainLabel } from "./control-component-keys";
import { readableV9PublicText, readableV9PublicWitnesses } from "./public-witness-texts";
import { assertV9PublicCardProjections } from "../report-cards-v9-projections";
import type { V9OpenEvidence } from "../../types/safety-score-v9-open-evidence";

type V9PublicAccessProjectionInput = V9AccessPostureResult & {
  reasons?: readonly V9PillarReason[];
};

export interface V9PublicCardProjectionInput {
  trace: V9ProductionScoreTrace;
  /** Exact fact-set provenance; absent only in compatibility/test callers. */
  backingFromLiveReserves?: boolean;
  supply?: SafetyScoreV9CurrentCard["supply"];
  providerRowExclusions?: SafetyScoreV9CurrentCard["scoreTrace"]["providerRowExclusions"];
  sharedBookId?: string | null;
  dependencyCoverage?: SafetyScoreV9CurrentCard["dependencyCoverage"];
  dependencyProvenance?: ReadonlyMap<string, NonNullable<SafetyScoreV9CurrentCard["dependencies"]["serial"][number]["provenance"]>>;
  dependencyTypes?: ReadonlyMap<string, NonNullable<SafetyScoreV9CurrentCard["dependencies"]["serial"][number]["dependencyType"]>>;
  scoreInput: Pick<V9ProductionScoreInput, "pillars" | "peg" | "dependencyReasons" | "methodologyReasons">;
  access: V9PublicAccessProjectionInput;
  dependencyInputs: V9ResolvedDependencyInputs;
  policy: V9ValidatedPolicyEnvelope;
  /**
   * Publication-wide documentation classification (`collectV9DocumentationGapIds`):
   * the same map the open-question counter classifies with. Absent classifies
   * nothing, so the trace carrier stays omitted (fail closed).
   */
  documentationGapIds?: ReadonlyMap<string, V9DocumentationClassification>;
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
  control?: Pick<V9EconomicControlResult, "score" | "components" | "controlFacts" | "processDiagnostics" | "issuanceFacts">;
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
  dexObservedAtSec?: number | null;
  evidenceReasons?: readonly V9PillarReason[];
  reasonCodes?: readonly V9ReasonCode[];
}

export interface BuildSafetyScoreV9ResponseArgs {
  candidateId: string;
  /** Server-computed open-evidence block; `open-questions.ts` is its only authority. */
  openEvidence: V9OpenEvidence;
  /**
   * Publication union of documentation-classified cause gaps
   * (`buildV9DocumentationCarriers().causeGapIds`). Only ids the response can
   * resolve are published, so an untracked classification never publishes a
   * dangling id.
   */
  documentationCauseGaps?: readonly string[];
  policyVersion: string;
  publicationGenerationId: string;
  publishedAtSec: number;
  /** A producer function hands the builder sole ownership of the returned array. */
  results: readonly V9PublicCardProjectionInput[] | (() => V9PublicCardProjectionInput[]);
  commonModeGroups?: readonly V9CommonModeGroup[];
  dexMaxAgeSec?: number;
}

export interface V9ProjectedResponseArgs extends Omit<BuildSafetyScoreV9ResponseArgs, "results"> {
  resultDigest: string | (() => string);
}

export interface V9PublicResponseProjector {
  project(input: V9PublicCardProjectionInput): void;
  finalize(args: V9ProjectedResponseArgs): SafetyScoreV9CurrentResponse;
}

export interface V9CommonModeProjectionResult {
  trace: Pick<V9ProductionScoreTrace, "assetId" | "caps" | "deploymentAdjustments"> & {
    structuralSignals: readonly Pick<V9ProductionScoreTrace["structuralSignals"][number],
      "kind" | "severity" | "reason" | "failureDomainKeys" |
      "economicLossScope" | "responsibility" | "pricedInPillar">[];
  };
}

type V9PublicResultIdentity = Pick<V9ProductionScoreTrace,
  "baseInputGenerationId" | "factSetDigest" | "policyId" | "policyDigest" |
  "evaluationBuildDigest" | "sourceGenerations" | "asOfSec">;

export interface SafetyScoreV9TopDriver {
  kind: "cap-bound" | "pillar-bound" | "withheld";
  /** Machine key for the cap, or the weakest pillar when score-bearing. */
  label: string | null;
  /** Binding cap limit or weakest pillar score. */
  value: number | null;
  /** Public explanation of the existing binding cap, weakest pillar, or withholding. */
  reason: string | null;
  evidenceFreshness: SafetyScoreV9EvidenceFreshness;
}

const PILLARS = ["backing", "exit", "control"] as const satisfies readonly V9QualityPillar[];
const EVIDENCE_RANK: Readonly<Record<V9EvidenceLevel, number>> = {
  strong: 0,
  adequate: 1,
  limited: 2,
  insufficient: 3,
};
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
  return input.scoreInput.pillars[pillar].aggregationDisposition !== "included"
    ? 0 : input.trace.effectiveScoringWeights?.[pillar] ?? 0;
}

function pillarCauseFields(input: V9PublicCardProjectionInput, pillar: V9QualityPillar) {
  const evaluation = input.scoreInput.pillars[pillar];
  return {
    aggregationDisposition: evaluation.aggregationDisposition,
    causeGapIds: uniqueSorted(evaluation.causeGapIds),
    limitedEvidenceCauses: evaluation.aggregationDisposition === "included"
      ? uniqueSorted(evaluation.limitedEvidenceCauses.filter(
          (cause): cause is "A" | "C" | "U" | "D" => cause === "A" || cause === "C" || cause === "U" || cause === "D",
        ))
      : [],
  };
}


function projectBackingBreakdown(
  input: V9PublicCardProjectionInput,
): NonNullable<V9UninternedPublicCard["breakdowns"]>["backing"] {
  const backing = input.backing;
  if (backing === undefined) {
    throw new Error(`Safety Score v9 ${input.trace.assetId} lacks a backing evaluation`);
  }
  const excluded = input.scoreInput.pillars.backing.aggregationDisposition !== "included";
  const evaluatedScore = excluded ? null : backing.score;
  const reserveGroupWeight = backing.contributions
    .filter((contribution) => contribution.source !== "mechanism")
    .reduce((sum, contribution) => sum + (excluded ? 0 : contribution.effectiveWeight), 0);
  const mechanismGroupWeight = backing.contributions
    .filter((contribution) => contribution.source === "mechanism")
    .reduce((sum, contribution) => sum + (excluded ? 0 : contribution.effectiveWeight), 0);
  const components = (input.scoreInput.pillars.backing.aggregationDisposition === "unavailable" ? [] : [...backing.contributions])
    .sort((left, right) => compareText(left.componentKey, right.componentKey))
    .map((contribution) => {
      const weight = excluded ? 0 : contribution.effectiveWeight;
      return {
        key: contribution.componentKey,
        label: publicLabel(input, contribution.componentKey),
        source: contribution.source,
        score: contribution.score,
        effectiveScoringWeight: weight,
        wholeAssetWeight: contribution.wholeAssetWeight,
        cause: contribution.cause,
        causeGapIds: uniqueSorted(contribution.causeGapIds),
        scoringDisposition: contribution.scoringDisposition,
        ...(contribution.factors === undefined ? {} : { factors: contribution.factors.map((factor) => ({
          ...factor, causeGapIds: uniqueSorted(factor.causeGapIds),
        })) }),
        weightedContribution: contribution.score === null ? 0 : contribution.score * weight,
        observationState: contribution.observationState,
      };
    });
  const waterfallScore = components.reduce(
    (sum, component) => sum + component.weightedContribution,
    0,
  );
  if (evaluatedScore !== null && Math.abs(waterfallScore - evaluatedScore) > 0.000001) {
    throw new Error(
      `Safety Score v9 ${input.trace.assetId} backing waterfall does not reconcile to its evaluated pillar`,
    );
  }
  const group = (
    key: "reserves" | "mechanism",
    label: string,
    sourceComponents: typeof components,
    weight: number,
  ) => {
    const active = sourceComponents.filter((component) => component.effectiveScoringWeight > 0);
    const cause = (["D", "C", "U"] as const).find((candidate) => active.some((component) => component.cause === candidate)) ?? null;
    return {
      key, label,
      score: sourceComponents.reduce((sum, component) => sum + component.weightedContribution, 0) / weight,
      effectiveScoringWeight: weight,
      cause,
      causeGapIds: uniqueSorted(active.flatMap((component) => component.causeGapIds)),
      scoringDisposition: cause === "D" ? "measured-adverse" as const
        : cause === null ? "included" as const : "bounded-uncertainty" as const,
    };
  };
  const groups = [
    ...(reserveGroupWeight > 0
      ? [group("reserves", "Reserves", components.filter((item) => item.source !== "mechanism"), reserveGroupWeight)]
      : []),
    ...(mechanismGroupWeight > 0
      ? [group("mechanism", "Mechanism", components.filter((item) => item.source === "mechanism"), mechanismGroupWeight)]
      : []),
  ];
  const publishedScore = input.scoreInput.pillars.backing.score;
  return {
    evaluatedScore,
    publishedScore,
    ...pillarCauseFields(input, "backing"),
    aggregationWeight: aggregationWeight(input, "backing"),
    groups,
    components,
    adjustments: [],
  };
}

function projectExitBreakdown(
  input: V9PublicCardProjectionInput,
): NonNullable<V9UninternedPublicCard["breakdowns"]>["exit"] {
  const exit = input.exit;
  if (exit === undefined) {
    throw new Error(`Safety Score v9 ${input.trace.assetId} lacks an exit evaluation`);
  }
  const excluded = input.scoreInput.pillars.exit.aggregationDisposition !== "included";
  const evaluatedScore = excluded ? null : exit.score;
  const policy = input.policy.policy.semantic.exit;
  const primary = exit.routes.find((route) => route.routeKey === exit.primaryRouteKey) ?? null;
  const completePrimary =
    primary !== null &&
    !excluded &&
    primary.score !== null &&
    primary.components !== null &&
    primary.confidenceFactor !== null &&
    primary.confidenceDimensions !== null
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
          const factor = completePrimary.factorContributions?.[key];
          if (factor === undefined) {
            throw new Error(`Safety Score v9 ${input.trace.assetId} primary exit route lacks ${key} cause contribution`);
          }
          const score = factor.score;
          const weight = policy.componentWeights[key];
          return {
            key, label, score, weight,
            cause: factor.cause, causeGapIds: uniqueSorted(factor.causeGapIds),
            scoringDisposition: factor.scoringDisposition,
            effectiveScoringWeight: factor.effectiveScoringWeight,
            weightedContribution: score === null ? 0 : score * factor.effectiveScoringWeight,
          };
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
      routeId: route.routeId,
      lane: route.lane,
      label: routeLabel(input, route),
      routeFamily: route.routeFamily,
      score: route.score,
      included: route.included,
      exclusionReason: route.exclusionReason,
      confidenceFactor: route.confidenceFactor,
      confidenceDimensions: route.confidenceDimensions,
      capacityEvidenceTier: route.capacityEvidenceTier,
      rawSameNotionalCostBps: route.rawSameNotionalCostBps,
      capacityScoringHorizon: route.capacityScoringHorizon,
      settlementDelaySec: route.settlementDelaySec,
      ...(route.physicalToUsd ? { physicalToUsd: route.physicalToUsd } : {}),
      ...(route.routeSuspension ? { routeSuspension: route.routeSuspension } : {}),
      ...(route.executionCertificate ? { executionCertificate: projectExitExecutionCertificate(route.executionCertificate) } : {}),
    }));
  const publishedScore = input.scoreInput.pillars.exit.score;
  return {
    evaluatedScore,
    publishedScore,
    ...pillarCauseFields(input, "exit"),
    aggregationWeight: aggregationWeight(input, "exit"),
    stressRequest:
      exit.stressRequest === null
        ? null
        : {
            requestedNotionalUsd: exit.stressRequest.requestedNotionalUsd,
            maxCostBps: exit.stressRequest.maxCostBps,
            comparisonWindowSec: exit.stressRequest.comparisonWindowSec,
            supplyObservedAtSec: exit.stressRequest.supplyObservedAtSec ?? null,
            sizingUncertaintyReason: exit.stressRequest.sizingUncertaintyReason ?? null,
          },
    primaryRoute:
      completePrimary === null
        ? null
        : {
            key: completePrimary.routeKey,
            routeId: completePrimary.routeId,
            lane: completePrimary.lane,
            label: routeLabel(input, completePrimary),
            routeFamily: completePrimary.routeFamily,
            ...(completePrimary.feeEvidence ? { feeEvidence: completePrimary.feeEvidence } : {}),
            score: completePrimary.score!,
            ...(completePrimary.physicalToUsd ? { physicalToUsd: completePrimary.physicalToUsd } : {}),
            ...(completePrimary.executionCertificate ? { executionCertificate: projectExitExecutionCertificate(completePrimary.executionCertificate) } : {}),
            components,
            confidenceFactor: completePrimary.confidenceFactor!,
            confidenceDimensions: completePrimary.confidenceDimensions!,
            capacityEvidenceTier: completePrimary.capacityEvidenceTier,
            rawSameNotionalCostBps: completePrimary.rawSameNotionalCostBps,
            supportedComponentCeiling: completePrimary.supportedComponentCeiling,
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
      excluded || diversificationRoute === null || exit.diversificationBonus <= 0
        ? null
        : {
            routeKey: diversificationRoute.routeKey,
            routeLabel: routeLabel(input, diversificationRoute),
            bonus: exit.diversificationBonus,
          },
    alternatives,
    adjustments: [],
  };
}

function canonicalProcessDiagnostics(
  diagnostics: Iterable<V1005ProcessDiagnostic>,
  issuanceFacts: V1005AssetIssuanceFacts | undefined,
): V1005ProcessDiagnostic[] {
  const processEvidence = uniqueSorted(issuanceFacts?.process?.evidenceRefIds ?? []);
  const processEvidenceSet = new Set(processEvidence);
  const rows = new Map<string, {
    diagnostic: V1005ProcessDiagnostic; evidenceRefs: Set<string>; usesProcessEvidence: boolean;
  }>();
  for (const diagnostic of diagnostics) {
    const referenced = diagnostic.issuanceFactsRef !== undefined;
    const usesProcessEvidence = referenced && diagnostic.issuanceFactsRef === issuanceFacts?.ref && issuanceFacts?.process !== undefined;
    const key = [diagnostic.gate, diagnostic.code, diagnostic.controlRef, diagnostic.pathId,
      diagnostic.classId, diagnostic.memberRef, diagnostic.field].join("\u0000");
    let entry = rows.get(key);
    if (!entry) {
      entry = { diagnostic, evidenceRefs: new Set(), usesProcessEvidence: false };
      rows.set(key, entry);
    }
    entry.usesProcessEvidence ||= usesProcessEvidence;
    if (!referenced) for (const ref of diagnostic.evidenceRefIds) entry.evidenceRefs.add(ref);
  }
  return [...rows.entries()].sort(([left], [right]) => compareText(left, right)).map(([, entry]) => {
    // Reuse the one full evidence table for generated failures; only actual extra refs allocate.
    let evidenceRefIds = processEvidence;
    if (!entry.usesProcessEvidence) {
      evidenceRefIds = [...entry.evidenceRefs].sort(compareText);
    } else if (entry.evidenceRefs.size > 0) {
      const extraRefs: string[] = [];
      for (const ref of entry.evidenceRefs) if (!processEvidenceSet.has(ref)) extraRefs.push(ref);
      if (extraRefs.length > 0) evidenceRefIds = [...processEvidence, ...extraRefs].sort(compareText);
    }
    return { ...entry.diagnostic, evidenceRefIds };
  });
}

function projectIssuanceSummary(control: NonNullable<V9PublicCardProjectionInput["control"]>): SafetyScoreV9IssuanceSummary | undefined {
  const facts = control.controlFacts ?? [];
  if (!control.issuanceFacts && !control.processDiagnostics?.length && !facts.some((fact) => fact.processDiagnostics?.length)) return undefined;
  const governance = control.issuanceFacts?.governance;
  const process = control.issuanceFacts?.process;
  function* diagnostics(): Iterable<V1005ProcessDiagnostic> {
    yield* control.processDiagnostics ?? [];
    yield* control.issuanceFacts?.diagnostics ?? [];
    yield* governance?.diagnostics ?? [];
    yield* governance?.votingControl.diagnostics ?? [];
    yield* process?.diagnostics ?? [];
    yield* process?.votingControl.diagnostics ?? [];
    for (const fact of facts) {
      yield* fact.processDiagnostics ?? [];
    }
  }
  const grouped = new Map<string, {
    summary: SafetyScoreV9IssuanceSummary["diagnostics"][number];
    controlRefs: Set<V1005ProcessDiagnostic["controlRef"]>;
  }>();
  for (const diagnostic of canonicalProcessDiagnostics(diagnostics(), control.issuanceFacts)) {
    const key = [diagnostic.gate, diagnostic.code, diagnostic.field, diagnostic.classId].join("\u0000");
    let group = grouped.get(key);
    if (!group) {
      group = {
        summary: { code: diagnostic.code, gate: diagnostic.gate, field: diagnostic.field,
          classId: diagnostic.classId, count: 0, controlRefs: [], exemplars: [] },
        controlRefs: new Set(),
      };
      grouped.set(key, group);
    }
    group.controlRefs.add(diagnostic.controlRef);
    group.summary.count++;
    if (group.summary.exemplars.length < 3) {
      const { issuanceFactsRef: _ref, ...measurements } = diagnostic;
      group.summary.exemplars.push({
        ...measurements, evidenceRefIds: diagnostic.evidenceRefIds.slice(0, 3),
        evidenceRefCount: diagnostic.evidenceRefIds.length,
      });
    }
  }
  if (!governance && !process && grouped.size === 0) return undefined;
  let governanceSummary: SafetyScoreV9IssuanceSummary["governance"];
  if (governance) {
    const { incompleteReasons, nonGovernorUnboundedPathKeys, diagnostics: governanceDiagnostics, votingControl, ...measurements } = governance;
    const incompleteReasonCounts = new Map<string, number>();
    for (const reason of incompleteReasons) {
      const separator = reason.indexOf(":");
      const code = separator < 0 ? reason : reason.slice(0, separator);
      incompleteReasonCounts.set(code, (incompleteReasonCounts.get(code) ?? 0) + 1);
    }
    governanceSummary = {
      ...measurements, incompleteReasonCount: incompleteReasons.length,
      incompleteReasonCounts: [...incompleteReasonCounts.entries()].sort(([left], [right]) => compareText(left, right))
        .map(([code, count]) => ({ code, count })),
      nonGovernorUnboundedPathCount: nonGovernorUnboundedPathKeys.length, diagnosticCount: governanceDiagnostics.length,
      votingControl: {
        observationState: votingControl.observationState, qualified: votingControl.qualified,
        largestSingleControllerShareBps: votingControl.largestSingleControllerShareBps,
        affiliatedAggregateShareBps: votingControl.affiliatedAggregateShareBps,
        affiliatedUnilateralRouteCount: votingControl.affiliatedUnilateralRouteIds.length,
        unknownAboveThresholdVoteOwnershipControllerCount: votingControl.unknownAboveThresholdVoteOwnershipControllerIds.length,
        otherHolderVoteOperatorControllerCount: votingControl.otherHolderVoteOperatorControllerIds.length,
        privilegedVoteCreation: votingControl.privilegedVoteCreation, forcedDelegation: votingControl.forcedDelegation,
        censusReconciliationCount: votingControl.censusReconciliations.length,
        unreconciledCensusCount: votingControl.censusReconciliations.filter((row) => row.state === "unreconciled").length,
      },
    };
  }
  let processSummary: SafetyScoreV9IssuanceSummary["process"];
  if (process) {
    const { nonGovernorDiscretionaryPathKeys, unclassifiedExpansionPathKeys, unknownRecipientPathKeys,
      votingControl: _votingControl, diagnostics: processDiagnostics, evidenceRefIds, ...measurements } = process;
    processSummary = {
      ...measurements, nonGovernorDiscretionaryPathCount: nonGovernorDiscretionaryPathKeys.length,
      unclassifiedExpansionPathCount: unclassifiedExpansionPathKeys.length, unknownRecipientPathCount: unknownRecipientPathKeys.length,
      evidenceRefCount: evidenceRefIds.length, diagnosticCount: processDiagnostics.length,
    };
  }
  return {
    ...(governanceSummary ? { governance: governanceSummary } : {}),
    ...(processSummary ? { process: processSummary } : {}),
    diagnostics: [...grouped.entries()].sort(([left], [right]) => compareText(left, right)).map(([, group]) => ({
      ...group.summary, controlRefs: [...group.controlRefs].sort((left, right) => compareText(left ?? "", right ?? "")),
    })),
  };
}

const CONTROL_AUTHORITY_NOUNS: Readonly<Record<V9DeploymentControlFactV2["controlKind"], string>> = {
  mint: "mint authority",
  upgrade: "upgrade authority",
  custody: "custody authority",
  freeze: "freeze authority",
  governance: "governance authority",
  oracle: "oracle authority",
  bridge: "bridged-token mint",
};

/**
 * `mint` and `mint:binding` are the scorer's pick among the binding native
 * paths; tied paths are dropped, so naming the pick's chain or role would name
 * one arbitrary tie-winner (USDC ties four single-signer EOAs at 80).
 */
const NATIVE_MINT_LABEL = "Native mint authority";

/**
 * Names a row that stands for exactly one control after the fact that scored
 * it, so a multi-chain asset reads "Taiko bridged-token mint" or "Solana
 * upgrade authority" instead of fifty identical "Mint authority" rows. A
 * global control carries an `asset:` deployment key, so its chain comes from
 * its authority.
 */
function controlFactLabel(
  component: V9EconomicControlResult["components"][number],
  fact: V9DeploymentControlFactV2,
): string | null {
  if (component.kind === "bridge") {
    const chain = v9ControlChainLabel(fact.deploymentKey);
    return chain === null ? null : `${chain} bridge`;
  }
  if (component.kind !== "mint") return null;
  if (component.binding && (component.componentKey === "mint" || component.componentKey === "mint:binding")) {
    return NATIVE_MINT_LABEL;
  }
  const chain = v9ControlChainLabel(fact.deploymentKey) ??
    (fact.authority === null ? null : v9ControlChainLabel(fact.authority.authorityKey));
  const noun = v9BridgeMintControlKey(component.componentKey) !== null
    ? CONTROL_AUTHORITY_NOUNS.bridge
    : CONTROL_AUTHORITY_NOUNS[fact.controlKind];
  return chain === null ? `${noun.charAt(0).toUpperCase()}${noun.slice(1)}` : `${chain} ${noun}`;
}

function shortKeyTail(key: string): string | null {
  const tail = key.slice(key.indexOf(":") + 1);
  if (tail.length === 0 || tail === key) return null;
  return tail.length > 12 ? `${tail.slice(0, 6)}…${tail.slice(-4)}` : tail;
}

/**
 * Rows sharing a label within one card get the first identity that tells the
 * whole group apart: the execution path (one controller split into reviewed
 * paths), then the authority, then the deployment.
 */
function disambiguateControlLabels(
  labels: readonly string[],
  facts: readonly (V9DeploymentControlFactV2 | undefined)[],
): string[] {
  const groups = new Map<string, number[]>();
  labels.forEach((label, index) => groups.set(label, [...(groups.get(label) ?? []), index]));
  const result = [...labels];
  const identities: ((fact: V9DeploymentControlFactV2) => string | null)[] = [
    (fact) => fact.executionPathId?.replace(/[_-]+/g, " ") ?? null,
    (fact) => fact.authority === null ? null : shortKeyTail(fact.authority.authorityKey),
    (fact) => shortKeyTail(fact.deploymentKey),
  ];
  for (const [label, indices] of groups) {
    if (indices.length < 2 || indices.some((index) => facts[index] === undefined)) continue;
    for (const identity of identities) {
      const suffixes = indices.map((index) => identity(facts[index]!));
      if (suffixes.some((suffix) => suffix === null) || new Set(suffixes).size !== suffixes.length) continue;
      indices.forEach((index, position) => { result[index] = `${label} · ${suffixes[position]}`; });
      break;
    }
  }
  return result;
}

function projectControlBreakdown(
  input: V9PublicCardProjectionInput,
): NonNullable<V9UninternedPublicCard["breakdowns"]>["control"] {
  const control = input.control;
  if (control === undefined) {
    throw new Error(`Safety Score v9 ${input.trace.assetId} lacks a control evaluation`);
  }
  const excluded = input.scoreInput.pillars.control.aggregationDisposition !== "included";
  const evaluatedScore = excluded ? null : control.score;
  const publishedScore = input.scoreInput.pillars.control.score;
  const issuanceSummary = projectIssuanceSummary(control);
  const components = input.scoreInput.pillars.control.aggregationDisposition === "unavailable" ? [] : [...control.components];
  const usedControlKeys = new Set(components.flatMap((component) => component.controlKeys));
  const detailFacts = (control.controlFacts ?? []).filter((fact) => usedControlKeys.has(fact.controlKey))
    .sort((left, right) => compareText(left.controlKey, right.controlKey));
  const detailRefs = new Map(detailFacts.map((fact, index) => [fact.controlKey, index]));
  const factsByKey = new Map(detailFacts.map((fact) => [fact.controlKey, fact]));
  const sortedComponents = components.sort((left, right) => compareText(left.componentKey, right.componentKey));
  const singleFacts = sortedComponents.map((component) =>
    component.controlKeys.length === 1 ? factsByKey.get(component.controlKeys[0]!) : undefined);
  const componentLabels = disambiguateControlLabels(sortedComponents.map((component, index) =>
    component.kind === "oracle" && component.posture === "privileged-internal-pricing"
      ? "Privileged internal pricing"
      : component.kind === "oracle" && component.posture === "oracleless"
        ? "Oracleless design"
        : component.kind === "inventory" ? "Control inventory"
          : (singleFacts[index] === undefined ? null : controlFactLabel(component, singleFacts[index]!)) ??
            input.display?.labels?.[component.componentKey] ??
            (component.kind === "mint" ? "Mint authority" : component.kind === "oracle" ? "Price oracle" : "Bridge authority")), singleFacts);
  const controlDetails = detailFacts.map((fact) => {
    const signatures = effectiveAuthoritySignatureRequirement(fact.authority);
    const executionPaths = [
      ...(fact.executionScope?.paths.filter((path) => fact.executionPathId === undefined || path.id === fact.executionPathId) ?? []),
      ...(fact.executionScopeContributors ?? []).flatMap((entry) => entry.scope?.paths.filter((path) => fact.executionPathId === undefined || path.id === fact.executionPathId) ?? []),
    ].map((path) => ({ id: path.id, targetDeployment: path.targetDeployment, entrypointKind: path.entrypointKind, entrypoints: path.entrypoints, activation: path.activation, reach: path.reach, capabilities: path.capabilities }));
    return {
      controlKey: fact.controlKey, authority: fact.authority,
      ...(signatures === null ? {} : { minimumCryptographicSignatures: signatures }),
      ...(fact.executionScopeComplete == null ? {} : { executionScopeComplete: fact.executionScopeComplete }),
      ...(fact.moduleImpact == null || fact.moduleImpact === "unresolved" ? {} : { moduleImpact: fact.moduleImpact }),
      ...(fact.scopeDiagnostics?.length ? { diagnostics: fact.scopeDiagnostics } : {}),
      ...(executionPaths.length ? { executionPaths } : {}),
    };
  });
  return {
    evaluatedScore,
    publishedScore,
    ...pillarCauseFields(input, "control"),
    aggregationWeight: aggregationWeight(input, "control"),
    method: "minimum-binding-component",
    ...(issuanceSummary ? { issuanceSummary } : {}),
    ...(controlDetails.length ? { controlDetails } : {}),
    components: sortedComponents.map((component, index) => ({
        key: component.componentKey,
        label: componentLabels[index]!,
        kind: component.kind,
        score: component.score,
        cause: component.cause,
        causeGapIds: uniqueSorted(component.causeGapIds),
        scoringDisposition: component.scoringDisposition,
        effectiveScoringWeight: excluded ? 0 : component.effectiveScoringWeight,
        binding: !excluded && !["not-applicable", "excluded-pipeline", "excluded-uncurated"].includes(component.scoringDisposition) && component.binding,
        posture: component.posture,
        ...(component.controlKeys.some((key) => detailRefs.has(key)) ? {
          controlDetailRefs: uniqueSorted(component.controlKeys).flatMap((key) => {
            const ref = detailRefs.get(key);
            return ref === undefined ? [] : [ref];
          }),
        } : {}),
      })),
    adjustments: [],
  };
}

function projectBreakdowns(
  input: V9PublicCardProjectionInput,
): V9UninternedPublicCard["breakdowns"] {
  if (input.trace.ratingStatus === "not-rated") return null;
  return {
    backing: projectBackingBreakdown(input),
    exit: projectExitBreakdown(input),
    control: projectControlBreakdown(input),
  };
}

function publicReason(reason: V9PillarReason): V9UninternedPublic<SafetyScoreV9PublicReason> {
  return {
    code: reason.code, message: reason.message, path: reason.path || null,
    cause: reason.cause ?? null, causeGapIds: uniqueSorted(reason.causeGapIds ?? []),
  };
}

function canonicalPublicReasons(reasons: readonly V9PillarReason[]): V9UninternedPublic<SafetyScoreV9PublicReason>[] {
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

function canonicalNrReasons(trace: V9ProductionScoreTrace): V9UninternedPublic<SafetyScoreV9NrReason>[] {
  if (trace.ratingStatus === "pipeline-gap") return [];
  const reasons: V9UninternedPublic<SafetyScoreV9NrReason>[] = [
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

function projectPillars(input: V9PublicCardProjectionInput): V9UninternedPublicCard["pillars"] {
  const contributions = new Map(
    input.trace.pillarContributions.map((contribution) => [contribution.pillar, contribution.score]),
  );
  const project = (pillar: V9QualityPillar) => {
    const evaluation = input.scoreInput.pillars[pillar];
    const contribution = contributions.get(pillar);
    if (input.trace.ratingStatus !== "pipeline-gap" && evaluation.score !== null && contribution !== evaluation.score) {
      throw new Error(`Safety Score v9 ${input.trace.assetId} ${pillar} pillar does not match its score trace`);
    }
    const pricedUnknown = input.trace.aggregation?.pricedUnknownPillars.find((item) => item.pillar === pillar);
    if (evaluation.score === null && contribution !== undefined && contribution !== pricedUnknown?.score) {
      throw new Error(`Safety Score v9 ${input.trace.assetId} ${pillar} trace contains a missing pillar`);
    }
    return {
      score: evaluation.score,
      ...pillarCauseFields(input, pillar),
      supportedComponentKeys: uniqueSorted(evaluation.supportedComponentKeys),
      evidenceLevel: evaluation.evidenceLevel,
      freshness: input.freshness?.[pillar] ?? "unknown",
      components: pillarComponents(input, pillar),
      reasons: canonicalPublicReasons(evaluation.reasons),
    };
  };
  return { backing: project("backing"), exit: project("exit"), control: project("control") };
}

function projectDependencies(input: V9PublicCardProjectionInput): V9UninternedPublicCard["dependencies"] {
  const targetPillar = (role: V9DependencyEconomicRole): "exit" | "control" | null => {
    if (role === "exit-dependency") return "exit";
    if (role === "control-operator" || role === "oracle-nav") return "control";
    return null;
  };
  return {
    serial: [...input.dependencyInputs.serial]
      .sort((left, right) => compareText(left.upstreamAssetId, right.upstreamAssetId))
      .map((dependency) => ({
        upstreamAssetId: dependency.upstreamAssetId, score: dependency.score, blocked: dependency.blocked,
        ratingStatus: dependency.ratingStatus ?? (dependency.score === null ? "not-rated" : "rated"),
        partialEvidence: projectV9CompactPartialEvidence(dependency.partialEvidence ?? null),
        causeGapIds: uniqueSorted(dependency.causeGapIds ?? []),
        limitedEvidenceCauses: uniqueSorted((dependency.limitedEvidenceCauses ?? []).filter(
          (cause): cause is "C" | "U" | "D" => cause === "C" || cause === "U" || cause === "D",
        )),
        wrapperForm: input.dependencyTypes?.get(`serial:${dependency.upstreamAssetId}`) === "wrapper" ? input.trace.wrapperParentLimit?.form ?? null : null,
        ...(input.dependencyTypes?.get(`serial:${dependency.upstreamAssetId}`) === undefined ? {} : { dependencyType: input.dependencyTypes.get(`serial:${dependency.upstreamAssetId}`) }),
        ...(input.dependencyProvenance?.get(dependency.upstreamAssetId) === undefined ? {} : { provenance: input.dependencyProvenance.get(dependency.upstreamAssetId) }),
      })),
    basket: [...input.dependencyInputs.basket]
      .sort((left, right) => compareText(left.upstreamAssetId, right.upstreamAssetId))
      .map((dependency) => ({
        upstreamAssetId: dependency.upstreamAssetId, score: dependency.score, weight: dependency.weight,
        ...(input.trace.wrapperParentLimit?.parentKind === "concentrated-collateral" &&
            input.trace.wrapperParentLimit.parentAssetId === dependency.upstreamAssetId
          ? { collateralParentScore: input.trace.wrapperParentLimit.parentScore } : {}),
        boundedUnknown: dependency.boundedUnknown,
        ratingStatus: dependency.ratingStatus ?? (dependency.score === null ? "not-rated" : "rated"),
        partialEvidence: projectV9CompactPartialEvidence(dependency.partialEvidence ?? null),
        causeGapIds: uniqueSorted(dependency.causeGapIds ?? []),
        limitedEvidenceCauses: uniqueSorted((dependency.limitedEvidenceCauses ?? []).filter(
          (cause): cause is "C" | "U" | "D" => cause === "C" || cause === "U" || cause === "D",
        )),
        wrapperForm: null,
        ...(input.dependencyTypes?.get(`basket:${dependency.upstreamAssetId}`) === undefined ? {} : { dependencyType: input.dependencyTypes.get(`basket:${dependency.upstreamAssetId}`) }),
        ...(input.dependencyProvenance?.get(dependency.upstreamAssetId) === undefined ? {} : { provenance: input.dependencyProvenance.get(dependency.upstreamAssetId) }),
      })),
    roles: [...(input.dependencyInputs.roleInputs ?? [])]
      .sort(
        (left, right) =>
          compareText(left.role, right.role) ||
          compareText(left.upstreamAssetId, right.upstreamAssetId) ||
          compareText(left.edgeKey, right.edgeKey),
      )
      .map((dependency) => {
        const pillar = targetPillar(dependency.role);
        return {
          edgeKey: dependency.edgeKey,
          exposureKey: dependency.exposureKey,
          riskEventKey: dependency.riskEventKey,
          upstreamAssetId: dependency.upstreamAssetId,
          role: dependency.role,
          weight: dependency.weight,
          targetPillar: pillar,
          inheritedDimensions: [...dependency.inheritedDimensions],
          unavailableDimensions: [...dependency.unavailableDimensions],
          score: dependency.score,
          ratingStatus: dependency.ratingStatus ?? (dependency.score === null ? "not-rated" : "rated"),
          partialEvidence: projectV9CompactPartialEvidence(dependency.partialEvidence ?? null),
          causeGapIds: uniqueSorted(dependency.causeGapIds ?? []),
          limitedEvidenceCauses: uniqueSorted((dependency.limitedEvidenceCauses ?? []).filter(
            (cause): cause is "C" | "U" | "D" => cause === "C" || cause === "U" || cause === "D",
          )),
          boundedUnknown: dependency.boundedUnknown,
          cycleBlocked: dependency.cycleBlocked,
          evidenceRefIds: [...dependency.evidenceRefIds].sort(compareText),
          failureDomains: [...dependency.failureDomains].sort((left, right) =>
            compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
          ),
        };
      }),
    cycleBlocked: input.dependencyInputs.cycleBlocked,
    reasonCodes: uniqueSorted(input.scoreInput.dependencyReasons.map((reason) => reason.code)),
  };
}

/** One published evidence fact, as the responsibility and documentation carriers read it. */
interface V9DocumentationCarrierFact {
  readonly responsibility: V9EvidenceResponsibility;
  readonly sourceGapId: string | null;
  readonly causeGapIds: readonly string[];
  readonly critical: boolean;
}

/**
 * Documentation reason of one published evidence fact: the fact's single causal
 * gap, resolved exactly like the obligation counter resolves it (`sourceGapId`,
 * else a one-root `causeGapIds`). A multi-root or unresolvable witness stays
 * unclassified, and an absent classification classifies nothing (fail closed).
 */
function documentationReasonForFact(
  classified: ReadonlyMap<string, V9DocumentationClassification> | undefined,
  sourceGapId: string | null,
  causeGapIds: readonly string[],
): V9DocumentationReason | null {
  if (classified === undefined) return null;
  const resolved = sourceGapId ?? (causeGapIds.length === 1 ? causeGapIds[0]! : null);
  return resolved === null ? null : classified.get(resolved)?.reason ?? null;
}

/**
 * Per-card `documentation-class-v1` carrier: the card's documentation-classed
 * evidence facts by reason. Omitted when nothing is classified, so a T1 payload
 * keeps its published bytes.
 */
function projectDocumentationEvidence(
  assetId: string,
  rows: readonly { readonly fact: V9DocumentationCarrierFact; readonly reason: V9DocumentationReason | null }[],
): {
  semantics: "documentation-class-v1";
  totalFactCount: number;
  criticalFactCount: 0;
  summaries: { reason: V9DocumentationReason; factCount: number }[];
} | undefined {
  const byReason = new Map<V9DocumentationReason, number>();
  let totalFactCount = 0;
  for (const { fact, reason } of rows) {
    if (reason === null) continue;
    // The schema publishes `criticalFactCount: 0` as a release invariant: a
    // critical datum can move a score, so it must never be documentation.
    if (fact.critical) {
      throw new Error(`Safety Score v9 ${assetId} classifies a critical evidence fact as documentation`);
    }
    totalFactCount++;
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  if (totalFactCount === 0) return undefined;
  return {
    semantics: "documentation-class-v1",
    totalFactCount,
    criticalFactCount: 0,
    summaries: [...byReason.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([reason, factCount]) => ({ reason, factCount })),
  };
}

function projectScoreTrace(input: V9PublicCardProjectionInput): V9UninternedPublicCard["scoreTrace"] {
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
      adjustmentPoints: round4(adjustment.scoreBefore - adjustment.scoreAfter),
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
  const documentationReasons: (V9DocumentationReason | null)[] = [];
  const responsibilityFacts = trace.unresolvedFacts.map((fact) => {
    if (fact.path === undefined) {
      throw new Error(
        `Safety Score v9 ${trace.assetId} unresolved fact ${fact.code} lacks an exact fact path`,
      );
    }
    if (fact.cause === undefined || fact.scoringDisposition === undefined) {
      throw new Error(`Safety Score v9 ${trace.assetId} unresolved fact ${fact.code} lacks cause-aware scoring disposition`);
    }
    const causeGapIds = uniqueSorted(fact.causeGapIds ?? (fact.sourceGapId ? [fact.sourceGapId] : []));
    documentationReasons.push(documentationReasonForFact(
      input.documentationGapIds,
      typeof fact.sourceGapId === "string" ? fact.sourceGapId : null,
      causeGapIds,
    ));
    return {
      reasonCode: fact.code,
      exactFactPath: fact.path,
      sourceGapId: fact.sourceGapId ?? null,
      responsibility: fact.responsibility,
      critical: fact.critical,
      cause: fact.cause,
      causeGapIds,
      scoringDisposition: fact.scoringDisposition,
    };
  });
  const documentedFacts = responsibilityFacts.map((fact, index) => ({
    fact,
    reason: documentationReasons[index]!,
  }));
  const responsibilitySummaries = RESPONSIBILITIES.map((responsibility) => {
    const rows = documentedFacts.filter(({ fact }) => {
      if (fact.responsibility === undefined) {
        throw new Error(
          `Safety Score v9 ${trace.assetId} unresolved fact ${fact.reasonCode} lacks evidence responsibility`,
        );
      }
      return fact.responsibility === responsibility;
    });
    const facts = rows.map(({ fact }) => fact);
    const documentationFactCount = countV9EvidenceObligations(
      rows.filter(({ reason }) => reason !== null).map(({ fact }) => fact),
      (fact) => fact.sourceGapId,
      (fact) => fact.causeGapIds,
      (fact) => fact.critical,
    ).factCount;
    return {
      responsibility,
      ...countV9EvidenceObligations(
        facts,
        (fact) => fact.sourceGapId,
        // Count the same canonical causal roots emitted in responsibilityFacts.
        // Repeated witnesses for one root are not a multi-root obligation.
        (fact) => fact.causeGapIds,
        (fact) => fact.critical,
      ),
      reasonCodes: uniqueSorted(facts.map((fact) => fact.reasonCode)),
      ...(documentationFactCount === 0 ? {} : { documentationFactCount }),
    };
  });
  const documentation = projectDocumentationEvidence(trace.assetId, documentedFacts);
  const deploymentAdjustmentPoints =
    trace.baseAssetScore === null || trace.deploymentAdjustedScore === null
      ? null
      : round4(trace.baseAssetScore - trace.deploymentAdjustedScore);

  return {
    schemaVersion: 4,
    ...(input.providerRowExclusions?.length ? { providerRowExclusions: input.providerRowExclusions } : {}),
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
            includedPillars: [...trace.aggregation.includedPillars],
            excludedPillars: [...trace.aggregation.excludedPillars],
            pricedUnknownPillars: trace.aggregation.pricedUnknownPillars.map((item) => ({
              ...item, causeGapIds: uniqueSorted(item.causeGapIds),
            })),
            effectiveScoringWeights: { ...trace.aggregation.effectiveScoringWeights },
            supportCeiling: trace.aggregation.supportCeiling,
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
      items: trace.adverseAttribution.filter((attribution) => {
        if (!attribution.path.includes("structural:active-control-incident:")) return true;
        // A parent limit already explains inherited risk. Do not headline an
        // incident without a material, directly attributed loss on this card.
        if (attribution.source === "parent-score") return false;
        const loss = trace.deploymentAdjustments
          .filter((adjustment) => adjustment.sourceSignalKeys.some((key) => key.startsWith("signal:active-control-incident:")))
          .reduce((sum, adjustment) => sum + adjustment.adjustmentPoints, 0);
        return loss >= 0.5 || input.control?.components.some((component) =>
          component.binding && component.posture === "compromised") === true;
      })
        .sort(
          (left, right) =>
            compareText(left.source, right.source) ||
            compareText(left.path, right.path) ||
            compareText(left.message, right.message),
        )
        .map((attribution) => ({
          ...attribution,
          message: attribution.path.startsWith("structural:active-control-incident:") &&
            !input.control?.components.some((component) => component.binding && component.posture === "compromised")
            ? `Deployment-scoped incident: ${attribution.message}` : attribution.message,
        })),
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
        .map(({ boundedness: _boundedness, ...attribution }) => {
          if (attribution.cause === undefined) throw new Error(`Safety Score v9 ${trace.assetId} bounded attribution lacks a cause`);
          return { ...attribution, cause: attribution.cause, causeGapIds: uniqueSorted(attribution.causeGapIds ?? []) };
        }),
    },
    evidenceResponsibility: {
      semantics: "limiting-fact-cause-v2",
      totalFactCount: trace.unresolvedFacts.length,
      facts: responsibilityFacts,
      summaries: responsibilitySummaries,
      ...(documentation === undefined ? {} : { documentation }),
    },
    scoreAdjustments: trace.scoreAdjustments.map((adjustment) => ({ ...adjustment })),
    wrapperParentLimit:
      trace.wrapperParentLimit === null
        ? null
        : { ...trace.wrapperParentLimit },
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

function projectPartialEvidence(input: V9PublicCardProjectionInput): V9UninternedPublicCard["partialEvidence"] {
  const partial = input.trace.partialEvidence;
  if (partial === null) return null;
  // Every excluded pillar retains its diagnostic roots, including evidence-free
  // pillars with C/U gaps. Visibility does not turn those gaps into A/B causes
  // or feed them back into scoring and parent-exclusion propagation.
  let missingGapIds: string[] | undefined;
  for (const pillar of PILLARS) {
    const evaluation = input.scoreInput.pillars[pillar];
    if (evaluation.aggregationDisposition === "included") continue;
    for (const id of evaluation.causeGapIds) {
      if (!partial.causeGapIds.includes(id)) (missingGapIds ??= []).push(id);
    }
  }
  return missingGapIds === undefined ? partial : {
    ...partial,
    causeGapIds: uniqueSorted([...partial.causeGapIds, ...missingGapIds]),
  };
}

function projectLocalAuthorityExposure(input: V9PublicCardProjectionInput): SafetyScoreV9CurrentCard["localAuthorityExposure"] {
  if (input.trace.ratingStatus !== "rated") return undefined;
  const qualities = new Map<string, number>();
  for (const authority of input.scoreInput.pillars.control.deploymentAuthorities ?? []) {
    qualities.set(authority.deploymentKey, Math.min(qualities.get(authority.deploymentKey) ?? authority.quality, authority.quality));
  }
  const priced = input.trace.deploymentAdjustments.flatMap((row) => {
    if (!row.signalKey.startsWith("local-authority:") || row.adjustmentPoints <= 0) return [];
    const key = row.signalKey.slice("local-authority:".length);
    const quality = qualities.get(key);
    if (quality === undefined || row.exposureShare <= 0) return [];
    return [{ key, quality, share: row.exposureShare, loss: row.adjustmentPoints }];
  }).sort((a, b) => b.loss - a.loss || compareText(a.key, b.key));
  if (priced.length === 0) return undefined;
  const coveredShare = priced.reduce((sum, row) => sum + row.share, 0);
  return {
    worstQuality: Math.min(...priced.map(row => row.quality)),
    coveredShare: coveredShare > 1 ? null : coveredShare,
    slices: priced.slice(0, 3).map(({ key, quality, share }) => {
      const [chain, identity] = key.split(":");
      const label = input.display?.labels?.[key] ??
        `${humanizeLabel(chain!)} deployment${identity ? ` (${identity.slice(0, 6)}...${identity.slice(-4)})` : ""}`;
      return { deploymentLabel: label.slice(0, 120), share, quality };
    }),
    moreCount: Math.max(0, priced.length - 3),
  };
}

function projectSafetyScoreV9CardUnchecked(input: V9PublicCardProjectionInput): V9InternedPublicCardDraft {
  const isRateable = input.trace.finalScore !== null;
  const caps = input.trace.caps.map((cap) => ({
    kind: cap.kind,
    limit: cap.limit,
    source: cap.source,
    reason: cap.reason,
    binding: isRateable && cap.binding,
  }));
  const bindingCap = isRateable ? (caps.find((cap) => cap.binding) ?? null) : null;
  const breakdowns = projectBreakdowns(input);
  const unknownPricedWeightShare = isRateable
    ? computeV9UnknownPricedWeightShare(breakdowns, input.trace.aggregation) : 0;
  const localAuthorityExposure = projectLocalAuthorityExposure(input);
  return internV9PublicCauseGaps(readableV9PublicWitnesses({
    id: input.trace.assetId,
    supply: input.supply ?? { circulatingUsdAtEvaluation: null, asOfSec: null, generationId: null },
    ...(input.sharedBookId == null ? {} : { sharedBookId: input.sharedBookId }),
    ...(input.dependencyCoverage === undefined ? {} : { dependencyCoverage: input.dependencyCoverage }),
    ...(input.backingFromLiveReserves === undefined
      ? {}
      : { backingFromLiveReserves: input.backingFromLiveReserves }),
    score: input.trace.finalScore,
    grade: input.trace.finalGrade,
    ...(unknownPricedWeightShare > 0.5 ? { provisional: true as const, unknownPricedWeightShare } : {}),
    ...(localAuthorityExposure === undefined ? {} : { localAuthorityExposure }),
    ratingStatus: input.trace.ratingStatus,
    partialEvidence: projectPartialEvidence(input),
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
      ...(input.access.freezeLookthrough == null ? {} : { freezeLookthrough: input.access.freezeLookthrough }),
    },
    dependencies: projectDependencies(input),
    scoreTrace: projectScoreTrace(input),
    breakdowns,
  }));
}

// The single-card seam carries the same root gap authority as production.
export function projectSafetyScoreV9Card(input: V9PublicCardProjectionInput): { card: SafetyScoreV9CurrentCard; foreignCauseGaps: string[] } {
  const projection = finalizeV9PublicCauseGaps([projectSafetyScoreV9CardUnchecked(input)]);
  return { card: SafetyScoreV9CurrentCardSchema.parse(projection.cards[0]), foreignCauseGaps: projection.foreignCauseGaps };
}

const MINT_HEADLINE_REASONS: Readonly<Record<V9MintPosture, string>> = {
  "none-resolved": "No privileged mint authority is established in the reviewed scope.",
  "bounded-admin": "Privileged mint authority is economically bounded.",
  "partially-bounded-admin": "Privileged mint authority is only partly economically bounded.",
  "concentrated-admin": "Mint authority is concentrated in privileged administrators.",
  "collateral-gated": "Privileged minting is collateral-gated.",
  "unbounded-reconciled": "Mint authority is economically unbounded, with qualifying reconciliation or prudential supervision.",
  "unbounded-governed": "Mint authority is economically unbounded but subject to qualifying delayed governance.",
  "unbounded-veto-guarded": "Mint authority is economically unbounded but subject to a qualifying public minority-veto window.",
  "unbounded-operationally-governed": "Mint authority is economically unbounded; its operational process is reviewed separately.",
  "unbounded-adverse": "Economically effective mint authority is unbounded.",
  compromised: "Mint authority is under an active incident.",
  unknown: "The mint authority posture remains unresolved.",
};

function weakestPillarHeadline(
  card: SafetyScoreV9CurrentCard,
  weakest: NonNullable<SafetyScoreV9CurrentCard["weakestPillar"]>,
): string {
  const scoreLabel = String(Math.round(weakest.score * 10) / 10);
  if (weakest.pillar === "control") {
    const binding = card.breakdowns?.control.components.find((component) =>
      component.binding && component.score === weakest.score);
    if (binding) {
      if (binding.kind === "mint" && Object.prototype.hasOwnProperty.call(MINT_HEADLINE_REASONS, binding.posture)) {
        return MINT_HEADLINE_REASONS[binding.posture as V9MintPosture];
      }
      return `${readableV9PublicText(binding.label)} limits Economic Control to ${scoreLabel}/100.`;
    }
  }
  const reasons = card.pillars[weakest.pillar].reasons;
  // Exit reasons must belong to the credited route, not an unused alternative.
  const primary = weakest.pillar === "exit" ? card.breakdowns?.exit.primaryRoute?.key : null;
  const reason = primary
    ? reasons.find((item) => item.path?.includes(primary))
    : weakest.pillar !== "control" ? reasons[0] : undefined;
  if (reason) return readableV9PublicText(reason.message);
  const label = weakest.pillar === "control" ? "Economic Control" : weakest.pillar === "backing" ? "Backing" : "Exit";
  return `${label} is the weakest pillar at ${scoreLabel}/100.`;
}


/**
 * Projects the existing public card into the one-line driver used by list
 * surfaces. This is deliberately a read-only projection: it does not inspect
 * score inputs or recompute a cap, pillar minimum, or evidence state.
 */
export function projectTopDriver(card: SafetyScoreV9CurrentCard): SafetyScoreV9TopDriver | null {
  if (card.witnessTexts !== undefined) card = resolveV9PublicWitnessTexts(card);
  const evidenceFreshness = card.evidence.freshness;
  // A pipeline gap is technical unavailability, not a withheld verdict; it has
  // no score-bearing driver to project.
  if (card.ratingStatus === "pipeline-gap") return null;
  if (card.score === null || card.grade === "NR") {
    const message = card.nrReasons[0]?.message ?? "Required evidence is withheld.";
    return {
      kind: "withheld",
      label: null,
      value: null,
      reason: card.witnessTexts === undefined ? message : resolveV9PublicWitnessText(card, message),
      evidenceFreshness,
    };
  }
  if (card.bindingCap !== null) {
    return {
      kind: "cap-bound",
      label: card.bindingCap.kind,
      value: card.bindingCap.limit,
      reason: card.bindingCap.reason,
      evidenceFreshness,
    };
  }
  if (card.weakestPillar !== null) {
    return {
      kind: "pillar-bound",
      label: card.weakestPillar.pillar,
      value: card.weakestPillar.score,
      reason: weakestPillarHeadline(card, card.weakestPillar),
      evidenceFreshness,
    };
  }
  return null;
}

function canonicalSourceGenerations(sourceGenerations: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(sourceGenerations).sort(([left], [right]) => compareText(left, right)));
}

const V9_RESULT_IDENTITY_FIELDS = [
  ["factSetDigest", "fact-set digest"],
  ["baseInputGenerationId", "base input generation"],
  ["evaluationBuildDigest", "evaluation build"],
  ["policyId", "policy ID"],
  ["policyDigest", "policy digest"],
] as const;

function assertMatchingResultIdentity(
  first: V9PublicResultIdentity,
  firstSourceGenerations: string,
  trace: V9ProductionScoreTrace,
): void {
  for (const [key, label] of V9_RESULT_IDENTITY_FIELDS) {
    if (trace[key] !== first[key]) {
      throw new Error(`Safety Score v9 publication mixes ${label}: ${trace[key]} != ${first[key]}`);
    }
  }
  if (String(trace.asOfSec) !== String(first.asOfSec)) {
    throw new Error(`Safety Score v9 publication mixes evidence clock: ${trace.asOfSec} != ${first.asOfSec}`);
  }
  const sourceGenerations = JSON.stringify(canonicalSourceGenerations(trace.sourceGenerations));
  if (sourceGenerations !== firstSourceGenerations) {
    throw new Error(`Safety Score v9 publication mixes source generations: ${sourceGenerations} != ${firstSourceGenerations}`);
  }
}

/** Pure publication projection: never regrades a group or reruns the scorer. */
export function projectSafetyScoreV9CommonModeGroups(
  groups: readonly V9CommonModeGroup[],
  results: readonly V9CommonModeProjectionResult[],
  cards: readonly SafetyScoreV9CurrentCard[],
): SafetyScoreV9CommonModeGroups {
  const resultById = new Map(results.map((result) => [result.trace.assetId, result]));
  const cardById = new Map(cards.map((card) => [card.id, card]));
  return groups.flatMap((group) => {
    const id = `${group.failureDomain.kind}:${group.failureDomain.key}`;
    const memberAssetIds = uniqueSorted(group.members.map((member) => member.assetId));
    if (memberAssetIds.length < 2) return [];
    const unjoinedAssetIds: string[] = [];
    const pricedEffects = memberAssetIds.flatMap((assetId) => {
      const trace = resultById.get(assetId)?.trace;
      const card = cardById.get(assetId);
      if (!trace || !card) throw new Error(`Common-mode member ${assetId} has no evaluated public card`);
      const deploymentAdjustmentIndices = card.scoreTrace.deploymentRisk.adjustments.flatMap(
        (adjustment, index) => adjustment.failureDomainKey === id ? [index] : [],
      );
      // Structural correlations remain disclosed; only measured deployment
      // adjustments contribute a priced common-mode effect.
      const expectedAdjustment = trace.deploymentAdjustments.some((adjustment) => adjustment.failureDomainKey === id);
      if (expectedAdjustment && deploymentAdjustmentIndices.length === 0) {
        unjoinedAssetIds.push(assetId);
      }
      return deploymentAdjustmentIndices.length
        ? [{ assetId, capIndices: [], deploymentAdjustmentIndices }]
        : [];
    });
    if (unjoinedAssetIds.length > 0) {
      console.warn("safety_score_v9_common_mode_priced_effects_incomplete", {
        groupId: id,
        assetIds: unjoinedAssetIds,
        reason: "evaluated-price-without-published-effect-reference",
      });
    }
    return [{
      id, ...group.failureDomain, memberAssetIds,
      ...(pricedEffects.length ? { pricedEffects } : {}),
      ...(unjoinedAssetIds.length ? { pricedEffectsIncomplete: true as const } : {}),
    }];
  }).sort((left, right) => compareText(left.id, right.id));
}

export interface V9PublicCardProjectionFailure {
  assetId: string;
  issues: z.core.$ZodIssue[];
}

/**
 * Per-card public-contract violations, attributed to their assets so the
 * producer can quarantine them and publish the rest (R8) instead of failing
 * the cohort. Issue paths are response-relative (`cards.<index>...`).
 */
export class V9PublicCardProjectionError extends Error {
  readonly failures: readonly V9PublicCardProjectionFailure[];

  constructor(failures: readonly V9PublicCardProjectionFailure[]) {
    const issue = failures[0]!.issues[0];
    super(`Safety Score v9 public card projection failed for ${failures.map((failure) => failure.assetId).join(", ")}` +
      (issue ? ` at ${issue.path.join(".")}: ${issue.message}` : ""));
    this.name = "V9PublicCardProjectionError";
    this.failures = failures;
  }

  /** Asset-local quarantine message naming that card's first failing public field. */
  messageFor(assetId: string): string {
    const issue = this.failures.find((failure) => failure.assetId === assetId)?.issues[0];
    return `Safety Score v9 asset ${assetId} public card projection failed` +
      (issue ? ` at ${issue.path.slice(2).join(".")}: ${issue.message}` : "");
  }
}

/** Project owned rows incrementally without retaining their trace or scorer input graphs. */
export function createSafetyScoreV9ResponseProjector(): V9PublicResponseProjector {
  let identity: V9PublicResultIdentity | null = null;
  let sourceGenerations = "";
  const seen = new Set<string>();
  // Finalize one card at a time; later reads retain a bounded decoded-card cache.
  const drafts = new Map<string, Uint8Array>();
  const foreignGapIds = new Set<string>();
  const compactCard = createV9PublicCardShardViewFactory();
  const failures = new Map<string, z.core.$ZodIssue[]>();
  const commonModeResults: V9CommonModeProjectionResult[] = [];
  const dexObservedAtSec = new Map<string, number | null>();
  return {
    project(input) {
      const { trace } = input;
      if (seen.has(trace.assetId)) throw new Error(`Duplicate Safety Score v9 result ${trace.assetId}`);
      seen.add(trace.assetId);
      if (input.dexObservedAtSec !== undefined) dexObservedAtSec.set(trace.assetId, input.dexObservedAtSec);
      if (identity === null) {
        identity = {
          baseInputGenerationId: trace.baseInputGenerationId,
          factSetDigest: trace.factSetDigest,
          policyId: trace.policyId,
          policyDigest: trace.policyDigest,
          evaluationBuildDigest: trace.evaluationBuildDigest,
          sourceGenerations: canonicalSourceGenerations(trace.sourceGenerations),
          asOfSec: trace.asOfSec,
        };
        sourceGenerations = JSON.stringify(identity.sourceGenerations);
      } else {
        assertMatchingResultIdentity(identity, sourceGenerations, trace);
      }
      commonModeResults.push({ trace: {
        assetId: trace.assetId,
        // Group reconciliation needs signal identity and cap eligibility, not
        // the evaluator's expanded evidence graph. Retaining that graph here
        // defeats per-asset release while the public cards accumulate.
        structuralSignals: trace.structuralSignals.map((signal) => ({
          kind: signal.kind, severity: signal.severity, reason: signal.reason,
          failureDomainKeys: signal.failureDomainKeys,
          economicLossScope: signal.economicLossScope, responsibility: signal.responsibility,
          pricedInPillar: signal.pricedInPillar,
        })),
        caps: trace.caps,
        deploymentAdjustments: trace.deploymentAdjustments,
      } });
      try {
        const { card, foreignCauseGaps } = projectSafetyScoreV9Card(input);
        assertV9PublicCardProjections(card);
        const { foreignCauseGapRefs: _localRefs, ...draft } = card;
        for (const id of foreignCauseGaps) foreignGapIds.add(id);
        drafts.set(trace.assetId, strToU8(JSON.stringify({ ...draft, foreignCauseGaps })));
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error;
        failures.set(trace.assetId, error.issues);
      }
    },
    finalize(args) {
      if (identity === null) throw new Error("Safety Score v9 publication requires at least one result");
      const ids = [...seen].sort(compareText);
      if (failures.size > 0) {
        throw new V9PublicCardProjectionError(ids.flatMap((assetId, index) => {
          const issues = failures.get(assetId);
          return issues === undefined ? [] : [{
            assetId,
            issues: issues.map((issue) => ({ ...issue, path: ["cards", index, ...issue.path] })),
          }];
        }));
      }
      const resultDigest = typeof args.resultDigest === "function" ? args.resultDigest() : args.resultDigest;
      const foreignCauseGaps = [...foreignGapIds].sort();
      const refs = new Map(foreignCauseGaps.map((id, index) => [id, index]));
      const cards = ids.map((id) => {
        const draft: V9InternedPublicCardDraft = JSON.parse(strFromU8(drafts.get(id)!)) as V9InternedPublicCardDraft;
        drafts.delete(id);
        return compactCard(finalizeV9PublicCauseGapCard(draft, refs));
      });
      drafts.clear();
      foreignGapIds.clear();
      seen.clear();
      const notRatedIds = cards.filter((card) => card.ratingStatus === "not-rated").map((card) => card.id);
      const pipelineGapIds = cards.filter((card) => card.ratingStatus === "pipeline-gap").map((card) => card.id);
      // Publish only documentation ids the response can resolve: an id outside
      // every card's cause graph and the foreign table is not a cause gap here,
      // and the envelope rejects a dangling id (R1: never publish it).
      let documentationCauseGaps: string[] | undefined;
      if (args.documentationCauseGaps !== undefined) {
        const resolvable = new Set<string>(foreignCauseGaps);
        for (const card of cards) {
          for (const gapId of card.localCauseGaps) resolvable.add(`${card.id}:gap:${gapId}`);
        }
        documentationCauseGaps = uniqueSorted(args.documentationCauseGaps.filter((id) => resolvable.has(id)));
      }
      const commonModeGroups = args.commonModeGroups === undefined
        ? undefined
        : projectSafetyScoreV9CommonModeGroups(args.commonModeGroups, commonModeResults, cards);
      commonModeResults.length = 0;
      // Every owned card passed full admission before the foreign-reference remap.
      // The envelope still validates chronology, membership and gap authority.
      const admittedCards = new WeakSet<object>(cards);
      const responseSchema = SafetyScoreV9CurrentResponseSchema.safeExtend({
        cards: z.array(z.custom<SafetyScoreV9CurrentCard>((value) =>
          value !== null && typeof value === "object" && admittedCards.has(value))),
      });
      return responseSchema.parse({
        model: "v9-critical-path",
        schemaVersion: 8,
        openEvidence: args.openEvidence,
        lifecycle: "active",
        candidateId: args.candidateId,
        policyVersion: args.policyVersion,
        publicationGenerationId: args.publicationGenerationId,
        baseInputGenerationId: identity.baseInputGenerationId,
        factSetDigest: identity.factSetDigest,
        resultDigest,
        policy: { id: identity.policyId, semanticDigest: identity.policyDigest },
        evaluationBuildDigest: identity.evaluationBuildDigest,
        sourceGenerations: identity.sourceGenerations,
        asOfSec: identity.asOfSec,
        publishedAtSec: args.publishedAtSec,
        completeness: {
          expectedCount: cards.length,
          ratedCount: cards.length - notRatedIds.length - pipelineGapIds.length,
          notRatedCount: notRatedIds.length,
          notRatedIds,
          pipelineGapCount: pipelineGapIds.length,
          pipelineGapIds,
        },
        cards,
        foreignCauseGaps,
        ...(documentationCauseGaps === undefined ? {} : { documentationCauseGaps }),
        ...(args.dexMaxAgeSec === undefined ? {} : { pillarFreshness: {
          dexMaxAgeSec: args.dexMaxAgeSec,
          dexObservedAtSec: ids.map(id => {
            if (!dexObservedAtSec.has(id)) throw new Error(`Missing DEX freshness clock for ${id}`);
            return dexObservedAtSec.get(id)!;
          }),
        } }),
        ...(commonModeGroups === undefined ? {} : { commonModeGroups }),
      });
    },
  };
}

/** One evaluated card's classified local gaps and unchanged pillar witnesses. */
export interface V9DocumentationCarrierCard {
  readonly assetId: string;
  readonly localDocumentationGapIds: ReadonlySet<string>;
  readonly pillars: readonly V9DocumentationPillarWitness[];
}

export interface V9DocumentationCarrierInput {
  readonly envelope: V9ValidatedPolicyEnvelope;
  /** `collectV9DocumentationGapIds` output; the same map classifies open questions. */
  readonly gapIds: ReadonlyMap<string, V9DocumentationClassification>;
  readonly cards: readonly V9DocumentationCarrierCard[];
  readonly openEvidence: V9OpenEvidence;
}

export interface V9DocumentationCarriers {
  /** Sorted publication union of documentation-classified gap ids (`documentationCauseGaps`). */
  readonly causeGapIds: readonly string[];
  /** Card id → pillars limited only by documentation gaps; a missing card is plain limited. */
  readonly documentationOnlyLimited: ReadonlyMap<string, readonly V9QualityPillar[]>;
  /** `openEvidence` with `byCard[].documentationOnlyLimited` filled under the fail-closed rule. */
  readonly openEvidence: V9OpenEvidence;
}

/**
 * Publication-wide documentation classification of the compiled cohort: the
 * per-asset classifier union, keyed by gap id. This map is the one classifier
 * authority every carrier (open-question counter, trace block, registry band)
 * reads, so a gap classifies identically everywhere.
 */
export function collectV9DocumentationGapIds(
  envelope: V9ValidatedPolicyEnvelope,
  assets: readonly V9DocumentationAssetFacts[],
): ReadonlyMap<string, V9DocumentationClassification> {
  const classified = new Map<string, V9DocumentationClassification>();
  for (const asset of assets) {
    for (const [gapId, classification] of documentationGapIds(envelope, asset)) {
      classified.set(gapId, classification);
    }
  }
  return classified;
}

/**
 * Decision B carriers (PLAN §2.3): the documentation-only-limited annotation and
 * the publication cause-gap union, both derived from the unchanged witnesses.
 * The rule itself is `documentationOnlyLimitedPillars`; this function only feeds
 * it the publication-wide classification. A card absent from `openEvidence.byCard`
 * is never annotated, and an empty list is omitted, never `[]`.
 */
export function buildV9DocumentationCarriers(input: V9DocumentationCarrierInput): V9DocumentationCarriers {
  const foreign = input.gapIds;
  const documentationOnlyLimited = new Map<string, readonly V9QualityPillar[]>();
  for (const card of input.cards) {
    const listed = documentationOnlyLimitedPillars({
      envelope: input.envelope,
      localDocumentationGapIds: card.localDocumentationGapIds,
      pillars: card.pillars,
      foreignDocumentationGapIds: foreign.keys(),
    });
    if (listed.length > 0) {
      documentationOnlyLimited.set(card.assetId, [...listed].sort(compareText));
    }
  }
  let annotated = input.openEvidence;
  if (documentationOnlyLimited.size > 0) {
    const byCard = input.openEvidence.byCard.map((entry) => {
      const listed = documentationOnlyLimited.get(entry.id);
      return listed === undefined ? entry : { ...entry, documentationOnlyLimited: [...listed] };
    });
    annotated = { ...input.openEvidence, byCard };
  }
  return {
    causeGapIds: [...foreign.keys()].sort(compareText),
    documentationOnlyLimited,
    openEvidence: annotated,
  };
}

export function buildSafetyScoreV9Response(args: BuildSafetyScoreV9ResponseArgs): SafetyScoreV9CurrentResponse {
  // A producer transfers this list; compatibility/test lists remain caller-owned.
  const ordered: (V9PublicCardProjectionInput | undefined)[] =
    typeof args.results === "function" ? args.results() : [...args.results];
  args = { ...args, results: [] };
  ordered.sort((left, right) => compareText(left!.trace.assetId, right!.trace.assetId));
  const projector = createSafetyScoreV9ResponseProjector();
  const compact: V9CompactScoreTrace[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const result = ordered[index]!;
    ordered[index] = undefined;
    projector.project(result);
    compact.push(projectCompactV9ScoreTrace(result.trace));
  }
  ordered.length = 0;
  const response = projector.finalize({ ...args, resultDigest: () => computeV9CompactResultDigest(compact) });
  compact.length = 0;
  return response;
}
