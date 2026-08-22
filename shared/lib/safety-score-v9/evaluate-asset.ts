import type {
  V9AssetFactsBase,
  V9AssetFactsV3,
  V9EvidenceResponsibility,
  V9FactStatusV2,
} from "../../types/safety-score-v9-facts";
import type {
  V9EvidenceLevel,
  V9ReasonCode,
  V9StructuralSignal,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import { isDexMeasuredExecutionObservationHistoryMature } from "../../types/measured-execution";
import { evaluateV9AccessPosture, type V9AccessPostureResult } from "./access-posture";
import {
  createUnavailableV9BackingResult,
  V9_WRAPPER_INHERITANCE_MIN_PARENT_WEIGHT,
  type V9BackingResult,
  type V9CdpLiquidationCapacitySelection,
  type V9InheritedStablecoinBacking,
} from "./backing";
import { evaluateV9Backing } from "./archetypes";
import { selectV9CdpLiquidationCapacity } from "./archetypes/cdp";
import { evaluateV9EconomicControlAssetFacts, type V9EconomicControlResult } from "./control";
import {
  projectV9RoleDependencyPillarLimits,
  type V9DependencyEvaluationPlan,
  type V9ResolvedDependencyInputs,
  type V9RoleDependencyPillarProjection,
} from "./dependencies";
import {
  evaluateV9ExitAssetFacts,
  projectV9ExitEvaluationRoute,
  type V9ExitEvaluationResult,
} from "./exit";
import {
  V9_LEGACY_RESPONSIBILITY_BY_REASON,
} from "./facts";
import {
  decimalSnap,
  hasV9PreExitDangerSignal,
  type V9PillarAdverseAttribution,
} from "./formula";
import { evaluateV9OperationalResilience, type V9OperationalResilienceResult } from "./operational-resilience";
import {
  applyOperationalResilienceCredits,
  measuredOperationalMarketDepth,
  operationalResilienceBlockers,
} from "./operational-market-depth";
import { resolveV9ReasonPolicy } from "./policy";
import { canonicalDomains, compareText, domainKey, uniqueSorted } from "./primitives";
import {
  resolveV9WrapperParentLimit,
  type V9WrapperForm,
} from "./wrapper-risk";
import {
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

export { projectV9ResolvedBackingExposure } from "./unavailability-roots";

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
  operationalResilience: V9OperationalResilienceResult | null;
  liquidationCapacitySelection?: V9CdpLiquidationCapacitySelection;
}

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
): V9PillarReason {
  return {
    code,
    path,
    message: message ?? resolveV9ReasonPolicy(envelope, code).reason.publicLabel,
    responsibility,
    ...(sourceGapId == null ? {} : { sourceGapId }),
  };
}

function pillarReasonsForGaps(
  envelope: V9ValidatedPolicyEnvelope,
  code: V9ReasonCode,
  path: string,
  gaps: readonly V9AssetFactsV3["gaps"][number][],
  fallbackResponsibility: V9EvidenceResponsibility,
  fallbackMessage?: string,
): V9PillarReason[] {
  const causalGaps = [
    ...new Map(
      [...gaps]
        .sort((left, right) => compareText(left.gapId, right.gapId))
        .map((gap) => [gap.gapId, gap]),
    ).values(),
  ];
  if (causalGaps.length === 0) {
    return [
      pillarReason(
        envelope,
        code,
        path,
        fallbackMessage,
        fallbackResponsibility,
      ),
    ];
  }
  return causalGaps.map((gap) =>
    pillarReason(
      envelope,
      code,
      `${path}:cause:${encodeURIComponent(gap.gapId)}`,
      gap.message,
      gap.responsibility,
      gap.gapId,
    ),
  );
}

interface V9ReasonAttribution {
  causalKey: string;
  responsibility: V9EvidenceResponsibility;
}

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
  return [
    ...new Map(
      attributions
        .sort(
          (left, right) =>
            compareText(left.causalKey, right.causalKey) ||
            compareText(left.responsibility, right.responsibility),
        )
        .map((attribution) => [
          `${attribution.causalKey}\u0000${attribution.responsibility}`,
          attribution,
        ]),
    ).values(),
  ];
}

function attributedReasonPath(
  basePath: string,
  attribution: V9ReasonAttribution,
): string {
  return `${basePath}:cause:${encodeURIComponent(attribution.causalKey)}`;
}

function structuralSignalFromBacking(reason: V9BackingResult["structuralReasons"][number]): V9StructuralSignal {
  return {
    kind: reason.kind,
    severity: reason.severity,
    reason: `${reason.kind} condition at ${reason.pathKey}.`,
    responsibility: reason.responsibility,
    ...(reason.materialShare === null ? {} : { materialSharePct: reason.materialShare * 100 }),
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
  const responsibility: V9EvidenceResponsibility =
    failure.kind !== "unreviewed-upgrade" &&
    reviewStatus.applicability.state === "required" &&
    reviewStatus.observationState === "known" &&
    controlsKnown &&
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
    ...(economicLossScope === "deployment" && failure.materialSharePct !== null
      ? {}
      : { pricedInPillar: "control" as const }),
    failureDomainKeys,
    evidence: [],
  };
}

function reasonClassifiedEvidenceLevel(
  score: number | null,
  reasonCodes: readonly V9ReasonCode[],
  envelope: V9ValidatedPolicyEnvelope,
  fallback: V9EvidenceLevel,
): V9EvidenceLevel {
  if (score === null) return "insufficient";
  const treatments = reasonCodes.map((code) => resolveV9ReasonPolicy(envelope, code).reason.defaultTreatment);
  if (treatments.includes("NR")) return "insufficient";
  if (treatments.includes("ceiling")) return "limited";
  return fallback;
}

function backingPillar(
  asset: V9AssetFactsV3,
  result: V9BackingResult,
  envelope: V9ValidatedPolicyEnvelope,
): V9PillarEvaluation {
  const gapGroups = new Map<
    string,
    {
      code: V9ReasonCode;
      path: string;
      gaps: V9AssetFactsV3["gaps"];
    }
  >();
  const syntheticReasons: Array<{
    reason: V9BackingResult["unresolved"][number];
    path: string;
  }> = [];
  for (const reason of result.unresolved) {
    const path = `backing:${reason.pathKey}`;
    const gaps = reason.gapIds.flatMap((gapId) => {
      const gap = asset.gaps.find((candidate) => candidate.gapId === gapId);
      return gap ? [gap] : [];
    });
    if (gaps.length === 0) {
      syntheticReasons.push({ reason, path });
      continue;
    }
    for (const gap of gaps) {
      const key = `${gap.reasonCode}\u0000${path}`;
      const group = gapGroups.get(key) ?? {
        code: gap.reasonCode,
        path,
        gaps: [],
      };
      group.gaps.push(gap);
      gapGroups.set(key, group);
    }
  }
  const canonicalSyntheticReasons = [
    ...new Map(
      syntheticReasons
        .sort(
          (left, right) =>
            compareText(left.reason.code, right.reason.code) ||
            compareText(left.path, right.path) ||
            compareText(left.reason.causalKey ?? "", right.reason.causalKey ?? "") ||
            compareText(
              left.reason.responsibility ?? "",
              right.reason.responsibility ?? "",
            ),
        )
        .map((entry) => [
          `${entry.reason.code}\u0000${entry.path}\u0000${entry.reason.causalKey ?? ""}\u0000${entry.reason.responsibility ?? ""}`,
          entry,
        ]),
    ).values(),
  ];
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
      ...[...gapGroups.values()].flatMap((group) =>
        pillarReasonsForGaps(
          envelope,
          group.code,
          group.path,
          group.gaps,
          V9_LEGACY_RESPONSIBILITY_BY_REASON[group.code],
        ),
      ),
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
        );
      }),
    ],
  );
  return {
    score: result.score,
    evidenceLevel: reasonClassifiedEvidenceLevel(
      result.score,
      result.unresolved.map((reason) => reason.code),
      envelope,
      "strong",
    ),
    reasons,
    structuralSignals: result.structuralReasons.map(structuralSignalFromBacking),
  };
}

function exitPillar(
  asset: V9AssetFactsV3,
  result: V9ExitEvaluationResult,
  envelope: V9ValidatedPolicyEnvelope,
): V9PillarEvaluation {
  const mechanismExitFacts = asset.mechanismExitFacts ?? [];
  const hasKnownRuntimeRoute = asset.exitRoutes.some(
    (route) => route.status.observationState === "known" && route.scoreEligible,
  );
  const profileExplainsMissingRuntime =
    !hasKnownRuntimeRoute &&
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
    primary.status.observationState === "known" &&
    primary.scoreEligible &&
    primary.lane === "dex" &&
    primary.coverageClass !== "diagnostic" &&
    envelope.policy.semantic.exit.scoreableEvidenceKinds.dex.includes(primary.evidenceKind) &&
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
  return {
    score: result.score,
    evidenceLevel: reasonClassifiedEvidenceLevel(
      result.score,
      effectiveReasons.map((reason) => reason.code),
      envelope,
      primaryStrong ? "strong" : "adequate",
    ),
    reasons: canonicalReasons(
      effectiveReasons.flatMap(({ code, profileFactKeys, profileResponsibility: responsibility }) => {
        const matchingGaps = asset.gaps.filter(
          (candidate) => candidate.ownerDomain === "exit" && candidate.reasonCode === code,
        );
        const exitGaps = asset.exitStatus.gapIds.flatMap((gapId) => {
          const candidate = asset.gaps.find((item) => item.gapId === gapId);
          return candidate ? [candidate] : [];
        });
        const unresolvedOutputGaps =
          code === "missing-same-notional-route" || code === "no-viable-exit-path"
            ? exitGaps.filter((gap) => gap.reasonCode === "unresolved-exit-output")
            : [];
        const causalGaps =
          matchingGaps.length > 0
            ? matchingGaps
            : unresolvedOutputGaps;
        const path =
          profileFactKeys.length > 0
            ? `exit:mechanism-profile:${profileFactKeys.join("+")}`
            : `exit:${code}`;
        const nativeMeasuredCompleteEmpty =
          code === "no-viable-exit-path" &&
          asset.exitStatus.applicability.state === "required" &&
          asset.exitStatus.observationState === "known" &&
          result.score === 0 &&
          result.primaryRouteKey === null &&
          causalGaps.length === 0 &&
          profileFactKeys.length === 0;
        return responsibility !== null
          ? [
              pillarReason(
                envelope,
                code,
                path,
                `Reviewed ${profileFactKeys.join(" and ")} evidence exists, but no score-eligible runtime route is compiled.`,
                responsibility,
              ),
            ]
          : pillarReasonsForGaps(
              envelope,
              code,
              path,
              causalGaps,
              nativeMeasuredCompleteEmpty
                ? "measured-adverse"
                : V9_LEGACY_RESPONSIBILITY_BY_REASON[code],
            );
      }),
    ),
    structuralSignals: [],
    adverseAttribution: capacityAttribution,
  };
}

function controlPillar(
  asset: V9AssetFactsV3,
  result: V9EconomicControlResult,
  envelope: V9ValidatedPolicyEnvelope,
): V9PillarEvaluation {
  const gapsForStatus = (status: V9FactStatusV2) =>
    status.gapIds.flatMap((gapId) => {
      const gap = asset.gaps.find((candidate) => candidate.gapId === gapId);
      return gap ? [gap] : [];
    });
  const controlDomainGaps = asset.gaps.filter(
    (candidate) => candidate.ownerDomain === "control",
  );
  const causalGapsForReason = (
    reason: V9EconomicControlResult["reasons"][number],
  ): V9AssetFactsV3["gaps"] => {
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

    if (reason.code === "incomplete-oracle-liquidation-branch") {
      return gapsForStatus(asset.economicControlReview.oracle.status);
    }
    if (reason.code === "missing-upgradeability-review") {
      return gapsForStatus(asset.economicControlReview.mint.status);
    }
    if (reason.code === "selected-bridge-route-unresolved") {
      return gapsForStatus(asset.economicControlReview.bridge.status);
    }
    if (
      reason.code === "runtime-bridge-materiality-unavailable" &&
      asset.supply.chainDistribution !== null
    ) {
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

  return {
    score: result.score,
    evidenceLevel: reasonClassifiedEvidenceLevel(
      result.score,
      result.reasons.map((reason) => reason.code),
      envelope,
      "strong",
    ),
    reasons: canonicalReasons(
      result.reasons.flatMap((reason) => {
        const aggregateSupplyResponsibility =
          reason.code === "runtime-bridge-materiality-unavailable" &&
          asset.supply.chainDistribution === null
            ? "producer-failed"
            : null;
        const fallbackResponsibility =
          aggregateSupplyResponsibility ??
          V9_LEGACY_RESPONSIBILITY_BY_REASON[reason.code];
        return pillarReasonsForGaps(
          envelope,
          reason.code,
          `control:${reason.path}`,
          aggregateSupplyResponsibility === null
            ? causalGapsForReason(reason)
            : [],
          fallbackResponsibility,
          reason.label,
        );
      }),
    ),
    structuralSignals: result.structuralFailures
      .filter((failure) => failure.binding)
      .map((failure) => structuralSignalFromControl(asset, failure)),
  };
}

function conservativeTrackRecordMonths(launchedAtSec: number | null, asOfSec: number): number {
  if (launchedAtSec === null) return 0;
  const start = new Date(launchedAtSec * 1_000);
  const end = new Date(asOfSec * 1_000);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * Whole months elapsed since a reviewed resolved mint incident, on the same
 * conservative floor convention as {@link conservativeTrackRecordMonths}. An
 * absent fact returns undefined so the decay ladder holds its strictest rung.
 */
function conservativeResolvedIncidentAgeMonths(
  latestResolvedIncidentAtSec: number | null | undefined,
  asOfSec: number,
): number | undefined {
  if (latestResolvedIncidentAtSec == null) return undefined;
  return conservativeTrackRecordMonths(latestResolvedIncidentAtSec, asOfSec);
}

function gapReasonsForStatus(
  asset: V9AssetFactsV3,
  status: V9FactStatusV2,
  envelope: V9ValidatedPolicyEnvelope,
  path: string,
  fallback: V9ReasonCode,
  fallbackResponsibility: V9EvidenceResponsibility = "integration-missing",
): V9PillarReason[] {
  const gaps = status.gapIds.flatMap((gapId) => {
    const gap = asset.gaps.find((candidate) => candidate.gapId === gapId);
    return gap ? [gap] : [];
  });
  if (gaps.length === 0) {
    return [pillarReason(envelope, fallback, path, undefined, fallbackResponsibility)];
  }
  return gaps.flatMap((gap) =>
    pillarReasonsForGaps(
      envelope,
      gap.reasonCode,
      path,
      gaps.filter((candidate) => candidate.reasonCode === gap.reasonCode),
      fallbackResponsibility,
    ),
  );
}

function unresolvedEvidenceReasons(
  asset: V9AssetFactsV3,
  envelope: V9ValidatedPolicyEnvelope,
): V9PillarReason[] {
  return canonicalReasons(
    asset.gaps.map((gap) =>
      pillarReason(
        envelope,
        gap.reasonCode,
        `gap:${gap.ownerDomain}:${gap.path.kind}:${gap.gapId}`,
        gap.message,
        gap.responsibility,
        gap.gapId,
      ),
    ),
  );
}

export function upstreamExitAccessScore(result: V9ExitEvaluationResult): number | null {
  if (result.primaryRouteKey === null) return null;
  return result.routes.find((route) => route.routeKey === result.primaryRouteKey)?.components?.access ?? null;
}

export function upstreamOracleNavScore(
  result: V9EvaluatedAsset,
  envelope: V9ValidatedPolicyEnvelope,
): number | null {
  const localComponentScore = result.control.components.find((component) => component.kind === "oracle")?.score;
  const localScore =
    localComponentScore ?? (result.control.oracleApplicability === "not-applicable" ? 95 : null);
  const oracleRoleInputs = (result.dependencyInputs.roleInputs ?? []).filter(
    (input) => input.role === "oracle-nav",
  );
  if (oracleRoleInputs.length === 0) return localScore;
  const projection = projectV9RoleDependencyPillarLimits(
    { ...result.dependencyInputs, roleInputs: oracleRoleInputs },
    {
      unresolvedMaterialityThreshold:
        envelope.policy.semantic.backing.structural.materialExposureShare,
    },
  ).control;
  if (projection.limit === null) return null;
  return localScore === null ? projection.limit : Math.min(localScore, projection.limit);
}

function applyRoleDependencyProjection(
  pillar: V9PillarEvaluation,
  projection: V9RoleDependencyPillarProjection,
  envelope: V9ValidatedPolicyEnvelope,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
): V9PillarEvaluation {
  if (projection.events.length === 0) return pillar;
  const unavailableAttributions = [
    ...new Map(
      projection.events
        .flatMap((event) =>
          event.unavailableDimensions.flatMap((dimension) =>
            event.upstreamAssetIds.flatMap((upstreamAssetId) => {
              const upstream = evaluatedById.get(upstreamAssetId);
              if (upstream === undefined) {
                return [
                  {
                    causalKey: `${upstreamAssetId}:${dimension}:missing-upstream-evaluation`,
                    responsibility: "integration-missing" as const,
                  },
                ];
              }
              if (dimension === "final") {
                return nrReasonAttributions(upstream.trace).map((attribution) => ({
                  ...attribution,
                  causalKey: `${upstreamAssetId}:${dimension}:${attribution.causalKey}`,
                }));
              }
              const reasons =
                dimension === "backing"
                  ? upstream.scoreInput.pillars.backing.reasons
                  : dimension === "exit" || dimension === "access"
                    ? upstream.scoreInput.pillars.exit.reasons
                    : upstream.scoreInput.pillars.control.reasons;
              return reasons.map((reason) => ({
                causalKey: `${upstreamAssetId}:${dimension}:${reason.code}:${reason.path}`,
                responsibility: reason.responsibility,
              }));
            }),
          ),
        )
        .sort(
          (left, right) =>
            compareText(left.causalKey, right.causalKey) ||
            compareText(left.responsibility, right.responsibility),
        )
        .map((attribution) => [
          `${attribution.causalKey}\u0000${attribution.responsibility}`,
          attribution,
        ]),
    ).values(),
  ];
  const attributions =
    unavailableAttributions.length > 0
      ? unavailableAttributions
      : [
          {
            causalKey: "missing-upstream-attribution",
            responsibility: "integration-missing" as const,
          },
        ];
  if (projection.limit !== null) {
    const reasons =
      projection.unresolvedExposureShare === 0
        ? pillar.reasons
        : canonicalReasons([
            ...pillar.reasons,
            ...attributions.map((attribution) =>
              pillarReason(
                envelope,
                "nonmaterial-dependency-unavailable",
                attributedReasonPath(
                  `dependency:${projection.targetPillar}`,
                  attribution,
                ),
                `The ${projection.targetPillar} dependency has unavailable evidence across ${(
                  projection.unresolvedExposureShare * 100
                ).toFixed(2)}% of the claim; its pillar limit includes the exposure's maximum bounded loss.`,
                attribution.responsibility,
              ),
            ),
          ]);
    return {
      ...pillar,
      score: pillar.score === null ? null : Math.min(pillar.score, projection.limit),
      reasons,
    };
  }
  const unavailableDimensions = uniqueSorted(
    projection.events.flatMap((event) => event.unavailableDimensions),
  );
  return {
    ...pillar,
    score: null,
    evidenceLevel: "insufficient",
    reasons: canonicalReasons([
      ...pillar.reasons,
      ...attributions.map((attribution) =>
        pillarReason(
          envelope,
          "material-dependency-unavailable",
          attributedReasonPath(
            `dependency:${projection.targetPillar}`,
            attribution,
          ),
          `The ${projection.targetPillar} dependency exposure has unavailable ${unavailableDimensions.join(
            ", ",
          )} evidence across ${(projection.unresolvedExposureShare * 100).toFixed(2)}% of the claim.`,
          attribution.responsibility,
        ),
      ),
    ]),
  };
}

function applyRoleDependencyPillarLimits(
  pillars: V9ProductionScoreInput["pillars"],
  resolved: V9ResolvedDependencyInputs,
  envelope: V9ValidatedPolicyEnvelope,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
): V9ProductionScoreInput["pillars"] {
  const projections = resolved.rolePillarProjections;
  return {
    backing: pillars.backing,
    exit: applyRoleDependencyProjection(pillars.exit, projections!.exit, envelope, evaluatedById),
    control: applyRoleDependencyProjection(pillars.control, projections!.control, envelope, evaluatedById),
  };
}

/**
 * A wrapper whose whole backing is one ~100% tracked, rated parent inherits that
 * parent's backing pillar. Missing reserve envelopes retain the reviewed
 * curated/variant path; a present envelope qualifies only when it is one known,
 * verified live exposure matching the sole serial wrapper parent.
 */
function resolveInheritedStablecoinBacking(
  asset: V9AssetFactsBase,
  resolved: V9ResolvedDependencyInputs,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
): V9InheritedStablecoinBacking | undefined {
  if (asset.reserveStatus.applicability.state === "not-applicable") return undefined;
  if (resolved.cycleBlocked) return undefined;
  if (resolved.serial.length + resolved.basket.length !== 1) return undefined;
  const wrapped = resolved.serial.length === 1;
  const upstreamAssetId = wrapped ? resolved.serial[0].upstreamAssetId : resolved.basket[0].upstreamAssetId;
  if (wrapped && resolved.serial[0].blocked) return undefined;
  let weight: number;
  if (asset.reserveExposures.length === 0) {
    // A reviewed curated composition or a declared variant — never a
    // manual-only dependency guess or an unmapped live envelope.
    if (asset.dependencies.source !== "variant" && asset.dependencies.baseSource !== "curated-reserve") {
      return undefined;
    }
    weight = wrapped ? 1 : resolved.basket[0].weight;
  } else {
    if (!wrapped || asset.reserveExposures.length !== 1) return undefined;
    const exposure = asset.reserveExposures[0]!;
    const hasWrapperEdge = asset.dependencies.edges.some(
      (edge) =>
        edge.pathKind === "serial-dependency" &&
        edge.dependencyType === "wrapper" &&
        edge.upstreamAssetId === upstreamAssetId,
    );
    if (
      !hasWrapperEdge ||
      asset.reserveStatus.applicability.state !== "required" ||
      asset.reserveStatus.observationState !== "known" ||
      exposure.provenance !== "live" ||
      exposure.status.applicability.state !== "required" ||
      exposure.status.observationState !== "known" ||
      exposure.trackedAssetId !== upstreamAssetId
    ) {
      return undefined;
    }
    weight = exposure.weight;
  }
  if (weight < V9_WRAPPER_INHERITANCE_MIN_PARENT_WEIGHT) return undefined;
  const parent = evaluatedById.get(upstreamAssetId);
  if (!parent || projectV9EffectiveBackingPillarScore(parent) === null) return undefined;
  if (wrapped && parent.trace.finalScore === null) return undefined;
  return {
    parentAssetId: upstreamAssetId,
    parentBackingScore: projectV9EffectiveBackingPillarScore(parent)!,
    weight: Math.min(1, weight),
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
  inheritedStablecoinBacking: V9InheritedStablecoinBacking | undefined,
): V9WrapperStrategyTier | undefined {
  if (asset.wrapperLocalFacts?.applicability === "wrapper") {
    if (asset.wrapperLocalFacts.form === "pure") return "pure";
    if (asset.wrapperLocalFacts.form === "native-staked") return "staked";
    return "vault";
  }
  if (asset.variantKind === "pure-wrapper") return "pure";
  if (asset.variantKind === "strategy-vault") return "vault";
  if (asset.variantKind === "savings-passthrough" || asset.variantKind === "risk-absorption") return "staked";
  // Fallback to the backing-inheritance tier only when no wrapper form is declared.
  if (asset.variantKind == null && inheritedStablecoinBacking !== undefined) {
    return inheritedStablecoinBacking.tier === "pure" ? "pure" : "vault";
  }
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
): V9PillarReason[] {
  const reasons: V9PillarReason[] = [];
  if (
    asset.dependencies.status.applicability.state === "unresolved" ||
    asset.dependencies.status.observationState !== "known"
  ) {
    reasons.push(
      ...gapReasonsForStatus(
        asset,
        asset.dependencies.status,
        envelope,
        "dependency:envelope",
        "unreviewed-dependency-relationships",
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
  const dependencyStatusGaps = asset.dependencies.status.gapIds.flatMap((gapId) => {
    const gap = asset.gaps.find((candidate) => candidate.gapId === gapId);
    return gap ? [gap] : [];
  });
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
        ...pillarReasonsForGaps(
          envelope,
          "unreviewed-dependency-relationships",
          `dependency:collateral:${dependency.upstreamAssetId}`,
          dependencyStatusGaps,
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

function pegInput(asset: V9AssetFactsV3, envelope: V9ValidatedPolicyEnvelope): V9ProductionScoreInput["peg"] {
  const applicable = asset.peg.status.applicability.state !== "not-applicable";
  const reasons =
    applicable && asset.peg.status.observationState !== "known"
      ? gapReasonsForStatus(asset, asset.peg.status, envelope, `peg:${asset.peg.pegKey}`, "missing-peg-input")
      : [];
  return {
    applicable,
    score: applicable ? asset.peg.pegScore : null,
    activeDepegBps: applicable && asset.peg.activeDepeg === true ? asset.peg.activeDepegBps : null,
    reasons: canonicalReasons(reasons),
  };
}

function parentInput(
  asset: V9AssetFactsV3,
  inputs: V9ResolvedDependencyInputs,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
  wrapperTier: V9WrapperStrategyTier | undefined,
  envelope: V9ValidatedPolicyEnvelope,
): V9ProductionScoreInput["parent"] {
  const required = inputs.serial.length > 0 || inputs.cycleBlocked;
  const availableScores = inputs.serial.flatMap((dependency) =>
    dependency.blocked || dependency.score === null ? [] : [dependency.score],
  );
  const rawScore =
    !required || inputs.cycleBlocked || availableScores.length !== inputs.serial.length
      ? null
      : Math.min(...availableScores);
  const propagatedReasons = inputs.serial.flatMap((dependency) => {
    const upstream = evaluatedById.get(dependency.upstreamAssetId);
    return (upstream?.trace.nrReasons ?? []).map((reason) => ({
      ...reason,
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
      propagatedAdverseAttribution,
      propagatedBoundedUncertaintyAttribution,
      wrapperParentLimit: null,
    };
  }
  const expectedForm: V9WrapperForm =
    wrapperTier === "pure" ? "pure" : wrapperTier === "staked" ? "native-staked" : "strategy-vault";
  if (asset.wrapperLocalFacts.applicability !== "wrapper") {
    throw new Error(`Safety Score v9 ${asset.assetId} wrapper parent lacks wrapper-local facts`);
  }
  if (asset.wrapperLocalFacts.form !== expectedForm) {
    throw new Error(
      `Safety Score v9 ${asset.assetId} wrapper form ${asset.wrapperLocalFacts.form} disagrees with ${expectedForm}`,
    );
  }
  const fallback = envelope.policy.semantic.formula.wrapperStrategyCap;
  const wrapperLimit = resolveV9WrapperParentLimit({
    parentScore: rawScore,
    localFacts: asset.wrapperLocalFacts,
    fallbackDiscounts: {
      pure: fallback.pure,
      "native-staked": fallback.staked,
      "strategy-vault": fallback.vault,
    },
  });
  const cMinusFloor =
    envelope.policy.semantic.formula.gradeThresholds.find((threshold) => threshold.grade === "C-")?.minScore;
  if (cMinusFloor === undefined) {
    throw new Error("Safety Score v9 policy has no C- grade threshold");
  }
  const parentItselfExplainsLowGrade = rawScore < cMinusFloor;
  return {
    required,
    score: decimalSnap(wrapperLimit.limit),
    propagatedReasons,
    propagatedAdverseAttribution:
      parentItselfExplainsLowGrade ? propagatedAdverseAttribution : [],
    propagatedBoundedUncertaintyAttribution:
      parentItselfExplainsLowGrade
        ? propagatedBoundedUncertaintyAttribution
        : [],
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
  const cdpReview = asset.mechanismRiskReview.review?.archetype === "cdp" ? asset.mechanismRiskReview.review : null;
  const liquidationCapacitySelection =
    asset.archetype === "cdp"
      ? selectV9CdpLiquidationCapacity(
          asset.assetId,
          cdpReview,
          asset.cdpStressCoverage,
          envelope,
          identity.asOfSec,
        )
      : undefined;
  const inheritedStablecoinBacking = resolveInheritedStablecoinBacking(asset, resolved, evaluatedById);
  const wrapperStrategyTier = resolveV9WrapperStrategyTier(asset, resolved, inheritedStablecoinBacking);
  const trackRecordMonths = conservativeTrackRecordMonths(asset.implementation.launchedAtSec, identity.asOfSec);
  const dependencyStatusGaps = asset.dependencies.status.gapIds.flatMap((gapId) => {
    const gap = asset.gaps.find((candidate) => candidate.gapId === gapId);
    return gap ? [gap] : [];
  });
  const backingAsset = {
    assetId: asset.assetId,
    reserveStatus: asset.reserveStatus,
    reserveExposures: asset.reserveExposures,
    gaps: asset.gaps,
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
    trackRecordMonths,
  };
  const backing =
    asset.mechanismRiskReview.review === null
      ? createUnavailableV9BackingResult(backingAsset, asset, envelope)
      : evaluateV9Backing(backingAsset, asset.mechanismRiskReview.review, envelope);
  const control = evaluateV9EconomicControlAssetFacts(
    asset,
    {
      assetId: asset.assetId,
      trackRecordMonths,
      ...asset.economicControlReview,
      ...(() => {
        const ageMonths = conservativeResolvedIncidentAgeMonths(
          asset.economicControlReview.mint.latestResolvedIncidentAtSec,
          identity.asOfSec,
        );
        return ageMonths === undefined ? {} : { resolvedIncidentAgeMonths: ageMonths };
      })(),
    },
    envelope,
  );
  const access = evaluateV9AccessPosture({
    policy: envelope,
    facts: asset,
    transfer: asset.accessReview.transfer,
    freezeReviews: asset.accessReview.freeze.reviews,
  });
  const peg = pegInput(asset, envelope);
  const backingPillarEvaluation = backingPillar(asset, backing, envelope);
  const controlPillarEvaluation = controlPillar(asset, control, envelope);
  // The exit pillar's SIM-EXIT-L2 undisclosed-fee credit is withheld from an
  // asset already held down by a non-exit adverse fact. The gate reads the same
  // structural-signal set the scorer assembles (backing + control + dependency;
  // the exit pillar itself contributes none) plus the measured peg, so the exit
  // credit never feeds back into the pre-exit gate that governs it.
  const preExitDangerHeld = hasV9PreExitDangerSignal(
    {
      structuralSignals: [
        ...backingPillarEvaluation.structuralSignals,
        ...controlPillarEvaluation.structuralSignals,
        ...dependencySignals,
      ],
      pegScore: peg.score,
      pegApplicable: peg.applicable,
      activeDepegBps: peg.activeDepegBps,
    },
    envelope,
  );
  const exit = evaluateV9ExitAssetFacts(asset, envelope, preExitDangerHeld);
  const basePillars = {
    backing: backingPillarEvaluation,
    exit: exitPillar(
      asset,
      exit,
      envelope,
    ),
    control: controlPillarEvaluation,
  };
  const methodologyReasons =
    asset.implementation.launchedAtSec === null
      ? gapReasonsForStatus(
          asset,
          asset.implementation.status,
          envelope,
          "methodology:implementation-date",
          "missing-implementation-date",
        )
      : [];
  const dependencyReasonsInput = dependencyReasons(
    asset,
    resolved,
    dependencyPlan,
    envelope,
    evaluatedById,
  );
  const measuredMarketDepth = measuredOperationalMarketDepth(asset, exit, envelope);
  const implementationHistory =
    asset.implementation.status.observationState === "known" &&
    asset.implementation.launchedAtSec !== null
      ? {
          minimumLiveHistoryMonths: trackRecordMonths,
          evidenceRefIds: asset.implementation.status.evidenceRefIds,
        }
      : null;
  const operationalResilience =
    (asset.operationalResilience === null || asset.operationalResilience === undefined) &&
    measuredMarketDepth === null
      ? null
      : evaluateV9OperationalResilience(
          asset.operationalResilience ?? null,
          measuredMarketDepth,
          envelope.policy.semantic.operationalResilience,
          operationalResilienceBlockers(
            resolved,
            basePillars,
            peg,
            dependencyReasonsInput,
            dependencySignals,
            methodologyReasons,
            envelope,
          ),
          implementationHistory,
        );
  const creditedPillars = applyOperationalResilienceCredits(basePillars, operationalResilience);
  const pillars = applyRoleDependencyPillarLimits(creditedPillars, resolved, envelope, evaluatedById);
  const scoreInput: V9ProductionScoreInput = {
    assetId: asset.assetId,
    marketRank,
    identity,
    pillars,
    peg,
    trackRecordMonths,
    parent: parentInput(
      asset,
      resolved,
      evaluatedById,
      wrapperStrategyTier,
      envelope,
    ),
    dependencyReasons: dependencyReasonsInput,
    dependencyStructuralSignals: dependencySignals,
    methodologyReasons,
    unresolvedEvidence: unresolvedEvidenceReasons(asset, envelope),
    operationalResilience,
  };
  const trace = scoreV9EvaluatedAsset(scoreInput, envelope);
  const unavailabilityRoots = resolveUnavailabilityRoots(
    asset,
    resolved,
    trace,
    unavailabilityRootsById,
  );
  const stressState = buildV9RetainedStressState(scoreInput, {
    circulatingUsd: asset.supply.status.observationState === "known" ? asset.supply.circulatingUsd : null,
    portfolioStatus:
      asset.exitStatus.observationState === "known" && asset.exitStatus.applicability.state === "required"
        ? "reviewed-complete"
        : "incomplete",
    routes: asset.exitRoutes.map(projectV9ExitEvaluationRoute),
  });
  return {
    evaluatedAsset: {
      assetId: asset.assetId,
      backing,
      exit,
      control,
      access,
      dependencyInputs: resolved,
      scoreInput,
      trace,
      compactTrace: projectCompactV9ScoreTrace(trace),
      stressState,
      operationalResilience,
      ...(liquidationCapacitySelection === undefined ? {} : { liquidationCapacitySelection }),
    },
    unavailabilityRoots,
  };
}
