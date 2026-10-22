import type {
  V9AssetFactsBase,
  V9AssetFactsV3,
  V9EvidenceResponsibility,
  V9FactStatusV2,
} from "../../types/safety-score-v9-facts";
import type { V9EvidenceCause } from "../../types/safety-score-v9-causes";
import type {
  V9EvidenceLevel,
  V9ReasonCode,
  V9StructuralSignal,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import { isDexMeasuredExecutionObservationHistoryMature } from "../../types/measured-execution";
import { V9_NEUTRAL_CONTROL_SCORE } from "../../types/safety-score-v9-public-facts";
import { evaluateV9AccessPosture, type V9AccessPostureResult } from "./access-posture";
import { createUnavailableV9BackingResult } from "./archetypes/evaluation";
import { verifiedLiveInheritedExposures, verifiedLiveLenderBookExposures, V9_WRAPPER_INHERITANCE_MIN_PARENT_WEIGHT } from "./backing-inheritance";
import {
  v9StructuralSignalSharePct,
  type V9BackingResult,
  type V9CdpLiquidationCapacitySelection,
  type V9InheritedStablecoinBacking,
} from "./backing-primitives";
import { evaluateV9Backing } from "./archetypes";
import { selectV9CdpLiquidationCapacity } from "./archetypes/cdp";
import { evaluateV9EconomicControl } from "./control";
import { deriveV9MintPosture, resolveV9StatusCauses, type V9EconomicControlResult } from "./control-primitives";
import { isUnboundedMintPosture } from "./mint-posture";
import {
  type V9DependencyEvaluationPlan,
  type V9ResolvedDependencyInputs,
} from "./dependencies";
import {
  evaluateV9Exit,
  projectV9ExitEvaluationRoute,
  resolveV9ExitSupplySizing,
  type V9ExitEvaluationResult,
} from "./exit";
import {
  V9_LEGACY_RESPONSIBILITY_BY_REASON,
} from "./facts";
import {
  createV9GapIndex,
  gapDomainAndCodeKey,
  gapsForV9Ids,
  projectGapReasons,
  type V9GapIndex,
} from "./gap-index";
import {
  decimalSnap,
  type V9PillarAdverseAttribution,
} from "./formula";
import { resolveV9ReasonTreatment } from "./policy";
import {
  isV9SharedControllerSignalAlreadyPriced,
  pricedV9ControllerKeys,
} from "./scoped-risk";
import {
  canonicalDomains,
  canonicalUniqueBy,
  compareText,
  domainKey,
  uniqueSorted,
} from "./primitives";
import {
  resolveV9WrapperParentLimit,
  resolveV9SingleCollateralParent,
  type V9WrapperForm,
} from "./wrapper-risk";
import {
  projectV9DependencyScore,
  resolveV9SerialParentAdverseAttribution,
  resolveV9SerialParentBoundedUncertaintyAttribution,
  scoreV9EvaluatedAsset,
  type V9PillarEvaluation,
  type V9PillarReason,
  type V9ProductionScoreInput,
  type V9ProductionScoreTrace,
} from "./score";
import { buildV9RetainedStressState, type V9RetainedStressState } from "./stress";
import { projectCompactV9ScoreTrace, type V9CompactScoreTrace } from "./trace";
import {
  canonicalReasons,
  resolvedBackingExposures,
  resolveUnavailabilityRoots,
} from "./unavailability-roots";


export interface V9EvaluatedAsset {
  assetId: string;
  backing: V9BackingResult;
  exit: V9ExitEvaluationResult;
  control: V9EconomicControlResult;
  access: V9AccessPostureResult;
  dependencyInputs: V9ResolvedDependencyInputs;
  scoreInput: V9ProductionScoreInput;
  trace: V9ProductionScoreTrace;
  compactTrace: V9CompactScoreTrace;
  stressState: V9RetainedStressState;
  liquidationCapacitySelection?: V9CdpLiquidationCapacitySelection;
  providerRowExclusions?: V9AssetFactsV3["supply"]["providerRowExclusions"];
}

type V9EvaluationGapIndex = V9GapIndex<V9AssetFactsV3["gaps"][number]>;

/** Post-credit backing quality inherited by baskets and wrapper parents. */
export function projectV9EffectiveBackingPillarScore(
  result: Pick<V9EvaluatedAsset, "scoreInput">,
): number | null {
  return result.scoreInput.pillars.backing.score;
}

export function deploymentExposureKey(deploymentKeys: readonly string[]): string {
  const keys = uniqueSorted(deploymentKeys);
  if (keys.length === 0) throw new Error("Safety Score v9 deployment exposure identity requires a deployment key");
  return `deployment-slice:${keys.join("+")}`;
}

export function deploymentRiskEventKey(kind: string, failureDomainKeys: readonly string[]): string {
  const keys = uniqueSorted(failureDomainKeys);
  if (keys.length === 0) throw new Error("Safety Score v9 deployment risk event requires a failure domain");
  return `deployment-event:${kind}:${keys.join("+")}`;
}

function pillarReason(
  envelope: V9ValidatedPolicyEnvelope,
  code: V9ReasonCode,
  path: string,
  message?: string,
  responsibility: V9EvidenceResponsibility = "measured-adverse",
  sourceGapId?: string | null,
  cause: V9EvidenceCause = responsibility === "measured-adverse" ? "D" : "U",
  causeGapIds: readonly string[] = sourceGapId == null ? [] : [sourceGapId],
): V9PillarReason {
  return {
    code,
    path,
    message: message ?? resolveV9ReasonTreatment(envelope, code, cause).reason.publicLabel,
    responsibility,
    ...(sourceGapId == null ? {} : { sourceGapId }),
    cause,
    causeGapIds,
  };
}

function pillarReasonsForGapIds(
  envelope: V9ValidatedPolicyEnvelope,
  index: V9EvaluationGapIndex,
  code: V9ReasonCode | null,
  path: string,
  gapIds: readonly string[],
  fallbackCode: V9ReasonCode,
  fallbackResponsibility: V9EvidenceResponsibility = "integration-missing",
  fallbackMessage?: string,
): V9PillarReason[] {
  return projectGapReasons({
    index,
    gapIds: uniqueSorted(gapIds),
    path,
    pathFor: (gap) => `${path}:cause:${encodeURIComponent(gap.gapId)}`,
    fallbackCode,
    fallbackMessage,
    treatmentFor: () => undefined,
  }).map((reason) =>
    pillarReason(
      envelope,
      code ?? reason.code,
      reason.path,
      reason.message,
      reason.responsibility ?? fallbackResponsibility,
      reason.path === path ? undefined : reason.gapIds[0],
      reason.cause,
      reason.causeGapIds,
    ),
  );
}

interface V9ReasonAttribution {
  causalKey: string;
  responsibility: V9EvidenceResponsibility;
}

const compareReasonAttributions = (left: V9ReasonAttribution, right: V9ReasonAttribution) =>
  compareText(left.causalKey, right.causalKey) || compareText(left.responsibility, right.responsibility);
const canonicalReasonAttributions = (attributions: readonly V9ReasonAttribution[]) =>
  canonicalUniqueBy(
    [...attributions].sort(compareReasonAttributions),
    (attribution) => `${attribution.causalKey}\u0000${attribution.responsibility}`,
    compareReasonAttributions,
    "last",
  );

function nrReasonAttributions(
  trace: Pick<V9ProductionScoreTrace, "nrReasons" | "propagatedParentReasons">,
): V9ReasonAttribution[] {
  const attributions = [
    ...trace.nrReasons.map((reason) => ({
      causalKey:
        reason.causalKey ??
        `asset:${reason.code}:${reason.field ?? "unattributed"}`,
      responsibility:
        reason.responsibility ??
        V9_LEGACY_RESPONSIBILITY_BY_REASON[reason.code],
    })),
    ...trace.propagatedParentReasons.map((reason) => ({
      causalKey:
        reason.causalKey ??
        `upstream:${reason.code}:${reason.field ?? "unattributed"}`,
      responsibility:
        reason.responsibility ??
        V9_LEGACY_RESPONSIBILITY_BY_REASON[reason.code],
    })),
  ];
  return canonicalReasonAttributions(attributions);
}

function attributedReasonPath(
  basePath: string,
  attribution: V9ReasonAttribution,
): string {
  return `${basePath}:cause:${encodeURIComponent(attribution.causalKey)}`;
}

function structuralSignalFromBacking(assetId: string, reason: V9BackingResult["structuralReasons"][number]): V9StructuralSignal {
  return {
    kind: reason.kind,
    severity: reason.severity,
    reason: reason.kind !== "speculative-credit"
      ? `${reason.kind} condition at ${reason.pathKey}.`
      : reason.pathKey === "mechanism:maturity-and-liquidity"
        ? reason.metricApplicability === "unavailable"
          ? "The issuer has not disclosed the maturity of its holdings."
          : "Long-dated or illiquid holdings create a maturity/liquidity mismatch."
        : reason.pathKey === "mechanism:credit-quality"
          ? "The reviewed credit-quality condition is weak."
          : "Material private-credit holdings create credit exposure.",
    responsibility: reason.responsibility,
    ...(reason.materialShare === null ? {} : {
      materialSharePct: v9StructuralSignalSharePct(assetId, "structuralSignals[*].materialSharePct", reason.materialShare),
    }),
    economicLossScope: "reserve-claim",
    recoveryPath: "unknown",
    expectedRecoverySec: null,
    lossAbsorptionPct: 0,
    evidenceConfidence: reason.materialShare === null ? "low" : "high",
    pricedInPillar: "backing",
    failureDomainKeys: reason.failureDomains.map(domainKey),
    evidence: [],
  };
}

function structuralSignalFromControl(
  asset: V9AssetFactsV3,
  failure: V9EconomicControlResult["structuralFailures"][number],
  bindingComponentControlKeys: ReadonlySet<string>,
  policy: V9ValidatedPolicyEnvelope,
): V9StructuralSignal {
  const controls = failure.controlKeys.flatMap((key) => {
    const control = asset.controls.find((candidate) => candidate.controlKey === key);
    return control ? [control] : [];
  });
  const scopes = new Set(controls.map((control) => control.economicLossScope));
  const economicLossScope =
    scopes.has("global-claim")
      ? "global-claim"
      : scopes.has("reserve-claim")
        ? "reserve-claim"
        : scopes.has("deployment")
          ? "deployment"
          : scopes.size > 0 && [...scopes].every((scope) => scope === "access-only")
            ? "access-only"
            : scopes.size === 0 &&
                (failure.kind === "centralized-mint" || failure.kind === "weak-oracle-branch")
              ? "global-claim"
              : undefined;
  const recoveryPath =
    economicLossScope === "deployment"
      ? "deployment-migration"
      : economicLossScope === "global-claim"
        ? "issuer-remediation"
        : economicLossScope === "access-only"
          ? "market-substitution"
          : "unknown";
  const reviewStatus =
    failure.kind === "centralized-mint"
      ? asset.economicControlReview.mint.status
      : failure.kind === "weak-oracle-branch"
        ? asset.economicControlReview.oracle.status
        : failure.kind === "material-bridge" || failure.kind === "peripheral-bridge"
          ? asset.economicControlReview.bridge.status
          : asset.controlStatus;
  const controlsKnown =
    controls.length === failure.controlKeys.length &&
    controls.every(
      (control) =>
        control.status.applicability.state === "required" &&
        control.status.observationState === "known",
    );
  const controlsCarryAdverseMintEvidence =
    (failure.kind === "centralized-mint" || failure.kind === "active-control-incident") &&
    controls.length > 0 && controls.length === failure.controlKeys.length &&
    controls.every((control) => {
      const posture = deriveV9MintPosture(control, asset.economicControlReview.mint, false, policy.policy.semantic, asset.issuanceFacts);
      return control.controlKind !== "bridge" &&
        control.status.applicability.state !== "not-applicable" &&
        control.status.evidenceRefIds.length > 0 &&
        isUnboundedMintPosture(posture);
    });
  const knownOraclePathEvidence =
    failure.kind === "weak-oracle-branch" &&
    asset.economicControlReview.oracle.knownPathTier !== undefined &&
    asset.economicControlReview.oracle.paths?.some((path) =>
      path.applicability.state === "required" && path.observationState === "known",
    );
  const responsibility: V9EvidenceResponsibility =
    failure.kind !== "unreviewed-upgrade" &&
    ((reviewStatus.applicability.state === "required" && reviewStatus.observationState === "known") ||
      failure.kind === "centralized-mint" || failure.kind === "active-control-incident" || knownOraclePathEvidence) &&
    (controlsKnown || controlsCarryAdverseMintEvidence) &&
    economicLossScope !== undefined
      ? "measured-adverse"
      : failure.kind === "unreviewed-upgrade"
        ? "issuer-undisclosed"
        : "integration-missing";
  const failureDomainKeys = failure.failureDomains.map(domainKey);
  const deploymentKeys = controls.map((control) => control.deploymentKey);
  return {
    kind: failure.kind,
    severity: failure.severity,
    reason: failure.reason,
    ...(failure.materialSharePct === null ? {} : { materialSharePct: failure.materialSharePct }),
    ...(economicLossScope === undefined ? {} : { economicLossScope }),
    ...(economicLossScope === "deployment"
      ? {
          exposureKey: deploymentExposureKey(deploymentKeys),
          riskEventKey: deploymentRiskEventKey(failure.kind, failureDomainKeys),
        }
      : {}),
    recoveryPath,
    expectedRecoverySec: null,
    lossAbsorptionPct: 0,
    responsibility,
    evidenceConfidence:
      controls.length > 0 &&
      controls.every(
        (control) =>
          control.status.applicability.state === "required" && control.status.observationState === "known",
      )
        ? "high"
        : "low",
    // Only the linked component owns pillar pricing. Shared controller identity
    // cannot suppress a worse local path with different economic bounds.
    ...(economicLossScope === "deployment" &&
    failure.materialSharePct !== null &&
    !failure.controlKeys.some((controlKey) => bindingComponentControlKeys.has(controlKey))
      ? {}
      : { pricedInPillar: "control" as const }),
    failureDomainKeys,
    evidence: [],
  };
}

function pillarCauseMetadata(
  result: Pick<V9PillarEvaluation, "aggregationDisposition" | "causeGapIds" | "limitedEvidenceCauses" | "supportedComponentKeys">,
  gapIndex: V9EvaluationGapIndex,
  excludedComponentKeys: readonly string[],
  inheritedExclusions: readonly { cause: V9EvidenceCause | null; causeGapIds: readonly string[] }[] = [],
): Pick<V9PillarEvaluation, "aggregationDisposition" | "causeGapIds" | "limitedEvidenceCauses" | "supportedComponentKeys" | "excludedComponentKeys" | "excludedCauseGapIds" | "excludedCauses"> {
  const excludedGaps = gapsForV9Ids(gapIndex, result.causeGapIds).filter(
    (gap) => gap.causeProof.cause === "A" || gap.causeProof.cause === "B",
  );
  return {
    aggregationDisposition: result.aggregationDisposition,
    causeGapIds: result.causeGapIds,
    limitedEvidenceCauses: result.limitedEvidenceCauses,
    supportedComponentKeys: result.aggregationDisposition !== "included" ? [] : result.supportedComponentKeys,
    excludedComponentKeys: uniqueSorted(excludedComponentKeys),
    excludedCauseGapIds: uniqueSorted([
      ...excludedGaps.map((gap) => gap.gapId),
      ...inheritedExclusions.filter((item) => item.cause === "A" || item.cause === "B").flatMap((item) => item.causeGapIds),
    ]),
    excludedCauses: uniqueSorted([
      ...excludedGaps.map((gap) => gap.causeProof.cause as "A" | "B"),
      ...inheritedExclusions.flatMap((item) => item.cause === "A" || item.cause === "B" ? [item.cause] : []),
    ]),
  };
}

// Evidence coverage is independent of the removed numeric missing-data ceilings.
// Keep the pre-cutover reason predicate; a bounded factor alone is not a
// whole-pillar evidence limitation.
const REASON_EVIDENCE_LEVEL: Partial<Record<V9ReasonCode, V9EvidenceLevel>> = {
  "incomparable-route-requests": "limited",
  "incomplete-dex-route-coverage": "limited",
  "incomplete-oracle-liquidation-branch": "limited",
  "material-bridge-supply-unmatched": "limited",
  "material-dependency-unavailable": "limited",
  "material-unknown-reserve-exposure": "limited",
  "mint-control-question": "limited",
  "missing-applicable-peg": "limited",
  "missing-bridge-route-rows": "limited",
  "missing-bridge-routes": "limited",
  "missing-custody-profile": "limited",
  "missing-implementation-date": "limited",
  "missing-mint-authority": "limited",
  "missing-oracle-profile": "limited",
  "oracle-topology-undisclosed": "limited",
  "missing-peg-input": "limited",
  "peg-price-unavailable-adverse-history": "limited",
  "peg-supply-floor-withheld": "limited",
  "missing-required-oracle-branches": "limited",
  "missing-reserve-composition": "limited",
  "missing-runtime-route-evidence": "limited",
  "missing-same-notional-route": "limited",
  "unproven-settlement-bound": "limited",
  "missing-upgrade-control": "limited",
  "missing-upgradeability-review": "limited",
  "partial-reserve-review": "limited",
  "runtime-bridge-materiality-unavailable": "limited",
  "scoped-control-question": "limited",
  "selected-bridge-route-missing": "limited",
  "selected-bridge-route-unresolved": "limited",
  "unknown-control-cap-authority": "limited",
  "unknown-control-mint-ability": "limited",
  "unknown-upgrade-authority": "limited",
  "unresolved-control-identity": "limited",
  "unresolved-mint-authority": "limited",
  "unresolved-oracle-branch-applicability": "limited",
  "unsupported-same-notional-route": "limited",
  "unreviewed-dependency-relationships": "limited",
  "unreviewed-oracle-profile": "limited",
  "unreviewed-reserve-envelope": "limited",
  "missing-latest-assurance-report": "adequate",
  "stale-audited-reserve-composition": "adequate",
  "critical-unresolved": "insufficient",
  "future-dated-input-fact": "insufficient",
  "historical-critical-input": "insufficient",
  "implementation-parent-cycle": "insufficient",
  "insufficient-evidence": "insufficient",
  "missing-archetype": "insufficient",
  "missing-parent-score": "insufficient",
  "missing-pillar": "insufficient",
  "missing-pillar-evidence": "insufficient",
  "parent-cycle": "insufficient",
};

function reasonClassifiedEvidence(
  score: number | null,
  reasons: readonly V9PillarReason[],
  fallback: V9EvidenceLevel = "strong",
  excluded: boolean = false,
): Pick<V9PillarEvaluation, "evidenceLevel" | "limitedEvidenceCauses" | "limitingCauseGapIds"> {
  let declaredLevel: V9EvidenceLevel | null = null;
  const limitedCauses: V9EvidenceCause[] = [];
  const limitingGapIds: string[] = [];
  for (const reason of reasons) {
    if (reason.cause === "A" || reason.cause === "B") continue;
    const level = REASON_EVIDENCE_LEVEL[reason.code];
    if (level === undefined) continue;
    if (
      declaredLevel === null ||
      level === "insufficient" ||
      (level === "limited" && declaredLevel === "adequate")
    ) declaredLevel = level;
    if (level !== "limited" && level !== "insufficient") continue;
    const cause = reason.cause ?? (reason.responsibility === "measured-adverse" ? "D" : "U");
    limitedCauses.push(cause);
    limitingGapIds.push(...(reason.causeGapIds ?? []));
  }
  const evidenceLevel = score === null ? "insufficient" : declaredLevel ?? fallback;
  const limited = !excluded && (evidenceLevel === "limited" || evidenceLevel === "insufficient");
  return {
    evidenceLevel,
    limitedEvidenceCauses: limited ? uniqueSorted(limitedCauses) : [],
    limitingCauseGapIds: limited ? uniqueSorted(limitingGapIds) : [],
  };
}

function backingPillar(
  result: V9BackingResult,
  envelope: V9ValidatedPolicyEnvelope,
  gapIndex: V9EvaluationGapIndex,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
): V9PillarEvaluation {
  const gapProjectedReasons: V9PillarReason[] = [];
  const syntheticReasons: Array<{
    reason: V9BackingResult["unresolved"][number];
    path: string;
  }> = [];
  for (const reason of result.unresolved) {
    const path = `backing:${reason.pathKey}`;
    const gaps = gapsForV9Ids(gapIndex, reason.gapIds);
    if (gaps.length === 0) {
      syntheticReasons.push({ reason, path });
      continue;
    }
    for (const gap of gaps) {
      gapProjectedReasons.push(
        ...pillarReasonsForGapIds(
          envelope,
          gapIndex,
          gap.reasonCode,
          path,
          [gap.gapId],
          gap.reasonCode,
          V9_LEGACY_RESPONSIBILITY_BY_REASON[gap.reasonCode],
        ),
      );
    }
  }
  const compareSyntheticReasons = (
    left: (typeof syntheticReasons)[number],
    right: (typeof syntheticReasons)[number],
  ) =>
    compareText(left.reason.code, right.reason.code) ||
    compareText(left.path, right.path) ||
    compareText(left.reason.causalKey ?? "", right.reason.causalKey ?? "") ||
    compareText(
      left.reason.responsibility ?? "",
      right.reason.responsibility ?? "",
  );
  const canonicalSyntheticReasons = canonicalUniqueBy(
    syntheticReasons.sort(compareSyntheticReasons),
    (entry) =>
      `${entry.reason.code}\u0000${entry.path}\u0000${entry.reason.causalKey ?? ""}\u0000${entry.reason.responsibility ?? ""}`,
    compareSyntheticReasons,
    "last",
  );
  const unkeyedSyntheticCounts = new Map<string, number>();
  for (const entry of canonicalSyntheticReasons) {
    const key = `${entry.reason.code}\u0000${entry.path}`;
    if (entry.reason.causalKey === undefined) {
      unkeyedSyntheticCounts.set(
        key,
        (unkeyedSyntheticCounts.get(key) ?? 0) + 1,
      );
    }
  }
  const reasons = canonicalReasons(
    [
      ...gapProjectedReasons,
      ...canonicalSyntheticReasons.map(({ reason, path }) => {
        const unkeyedIdentityCount =
          unkeyedSyntheticCounts.get(`${reason.code}\u0000${path}`) ?? 0;
        if (unkeyedIdentityCount > 1 && reason.causalKey === undefined) {
          throw new Error(
            `Safety Score v9 backing reason ${reason.code} at ${path} has multiple causal roots without stable causal keys`,
          );
        }
        return pillarReason(
          envelope,
          reason.code,
          reason.causalKey === undefined
            ? path
            : `${path}:cause:${encodeURIComponent(reason.causalKey)}`,
          undefined,
          reason.responsibility ??
            V9_LEGACY_RESPONSIBILITY_BY_REASON[reason.code],
          undefined,
          reason.cause ?? (reason.responsibility === "measured-adverse" ? "D" : "U"),
          reason.causeGapIds ?? [],
        );
      }),
    ],
  );
  const availableUpstreamPaths = new Set(result.contributions.flatMap((row) => {
    const upstream = row.upstreamAssetId === null ? undefined : evaluatedById.get(row.upstreamAssetId);
    return upstream?.scoreInput.pillars.backing.score != null ? [`backing:${row.componentKey}`] : [];
  }));
  const evidenceReasons = reasons.filter((reason) => {
    const causeSuffix = reason.path.indexOf(":cause:");
    const path = causeSuffix < 0 ? reason.path : reason.path.slice(0, causeSuffix);
    // Available upstream evidence ceilings were narrowed to the held reserve
    // exposure, not a limitation of the child's entire backing pillar.
    if (
      reason.sourceGapId === undefined &&
      availableUpstreamPaths.has(path) &&
      REASON_EVIDENCE_LEVEL[reason.code] !== "insufficient"
    ) return false;
    // Explicit R5 remainder attribution replaces a bounded unstructured slice.
    // Its numeric rung and proof survive without inventing a new coverage ceiling.
    return reason.cause === "D" || !(reason.causeGapIds?.length && reason.causeGapIds.every((id) => {
      const scope = gapIndex.byId.get(id)?.causeScope;
      return scope?.componentKey === "reserve-residual" && scope.requiredDatum === "reserveCompositionRemainder";
    }));
  });
  // Source-gap deduplication must not replace an already-valid pillar witness
  // with an optional component witness that publication may later omit.
  const qualifiedPillarGapIds = new Set<string>();
  if (result.score !== null) {
    for (const reason of reasons) {
      if (reason.sourceGapId == null || (reason.cause !== "C" && reason.cause !== "U")) continue;
      const treatment = resolveV9ReasonTreatment(envelope, reason.code, reason.cause);
      if (!treatment.critical && treatment.treatment !== "diagnostic") qualifiedPillarGapIds.add(reason.sourceGapId);
    }
  }
  const boundedComponents: Array<NonNullable<V9PillarEvaluation["boundedComponents"]>[number]> = [];
  const appendBoundedComponent = (
    component: Pick<V9BackingResult["contributions"][number], "componentKey" | "score" | "effectiveScoringWeight" | "scoringDisposition" | "causeGapIds">,
    parentWeight = 1,
  ) => {
    const weight = component.effectiveScoringWeight * parentWeight;
    if (component.scoringDisposition !== "bounded-uncertainty" || component.score === null || weight <= 0) return;
    for (const gap of gapsForV9Ids(gapIndex, component.causeGapIds)) {
      if (gap.ownerDomain !== "backing" || (gap.causeProof.cause !== "C" && gap.causeProof.cause !== "U")) continue;
      if (qualifiedPillarGapIds.has(gap.gapId)) continue;
      for (const reason of pillarReasonsForGapIds(
        envelope, gapIndex, gap.reasonCode, `backing:${component.componentKey}:bounded-component`,
        [gap.gapId], gap.reasonCode, V9_LEGACY_RESPONSIBILITY_BY_REASON[gap.reasonCode],
      )) {
        boundedComponents.push({ reason, score: component.score, effectiveScoringWeight: weight });
      }
    }
  };
  for (const row of result.contributions) {
    if (row.score === null || row.effectiveScoringWeight <= 0) continue;
    appendBoundedComponent(row);
    for (const factor of row.factors ?? []) appendBoundedComponent(factor, row.effectiveScoringWeight);
  }
  return {
    ...pillarCauseMetadata(result, gapIndex, result.contributions.flatMap((row) => [
      ...(row.scoringDisposition === "excluded-pipeline" || row.scoringDisposition === "excluded-uncurated" ? [row.componentKey] : []),
      ...(row.factors ?? []).filter((factor) => factor.scoringDisposition === "excluded-pipeline" || factor.scoringDisposition === "excluded-uncurated").map((factor) => factor.componentKey),
    ]), result.contributions),
    score: result.score,
    ...reasonClassifiedEvidence(result.score, evidenceReasons, "strong", result.aggregationDisposition !== "included"),
    reasons: canonicalReasons([...reasons, ...boundedComponents.map((component) => component.reason)]),
    boundedComponents,
    structuralSignals: result.structuralReasons.map((reason) => structuralSignalFromBacking(result.assetId, reason)),
  };
}

// Equivalence describes the same unavailable route surface, not an unrelated
// Exit gap. Only gaps referenced by the asset's Exit status can use this join.
const EXIT_ROUTE_GAP_EQUIVALENTS: Partial<Record<V9ReasonCode, readonly V9ReasonCode[]>> = {
  "missing-same-notional-route": ["missing-runtime-route-evidence", "unsupported-same-notional-route", "unresolved-exit-output"],
  "missing-runtime-route-evidence": ["missing-same-notional-route", "unsupported-same-notional-route", "unresolved-exit-output"],
  "unsupported-same-notional-route": ["missing-runtime-route-evidence", "missing-same-notional-route", "unresolved-exit-output"],
  "no-viable-exit-path": ["missing-runtime-route-evidence", "missing-same-notional-route", "unsupported-same-notional-route", "unresolved-exit-output"],
};

// Only route-exclusive facts on an unscored alternative are diagnostic-only.
// A scored route with an excluded factor still has a genuine component exclusion.
function diagnosticOptionalExitGapIds(asset: V9AssetFactsV3, result: V9ExitEvaluationResult, gapIndex: V9EvaluationGapIndex): Set<string> {
  if (result.aggregationDisposition !== "included") return new Set();
  const optionalRouteKeys = new Set(result.routes.filter((route) =>
    route.routeKey !== result.primaryRouteKey && route.routeKey !== result.diversificationRouteKey &&
    !route.included && route.score === null && route.components === null &&
    route.scoringDisposition !== "excluded-pipeline" && route.scoringDisposition !== "excluded-uncurated" &&
    Object.values(route.factorContributions ?? {}).every((factor) => factor.effectiveScoringWeight === 0 &&
      factor.scoringDisposition !== "excluded-pipeline" && factor.scoringDisposition !== "excluded-uncurated"),
  ).map((route) => route.routeKey));
  const retainedGapIds = new Set([
    ...asset.exitStatus.gapIds,
    ...asset.exitRoutes.filter((route) => !optionalRouteKeys.has(route.routeKey)).flatMap((route) => [
      ...route.status.gapIds, ...Object.values(route.factorStatuses ?? {}).flatMap((status) => status?.gapIds ?? []),
    ]),
  ]);
  return new Set(asset.exitRoutes.filter((route) => optionalRouteKeys.has(route.routeKey)).flatMap((route) =>
    [...route.status.gapIds, ...Object.values(route.factorStatuses ?? {}).flatMap((status) => status?.gapIds ?? [])],
  ).filter((id) => {
    const gap = gapIndex.byId.get(id);
    if (retainedGapIds.has(id) || gap === undefined ||
      (gap.causeProof.cause !== "A" && gap.causeProof.cause !== "B") ||
      gap.causeScope?.pillar !== "exit" || gap.causeScope.routeKey == null ||
      !optionalRouteKeys.has(gap.causeScope.routeKey)) return false;
    if (result.primaryRouteKey !== null) return true;
    // Without a primary, an A/B factor may itself be the missing admission
    // datum. Require an independent barrier that resolving this fact cannot clear.
    const route = asset.exitRoutes.find((candidate) => candidate.routeKey === gap.causeScope!.routeKey)!;
    if (gap.causeScope.factorKey !== "output" && route.output.sameNotionalEligible === false) return true;
    return route.coverageClass === "diagnostic" && (["capacity", "settlement"] as const).some((key) => {
      if (key === gap.causeScope!.factorKey) return false;
      const status = route.factorStatuses?.[key];
      return status !== undefined && status.observationState !== "known" && status.gapIds.some((gapId) => {
        const blocker = gapIndex.byId.get(gapId);
        return (blocker?.causeProof.cause === "C" || blocker?.causeProof.cause === "U") &&
          blocker.causeScope?.pillar === "exit" && blocker.causeScope.routeKey === route.routeKey &&
          blocker.causeScope.factorKey === key;
      });
    });
  }));
}

function exitPillar(
  asset: V9AssetFactsV3,
  result: V9ExitEvaluationResult,
  envelope: V9ValidatedPolicyEnvelope,
  gapIndex: V9EvaluationGapIndex,
): V9PillarEvaluation {
  const mechanismExitFacts = asset.mechanismExitFacts ?? [];
  const hasRetainedRuntimeRoute = result.routes.some((trace) => {
    if (!trace.included) return false;
    const route = asset.exitRoutes.find((candidate) => candidate.routeKey === trace.routeKey);
    return route?.status.observationState === "known" || route?.status.observationState === "stale";
  });
  const profileExplainsMissingRuntime =
    !hasRetainedRuntimeRoute &&
    mechanismExitFacts.length > 0;
  const profileResponsibility: V9EvidenceResponsibility =
    mechanismExitFacts.some((fact) => fact.disposition === "supported")
      ? "integration-missing"
      : mechanismExitFacts.some((fact) => fact.disposition === "method-unsupported")
        ? "method-unsupported"
        : mechanismExitFacts.some((fact) => fact.disposition === "integration-missing")
          ? "integration-missing"
          : "issuer-undisclosed";
  const effectiveReasons = result.reasons.map((code) => {
    const replaceMissingRoute =
      profileExplainsMissingRuntime &&
      (code === "no-viable-exit-path" || code === "missing-same-notional-route");
    return {
      code: replaceMissingRoute ? "missing-runtime-route-evidence" as const : code,
      sourceCode: code,
      profileFactKeys: replaceMissingRoute
        ? mechanismExitFacts.map((fact) => fact.factKey)
        : [],
      profileResponsibility: replaceMissingRoute ? profileResponsibility : null,
    };
  });
  const primary =
    result.primaryRouteKey === null
      ? null
      : (asset.exitRoutes.find((route) => route.routeKey === result.primaryRouteKey) ?? null);
  const primaryTrace =
    result.primaryRouteKey === null
      ? null
      : (result.routes.find((route) => route.routeKey === result.primaryRouteKey) ?? null);
  const capacityFloor = primaryTrace?.capsApplied.find(
    (cap) => cap === "zero-executable-capacity" || cap === "immaterial-executable-capacity",
  );
  const capacityAttribution: readonly V9PillarAdverseAttribution[] =
    primary !== null &&
    primaryTrace?.included === true &&
    primaryTrace.capacityPoint !== null &&
    (primary.status.observationState === "known" || primary.status.observationState === "stale") &&
    primary.scoreEligible &&
    primary.coverageClass === "exact-complete" &&
    primary.evidenceKind !== "documented-terms" &&
    capacityFloor !== undefined
      ? [{
          source: "pillar-score",
          path: `pillar:exit:route:${primary.routeKey}:capacity`,
          message:
            capacityFloor === "zero-executable-capacity"
              ? `The score-bearing ${primary.coverageClass} measurement for primary exit route ${primary.routeKey} had zero executable capacity for the ${primaryTrace.capacityPoint.requestedNotionalUsd} USD stress request at ${primaryTrace.capacityPoint.maxCostBps} bps.`
              : `The score-bearing ${primary.coverageClass} measurement for primary exit route ${primary.routeKey} had ${primaryTrace.capacityPoint.executableUsd} USD of executable capacity for the ${primaryTrace.capacityPoint.requestedNotionalUsd} USD stress request at ${primaryTrace.capacityPoint.maxCostBps} bps, below the policy-derived material-capacity floor.`,
          responsibility: "measured-adverse",
        }]
      : [];
  const primaryStrong =
    primary !== null &&
    primary !== null &&
    primary.status.observationState === "known" &&
    primary.observationConfidence === "high" &&
    (primary.evidenceKind !== "measured-executable-depth" ||
      (primary.modelConfidence === "high" &&
        isDexMeasuredExecutionObservationHistoryMature(primary.observationHistory))) &&
    envelope.policy.semantic.exit.strongEvidenceKinds.includes(primary.evidenceKind);
  const diagnosticGapIds = diagnosticOptionalExitGapIds(asset, result, gapIndex);
  const pillar: V9PillarEvaluation = {
    ...pillarCauseMetadata({
      ...result, causeGapIds: result.causeGapIds.filter((id) => !diagnosticGapIds.has(id)),
    }, gapIndex, result.routes.flatMap((route) => [
      ...(route.scoringDisposition === "excluded-pipeline" || route.scoringDisposition === "excluded-uncurated" ? [route.routeKey] : []),
      ...Object.entries(route.factorContributions ?? {}).filter(([, factor]) =>
        factor.scoringDisposition === "excluded-pipeline" || factor.scoringDisposition === "excluded-uncurated",
      ).map(([key]) => `${route.routeKey}:${key}`),
    ])),
    // Keep the complete inventory; only promotion into partial evidence is filtered.
    causeGapIds: result.causeGapIds,
    score: result.score,
    evidenceLevel: primaryStrong ? "strong" : "adequate",
    reasons: canonicalReasons(
      effectiveReasons.flatMap(({ code, sourceCode, profileFactKeys, profileResponsibility: responsibility }) => {
        const matchingGaps =
          gapIndex.byDomainAndCode.get(gapDomainAndCodeKey("exit", sourceCode)) ?? [];
        const exitGaps = gapsForV9Ids(gapIndex, asset.exitStatus.gapIds);
        const equivalentCodes = EXIT_ROUTE_GAP_EQUIVALENTS[sourceCode] ?? [];
        const equivalentSurfaceGaps = exitGaps.filter((gap) => {
          if (gap.ownerDomain !== "exit" || (gap.causeScope !== undefined && gap.causeScope.pillar !== "exit") || !equivalentCodes.includes(gap.reasonCode)) return false;
          if (gap.path.kind === "local-component") return gap.path.componentKey === "exit-routes";
          const routeKey = gap.causeScope?.routeKey;
          return routeKey != null && asset.exitRoutes.some((route) => route.routeKey === routeKey);
        });
        const settlementGaps = sourceCode === "unproven-settlement-bound"
          ? gapsForV9Ids(gapIndex, asset.exitRoutes
              .filter((route) => route.settlementBoundUnproven)
              .flatMap((route) => route.factorStatuses?.settlement?.gapIds ?? []))
          : [];
        const causalGaps = settlementGaps.length > 0
          ? settlementGaps
          : matchingGaps.length > 0 ? matchingGaps : equivalentSurfaceGaps;
        const path =
          profileFactKeys.length > 0
            ? `exit:mechanism-profile:${profileFactKeys.join("+")}`
            : `exit:${code}`;
        const nativeMeasuredCompleteEmpty =
          code === "no-viable-exit-path" &&
          asset.exitStatus.applicability.state === "required" &&
          asset.exitStatus.observationState === "known" &&
          asset.exitRoutes.length === 0 &&
          result.score === 0 &&
          result.primaryRouteKey === null &&
          causalGaps.length === 0 &&
          profileFactKeys.length === 0;
        const nativeMeasuredCapacityFloor =
          code === "no-viable-exit-path" &&
          primary !== null &&
          primaryTrace?.included === true &&
          (primary.status.observationState === "known" || primary.status.observationState === "stale") &&
          primary.scoreEligible &&
          primary.coverageClass === "exact-complete" &&
          primary.evidenceKind !== "documented-terms" &&
          capacityFloor !== undefined &&
          causalGaps.length === 0 &&
          profileFactKeys.length === 0;
        if (code === "correlated-exit-routes" && primary !== null && causalGaps.length === 0) {
          const includedRoutes = asset.exitRoutes.filter((route) =>
            result.routes.some((trace) => trace.routeKey === route.routeKey && trace.included));
          // Correlation is a known diagnostic only when every included
          // alternative has a sourced, current shared domain or resource.
          // Withholding diversification is unchanged; missing identity proof
          // must still fall through to bounded U.
          if (primary.status.observationState === "known" && primary.status.evidenceRefIds.length > 0 &&
            includedRoutes.length > 1 && includedRoutes.every((route) =>
              route.status.observationState === "known" && route.status.evidenceRefIds.length > 0 &&
              (route === primary ||
                primary.failureDomains.some((domain) =>
                  route.failureDomains.some((other) => domainKey(domain) === domainKey(other))) ||
                primary.physicalResourceKeys.some((key) => route.physicalResourceKeys.includes(key))))) {
            return [{
              ...pillarReason(envelope, code, path, undefined, "measured-adverse"),
              causeProof: {
                cause: "D",
                adverseFactId: `${asset.assetId}:exit:correlated-route-inventory`,
                evidenceRefIds: uniqueSorted(includedRoutes.flatMap((route) => route.status.evidenceRefIds)),
              },
            }];
          }
        }
        if (nativeMeasuredCompleteEmpty || nativeMeasuredCapacityFloor) {
          // These are admitted adverse facts, not missing-gap fallbacks. An
          // empty gap list otherwise defaults to U and loses the measured D.
          return [{
            ...pillarReason(envelope, code, path, undefined, "measured-adverse"),
            causeProof: {
              cause: "D",
              adverseFactId: nativeMeasuredCompleteEmpty
                ? `${asset.assetId}:exit:empty-route-inventory`
                : `${asset.assetId}:exit:${primary!.routeKey}:capacity`,
              evidenceRefIds: nativeMeasuredCompleteEmpty
                ? asset.exitStatus.evidenceRefIds
                : primary!.status.evidenceRefIds,
            },
          }];
        }
        return responsibility !== null
          ? [
              pillarReason(
                envelope,
                code,
                path,
                `Reviewed ${profileFactKeys.join(" and ")} evidence exists, but no score-eligible runtime route is compiled.`,
                responsibility,
              ),
              // The reviewed-profile diagnostic is not the cause of the charged
              // runtime uncertainty. Keep its actual admitted gap witnesses too.
              ...pillarReasonsForGapIds(
                envelope, gapIndex, sourceCode, path,
                causalGaps.map((gap) => gap.gapId), sourceCode,
              ),
            ]
          : pillarReasonsForGapIds(
              envelope,
              gapIndex,
              code,
              path,
              causalGaps.map((gap) => gap.gapId),
              code,
              V9_LEGACY_RESPONSIBILITY_BY_REASON[code],
            );
      }),
    ),
    structuralSignals: [],
    adverseAttribution: capacityAttribution,
  };
  const evidence = reasonClassifiedEvidence(result.score, pillar.reasons, primaryStrong ? "strong" : "adequate", result.aggregationDisposition === "excluded-a-b");
  return Object.assign(pillar, evidence, {
    // The scorer owns the causes actually priced; diagnostic reasons cannot
    // replace them with a different whole-pillar unknown classification.
    limitedEvidenceCauses: result.limitedEvidenceCauses,
    // These A/B diagnostics were never C/U/D witnesses before the promotion fix.
    limitingCauseGapIds: evidence.limitingCauseGapIds?.filter((id) => !diagnosticGapIds.has(id)),
  });
}

function controlPillar(
  asset: V9AssetFactsV3,
  result: V9EconomicControlResult,
  envelope: V9ValidatedPolicyEnvelope,
  gapIndex: V9EvaluationGapIndex,
): V9PillarEvaluation {
  const score = result.score;
  const unresolvedDeploymentControls = asset.controls.filter(
    (control) =>
      control.scope === "deployment" &&
      control.economicLossScope === "deployment" &&
      control.status.applicability.state !== "not-applicable" &&
      !resolveV9StatusCauses([control.status], asset.gaps).excluded &&
      (control.status.applicability.state !== "required" || control.status.observationState !== "known"),
  );
  const scoreBearingReasons = [
    ...result.reasons,
    ...unresolvedDeploymentControls.map((control): V9EconomicControlResult["reasons"][number] => ({
      code: "unresolved-control-identity",
      controlKey: control.controlKey,
      path: `control:${control.controlKey}:materiality`,
      pathKind: "deployment-control",
      critical: false,
      label: "Unresolved deployment exposure lacks an admitted control review.",
    })),
  ];
  const gapsForStatus = (status: V9FactStatusV2) => gapsForV9Ids(gapIndex, status.gapIds);
  const controlDomainGaps = [...gapIndex.byDomainAndCode.values()]
    .flat()
    .filter((candidate) => candidate.ownerDomain === "control");
  const causalGapsForReason = (
    reason: V9EconomicControlResult["reasons"][number],
  ): V9AssetFactsV3["gaps"] => {
    if (reason.code === "runtime-bridge-materiality-unavailable") {
      const materialityGaps = gapsForV9Ids(gapIndex, asset.controls
        .filter((control) => control.controlKind === "bridge" &&
          control.scope === "deployment" &&
          (reason.controlKey === null || control.controlKey === reason.controlKey))
        .flatMap((control) => control.factorStatuses?.materialSupplyShare?.gapIds ?? []));
      if (materialityGaps.length > 0) return materialityGaps;
    }
    if (reason.code === "unresolved-oracle-branch-applicability") {
      const status = asset.economicControlReview.oracle.status;
      return gapsForV9Ids(gapIndex, status.applicability.gapId === null
        ? status.gapIds : [status.applicability.gapId]);
    }
    // These reasons originate in the aggregate mint review, even when its
    // anchor names a fully reviewed deployment control. Join the originating
    // status/factor before consulting that control's independent diagnostics.
    if (reason.path === "mint" &&
      (reason.code === "missing-mint-authority" || reason.code === "unresolved-mint-authority")) {
      return gapsForStatus(asset.economicControlReview.mint.status);
    }
    if (reason.code === "mint-control-question") {
      const mint = asset.economicControlReview.mint;
      if (reason.path === "mint:reconciliation") {
        return gapsForV9Ids(gapIndex, mint.factorStatuses?.reconciliation?.gapIds ?? []);
      }
      if (reason.path === "mint" && mint.status.applicability.state === "unresolved") {
        return gapsForV9Ids(gapIndex, mint.status.applicability.gapId === null
          ? mint.status.gapIds : [mint.status.applicability.gapId]);
      }
    }
    if (reason.controlKey !== null) {
      const control = asset.controls.find(
        (candidate) => candidate.controlKey === reason.controlKey,
      );
      const controlGapIds = new Set(control?.status.gapIds ?? []);
      const controlGaps = controlDomainGaps.filter((gap) => {
        if (controlGapIds.has(gap.gapId)) return true;
        if (gap.path.kind === "deployment-control") {
          return gap.path.controlKey === reason.controlKey;
        }
        return (
          gap.path.kind === "local-component" &&
          gap.path.componentKey === `control:${reason.controlKey}`
        );
      });
      if (controlGaps.length > 0) return controlGaps;
    }

    if (reason.controlKey === null) {
      const matchingGaps = controlDomainGaps.filter(
        (candidate) => candidate.reasonCode === reason.code,
      );
      if (matchingGaps.length > 0) return matchingGaps;
    }

    if (reason.code === "oracle-topology-undisclosed") {
      return gapsForStatus(
        asset.economicControlReview.oracle.factorStatuses?.tier ?? asset.economicControlReview.oracle.status,
      );
    }

    if (reason.code === "incomplete-oracle-liquidation-branch") {
      return gapsForStatus(asset.economicControlReview.oracle.status);
    }
    if (reason.code === "missing-upgradeability-review") {
      return gapsForStatus(asset.economicControlReview.mint.status);
    }
    if (reason.code === "selected-bridge-route-unresolved") {
      return gapsForStatus(asset.economicControlReview.bridge.status);
    }
    if (reason.code === "runtime-bridge-materiality-unavailable") {
      const supplyReviewGaps = gapsForStatus(asset.supply.status).filter(
        (gap) => gap.reasonCode === "runtime-bridge-materiality-unavailable",
      );
      if (supplyReviewGaps.length > 0) return supplyReviewGaps;
      const unresolvedBridgeGapIds = new Set(
        asset.controls
          .filter(
            (control) =>
              control.controlKind === "bridge" &&
              control.status.observationState !== "known",
          )
          .flatMap((control) => control.status.gapIds),
      );
      const unresolvedBridgeGaps = controlDomainGaps.filter((gap) =>
        unresolvedBridgeGapIds.has(gap.gapId),
      );
      return unresolvedBridgeGaps.length > 0
        ? unresolvedBridgeGaps
        : gapsForStatus(asset.economicControlReview.bridge.status);
    }
    return [];
  };

  const bindingComponentControlKeys = new Set(result.components
    .filter((component) => component.binding).flatMap((component) => component.controlKeys));
  const authoritySignalsByControlKey = new Map<string, V9StructuralSignal[]>();
  const pillar: V9PillarEvaluation = {
    ...pillarCauseMetadata(result, gapIndex, result.components.filter((component) =>
      component.scoringDisposition === "excluded-pipeline" || component.scoringDisposition === "excluded-uncurated",
    ).map((component) => component.componentKey)),
    score,
    evidenceLevel: "strong",
    reasons: canonicalReasons(
      scoreBearingReasons.flatMap((reason) => {
        return pillarReasonsForGapIds(
          envelope,
          gapIndex,
          reason.code,
          `control:${reason.path}`,
          causalGapsForReason(reason).map((gap) => gap.gapId),
          reason.code,
          V9_LEGACY_RESPONSIBILITY_BY_REASON[reason.code],
          reason.label,
        );
      }),
    ),
    structuralSignals: (() => {
      return result.structuralFailures.flatMap((failure) => {
        const signal = structuralSignalFromControl(asset, failure, bindingComponentControlKeys, envelope);
        if (signal.economicLossScope === "deployment" && signal.responsibility === "measured-adverse") {
          const componentKind = failure.kind === "material-bridge" || failure.kind === "peripheral-bridge"
            ? "bridge" : failure.kind === "weak-oracle-branch" ? "oracle" : "mint";
          const measured = result.components.filter((component) =>
            component.kind === componentKind && component.score !== null &&
            component.controlKeys.some((key) => failure.controlKeys.includes(key)),
          );
          if (measured.length > 0) signal.exposedScore = Math.min(...measured.map((component) => component.score!));
        }
        if (signal.economicLossScope === "deployment" &&
          (failure.kind === "centralized-mint" || failure.kind === "active-control-incident")) {
          for (const key of failure.controlKeys) {
            const control = asset.controls.find((candidate) => candidate.controlKey === key);
            if (control === undefined || control.controlKind === "bridge" || control.controlKind === "oracle" ||
              control.materialSupplyShare === null) continue;
            const sources = authoritySignalsByControlKey.get(key) ?? [];
            sources.push(signal);
            authoritySignalsByControlKey.set(key, sources);
          }
        }
        return failure.binding || (signal.economicLossScope === "deployment" && signal.responsibility === "measured-adverse")
          ? [signal]
          : [];
      });
    })(),
  };
  // Authority is a graded mint/admin/upgrade component, not a bridge or oracle
  // measurement. Include bounded postures even when no structural failure fires.
  pillar.deploymentAuthorities = result.components.flatMap((component) => {
    if (component.kind !== "mint" || component.score === null ||
      component.componentKey.startsWith("mint:bridge:")) return [];
    return component.controlKeys.flatMap((key) => {
      const control = asset.controls.find((candidate) => candidate.controlKey === key);
      if (control === undefined || control.controlKind === "bridge" || control.controlKind === "oracle" ||
        control.economicLossScope !== "deployment" || control.materialSupplyShare === null) return [];
      return [{
        deploymentKey: control.deploymentKey,
        quality: component.score!,
        share: control.materialSupplyShare,
        failureDomainKeys: component.failureDomains.map(domainKey),
        sourceSignals: authoritySignalsByControlKey.get(key) ?? [],
      }];
    });
  });
  return Object.assign(pillar, reasonClassifiedEvidence(score, pillar.reasons, "strong", result.aggregationDisposition === "excluded-a-b"));
}

function conservativeTrackRecordMonths(launchedAtSec: number | null, asOfSec: number): number {
  if (launchedAtSec === null) return 0;
  const start = new Date(launchedAtSec * 1_000);
  const end = new Date(asOfSec * 1_000);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/** Exact elapsed days on the same clock as realized-holder-loss recovery. */
function resolvedIncidentAgeDays(
  latestResolvedIncidentAtSec: number | null | undefined,
  asOfSec: number,
): number | undefined {
  if (latestResolvedIncidentAtSec == null) return undefined;
  return Math.max(0, asOfSec - latestResolvedIncidentAtSec) / 86_400;
}

function unresolvedEvidenceReasons(
  envelope: V9ValidatedPolicyEnvelope,
  gapIndex: V9EvaluationGapIndex,
): V9PillarReason[] {
  return canonicalReasons(
    [...gapIndex.byId.values()].map((gap) =>
      pillarReason(
        envelope,
        gap.reasonCode,
        `gap:${gap.ownerDomain}:${gap.path.kind}:${gap.gapId}`,
        gap.message,
        gap.responsibility,
        gap.gapId,
        gap.causeProof.cause,
        [gap.gapId],
      ),
    ),
  );
}

export function upstreamExitAccessScore(result: V9ExitEvaluationResult): number | null {
  if (result.primaryRouteKey === null) return null;
  return result.routes.find((route) => route.routeKey === result.primaryRouteKey)?.components?.access ?? null;
}

export function upstreamOracleNavProjection(
  result: V9EvaluatedAsset,
): { score: number | null; cause: V9EvidenceCause | null } {
  const localComponent = result.control.components.find((component) => component.kind === "oracle");
  const localComponentScore = localComponent?.score;
  const localScore =
    localComponentScore ??
    (result.control.oracleApplicability === "not-applicable" ? V9_NEUTRAL_CONTROL_SCORE : null);
  // Known adverse topology is admitted as an oracle structural signal, while
  // component causes primarily describe unresolved factor evidence.
  const localCause = localComponent?.cause ??
    (localComponent?.posture === "single-source-or-laggy" &&
      result.scoreInput.pillars.control.structuralSignals.some((signal) =>
        signal.kind === "weak-oracle-branch" && signal.pricedInPillar === "control" &&
        signal.responsibility === "measured-adverse")
      ? "D" : null);
  return { score: localScore, cause: localCause };
}


/**
 * Direct parent-token claims inherit parent Backing. A complete admitted lender
 * book is a separate parent-denominated candidate whose collateral risk remains
 * priced; an arbitrary strategy denomination establishes neither admission.
 */
function resolveInheritedStablecoinBacking(
  asset: V9AssetFactsBase,
  resolved: V9ResolvedDependencyInputs,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
  envelope: V9ValidatedPolicyEnvelope,
): V9InheritedStablecoinBacking | undefined {
  if (asset.reserveStatus.applicability.state === "not-applicable") return undefined;
  if (
    asset.wrapperLocalFacts?.applicability === "wrapper" &&
    asset.wrapperLocalFacts.parentBackingInheritance?.state === "withheld"
  ) return undefined;
  if (resolved.cycleBlocked) return undefined;
  if (resolved.serial.length + resolved.basket.length !== 1) return undefined;
  const wrapped = resolved.serial.length === 1;
  const upstreamAssetId = wrapped ? resolved.serial[0].upstreamAssetId : resolved.basket[0].upstreamAssetId;
  if (wrapped && resolved.serial[0].blocked && resolved.serial[0].ratingStatus !== "not-rated") return undefined;
  const parent = evaluatedById.get(upstreamAssetId);
  if (!parent) return undefined;
  const parentBackingScore = projectV9EffectiveBackingPillarScore(parent);
  if (parentBackingScore === null) return undefined;
  const reviewedCuratedClaim = asset.dependencies.source === "curated-reserve" &&
    asset.dependencies.baseSource === "curated-reserve" &&
    asset.dependencies.status.applicability.state === "required" &&
    asset.dependencies.status.observationState === "known" &&
    asset.dependencies.status.evidenceRefIds.length > 0;
  let weight: number;
  let admittedClaimEvidenceRefIds: readonly string[] | undefined;
  if (asset.reserveExposures.length === 0) {
    // A reviewed exact parent claim is usable evidence without a live balance.
    // A variant label or a parent-denominated strategy is not that claim.
    if (!reviewedCuratedClaim) return undefined;
    admittedClaimEvidenceRefIds = asset.dependencies.status.evidenceRefIds;
    weight = wrapped ? 1 : resolved.basket[0].weight;
  } else {
    const hasWrapperEdge = asset.dependencies.edges.some(
      edge => edge.pathKind === "serial-dependency" &&
        edge.dependencyType === "wrapper" && edge.upstreamAssetId === upstreamAssetId,
    );
    if (!hasWrapperEdge && !reviewedCuratedClaim) return undefined;
    const parentClaim = { parentAssetId: upstreamAssetId, parentBackingScore };
    const exposures = verifiedLiveInheritedExposures(asset, parentClaim) ??
      verifiedLiveLenderBookExposures(asset, parentClaim, envelope);
    if (exposures === undefined) return undefined;
    weight = exposures.reduce((sum, exposure) => sum + exposure.weight, 0);
    if (!wrapped) weight = Math.min(weight, resolved.basket[0].weight);
    if (!hasWrapperEdge) admittedClaimEvidenceRefIds = asset.dependencies.status.evidenceRefIds;
  }
  if (weight < V9_WRAPPER_INHERITANCE_MIN_PARENT_WEIGHT) return undefined;
  const parentPillar = parent.scoreInput.pillars.backing;
  const cause = parentPillar.reasons.some((reason) => reason.cause === "D")
    ? "D"
    : parentPillar.limitedEvidenceCauses.find((value) => value === "C" || value === "U") ?? null;
  return {
    parentAssetId: upstreamAssetId,
    parentBackingScore,
    cause,
    causeGapIds: parentPillar.causeGapIds.filter((id) => !parentPillar.excludedCauseGapIds?.includes(id)),
    collateralizationApplications: parent.backing.collateralizationApplications,
    weight: Math.min(1, weight),
    ...(admittedClaimEvidenceRefIds === undefined ? {} : { admittedClaimEvidenceRefIds }),
    tier: wrapped ? "wrapped" : "pure",
    failureDomains: canonicalDomains([
      ...parent.backing.failureDomains,
      { kind: "reserve-issuer", key: `asset:${upstreamAssetId}` },
    ]),
  };
}

/** The three wrapper-strategy parent-cap tiers, keyed to `formula.wrapperStrategyCap`. */
export type V9WrapperStrategyTier = "pure" | "staked" | "vault";

/**
 * Wrapper-strategy classification for the parent cap. A yield/vault wrapper must
 * rate meaningfully below its required parent, tiered by the wrapper's form:
 *  - `pure-wrapper` (a direct 1:1 wrap/unwrap claim) -> "pure" (the smallest
 *    fallback haircut): it adds a contract layer without a yield strategy.
 *  - third-party strategy forms (such as Yearn/Gauntlet/Steakhouse vaults and
 *    third-party risk-absorption wrappers) → "vault" (the largest haircut): they layer third-party strategy,
 *    smart-contract and liquidity risk over an issuer it does not control.
 *  - native savings/staking forms operated by the parent protocol → "staked"
 *    (a smaller haircut): a thinner, same-protocol layer.
 * Current V3 facts carry the reviewed wrapper form directly. Retained V2 facts
 * fall back to `variantKind`; an unmapped form or a bare serial-wrapper parent
 * takes the conservative "vault" haircut. A serial parent with no wrapper edge
 * (a collateral basket or a "mechanism" serial claim) returns undefined.
 */
export function resolveV9WrapperStrategyTier(
  asset: V9AssetFactsBase,
  resolved: V9ResolvedDependencyInputs,
): V9WrapperStrategyTier | undefined {
  if (asset.wrapperLocalFacts?.applicability === "wrapper") {
    if (asset.wrapperLocalFacts.form === "pure") return "pure";
    if (asset.wrapperLocalFacts.form === "native-staked") return "staked";
    return "vault";
  }
  if (asset.variantKind === "pure-wrapper") return "pure";
  if (asset.variantKind === "strategy-vault") return "vault";
  if (asset.variantKind === "savings-passthrough" || asset.variantKind === "risk-absorption") return "staked";
  if (resolved.serial.length === 0) return undefined;
  const serialUpstreamIds = new Set(resolved.serial.map((dependency) => dependency.upstreamAssetId));
  const hasWrapperSerialEdge = asset.dependencies.edges.some(
    (edge) =>
      edge.pathKind === "serial-dependency" &&
      edge.dependencyType === "wrapper" &&
      serialUpstreamIds.has(edge.upstreamAssetId),
  );
  return hasWrapperSerialEdge ? "vault" : undefined;
}

function dependencyReasons(
  asset: V9AssetFactsV3,
  inputs: V9ResolvedDependencyInputs,
  plan: V9DependencyEvaluationPlan,
  envelope: V9ValidatedPolicyEnvelope,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
  gapIndex: V9EvaluationGapIndex,
): V9PillarReason[] {
  const reasons: V9PillarReason[] = [];
  if (
    asset.dependencies.status.applicability.state === "unresolved" ||
    asset.dependencies.status.observationState !== "known"
  ) {
    reasons.push(
      ...pillarReasonsForGapIds(
        envelope,
        gapIndex,
        null,
        "dependency:envelope",
        asset.dependencies.status.gapIds,
        "unreviewed-dependency-relationships",
        "integration-missing",
      ),
    );
  }
  if (
    asset.dependencies.diagnostics.graphState === "invalid" ||
    asset.dependencies.diagnostics.graphState === "unresolved"
  ) {
    reasons.push(
      pillarReason(
        envelope,
        "unreviewed-dependency-relationships",
        "dependency:graph",
        undefined,
        "method-unsupported",
      ),
    );
  }
  const mappedWeightByUpstream = new Map<string, number>();
  const dependencyStatusGaps = gapsForV9Ids(gapIndex, asset.dependencies.status.gapIds);
  for (const exposure of asset.reserveExposures) {
    if (exposure.trackedAssetId === null) continue;
    mappedWeightByUpstream.set(
      exposure.trackedAssetId,
      (mappedWeightByUpstream.get(exposure.trackedAssetId) ?? 0) + exposure.weight,
    );
  }
  for (const dependency of inputs.basket) {
    const mappedWeight = mappedWeightByUpstream.get(dependency.upstreamAssetId);
    if (mappedWeight === undefined || Math.abs(mappedWeight - dependency.weight) > 0.000001) {
      reasons.push(
        ...pillarReasonsForGapIds(
          envelope,
          gapIndex,
          "unreviewed-dependency-relationships",
          `dependency:collateral:${dependency.upstreamAssetId}`,
          dependencyStatusGaps.map((gap) => gap.gapId),
          "unreviewed-dependency-relationships",
          "integration-missing",
          `Collateral dependency ${dependency.upstreamAssetId} is not exactly mapped to reserve exposures.`,
        ),
      );
    }
  }
  const serialCycleMembers = new Set(plan.serialCycleAssetIds);
  if (serialCycleMembers.has(asset.assetId)) {
    reasons.push(
      pillarReason(envelope, "implementation-parent-cycle", "dependency:cycle", undefined, "method-unsupported"),
    );
  } else if (plan.serialBlockedDescendants.includes(asset.assetId)) {
    reasons.push(
      pillarReason(envelope, "parent-cycle", "dependency:serial-ancestor-cycle", undefined, "method-unsupported"),
    );
  }
  for (const serial of inputs.serial.filter((dependency) => dependency.blocked)) {
    const upstream = evaluatedById.get(serial.upstreamAssetId);
    const upstreamAttributions =
      upstream === undefined ? [] : nrReasonAttributions(upstream.trace);
    const attributions =
      upstreamAttributions.length > 0
        ? upstreamAttributions
        : [
            {
              causalKey: "missing-upstream-evaluation",
              responsibility: "integration-missing" as const,
            },
          ];
    for (const attribution of attributions) {
      reasons.push(
        pillarReason(
          envelope,
          "missing-parent-score",
          attributedReasonPath(
            `dependency:serial:${serial.upstreamAssetId}`,
            attribution,
          ),
          `Required upstream ${serial.upstreamAssetId} is not rateable.`,
          attribution.responsibility,
        ),
      );
    }
  }
  return canonicalReasons(reasons);
}

function pegInput(
  asset: V9AssetFactsV3,
  envelope: V9ValidatedPolicyEnvelope,
  gapIndex: V9EvaluationGapIndex,
): V9ProductionScoreInput["peg"] {
  const applicable = asset.peg.status.applicability.state !== "not-applicable";
  const reasons =
    applicable && asset.peg.status.observationState !== "known"
      ? pillarReasonsForGapIds(
          envelope,
          gapIndex,
          null,
          `peg:${asset.peg.pegKey}`,
          asset.peg.status.gapIds,
          "missing-peg-input",
        )
      : [];
  return {
    applicable,
    score: applicable ? asset.peg.pegScore : null,
    activeDepegBps: applicable && asset.peg.activeDepeg === true ? asset.peg.activeDepegBps : null,
    reasons: canonicalReasons(reasons),
  };
}

/** Apply the ordinary serial ceiling and any admitted near-total collateral ceiling. */
export function resolveV9ParentLimitInput(
  asset: V9AssetFactsV3,
  inputs: V9ResolvedDependencyInputs,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
  wrapperTier: V9WrapperStrategyTier | undefined,
  envelope: V9ValidatedPolicyEnvelope,
): V9ProductionScoreInput["parent"] {
  const serial = parentInput(asset, inputs, evaluatedById, wrapperTier, envelope);
  const collateral = resolveV9SingleCollateralParent(asset.dependencies.status, inputs, asset.reserveExposures);
  if (!collateral || (serial.required && serial.score === null)) return serial;
  const upstream = evaluatedById.get(collateral.upstreamAssetId);
  const trace = upstream?.trace;
  const score = trace ? projectV9DependencyScore(trace) : null;
  if (score === null) return serial;
  const concentrated = parentInput(asset, {
    ...inputs,
    serial: [{
      upstreamAssetId: collateral.upstreamAssetId,
      score,
      blocked: false,
      ratingStatus: trace?.ratingStatus ?? "pipeline-gap",
      cause: collateral.cause,
      causeGapIds: trace?.causeGapIds ?? collateral.causeGapIds,
      limitedEvidenceCauses: trace?.limitedEvidenceCauses ?? collateral.limitedEvidenceCauses,
      partialEvidence: trace?.partialEvidence ?? null,
    }],
  }, evaluatedById, "pure", envelope, true);
  if (concentrated.wrapperParentLimit) {
    concentrated.wrapperParentLimit = {
      ...concentrated.wrapperParentLimit,
      parentKind: "concentrated-collateral",
      parentAssetId: collateral.upstreamAssetId,
    };
  }
  return !serial.required || concentrated.score === null ||
    (serial.score !== null && concentrated.score < serial.score) ? concentrated : serial;
}

function parentInput(
  asset: V9AssetFactsV3,
  inputs: V9ResolvedDependencyInputs,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
  wrapperTier: V9WrapperStrategyTier | undefined,
  envelope: V9ValidatedPolicyEnvelope,
  collateralClaim = false,
): V9ProductionScoreInput["parent"] {
  const required = inputs.serial.length > 0 || inputs.cycleBlocked;
  const unavailableParents = inputs.serial.filter((dependency) => dependency.score === null);
  const parentPipelineGap = unavailableParents.some((dependency) =>
    dependency.ratingStatus === "pipeline-gap",
  );
  const parentStatus = parentPipelineGap || inputs.cycleBlocked ? "pipeline-gap" as const
    : unavailableParents.length > 0 ? "not-rated" as const : "rated" as const;
  const parentPartials = inputs.serial.flatMap((dependency) => dependency.partialEvidence ? [dependency.partialEvidence] : []);
  const partialEvidence: V9ProductionScoreInput["parent"]["partialEvidence"] = parentPartials.length === 0 ? null : {
    reasonCode: "partial-evidence-pipeline-gap",
    excludedPillars: uniqueSorted(parentPartials.flatMap((partial) => partial.excludedPillars)),
    excludedComponentKeys: uniqueSorted(parentPartials.flatMap((partial) => partial.excludedComponentKeys)),
    causeGapIds: uniqueSorted(parentPartials.flatMap((partial) => partial.causeGapIds)),
    causes: uniqueSorted(parentPartials.flatMap((partial) => partial.causes)),
  };
  const parentCauseGapIds = uniqueSorted(unavailableParents.flatMap((dependency) => dependency.causeGapIds ?? []));
  const parentLimitedCauses = uniqueSorted(unavailableParents.flatMap((dependency) => dependency.limitedEvidenceCauses ?? []));
  const availableScores = inputs.serial.flatMap((dependency) =>
    dependency.blocked || dependency.score === null ? [] : [dependency.score],
  );
  const rawScore =
    !required || inputs.cycleBlocked || availableScores.length !== inputs.serial.length
      ? null
      : Math.min(...availableScores);
  const propagatedReasons = inputs.serial.flatMap((dependency) => {
    const upstream = evaluatedById.get(dependency.upstreamAssetId);
    const reasons: V9ProductionScoreInput["parent"]["propagatedReasons"] =
      upstream?.trace.nrReasons.length ? upstream.trace.nrReasons : dependency.score !== null ? [] : [{
        code: "missing-parent-score",
        message: `The required parent ${dependency.upstreamAssetId} is unavailable.`,
        cause: dependency.cause ?? "U",
        causeGapIds: dependency.causeGapIds ?? [],
      }];
    return reasons.map((reason) => ({
      ...reason,
      cause: reason.cause ?? "U",
      causalKey:
        reason.causalKey ??
        `asset:${dependency.upstreamAssetId}:${reason.code}:${reason.field ?? "unattributed"}`,
    }));
  });
  const propagatedAdverseAttribution = resolveV9SerialParentAdverseAttribution(
    rawScore,
    inputs.serial.map((dependency) => ({
      ...dependency,
      adverseAttribution:
        evaluatedById.get(dependency.upstreamAssetId)?.trace.adverseAttribution ?? [],
    })),
  );
  const propagatedBoundedUncertaintyAttribution =
    resolveV9SerialParentBoundedUncertaintyAttribution(
      rawScore,
      inputs.serial.map((dependency) => ({
        ...dependency,
        boundedUncertaintyAttribution:
          evaluatedById.get(dependency.upstreamAssetId)?.trace
            .boundedUncertaintyAttribution ?? [],
      })),
    );
  if (rawScore === null || wrapperTier === undefined) {
    return {
      required,
      score: rawScore,
      propagatedReasons,
      ratingStatus: parentStatus,
      causeGapIds: parentCauseGapIds,
      limitedEvidenceCauses: parentLimitedCauses,
      partialEvidence,
      propagatedAdverseAttribution,
      propagatedBoundedUncertaintyAttribution,
      wrapperParentLimit: null,
    };
  }
  const expectedForm: V9WrapperForm =
    wrapperTier === "pure" ? "pure" : wrapperTier === "staked" ? "native-staked" : "strategy-vault";
  if (!collateralClaim && asset.wrapperLocalFacts.applicability !== "wrapper") {
    throw new Error(`Safety Score v9 ${asset.assetId} wrapper parent lacks wrapper-local facts`);
  }
  if (!collateralClaim && asset.wrapperLocalFacts.applicability === "wrapper" &&
      asset.wrapperLocalFacts.form !== expectedForm) {
    throw new Error(
      `Safety Score v9 ${asset.assetId} wrapper form ${asset.wrapperLocalFacts.form} disagrees with ${expectedForm}`,
    );
  }
  const fallback = envelope.policy.semantic.formula.wrapperStrategyCap;
  const wrapperLimit = resolveV9WrapperParentLimit({
    parentScore: rawScore,
    localFacts: { form: expectedForm },
    formDiscounts: {
      pure: fallback.pure,
      "native-staked": fallback.staked,
      "strategy-vault": fallback.vault,
    },
  });
  return {
    required,
    score: decimalSnap(wrapperLimit.limit),
    ratingStatus: parentStatus,
    causeGapIds: parentCauseGapIds,
    limitedEvidenceCauses: parentLimitedCauses,
    partialEvidence,
    propagatedReasons,
    propagatedAdverseAttribution,
    propagatedBoundedUncertaintyAttribution,
    wrapperParentLimit: wrapperLimit,
  };
}

interface V9EvaluateAssetInput {
  asset: V9AssetFactsV3;
  resolved: V9ResolvedDependencyInputs;
  dependencyPlan: V9DependencyEvaluationPlan;
  envelope: V9ValidatedPolicyEnvelope;
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>;
  unavailabilityRootsById: ReadonlyMap<string, readonly string[]>;
  identity: V9ProductionScoreInput["identity"];
  marketRank: number | null;
  dependencySignals: readonly V9StructuralSignal[];
}

export function evaluateV9Asset({
  asset,
  resolved,
  dependencyPlan,
  envelope,
  evaluatedById,
  unavailabilityRootsById,
  identity,
  marketRank,
  dependencySignals,
}: V9EvaluateAssetInput): {
  evaluatedAsset: V9EvaluatedAsset;
  unavailabilityRoots: readonly string[];
} {
  const gapIndex = createV9GapIndex(asset.gaps);
  const cdpReview = asset.mechanismRiskReview.review?.archetype === "cdp" ? asset.mechanismRiskReview.review : null;
  const liquidationCapacitySelection =
    asset.archetype === "cdp"
      ? selectV9CdpLiquidationCapacity(
          cdpReview,
          asset.cdpStressCoverage,
          envelope,
          identity.asOfSec,
        )
      : undefined;
  const inheritedStablecoinBacking = resolveInheritedStablecoinBacking(asset, resolved, evaluatedById, envelope);
  const wrapperStrategyTier = resolveV9WrapperStrategyTier(asset, resolved);
  const trackRecordMonths = conservativeTrackRecordMonths(asset.implementation.launchedAtSec, identity.asOfSec);
  const dependencyStatusGaps = gapsForV9Ids(gapIndex, asset.dependencies.status.gapIds);
  const backingAsset = {
    assetId: asset.assetId,
    reserveStatus: asset.reserveStatus,
    reserveExposures: asset.reserveExposures,
    reserveResiduals: asset.reserveResiduals,
    reserveCompositionEvidenceClass: asset.reserveCompositionEvidenceClass,
    reserveCompositionProvenance: asset.reserveCompositionProvenance,
    reserveBoundFacts: asset.reserveBoundFacts,
    gaps: asset.gaps,
    gapIndex,
    resolvedUpstreamExposures: resolvedBackingExposures(
      asset,
      resolved,
      evaluatedById,
      unavailabilityRootsById,
    ),
    seriallyResolvedUpstreamAssetIds: resolved.serial.map((dependency) => dependency.upstreamAssetId),
    unresolvedUpstreamProjectionAttributions:
      dependencyStatusGaps.length > 0
        ? dependencyStatusGaps.map((gap) => ({
            causalKey: gap.gapId,
            responsibility: gap.responsibility,
          }))
        : [{
            causalKey: "dependency-projection:unattributed",
            responsibility: "method-unsupported" as const,
          }],
    ...(liquidationCapacitySelection === undefined
      ? {}
      : { cdpLiquidationCapacitySelection: liquidationCapacitySelection }),
    ...(inheritedStablecoinBacking === undefined ? {} : { inheritedStablecoinBacking }),
    ...(asset.lenderBook === undefined ? {} : { lenderBook: asset.lenderBook }),
    trackRecordMonths,
    asOfSec: identity.asOfSec,
  };
  const backing =
    asset.mechanismRiskReview.review === null
      ? createUnavailableV9BackingResult(backingAsset, asset, envelope)
      : evaluateV9Backing(backingAsset, asset.mechanismRiskReview.review, envelope);
  const control = evaluateV9EconomicControl({
    facts: asset,
    ...asset.economicControlReview,
    ...(() => {
      const ageDays = resolvedIncidentAgeDays(
        asset.economicControlReview.mint.latestResolvedIncidentAtSec,
        identity.asOfSec,
      );
      return ageDays === undefined ? {} : { resolvedIncidentAgeDays: ageDays };
    })(),
    policy: envelope,
  });
  const access = evaluateV9AccessPosture({
    policy: envelope,
    facts: asset,
    transfer: asset.accessReview.transfer,
    freezeReviews: asset.accessReview.freeze.reviews,
    claimGraph: asset.accessReview.freeze.claimGraph,
  });
  const peg = pegInput(asset, envelope, gapIndex);
  const backingPillarEvaluation = backingPillar(backing, envelope, gapIndex, evaluatedById);
  const inheritedBackingPillars = resolved.basket.flatMap((dependency) => {
    const upstream = evaluatedById.get(dependency.upstreamAssetId)?.scoreInput.pillars.backing;
    return upstream?.excludedCauseGapIds?.length ? [{ assetId: dependency.upstreamAssetId, pillar: upstream }] : [];
  });
  if (inheritedBackingPillars.length > 0) {
    backingPillarEvaluation.causeGapIds = uniqueSorted([
      ...backingPillarEvaluation.causeGapIds, ...inheritedBackingPillars.flatMap(({ pillar }) => pillar.excludedCauseGapIds ?? []),
    ]);
    backingPillarEvaluation.excludedCauseGapIds = uniqueSorted([
      ...(backingPillarEvaluation.excludedCauseGapIds ?? []), ...inheritedBackingPillars.flatMap(({ pillar }) => pillar.excludedCauseGapIds ?? []),
    ]);
    backingPillarEvaluation.excludedCauses = uniqueSorted([
      ...(backingPillarEvaluation.excludedCauses ?? []), ...inheritedBackingPillars.flatMap(({ pillar }) => pillar.excludedCauses ?? []),
    ]);
    backingPillarEvaluation.excludedComponentKeys = uniqueSorted([
      ...(backingPillarEvaluation.excludedComponentKeys ?? []),
      ...inheritedBackingPillars.flatMap(({ assetId, pillar }) => (pillar.excludedComponentKeys ?? []).map((key) => `dependency:backing:${assetId}:${key}`)),
    ]);
  }
  const controlPillarEvaluation = controlPillar(asset, control, envelope, gapIndex);
  // One projection of the exit routes (and the circulating supply / portfolio
  // status derived beside them) serves both the exit evaluation and the
  // retained stress state; evaluateV9Exit copies before sorting, so the shared
  // array is never mutated downstream.
  const exitSupplySizing = resolveV9ExitSupplySizing(asset);
  const exitCirculatingUsd = exitSupplySizing.circulatingUsd;
  const exitPortfolioStatus =
    asset.exitStatus.observationState === "known" && asset.exitStatus.applicability.state === "required"
      ? "reviewed-complete"
      : "incomplete";
  const projectedExitRoutes = asset.exitRoutes.map(projectV9ExitEvaluationRoute);
  const exit = evaluateV9Exit(
    {
      assetId: asset.assetId,
      clockSec: identity.asOfSec,
      ...exitSupplySizing,
      portfolioStatus: exitPortfolioStatus,
      portfolioFactStatus: asset.exitStatus,
      verifiedNoPoolsSupplyShare: asset.exitCoverage?.verifiedNoPoolsSupplyShare,
      gaps: asset.gaps,
      routes: projectedExitRoutes,
    },
    envelope,
  );
  const basePillars = {
    backing: backingPillarEvaluation,
    exit: exitPillar(
      asset,
      exit,
      envelope,
      gapIndex,
    ),
    control: controlPillarEvaluation,
  };
  // A default price is not evidence that an economic subject was reviewed.
  const hasExitSubject = asset.exitStatus.evidenceRefIds.length > 0 ||
    asset.exitRoutes.some((route) => route.status.evidenceRefIds.length > 0) ||
    (asset.mechanismExitFacts?.some((fact) => fact.evidenceRefIds.length > 0) ?? false);
  const hasControlSubject = asset.controls.some((control) => control.status.evidenceRefIds.length > 0) ||
    Object.values(asset.economicControlReview).some((review) => review.status.evidenceRefIds.length > 0);
  for (const [pillar, hasSubject] of [["exit", hasExitSubject], ["control", hasControlSubject]] as const) {
    if (!hasSubject && basePillars[pillar].aggregationDisposition === "included") {
      basePillars[pillar] = {
        ...basePillars[pillar], score: null, aggregationDisposition: "unavailable",
        evidenceLevel: "insufficient", supportedComponentKeys: [], limitedEvidenceCauses: [],
        limitingCauseGapIds: [],
      };
    }
  }
  const parent = resolveV9ParentLimitInput(asset, resolved, evaluatedById, wrapperStrategyTier, envelope);
  if (parent.ratingStatus === "pipeline-gap") {
    for (const pillar of ["backing", "exit"] as const) {
      basePillars[pillar] = {
        ...basePillars[pillar], score: null,
        aggregationDisposition: (parent.partialEvidence?.causes.length ?? 0) > 0 ? "excluded-a-b" : "unavailable",
        supportedComponentKeys: [], limitedEvidenceCauses: [],
        causeGapIds: parent.causeGapIds ?? [],
        excludedCauseGapIds: parent.causeGapIds ?? [],
        excludedCauses: parent.partialEvidence?.causes ?? [],
        excludedComponentKeys: [`dependency:serial:${pillar}`],
      };
    }
  }
  const methodologyReasons =
    asset.implementation.launchedAtSec === null
      ? pillarReasonsForGapIds(
          envelope,
          gapIndex,
          null,
          "methodology:implementation-date",
          asset.implementation.status.gapIds,
          "missing-implementation-date",
        )
      : [];
  const dependencyReasonsInput = dependencyReasons(
    asset,
    resolved,
    dependencyPlan,
    envelope,
    evaluatedById,
    gapIndex,
  );
  const pillars = basePillars;
  const pricedControllerKeys = pricedV9ControllerKeys(asset.controls, control.components);
  const pricedDependencySignals = dependencySignals.map((signal) =>
    isV9SharedControllerSignalAlreadyPriced(signal, asset.controls, pricedControllerKeys)
      ? { ...signal, pricedInPillar: "control" as const } : signal);
  const scoreInput: V9ProductionScoreInput = {
    assetId: asset.assetId,
    marketRank,
    identity,
    pillars,
    peg,
    trackRecordMonths: asset.implementation.launchedAtSec === null ? null : trackRecordMonths,
    realizedHolderLossEvents: asset.realizedHolderLossEvents ?? [],
    parent,
    dependencyReasons: dependencyReasonsInput,
    dependencyStructuralSignals: pricedDependencySignals,
    methodologyReasons,
    unresolvedEvidence: unresolvedEvidenceReasons(envelope, gapIndex),
  };
  const trace = scoreV9EvaluatedAsset(scoreInput, envelope);
  const componentReasonKeys = new Set((scoreInput.pillars.backing.boundedComponents ?? []).map(
    ({ reason }) => `${reason.code}\u0000${reason.path}`,
  ));
  const retainedComponentKeys = new Set(trace.boundedUncertaintyAttribution
    .filter((item) => item.source === "reason")
    .map((item) => `${item.code}\u0000${item.path}`));
  const emittedScoreInput: V9ProductionScoreInput = {
    ...scoreInput,
    pillars: {
      ...scoreInput.pillars,
      backing: {
        ...scoreInput.pillars.backing,
        reasons: scoreInput.pillars.backing.reasons.filter((reason) =>
          !componentReasonKeys.has(`${reason.code}\u0000${reason.path}`) ||
          retainedComponentKeys.has(`${reason.code}\u0000${reason.path}`),
        ),
        boundedComponents: scoreInput.pillars.backing.boundedComponents?.filter(({ reason }) =>
          retainedComponentKeys.has(`${reason.code}\u0000${reason.path}`),
        ),
      },
    },
  };
  const unavailabilityRoots = resolveUnavailabilityRoots(
    asset,
    resolved,
    trace,
    unavailabilityRootsById,
  );
  const stressState = buildV9RetainedStressState({
    circulatingUsd: exitCirculatingUsd,
    portfolioStatus: exitPortfolioStatus,
  });
  return {
    evaluatedAsset: {
      assetId: asset.assetId,
      backing,
      exit,
      control,
      access,
      dependencyInputs: resolved,
      scoreInput: emittedScoreInput,
      trace,
      compactTrace: projectCompactV9ScoreTrace(trace),
      stressState,
      ...(asset.supply.providerRowExclusions?.length ? { providerRowExclusions: asset.supply.providerRowExclusions } : {}),
      ...(liquidationCapacitySelection === undefined ? {} : { liquidationCapacitySelection }),
    },
    unavailabilityRoots,
  };
}
