import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "../../data/safety-score-v9/evaluation-build-manifest-v1";
import type {
  CompiledV9FactSetV2,
  CompiledV9FactSetV3,
  V9AssetFactsV2,
  V9AssetFactsV3,
  V9EvidenceResponsibility,
  V9FactStatusV2,
  V9FailureDomainRef,
} from "../../types/safety-score-v9-facts";
import type {
  V9EvidenceLevel,
  V9ReasonCode,
  V9Severity,
  V9StructuralSignal,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import { isDexMeasuredExecutionObservationHistoryMature } from "../../types/measured-execution";
import { resolveChainId } from "../chains";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { evaluateV9AccessPosture, type V9AccessPostureResult } from "./access-posture";
import {
  createUnavailableV9BackingResult,
  isV9MaterialShare,
  V9_WRAPPER_INHERITANCE_MIN_PARENT_WEIGHT,
  type V9BackingResult,
  type V9CdpLiquidationCapacitySelection,
  type V9InheritedStablecoinBacking,
  type V9ResolvedUpstreamExposure,
} from "./backing";
import { evaluateV9Backing } from "./archetypes";
import { selectV9CdpLiquidationCapacity } from "./archetypes/cdp";
import { evaluateV9EconomicControlAssetFacts, type V9EconomicControlResult } from "./control";
import { assertV9FactSetCompiledInProcess } from "./compile";
import {
  buildV9DependencyEvaluationPlan,
  projectV9RoleDependencyPillarLimits,
  resolveV9DependencyInputs,
  type V9CommonModeMember,
  type V9DependencyEvaluationPlan,
  type V9DependencyPathPlan,
  type V9ResolvedDependencyInputs,
  type V9RoleDependencyPillarProjection,
} from "./dependencies";
import {
  evaluateV9ExitAssetFacts,
  projectV9ExitEvaluationRoute,
  resolveV9DistinctExitCapacity,
  type V9ExitEvaluationResult,
  type V9ExitStressRequest,
} from "./exit";
import {
  isV9RepresentationGroupRoute,
  isV9UncanonicalizedChainPoolRoute,
  readCompiledV9FactSetForEvaluation,
  V9_LEGACY_RESPONSIBILITY_BY_REASON,
  type V9EvaluationFactSetRead,
} from "./facts";
import {
  decimalSnap,
  hasV9PreExitDangerSignal,
  type V9PillarAdverseAttribution,
} from "./formula";
import {
  evaluateV9OperationalResilience,
  type V9OperationalResilienceBlockers,
  type V9OperationalResilienceMeasuredMarketDepth,
  type V9OperationalResilienceResult,
} from "./operational-resilience";
import { assertV9ValidatedPolicyEnvelope, resolveV9ReasonPolicy } from "./policy";
import { compareText, deepFreeze } from "./primitives";
import {
  resolveV9WrapperParentLimit,
  type V9WrapperForm,
} from "./wrapper-risk";
import {
  resolveV9SerialParentAdverseAttribution,
  resolveV9SerialParentBoundedUncertaintyAttribution,
  projectV9DependencyScore,
  scoreV9EvaluatedAsset,
  type V9PillarEvaluation,
  type V9PillarReason,
  type V9ProductionScoreInput,
  type V9ProductionScoreTrace,
} from "./score";
import { createV9PublicStressState, type V9PublicStressState } from "./stress";
import { computeV9ResultDigest, projectCompactV9ScoreTrace, type V9CompactScoreTrace } from "./trace";

const V9_EVALUATED_SET_DIGEST_DOMAIN = "safety-score-v9.evaluated-set.v2";

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
  stressState: V9PublicStressState;
  operationalResilience: V9OperationalResilienceResult | null;
  liquidationCapacitySelection?: V9CdpLiquidationCapacitySelection;
}

export interface V9EvaluatedSet {
  schemaVersion: 1;
  factSetDigest: string;
  baseInputGenerationId: string;
  policyId: string;
  policyDigest: string;
  evaluationBuildDigest: string;
  asOfSec: number;
  sourceGenerations: Readonly<Record<string, string>>;
  dependencyPlan: Readonly<V9DependencyEvaluationPlan>;
  evaluationOrder: readonly string[];
  assets: readonly V9EvaluatedAsset[];
  scoreResultDigest: string;
  evaluatedSetDigest: string;
}

/** Post-credit backing quality inherited by baskets and wrapper parents. */
export function projectV9EffectiveBackingPillarScore(
  result: Pick<V9EvaluatedAsset, "scoreInput">,
): number | null {
  return result.scoreInput.pillars.backing.score;
}

function marketRankByAsset(
  assets: readonly V9AssetFactsV3[],
  activeAssetIds: readonly string[],
): ReadonlyMap<string, number> {
  const active = new Set(activeAssetIds);
  const ranked = assets
    .filter(
      (asset) =>
        active.has(asset.assetId) &&
        asset.supply.status.observationState === "known" &&
        asset.supply.circulatingUsd !== null,
    )
    .map((asset) => ({
      assetId: asset.assetId,
      circulatingUsd: asset.supply.circulatingUsd!,
    }))
    .sort(
      (left, right) =>
        right.circulatingUsd - left.circulatingUsd ||
        compareText(left.assetId, right.assetId),
    );
  const result = new Map<string, number>();
  let previousSupply: number | null = null;
  let rank = 0;
  ranked.forEach((asset, index) => {
    if (previousSupply === null || asset.circulatingUsd !== previousSupply) {
      rank = index + 1;
      previousSupply = asset.circulatingUsd;
    }
    result.set(asset.assetId, rank);
  });
  return result;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

function domainKey(domain: V9FailureDomainRef): string {
  return `${domain.kind}:${domain.key}`;
}

function canonicalDomains(domains: readonly V9FailureDomainRef[]): V9FailureDomainRef[] {
  return [...new Map(domains.map((domain) => [domainKey(domain), domain])).values()].sort((left, right) =>
    compareText(domainKey(left), domainKey(right)),
  );
}

function deploymentExposureKey(deploymentKeys: readonly string[]): string {
  const keys = uniqueSorted(deploymentKeys);
  if (keys.length === 0) throw new Error("Safety Score v9 deployment exposure identity requires a deployment key");
  return `deployment-slice:${keys.join("+")}`;
}

function deploymentRiskEventKey(kind: string, failureDomainKeys: readonly string[]): string {
  const keys = uniqueSorted(failureDomainKeys);
  if (keys.length === 0) throw new Error("Safety Score v9 deployment risk event requires a failure domain");
  return `deployment-event:${kind}:${keys.join("+")}`;
}

function sourceGenerations(factSet: CompiledV9FactSetV3): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(factSet.sourceFingerprints)
      .sort(([left], [right]) => compareText(left, right))
      .map(([source, identity]) => [source, identity.generationId]),
  );
}

function pillarReason(
  envelope: V9ValidatedPolicyEnvelope,
  code: V9ReasonCode,
  path: string,
  message?: string,
  responsibility: V9EvidenceResponsibility = "measured-adverse",
): V9PillarReason {
  return {
    code,
    path,
    message: message ?? resolveV9ReasonPolicy(envelope, code).reason.publicLabel,
    responsibility,
  };
}

function canonicalReasons(reasons: readonly V9PillarReason[]): V9PillarReason[] {
  const normalized = [
    ...new Map(
      [...reasons]
        .sort(
          (left, right) =>
            compareText(left.code, right.code) ||
            compareText(left.path, right.path) ||
            compareText(left.message, right.message) ||
            compareText(left.responsibility, right.responsibility),
        )
        .map((reason) => [
          `${reason.code}\u0000${reason.path}\u0000${reason.message}\u0000${reason.responsibility}`,
          reason,
        ]),
    ).values(),
  ];
  const byPublicIdentity = new Map<string, V9PillarReason>();
  for (const reason of normalized) {
    const key = `${reason.code}\u0000${reason.path}`;
    const existing = byPublicIdentity.get(key);
    if (existing !== undefined && existing.responsibility !== reason.responsibility) {
      throw new Error(
        `Safety Score v9 reason ${reason.code} at ${reason.path} has multiple causal owners; ` +
          "emit distinct causal paths instead of changing public identity by responsibility",
      );
    }
    if (existing === undefined) byPublicIdentity.set(key, reason);
  }
  return [...byPublicIdentity.values()].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path, right.path) ||
      compareText(left.message, right.message) ||
      compareText(left.responsibility, right.responsibility),
  );
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
  sourceSchemaVersion: V9EvaluationFactSetRead["sourceSchemaVersion"],
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
          sourceSchemaVersion === 3 &&
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
      ),
    ),
  );
}

/** A reviewed bridge tier as carried by the fact set's bridge-route review. */
type V9BridgeRouteTier = V9AssetFactsV2["economicControlReview"]["bridge"]["routes"][number]["tier"];

export interface V9ConservativeShareBounds {
  lower: number;
  upper: number;
}

export interface V9BridgeDomainExposure {
  shareBounds: V9ConservativeShareBounds;
  reviewedTiers: readonly V9BridgeRouteTier[];
  reviewedTiersComplete: boolean;
}

/**
 * The per-asset evidence the common-mode grader keys severity off, by domain
 * kind. The dependency plan remains identity-only; DEX and bridge materiality is
 * derived here from the asset's exact fact set.
 */
export interface V9SupplyChainExposure {
  shareBySlug: ReadonlyMap<string, number>;
  unattributedShare: number;
  /**
   * Reviewed or conservatively pooled supply with no destination-chain split.
   * The legacy field name is retained for evaluator/test compatibility.
   */
  unmatchedChainLabelPoolShare: number;
  complete: boolean;
}
export interface V9CommonModeContext {
  supplyExposure: V9SupplyChainExposure;
  dexExposureByDomain: ReadonlyMap<string, V9ConservativeShareBounds>;
  bridgeExposureByDomain: ReadonlyMap<string, V9BridgeDomainExposure>;
}

export interface V9MintControlGroupIssuerFacts {
  controllerIssuerKey: string | null;
  members: readonly {
    assetId: string;
    pathKey: string;
    assetIssuerKey: string | null;
  }[];
}

/**
 * Reshape-v2 D2 (owner ruling 2026-07-21): a mint/upgrade-control domain whose
 * key is a tracked asset (`asset:<id>`) IS that asset acting as controller. For
 * a member whose serial-claim parent is exactly that asset the relationship is
 * definitional — the parent/wrapper cap already prices the inheritance — so the
 * shared-controller signal defers to it (diagnostic). Non-child members keep
 * the group severity; non-asset domains (safe/eoa/program keys) never match.
 */
export function v9ControlAssetDomainId(failureDomain: V9FailureDomainRef): string | null {
  return (failureDomain.kind === "mint-control" || failureDomain.kind === "upgrade-control") &&
    failureDomain.key.startsWith("asset:")
    ? failureDomain.key.slice("asset:".length)
    : null;
}

export function isV9ParentControlledCommonModeMember(
  assetId: string,
  controlAssetDomainId: string | null,
  serialPaths: readonly V9DependencyPathPlan[],
): boolean {
  return (
    controlAssetDomainId !== null &&
    serialPaths.some(
      (path) =>
        path.assetId === assetId && path.role === "serial-claim" && path.upstreamAssetId === controlAssetDomainId,
    )
  );
}

/**
 * A controller's native asset does not depend on products that reuse its
 * controller. Exact serial children also defer to their parent cap, while
 * unrelated products remain exposed to the shared controller.
 */
export function isV9ControllerOwnedCommonModeMember(
  assetId: string,
  controllerAssetId: string | null,
  serialPaths: readonly V9DependencyPathPlan[],
): boolean {
  return (
    controllerAssetId !== null &&
    (assetId === controllerAssetId ||
      isV9ParentControlledCommonModeMember(assetId, controllerAssetId, serialPaths))
  );
}

/** Same-issuer mint groups are diagnostic; every unresolved or crossed join fails closed. */
export function resolveV9MintControlGroupSeverity(group: V9MintControlGroupIssuerFacts): V9Severity {
  if (group.controllerIssuerKey === null || group.members.length === 0) return "high";
  return group.members.every(
    (member) => member.assetIssuerKey !== null && member.assetIssuerKey === group.controllerIssuerKey,
  )
    ? "low"
    : "high";
}

const SUPPLY_USD_RECONCILIATION_TOLERANCE = 0.01;
const SHARE_RECONCILIATION_TOLERANCE = 0.000001;

function clampShare(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function boundedPooledChainShare(supply: V9AssetFactsV2["supply"]): number {
  return supply.selectedBridgeRoutes.reduce(
    (sum, route) =>
      sum +
      (isV9UncanonicalizedChainPoolRoute(route.deploymentRouteKey) ||
      isV9RepresentationGroupRoute(route.deploymentRouteKey)
        ? route.supplyShare
        : 0),
    0,
  );
}

function summarizeSupplyChainExposure(supply: V9AssetFactsV2["supply"]): V9SupplyChainExposure {
  const poolShare = boundedPooledChainShare(supply);
  if (!isKnownRequiredStatus(supply.status)) {
    return {
      shareBySlug: new Map<string, number>(),
      unattributedShare: 1,
      unmatchedChainLabelPoolShare: poolShare,
      complete: false,
    };
  }
  if (supply.chainDistribution === null || supply.chainDistribution === undefined) {
    return {
      shareBySlug: new Map<string, number>(),
      unattributedShare: 1,
      unmatchedChainLabelPoolShare: poolShare,
      complete: false,
    };
  }
  const circulatingUsd = supply.circulatingUsd;
  const distributedUsd =
    supply.chainDistribution.chains.reduce((sum, row) => sum + row.supplyUsd, 0) +
    supply.chainDistribution.unattributedSupplyUsd;
  const distributedShare =
    supply.chainDistribution.chains.reduce((sum, row) => sum + row.supplyShare, 0) +
    supply.chainDistribution.unattributedSupplyShare;
  const expectedShare = circulatingUsd !== null && circulatingUsd > 0 ? 1 : 0;
  if (
    circulatingUsd === null ||
    Math.abs(distributedUsd - circulatingUsd) > SUPPLY_USD_RECONCILIATION_TOLERANCE ||
    Math.abs(distributedShare - expectedShare) > SHARE_RECONCILIATION_TOLERANCE
  ) {
    return {
      shareBySlug: new Map<string, number>(),
      unattributedShare: 1,
      unmatchedChainLabelPoolShare: poolShare,
      complete: false,
    };
  }
  const shareBySlug = new Map<string, number>();
  for (const row of supply.chainDistribution.chains) {
    const chainId = resolveChainId(row.chainId) ?? row.chainId.toLowerCase();
    // Retained facts can contain pre-canonical aliases. Ambiguous rows must not
    // be merged silently because that could understate a material chain share.
    if (shareBySlug.has(chainId)) {
      return {
        shareBySlug: new Map<string, number>(),
        unattributedShare: 1,
        unmatchedChainLabelPoolShare: poolShare,
        complete: false,
      };
    }
    shareBySlug.set(chainId, row.supplyShare);
  }
  return {
    shareBySlug,
    unattributedShare: supply.chainDistribution.unattributedSupplyShare,
    unmatchedChainLabelPoolShare: poolShare,
    complete: true,
  };
}

function referenceExitRequest(envelope: V9ValidatedPolicyEnvelope): V9ExitStressRequest {
  const request = envelope.policy.semantic.exit.stressRequest;
  return {
    requestedNotionalUsd: request.referenceNotionalUsd,
    maxCostBps: request.maxCostBps,
    comparisonWindowSec: request.settlementHorizonSec,
    rawSupplyRequestUsd: request.referenceNotionalUsd,
  };
}

function measuredOperationalMarketDepth(
  asset: V9AssetFactsV3,
  exit: V9ExitEvaluationResult,
  envelope: V9ValidatedPolicyEnvelope,
): V9OperationalResilienceMeasuredMarketDepth | null {
  const request = exit.stressRequest;
  if (request === null) return null;
  const measuredRoutes = asset.exitRoutes.filter(
    (route) =>
      route.lane === "dex" &&
      route.evidenceKind === "measured-executable-depth" &&
      route.status.observationState === "known" &&
      route.scoreEligible &&
      route.observationHistory !== null &&
      route.observationHistory !== undefined,
  );
  const distinctCapacity = resolveV9DistinctExitCapacity(
    measuredRoutes.map(projectV9ExitEvaluationRoute),
    request,
    envelope,
  );
  const includedRouteKeys = new Set(distinctCapacity.includedRouteKeys);
  const includedRoutes = measuredRoutes.filter((route) => includedRouteKeys.has(route.routeKey));
  if (includedRoutes.length === 0) return null;
  return {
    completeProducerCycleCount: Math.min(
      ...includedRoutes.map((route) => route.observationHistory!.completeProducerCycleCount),
    ),
    successfulObservationCount: Math.min(
      ...includedRoutes.map((route) => route.observationHistory!.successfulObservationCount),
    ),
    conservativeCompletionRatio: clampShare(
      distinctCapacity.valuedExecutableUsd / request.requestedNotionalUsd,
    ),
    evidenceRefIds: uniqueSorted(
      includedRoutes.flatMap((route) => [
        ...route.status.evidenceRefIds,
        ...route.settlementEvidenceRefIds,
        ...route.output.status.evidenceRefIds,
        ...(route.output.valuation?.evidenceRefIds ?? []),
      ]),
    ),
  };
}

function operationalResilienceBlockers(
  asset: V9AssetFactsV3,
  resolved: V9ResolvedDependencyInputs,
  pillars: Readonly<Record<"backing" | "exit" | "control", V9PillarEvaluation>>,
  peg: V9ProductionScoreInput["peg"],
  dependencyReasonsInput: readonly V9PillarReason[],
  dependencySignals: readonly V9StructuralSignal[],
  methodologyReasons: readonly V9PillarReason[],
  envelope: V9ValidatedPolicyEnvelope,
): V9OperationalResilienceBlockers {
  const pillarSignals = [
    ...pillars.backing.structuralSignals,
    ...pillars.exit.structuralSignals,
    ...pillars.control.structuralSignals,
  ];
  const scoreBearingReasons = [
    ...pillars.backing.reasons,
    ...pillars.exit.reasons,
    ...pillars.control.reasons,
    ...peg.reasons,
    ...dependencyReasonsInput,
    ...methodologyReasons,
  ];
  const issuerOpacity = scoreBearingReasons.some((reason) => {
    if (reason.responsibility !== "issuer-undisclosed") return false;
    // Visibility-only diagnostics do not reduce a pillar, impose a ceiling, or
    // make the score unavailable. Treating one as material issuer opacity
    // would let an immaterial disclosure gap erase independently documented
    // operating history. Pillar, ceiling, and NR reasons remain blockers.
    return resolveV9ReasonPolicy(envelope, reason.code).reason.defaultTreatment !== "diagnostic";
  });
  const globalReserveImpairment = pillarSignals.some(
    (signal) =>
      (signal.economicLossScope === "reserve-claim" || signal.economicLossScope === "global-claim") &&
      ((signal.kind === "unsafe-backing" && signal.severity !== "low") || signal.severity === "critical"),
  );
  const criticalControlFailure = pillars.control.structuralSignals.some(
    (signal) =>
      signal.severity === "critical" &&
      (signal.kind === "active-control-incident" || signal.economicLossScope === "global-claim"),
  );
  const criticalDependency =
    resolved.cycleBlocked ||
    resolved.serial.some((dependency) => dependency.blocked) ||
    dependencySignals.some((signal) => signal.severity === "critical");
  return {
    activeDepeg: peg.activeDepegBps !== null && peg.activeDepegBps > 0,
    globalReserveImpairment,
    criticalControlFailure,
    criticalDependency,
    issuerOpacity,
  };
}

function applyOperationalResilienceCredits(
  pillars: Readonly<Record<"backing" | "exit" | "control", V9PillarEvaluation>>,
  result: V9OperationalResilienceResult | null,
): V9ProductionScoreInput["pillars"] {
  if (result === null) return pillars;
  return {
    backing: {
      ...pillars.backing,
      score:
        pillars.backing.score === null
          ? null
          : Math.min(100, pillars.backing.score + result.pillarCredits.backing),
    },
    exit: {
      ...pillars.exit,
      score:
        pillars.exit.score === null
          ? null
          : Math.min(100, pillars.exit.score + result.pillarCredits.exit),
    },
    control: {
      ...pillars.control,
      score:
        pillars.control.score === null
          ? null
          : Math.min(100, pillars.control.score + result.pillarCredits.control),
    },
  };
}

function upstreamExitAccessScore(result: V9ExitEvaluationResult): number | null {
  if (result.primaryRouteKey === null) return null;
  return result.routes.find((route) => route.routeKey === result.primaryRouteKey)?.components?.access ?? null;
}

function upstreamOracleNavScore(
  result: V9EvaluatedAsset,
  envelope: V9ValidatedPolicyEnvelope,
): number | null {
  const localScore = result.control.components.find((component) => component.kind === "oracle")?.score ?? null;
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
  const projections =
    resolved.rolePillarProjections ??
    projectV9RoleDependencyPillarLimits(resolved, {
      unresolvedMaterialityThreshold:
        envelope.policy.semantic.backing.structural.materialExposureShare,
    });
  return {
    backing: pillars.backing,
    exit: applyRoleDependencyProjection(pillars.exit, projections.exit, envelope, evaluatedById),
    control: applyRoleDependencyProjection(pillars.control, projections.control, envelope, evaluatedById),
  };
}

function summarizeDexDomainExposure(
  asset: V9AssetFactsV2 | V9AssetFactsV3,
  envelope: V9ValidatedPolicyEnvelope,
): ReadonlyMap<string, V9ConservativeShareBounds> {
  const request = referenceExitRequest(envelope);
  const dexRoutes = asset.exitRoutes.filter((route) => route.lane === "dex");
  const domains = uniqueSorted(
    dexRoutes
      .filter((route) => route.coverageClass !== "diagnostic")
      .flatMap((route) => route.failureDomains.filter((domain) => domain.kind === "dex-protocol").map(domainKey)),
  );
  return new Map(
    domains.map((key) => {
      const relevantRoutes = dexRoutes.filter(
        (route) =>
          route.coverageClass !== "diagnostic" && route.failureDomains.some((domain) => domainKey(domain) === key),
      );
      const projectedRoutes = relevantRoutes.map(projectV9ExitEvaluationRoute);
      const resolved = resolveV9DistinctExitCapacity(projectedRoutes, request, envelope);
      const lower = clampShare(
        Math.min(request.requestedNotionalUsd, resolved.valuedExecutableUsd) / request.requestedNotionalUsd,
      );
      const completeAndCurrent =
        asset.exitStatus.observationState === "known" &&
        relevantRoutes.length > 0 &&
        relevantRoutes.every((route) => {
          if (
            route.status.observationState !== "known" ||
            !route.scoreEligible ||
            route.coverageClass !== "exact-complete"
          ) {
            return false;
          }
          return resolved.includedRouteKeys.includes(route.routeKey);
        });
      return [key, { lower, upper: completeAndCurrent ? lower : 1 }] as const;
    }),
  );
}

function isKnownRequiredStatus(status: V9FactStatusV2): boolean {
  return status.applicability.state === "required" && status.observationState === "known";
}

function isKnownCommonModeMember(
  member: V9CommonModeMember,
  assetsById: ReadonlyMap<string, V9AssetFactsV3>,
): boolean {
  const asset = assetsById.get(member.assetId);
  if (!asset) return false;
  if (member.owner === "backing") {
    const exposure = asset.reserveExposures.find((candidate) => candidate.exposureKey === member.pathKey);
    return exposure !== undefined && isKnownRequiredStatus(exposure.status);
  }
  if (member.owner === "exit") {
    const route = asset.exitRoutes.find((candidate) => candidate.routeKey === member.pathKey);
    return route !== undefined && isKnownRequiredStatus(route.status);
  }
  if (member.owner === "control") {
    const control = asset.controls.find((candidate) => candidate.controlKey === member.pathKey);
    return control !== undefined && isKnownRequiredStatus(control.status);
  }
  if (member.owner === "dependency") {
    return (
      isKnownRequiredStatus(asset.dependencies.status) &&
      asset.dependencies.edges.some((edge) => edge.edgeKey === member.pathKey)
    );
  }
  if (member.owner === "peg") return isKnownRequiredStatus(asset.peg.status);
  return isKnownRequiredStatus(asset.supply.status);
}

function sharesReconcile(left: number, right: number): boolean {
  return Math.abs(left - right) <= SHARE_RECONCILIATION_TOLERANCE;
}

function bridgeSupplyIsConsistent(supply: V9AssetFactsV2["supply"]): boolean {
  const circulatingUsd = supply.circulatingUsd;
  if (!isKnownRequiredStatus(supply.status) || circulatingUsd === null) return false;
  const { selectedRouteSupplyShare, unknownRouteSupplyShare, unreviewedRouteSupplyShare } = supply;
  if (selectedRouteSupplyShare === null || unknownRouteSupplyShare === null || unreviewedRouteSupplyShare === null) {
    return false;
  }
  const expectedTotalShare = circulatingUsd > 0 ? 1 : 0;
  if (
    !sharesReconcile(
      selectedRouteSupplyShare + unknownRouteSupplyShare + unreviewedRouteSupplyShare,
      expectedTotalShare,
    )
  ) {
    return false;
  }
  const reviewedRowShare = supply.selectedBridgeRoutes
    .filter((route) => route.reviewState === "selected-reviewed")
    .reduce((sum, route) => sum + route.supplyShare, 0);
  const unresolvedRowShare = supply.selectedBridgeRoutes
    .filter((route) => route.reviewState === "selected-unresolved")
    .reduce((sum, route) => sum + route.supplyShare, 0);
  const unmatchedRowShare = supply.selectedBridgeRoutes
    .filter((route) => route.reviewState === "unmatched")
    .reduce((sum, route) => sum + route.supplyShare, 0);
  const carriesExplicitUnmatchedRows = supply.selectedBridgeRoutes.some((route) => route.reviewState === "unmatched");
  if (
    !sharesReconcile(reviewedRowShare, selectedRouteSupplyShare) ||
    !sharesReconcile(unresolvedRowShare, unreviewedRouteSupplyShare) ||
    (carriesExplicitUnmatchedRows && !sharesReconcile(unmatchedRowShare, unknownRouteSupplyShare))
  ) {
    return false;
  }
  return supply.selectedBridgeRoutes.every((route) => {
    if (circulatingUsd === 0) {
      return route.supplyUsd <= 0.01 && route.supplyShare <= SHARE_RECONCILIATION_TOLERANCE;
    }
    return sharesReconcile(route.supplyUsd / circulatingUsd, route.supplyShare);
  });
}

function summarizeBridgeDomainExposure(
  asset: V9AssetFactsV2 | V9AssetFactsV3,
  representationGroupMaterialShareThreshold: number,
): ReadonlyMap<string, V9BridgeDomainExposure> {
  const controlsByKey = new Map(asset.controls.map((control) => [control.controlKey, control]));
  const selectedByDeployment = new Map(
    asset.supply.selectedBridgeRoutes.map((route) => [route.deploymentRouteKey, route]),
  );
  const lowerByDomain = new Map<string, number>();
  const tiersByDomain = new Map<string, Set<V9BridgeRouteTier>>();
  const validJoinedDeployments = new Set<string>();
  const joinedDomainDeployments = new Set<string>();
  const unresolvedDomains = new Set<string>();
  const supplyBridgeDomainKeys: ReadonlySet<string> = new Set(
    asset.supply.failureDomains.filter((domain) => domain.kind === "bridge-route").map(domainKey),
  );
  const domainKeys = new Set(supplyBridgeDomainKeys);
  const bridgeReviewKnown = isKnownRequiredStatus(asset.economicControlReview.bridge.status);
  const supplyConsistent = bridgeSupplyIsConsistent(asset.supply);
  let unresolvedJoin = !bridgeReviewKnown || !supplyConsistent;

  for (const review of asset.economicControlReview.bridge.routes) {
    const control = controlsByKey.get(review.controlKey);
    if (!control) {
      unresolvedJoin = true;
      continue;
    }
    const bridgeDomains = control.failureDomains.filter((domain) => domain.kind === "bridge-route");
    if (bridgeDomains.length === 0) {
      unresolvedJoin = true;
      continue;
    }
    const selected = selectedByDeployment.get(control.deploymentKey);
    const boundedRepresentationGroupMechanism =
      isV9RepresentationGroupRoute(control.deploymentKey) &&
      control.status.applicability.state === "required" &&
      control.status.observationState === "bounded-unknown" &&
      control.authority?.model === "unknown" &&
      control.capSemantics.kind !== "unknown" &&
      control.claimImpairment !== "unknown" &&
      control.economicLossScope === "deployment" &&
      control.materialSupplyShare !== null &&
      control.materialSupplyShare <
        representationGroupMaterialShareThreshold;
    const validControl =
      (isKnownRequiredStatus(control.status) ||
        boundedRepresentationGroupMechanism) &&
      control.controlKind === "bridge" &&
      control.capabilities.includes("bridge-mint");
    const knownZeroExposure =
      bridgeReviewKnown &&
      supplyConsistent &&
      validControl &&
      selected === undefined &&
      control.materialSupplyShare === 0;
    const materialShareConsistent =
      selected !== undefined &&
      control.materialSupplyShare !== null &&
      sharesReconcile(control.materialSupplyShare, selected.supplyShare);
    const validJoin =
      bridgeReviewKnown &&
      supplyConsistent &&
      validControl &&
      selected?.reviewState === "selected-reviewed" &&
      materialShareConsistent;
    if (validJoin) validJoinedDeployments.add(control.deploymentKey);
    for (const domain of bridgeDomains) {
      const key = domainKey(domain);
      domainKeys.add(key);
      if (knownZeroExposure) continue;
      if (!validJoin) {
        unresolvedDomains.add(key);
        continue;
      }
      const tiers = tiersByDomain.get(key) ?? new Set<V9BridgeRouteTier>();
      tiers.add(review.tier);
      tiersByDomain.set(key, tiers);
      const joinedDomainDeployment = `${key}\u0000${control.deploymentKey}`;
      if (!joinedDomainDeployments.has(joinedDomainDeployment)) {
        lowerByDomain.set(key, (lowerByDomain.get(key) ?? 0) + selected.supplyShare);
        joinedDomainDeployments.add(joinedDomainDeployment);
      }
    }
  }

  for (const route of asset.supply.selectedBridgeRoutes) {
    if (
      route.reviewState !== "selected-reviewed" ||
      route.reviewedRouteKind === "native" ||
      validJoinedDeployments.has(route.deploymentRouteKey)
    ) {
      continue;
    }
    const attributableDomain = `bridge-route:${route.deploymentRouteKey}`;
    if (supplyBridgeDomainKeys.has(attributableDomain)) {
      unresolvedDomains.add(attributableDomain);
    } else {
      unresolvedJoin = true;
    }
  }
  const unresolvedShare = supplyConsistent
    ? clampShare(asset.supply.unreviewedRouteSupplyShare! + asset.supply.unknownRouteSupplyShare!)
    : 1;

  return new Map(
    [...domainKeys].sort(compareText).map((key) => {
      const lower = clampShare(lowerByDomain.get(key) ?? 0);
      const upper = unresolvedJoin || unresolvedDomains.has(key) ? 1 : clampShare(lower + unresolvedShare);
      return [
        key,
        {
          shareBounds: { lower, upper },
          reviewedTiers: [...(tiersByDomain.get(key) ?? [])].sort(compareText),
          reviewedTiersComplete: !unresolvedJoin && !unresolvedDomains.has(key),
        },
      ] as const;
    }),
  );
}

function buildCommonModeContext(
  asset: V9AssetFactsV2 | V9AssetFactsV3 | undefined,
  envelope: V9ValidatedPolicyEnvelope,
): V9CommonModeContext {
  // A missing asset fact fails closed: no attributed share, no reviewed tiers.
  if (!asset) {
    return {
      supplyExposure: {
        shareBySlug: new Map<string, number>(),
        unattributedShare: 1,
        unmatchedChainLabelPoolShare: 0,
        complete: false,
      },
      dexExposureByDomain: new Map<string, V9ConservativeShareBounds>(),
      bridgeExposureByDomain: new Map<string, V9BridgeDomainExposure>(),
    };
  }
  return {
    supplyExposure: summarizeSupplyChainExposure(asset.supply),
    dexExposureByDomain: summarizeDexDomainExposure(asset, envelope),
    bridgeExposureByDomain: summarizeBridgeDomainExposure(
      asset,
      Math.min(
        envelope.policy.semantic.materiality
          .deploymentMaterialSharePct / 100,
        envelope.policy.semantic.materiality
          .commonModeShareThreshold,
      ),
    ),
  };
}

/**
 * Grades proportional common-mode domains from reviewed asset-local exposure.
 * Mature ecosystem domains are diagnostic; otherwise proven exposure below 5%
 * is diagnostic, 5%-<10% is moderate, and >=10% or unknown is high. Serial
 * control domains do not enter this proportional path and remain fail-closed.
 */
function venueFamilyKey(key: string): string {
  return key.toLowerCase().replace(/-v\d+$/u, "");
}

function proportionalCommonModeSeverity(
  share: number | null,
  mature: boolean,
  materiality: V9ValidatedPolicyEnvelope["policy"]["semantic"]["materiality"],
): V9Severity {
  if (mature) return "low";
  const high = materiality.commonModeSignal.severity;
  if (share === null) return high;
  if (!isV9MaterialShare(share, materiality.commonModeShareThreshold)) return "low";
  return isV9MaterialShare(share, materiality.commonModeHighShareThreshold) ? high : "moderate";
}

interface V9CommonModeShareInfo {
  share: number | null;
  mature: boolean;
}

// Factored out of commonModeSignalSeverity so the reason-text builder in
// commonModeSignalsByAsset can render the same measured share it graded
// against, instead of re-deriving it. Returns null for domain kinds that
// carry no proportional share (reserve-issuer and the fail-closed defaults).
function commonModeShareForDomain(
  failureDomain: V9FailureDomainRef,
  context: V9CommonModeContext,
  materiality: V9ValidatedPolicyEnvelope["policy"]["semantic"]["materiality"],
): V9CommonModeShareInfo | null {
  switch (failureDomain.kind) {
    case "chain": {
      const chainId = resolveChainId(failureDomain.key) ?? failureDomain.key.toLowerCase();
      // A pooled destination distribution below the common-mode floor is
      // bounded by its exact aggregate share. This covers both unresolved raw
      // provider labels and reviewed representation groups; at or above the
      // floor the full unattributed share remains fail-closed.
      const poolShare = context.supplyExposure.unmatchedChainLabelPoolShare;
      const unattributedAddon =
        poolShare < materiality.commonModeShareThreshold
          ? clampShare(context.supplyExposure.unattributedShare - poolShare)
          : context.supplyExposure.unattributedShare;
      const share = context.supplyExposure.complete
        ? clampShare((context.supplyExposure.shareBySlug.get(chainId) ?? 0) + unattributedAddon)
        : null;
      return { share, mature: materiality.matureChains.includes(chainId) };
    }
    case "dex-protocol":
      return {
        share: context.dexExposureByDomain.get(domainKey(failureDomain))?.upper ?? null,
        // Measured-execution routes carry versioned protocol keys
        // ("uniswap-v3", "pancakeswap-v3"); venue maturity is a property of
        // the venue family, so membership is tested on the version-stripped
        // family key.
        mature: materiality.matureVenues.includes(venueFamilyKey(failureDomain.key)),
      };
    case "bridge-route": {
      const exposure = context.bridgeExposureByDomain.get(domainKey(failureDomain));
      return {
        share: exposure !== undefined && exposure.reviewedTiersComplete ? exposure.shareBounds.upper : null,
        mature: false,
      };
    }
    default:
      return null;
  }
}

export function commonModeSignalSeverity(
  failureDomain: V9FailureDomainRef,
  context: V9CommonModeContext,
  materiality: V9ValidatedPolicyEnvelope["policy"]["semantic"]["materiality"],
): V9Severity {
  if (failureDomain.kind === "reserve-issuer") {
    // Single-obligor exposure is already priced by backing concentration;
    // keep the signal diagnostic (non-capping) to avoid double-counting.
    return "low";
  }
  const shareInfo = commonModeShareForDomain(failureDomain, context, materiality);
  if (!shareInfo) return materiality.commonModeSignal.severity;
  return proportionalCommonModeSeverity(shareInfo.share, shareInfo.mature, materiality);
}

// Renders a materiality share as a percentage string for reason text, e.g.
// 0.1083 -> "10.8%", 0.25 -> "25%".
function formatCommonModeSharePct(share: number): string {
  const rounded = Math.round(share * 1000) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function commonModeEconomicScope(
  kind: V9FailureDomainRef["kind"],
): NonNullable<V9StructuralSignal["economicLossScope"]> {
  if (kind === "dex-protocol") return "access-only";
  if (kind === "chain" || kind === "bridge-route") return "deployment";
  if (kind === "reserve-issuer" || kind === "reserve-custodian") return "reserve-claim";
  return "global-claim";
}

function commonModeReasonQualifier(
  kind: V9FailureDomainRef["kind"],
  severity: V9Severity,
  materiality: V9ValidatedPolicyEnvelope["policy"]["semantic"]["materiality"],
  shareUnavailable: boolean,
): string {
  const lowPct = formatCommonModeSharePct(materiality.commonModeShareThreshold);
  const highPct = formatCommonModeSharePct(materiality.commonModeHighShareThreshold);
  if (kind === "chain") {
    if (severity === "low")
      return `reviewed mature chain or conservative exposure upper bound below ${lowPct}, diagnostic only`;
    if (severity === "moderate") return `conservative non-mature exposure upper bound from ${lowPct} to below ${highPct}`;
    // The unavailable disjunction only applies to the fail-closed case (no
    // reviewed chain inventory); a measured share at or above the high
    // threshold states its own bound instead of reusing that phrasing.
    return shareUnavailable
      ? "chain inventory unavailable, treated at the high-severity floor"
      : `conservative exposure upper bound at or above ${highPct}`;
  }
  if (kind === "dex-protocol") {
    if (severity === "low") return `reviewed mature venue or proven exposure below ${lowPct}, diagnostic only`;
    if (severity === "moderate") return `reviewed non-mature exposure from ${lowPct} to below ${highPct}`;
    return shareUnavailable ? "unknown venue concentration" : `exposure at or above ${highPct}`;
  }
  if (kind === "bridge-route") {
    if (severity === "low") return `proven exposure below ${lowPct}, diagnostic only`;
    if (severity === "moderate") return `reviewed exposure from ${lowPct} to below ${highPct}`;
    return shareUnavailable ? "unknown/unattributed bridge exposure" : `exposure at or above ${highPct}`;
  }
  if (kind === "reserve-issuer") {
    return "single-obligor exposure priced in backing, diagnostic only";
  }
  return severity === "high" ? "shared critical control identity" : "diagnostic";
}

function commonModeSignalsByAsset(
  plan: V9DependencyEvaluationPlan,
  envelope: V9ValidatedPolicyEnvelope,
  assetsById: ReadonlyMap<string, V9AssetFactsV3>,
): ReadonlyMap<string, readonly V9StructuralSignal[]> {
  const materiality = envelope.policy.semantic.materiality;
  const contextByAsset = new Map<string, V9CommonModeContext>();
  const contextFor = (assetId: string): V9CommonModeContext => {
    const cached = contextByAsset.get(assetId);
    if (cached) return cached;
    const context = buildCommonModeContext(assetsById.get(assetId), envelope);
    contextByAsset.set(assetId, context);
    return context;
  };
  const roleScopedDependencyPaths = new Set(
    [...plan.exitPaths, ...plan.controlPaths, ...plan.oracleNavPaths].map(
      (path) => `${path.assetId}\u0000${path.edgeKey}`,
    ),
  );
  const signals = new Map<string, V9StructuralSignal[]>();
  for (const group of plan.commonModeGroups) {
    const unpricedMembers = group.members.filter(
      (member) =>
        member.owner !== "dependency" ||
        !roleScopedDependencyPaths.has(`${member.assetId}\u0000${member.pathKey}`),
    );
    const effectiveMembers =
      group.failureDomain.kind === "dex-protocol"
        ? unpricedMembers.filter((member) => {
            if (member.owner !== "exit") return false;
            const route = assetsById
              .get(member.assetId)
              ?.exitRoutes.find((candidate) => candidate.routeKey === member.pathKey);
            return (
              route?.lane === "dex" &&
              isKnownRequiredStatus(route.status) &&
              route.scoreEligible &&
              route.coverageClass !== "diagnostic" &&
              route.failureDomains.some((domain) => domainKey(domain) === domainKey(group.failureDomain))
            );
          })
        : unpricedMembers;
    const assetIds = uniqueSorted(effectiveMembers.map((member) => member.assetId));
    if (
      assetIds.length < materiality.commonControlMinAssets ||
      effectiveMembers.length < materiality.commonControlMinPaths
    ) {
      continue;
    }
    const key = domainKey(group.failureDomain);
    const mintControlAssessment = (() => {
      // D2 (mint-control) extended by D15 (2026-07-18) to upgrade-control:
      // an issuer's own controller shared across its own products is the
      // issuer itself, not an external dependency. Cross-issuer and
      // unresolved-identity groups still fail closed in
      // resolveV9MintControlGroupSeverity.
      if (group.failureDomain.kind !== "mint-control" && group.failureDomain.kind !== "upgrade-control") return null;
      const members = assetIds.map((assetId) => {
        const assetMembers = effectiveMembers.filter((member) => member.assetId === assetId);
        return {
          assetId,
          pathKey: assetMembers[0]?.pathKey ?? key,
          assetIssuerKey: assetsById.get(assetId)?.assetIssuerKey ?? null,
        };
      });
      let controllerAssetId: string | null = null;
      let controllerAttributionComplete = effectiveMembers.length > 0;
      for (const member of effectiveMembers) {
        const attributedControllerAssetId =
          member.owner === "control"
            ? (assetsById
                .get(member.assetId)
                ?.controls.find((control) => control.controlKey === member.pathKey)
                ?.controllerAssetId ?? null)
            : null;
        if (
          attributedControllerAssetId === null ||
          (controllerAssetId !== null && controllerAssetId !== attributedControllerAssetId)
        ) {
          controllerAttributionComplete = false;
          break;
        }
        controllerAssetId = attributedControllerAssetId;
      }
      // Attribution is usable only when every path names the same controller
      // owner. Retained facts without that field preserve the prior fail-closed
      // member-issuer proxy.
      if (!controllerAttributionComplete) controllerAssetId = null;
      const controllerIssuerKey =
        controllerAssetId === null
          ? (members[0]?.assetIssuerKey ?? null)
          : (assetsById.get(controllerAssetId)?.assetIssuerKey ?? null);
      return {
        controllerAssetId,
        severity: resolveV9MintControlGroupSeverity({
          controllerIssuerKey,
          members,
        }),
        identitiesKnown:
          controllerIssuerKey !== null &&
          members.every((member) => member.assetIssuerKey !== null),
      };
    })();
    const mintControlSeverity = mintControlAssessment?.severity ?? null;
    const memberFactsKnown = effectiveMembers.every((member) =>
      isKnownCommonModeMember(member, assetsById),
    );
    const controlAssetDomainId = v9ControlAssetDomainId(group.failureDomain);
    for (const assetId of assetIds) {
      const parentControlled = isV9ParentControlledCommonModeMember(assetId, controlAssetDomainId, plan.serialPaths);
      const controllerOwned = isV9ControllerOwnedCommonModeMember(
        assetId,
        mintControlAssessment?.controllerAssetId ?? null,
        plan.serialPaths,
      );
      const context = contextFor(assetId);
      const severity = parentControlled || controllerOwned
        ? "low"
        : (mintControlSeverity ?? commonModeSignalSeverity(group.failureDomain, context, materiality));
      // Only the proportional (chain/dex-protocol/bridge-route) domains carry
      // a per-asset measured share; parent-controlled and mint/upgrade-control
      // groups keep their existing group-first phrasing below.
      const shareInfo =
        parentControlled || controllerOwned || mintControlSeverity !== null
          ? null
          : commonModeShareForDomain(group.failureDomain, context, materiality);
      const shareUnavailable = severity === "high" && shareInfo !== null && shareInfo.share === null;
      const qualifier = parentControlled || controllerOwned
        ? assetId === mintControlAssessment?.controllerAssetId
          ? "own controller, downstream reuse creates no reverse dependency, diagnostic only"
          : "own required parent's controller, priced by the parent cap, diagnostic only"
        : mintControlSeverity === "low"
          ? "same-issuer controller, diagnostic only"
          : commonModeReasonQualifier(group.failureDomain.kind, severity, materiality, shareUnavailable);
      const groupClause = `${effectiveMembers.length} reviewed paths across ${assetIds.length} assets share ${key}`;
      // Where the coin's own measured share drives the severity (moderate, or
      // high with a measured — not unavailable — share), lead the reason with
      // that share and demote the cross-asset group trigger to secondary
      // context; readers otherwise misread the group count as the driver.
      const ownShare = severity !== "low" && shareInfo !== null ? shareInfo.share : null;
      const responsibility: V9EvidenceResponsibility =
        shareInfo !== null
          ? shareInfo.share === null
            ? "integration-missing"
            : "measured-adverse"
          : memberFactsKnown &&
              (mintControlAssessment === null || mintControlAssessment.identitiesKnown)
            ? "measured-adverse"
            : "integration-missing";
      const reason =
        ownShare !== null
          ? `This asset's own reviewed share is ${formatCommonModeSharePct(ownShare)} at ${key}, ${qualifier} (also ${groupClause}).`
          : `${groupClause}, ${qualifier}.`;
      const economicLossScope = commonModeEconomicScope(group.failureDomain.kind);
      const localDeploymentKeys = uniqueSorted(
        effectiveMembers
          .filter((member) => member.assetId === assetId && member.owner === "control")
          .flatMap((member) => {
            const control = assetsById
              .get(assetId)
              ?.controls.find((candidate) => candidate.controlKey === member.pathKey);
            return control === undefined ? [] : [control.deploymentKey];
          }),
      );
      const signal: V9StructuralSignal = {
        ...materiality.commonModeSignal,
        severity,
        reason,
        ...(shareInfo?.share === null || shareInfo === null
          ? {}
          : { materialSharePct: shareInfo.share * 100 }),
        economicLossScope,
        ...(economicLossScope === "deployment"
          ? {
              exposureKey:
                localDeploymentKeys.length === 0
                  ? `common-mode-slice:${assetId}:${key}`
                  : deploymentExposureKey(localDeploymentKeys),
              riskEventKey: deploymentRiskEventKey("common-mode", [key]),
            }
          : {}),
        recoveryPath:
          group.failureDomain.kind === "dex-protocol"
            ? "market-substitution"
            : group.failureDomain.kind === "chain" || group.failureDomain.kind === "bridge-route"
              ? "deployment-migration"
              : group.failureDomain.kind === "reserve-issuer" || group.failureDomain.kind === "reserve-custodian"
                ? "unknown"
                : "issuer-remediation",
        expectedRecoverySec: null,
        lossAbsorptionPct: 0,
        responsibility,
        evidenceConfidence: responsibility === "measured-adverse" ? "high" : "low",
        failureDomainKeys: [key],
        evidence: [],
      };
      signals.set(assetId, [...(signals.get(assetId) ?? []), signal]);
    }
  }
  return new Map(
    [...signals].map(([assetId, assetSignals]) => [
      assetId,
      [...assetSignals].sort((left, right) =>
        compareText(left.failureDomainKeys[0] ?? "", right.failureDomainKeys[0] ?? ""),
      ),
    ]),
  );
}

export function projectV9ResolvedBackingExposure(
  exposureKey: string,
  dependency: V9ResolvedDependencyInputs["basket"][number],
  upstream: Pick<V9EvaluatedAsset, "backing" | "scoreInput"> | undefined,
  failureRootAssetIds: readonly string[],
): V9ResolvedUpstreamExposure {
  const backingReasons = canonicalReasons(upstream?.scoreInput.pillars.backing.reasons ?? []);
  const reasons =
    backingReasons.length > 0 &&
    backingReasons.every((reason) => reason.responsibility !== undefined)
      ? backingReasons.map(({ code, path, responsibility }) => ({
          code,
          path,
          responsibility,
        }))
      : undefined;
  return {
    exposureKey,
    upstreamAssetId: dependency.upstreamAssetId,
    score: dependency.score,
    evidenceLevel: upstream?.scoreInput.pillars.backing.evidenceLevel ?? "insufficient",
    reasonCodes: uniqueSorted(backingReasons.map((reason) => reason.code)),
    ...(reasons === undefined ? {} : { reasons }),
    failureDomains: canonicalDomains(upstream?.backing.failureDomains ?? []),
    failureRootAssetIds: uniqueSorted(failureRootAssetIds),
  };
}

function resolvedBackingExposures(
  asset: V9AssetFactsV2 | V9AssetFactsV3,
  dependencyInputs: V9ResolvedDependencyInputs,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
  unavailabilityRootsById: ReadonlyMap<string, readonly string[]>,
): V9ResolvedUpstreamExposure[] {
  const basketByUpstream = new Map(
    dependencyInputs.basket.map((dependency) => [dependency.upstreamAssetId, dependency]),
  );
  // The availability materiality decision lives in backing, which aggregates by
  // the propagated terminal failure roots (VER2-001) under the shared
  // materiality predicate (VER2-010). This projection only carries the roots
  // and evidence; it no longer emits an availability reason code.
  return asset.reserveExposures.flatMap((exposure) => {
    if (exposure.trackedAssetId === null) return [];
    const dependency = basketByUpstream.get(exposure.trackedAssetId);
    if (!dependency) return [];
    const upstream = evaluatedById.get(dependency.upstreamAssetId);
    const unavailable = dependency.score === null;
    const failureRootAssetIds = unavailable
      ? (unavailabilityRootsById.get(dependency.upstreamAssetId) ?? [dependency.upstreamAssetId])
      : [dependency.upstreamAssetId];
    return [projectV9ResolvedBackingExposure(exposure.exposureKey, dependency, upstream, failureRootAssetIds)];
  });
}

/**
 * A wrapper whose whole backing is one ~100% tracked, rated parent inherits that
 * parent's backing pillar. Missing reserve envelopes retain the reviewed
 * curated/variant path; a present envelope qualifies only when it is one known,
 * verified live exposure matching the sole serial wrapper parent.
 */
function resolveInheritedStablecoinBacking(
  asset: V9AssetFactsV2 | V9AssetFactsV3,
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
 *  - `strategy-vault` (a third-party aggregator such as a Yearn/Gauntlet/Steakhouse
 *    vault) → "vault" (the largest haircut): it layers third-party strategy,
 *    smart-contract and liquidity risk over an issuer it does not control.
 *  - `savings-passthrough` / `risk-absorption` (the protocol's OWN native savings
 *    or staking token, e.g. sDAI, sUSDe, scrvUSD) → "staked" (a smaller haircut):
 *    a thinner, same-protocol layer.
 * The registry `variantKind` — threaded onto the compiled facts — is the only
 * signal that separates a third-party vault from a native savings token (issuer
 * key, variantOf and inheritedFrom all collapse to the parent for both). When
 * `variantKind` is absent we fall back to the backing-inheritance tier ("pure" for
 * a 1:1 holding); an unmapped form or a bare serial-wrapper parent takes the
 * conservative "vault" haircut. A serial parent with no wrapper edge (a collateral
 * basket or a "mechanism" serial claim) returns undefined — no discount.
 */
export function resolveV9WrapperStrategyTier(
  asset: V9AssetFactsV2 | V9AssetFactsV3,
  resolved: V9ResolvedDependencyInputs,
  inheritedStablecoinBacking: V9InheritedStablecoinBacking | undefined,
): V9WrapperStrategyTier | undefined {
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

function evaluatedSetDigestPayload(result: Omit<V9EvaluatedSet, "evaluatedSetDigest">) {
  return {
    schemaVersion: result.schemaVersion,
    factSetDigest: result.factSetDigest,
    baseInputGenerationId: result.baseInputGenerationId,
    policyId: result.policyId,
    policyDigest: result.policyDigest,
    evaluationBuildDigest: result.evaluationBuildDigest,
    asOfSec: result.asOfSec,
    sourceGenerations: result.sourceGenerations,
    dependencyPlanDigest: result.dependencyPlan.planDigest,
    evaluationOrder: result.evaluationOrder,
    scoreResultDigest: result.scoreResultDigest,
    assets: result.assets.map((asset) => ({
      compactTrace: asset.compactTrace,
      dependencyInputs: asset.dependencyInputs,
      access: asset.access,
      operationalResilience: asset.operationalResilience,
      wrapperParentLimit: asset.trace.wrapperParentLimit,
      stressStateDigest: asset.stressState.stateDigest,
    })),
  };
}

function evaluateV9FactSetRead(
  factSetRead: V9EvaluationFactSetRead,
  envelope: V9ValidatedPolicyEnvelope,
): Readonly<V9EvaluatedSet> {
  assertV9ValidatedPolicyEnvelope(envelope);
  const factSet = factSetRead.factSet;
  const assetsById = new Map(factSet.assets.map((asset) => [asset.assetId, asset]));
  const marketRanks = marketRankByAsset(factSet.assets, factSet.activeAssetIds);
  const dependencyPlan = buildV9DependencyEvaluationPlan({
    activeAssetIds: factSet.activeAssetIds,
    assets: factSet.assets,
  });
  const commonSignals = commonModeSignalsByAsset(dependencyPlan, envelope, assetsById);
  const evaluatedById = new Map<string, V9EvaluatedAsset>();
  // Terminal unavailable-asset roots per evaluated asset, propagated in
  // topological order: an unavailable asset inherits the union of the roots of
  // its own unavailable upstreams, or is its own root when nothing upstream is
  // unavailable. Backing aggregates materiality by these roots (VER2-001).
  const unavailabilityRootsById = new Map<string, readonly string[]>();
  const identity = {
    factSetDigest: factSetRead.sourceFactSetDigest,
    baseInputGenerationId: factSet.baseInputGenerationId,
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    asOfSec: factSet.asOfSec,
    sourceGenerations: sourceGenerations(factSet),
  };

  for (const assetId of dependencyPlan.topologicalOrder) {
    const asset = assetsById.get(assetId);
    if (!asset) throw new Error(`Safety Score v9 dependency plan references missing asset ${assetId}`);
    const unresolved = resolveV9DependencyInputs(
      dependencyPlan,
      [...evaluatedById.values()].map((result) => ({
        assetId: result.assetId,
        score: projectV9DependencyScore(result.trace),
        backingScore: projectV9EffectiveBackingPillarScore(result),
        exitScore: result.scoreInput.pillars.exit.score,
        accessScore: upstreamExitAccessScore(result.exit),
        controlScore: result.scoreInput.pillars.control.score,
        oracleNavScore: upstreamOracleNavScore(result, envelope),
      })),
    ).find((candidate) => candidate.assetId === assetId);
    if (!unresolved) throw new Error(`Safety Score v9 dependency inputs are missing for ${assetId}`);
    const resolved: V9ResolvedDependencyInputs = {
      ...unresolved,
      rolePillarProjections: projectV9RoleDependencyPillarLimits(unresolved, {
        unresolvedMaterialityThreshold:
          envelope.policy.semantic.backing.structural.materialExposureShare,
      }),
    };

    const cdpReview = asset.mechanismRiskReview.review?.archetype === "cdp" ? asset.mechanismRiskReview.review : null;
    const liquidationCapacitySelection =
      asset.archetype === "cdp"
        ? selectV9CdpLiquidationCapacity(asset.assetId, cdpReview, asset.cdpStressCoverage, envelope, factSet.asOfSec)
        : undefined;
    const inheritedStablecoinBacking = resolveInheritedStablecoinBacking(asset, resolved, evaluatedById);
    const wrapperStrategyTier = resolveV9WrapperStrategyTier(asset, resolved, inheritedStablecoinBacking);
    const trackRecordMonths = conservativeTrackRecordMonths(asset.implementation.launchedAtSec, factSet.asOfSec);
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
          ...(commonSignals.get(assetId) ?? []),
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
        factSetRead.sourceSchemaVersion,
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
    const dependencyReasonsInput = dependencyReasons(asset, resolved, dependencyPlan, envelope, evaluatedById);
    const dependencySignals = commonSignals.get(assetId) ?? [];
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
              asset,
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
      assetId,
      marketRank: marketRanks.get(assetId) ?? null,
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
    const unavailableUpstreamRoots = uniqueSorted(
      [...resolved.basket, ...resolved.serial]
        .filter((dependency) => dependency.score === null)
        .flatMap(
          (dependency) => unavailabilityRootsById.get(dependency.upstreamAssetId) ?? [dependency.upstreamAssetId],
        ),
    );
    unavailabilityRootsById.set(
      assetId,
      trace.finalScore !== null || unavailableUpstreamRoots.length === 0 ? [assetId] : unavailableUpstreamRoots,
    );
    const stressState = createV9PublicStressState(scoreInput, {
      circulatingUsd: asset.supply.status.observationState === "known" ? asset.supply.circulatingUsd : null,
      portfolioStatus:
        asset.exitStatus.observationState === "known" && asset.exitStatus.applicability.state === "required"
          ? "reviewed-complete"
          : "incomplete",
      routes: asset.exitRoutes.map(projectV9ExitEvaluationRoute),
    });
    evaluatedById.set(assetId, {
      assetId,
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
    });
  }

  const assets = [...evaluatedById.values()].sort((left, right) => compareText(left.assetId, right.assetId));
  const core: Omit<V9EvaluatedSet, "evaluatedSetDigest"> = {
    schemaVersion: 1,
    factSetDigest: factSetRead.sourceFactSetDigest,
    baseInputGenerationId: factSet.baseInputGenerationId,
    policyId: envelope.policy.policyId,
    policyDigest: envelope.semanticDigest,
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    asOfSec: factSet.asOfSec,
    sourceGenerations: identity.sourceGenerations,
    dependencyPlan,
    evaluationOrder: dependencyPlan.topologicalOrder,
    assets,
    scoreResultDigest: computeV9ResultDigest(assets.map((asset) => asset.trace)),
  };
  const evaluatedSetDigest = sha256Hex(
    stableJsonStringifyV1({ domain: V9_EVALUATED_SET_DIGEST_DOMAIN, result: evaluatedSetDigestPayload(core) }),
  );
  return deepFreeze({ ...core, evaluatedSetDigest }) as Readonly<V9EvaluatedSet>;
}

/** Evaluate one untrusted compiled active-asset set after strict validation. */
export function evaluateV9FactSet(
  input: CompiledV9FactSetV2 | CompiledV9FactSetV3,
  envelope: V9ValidatedPolicyEnvelope,
): Readonly<V9EvaluatedSet> {
  return evaluateV9FactSetRead(readCompiledV9FactSetForEvaluation(input), envelope);
}

/**
 * Trusted same-process path for a V3 fact set just returned by
 * compileV9FactSetV3(). Stored, replayed, or otherwise external facts must use
 * evaluateV9FactSet() so their schema and digest are verified first.
 */
export function evaluateValidatedV9FactSet(
  factSet: CompiledV9FactSetV3,
  envelope: V9ValidatedPolicyEnvelope,
): Readonly<V9EvaluatedSet> {
  assertV9FactSetCompiledInProcess(factSet);
  return evaluateV9FactSetRead(
    {
      sourceSchemaVersion: 3,
      sourceFactSetDigest: factSet.v9FactSetDigest,
      factSet,
    },
    envelope,
  );
}
