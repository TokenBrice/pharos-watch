import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "../../data/safety-score-v9/evaluation-build-manifest-v1";
import type {
  CompiledV9FactSetV2,
  V9AssetFactsV2,
  V9FactStatusV2,
  V9FailureDomainRef,
} from "../../types/safety-score-v9-facts";
import type {
  V9EvidenceLevel,
  V9ReasonCode,
  V9StructuralSignal,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { evaluateV9AccessPosture, type V9AccessPostureResult } from "./access-posture";
import { createUnavailableV9BackingResult, type V9BackingResult, type V9ResolvedUpstreamExposure } from "./backing";
import { evaluateV9Backing } from "./archetypes";
import { evaluateV9EconomicControlAssetFacts, type V9EconomicControlResult } from "./control";
import {
  buildV9DependencyEvaluationPlan,
  resolveV9DependencyInputs,
  type V9DependencyEvaluationPlan,
  type V9ResolvedDependencyInputs,
} from "./dependencies";
import { evaluateV9ExitAssetFacts, projectV9ExitEvaluationRoute, type V9ExitEvaluationResult } from "./exit";
import { parseCompiledV9FactSetV2 } from "./facts";
import { assertV9ValidatedPolicyEnvelope, resolveV9ReasonPolicy } from "./policy";
import {
  scoreV9EvaluatedAsset,
  type V9PillarEvaluation,
  type V9PillarReason,
  type V9ProductionScoreInput,
  type V9ProductionScoreTrace,
} from "./score";
import { createV9PublicStressState, type V9PublicStressState } from "./stress";
import { computeV9ResultDigest, projectCompactV9ScoreTrace, type V9CompactScoreTrace } from "./trace";

const V9_EVALUATED_SET_DIGEST_DOMAIN = "safety-score-v9.evaluated-set.v1";

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

const SOURCE_KEYS = [
  "registry",
  "dex",
  "redemption",
  "liveReserves",
  "chainSupply",
  "peg",
  "researchOverlays",
] as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sourceGenerations(factSet: CompiledV9FactSetV2): Readonly<Record<string, string>> {
  return Object.fromEntries(SOURCE_KEYS.map((source) => [source, factSet.sourceFingerprints[source].generationId]));
}

function pillarReason(
  envelope: V9ValidatedPolicyEnvelope,
  code: V9ReasonCode,
  path: string,
  message?: string,
): V9PillarReason {
  return {
    code,
    path,
    message: message ?? resolveV9ReasonPolicy(envelope, code).reason.publicLabel,
  };
}

function canonicalReasons(reasons: readonly V9PillarReason[]): V9PillarReason[] {
  return [
    ...new Map(reasons.map((reason) => [`${reason.code}\u0000${reason.path}\u0000${reason.message}`, reason])).values(),
  ].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path, right.path) ||
      compareText(left.message, right.message),
  );
}

function structuralSignalFromBacking(reason: V9BackingResult["structuralReasons"][number]): V9StructuralSignal {
  return {
    kind: reason.kind,
    severity: reason.severity,
    reason: `${reason.kind} condition at ${reason.pathKey}.`,
    ...(reason.materialShare === null ? {} : { materialSharePct: reason.materialShare * 100 }),
    failureDomainKeys: reason.failureDomains.map(domainKey),
    evidence: [],
  };
}

function structuralSignalFromControl(
  failure: V9EconomicControlResult["structuralFailures"][number],
): V9StructuralSignal {
  return {
    kind: failure.kind,
    severity: failure.severity,
    reason: failure.reason,
    ...(failure.materialSharePct === null ? {} : { materialSharePct: failure.materialSharePct }),
    failureDomainKeys: failure.failureDomains.map(domainKey),
    evidence: [],
  };
}

function backingPillar(result: V9BackingResult, envelope: V9ValidatedPolicyEnvelope): V9PillarEvaluation {
  const reasons = canonicalReasons(
    result.unresolved.map((reason) => pillarReason(envelope, reason.code, `backing:${reason.pathKey}`)),
  );
  const evidenceLevel: V9EvidenceLevel =
    result.score === null
      ? "insufficient"
      : result.unresolved.some((reason) => reason.treatment !== "diagnostic")
        ? "limited"
        : "strong";
  return {
    score: result.score,
    evidenceLevel,
    reasons,
    structuralSignals: result.structuralReasons.map(structuralSignalFromBacking),
  };
}

function exitPillar(
  asset: V9AssetFactsV2,
  result: V9ExitEvaluationResult,
  envelope: V9ValidatedPolicyEnvelope,
): V9PillarEvaluation {
  const primary =
    result.primaryRouteKey === null
      ? null
      : (asset.exitRoutes.find((route) => route.routeKey === result.primaryRouteKey) ?? null);
  const primaryStrong =
    primary !== null &&
    primary.status.observationState === "known" &&
    primary.observationConfidence === "high" &&
    envelope.policy.semantic.exit.strongEvidenceKinds.includes(primary.evidenceKind);
  const evidenceLevel: V9EvidenceLevel =
    result.score === null
      ? "insufficient"
      : asset.exitStatus.observationState !== "known"
        ? "limited"
        : primaryStrong
          ? "strong"
          : "adequate";
  return {
    score: result.score,
    evidenceLevel,
    reasons: canonicalReasons(result.reasons.map((code) => pillarReason(envelope, code, `exit:${code}`))),
    structuralSignals: [],
  };
}

function controlPillar(result: V9EconomicControlResult): V9PillarEvaluation {
  return {
    score: result.score,
    evidenceLevel: result.score === null ? "insufficient" : result.reasons.length > 0 ? "limited" : "strong",
    reasons: canonicalReasons(
      result.reasons.map((reason) => ({ code: reason.code, path: `control:${reason.path}`, message: reason.label })),
    ),
    structuralSignals: result.structuralFailures.filter((failure) => failure.binding).map(structuralSignalFromControl),
  };
}

function worstEvidenceLevel(
  pillars: V9ProductionScoreInput["pillars"],
  envelope: V9ValidatedPolicyEnvelope,
): V9EvidenceLevel {
  const rank = envelope.policy.semantic.evidence.rank;
  return [pillars.backing.evidenceLevel, pillars.exit.evidenceLevel, pillars.control.evidenceLevel].sort(
    (left, right) => rank[right] - rank[left],
  )[0]!;
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
  asset: V9AssetFactsV2,
  status: V9FactStatusV2,
  envelope: V9ValidatedPolicyEnvelope,
  path: string,
  fallback: V9ReasonCode,
): V9PillarReason[] {
  const reasons = status.gapIds.flatMap((gapId) => {
    const gap = asset.gaps.find((candidate) => candidate.gapId === gapId);
    return gap ? [pillarReason(envelope, gap.reasonCode, path, gap.message)] : [];
  });
  return reasons.length > 0 ? reasons : [pillarReason(envelope, fallback, path)];
}

function commonModeSignalsByAsset(
  plan: V9DependencyEvaluationPlan,
  envelope: V9ValidatedPolicyEnvelope,
): ReadonlyMap<string, readonly V9StructuralSignal[]> {
  const materiality = envelope.policy.semantic.materiality;
  const signals = new Map<string, V9StructuralSignal[]>();
  for (const group of plan.commonModeGroups) {
    const assetIds = uniqueSorted(group.members.map((member) => member.assetId));
    if (
      assetIds.length < materiality.commonControlMinAssets ||
      group.members.length < materiality.commonControlMinPaths
    ) {
      continue;
    }
    const key = domainKey(group.failureDomain);
    for (const assetId of assetIds) {
      const signal: V9StructuralSignal = {
        ...materiality.commonModeSignal,
        reason: `${group.members.length} reviewed paths across ${assetIds.length} assets share ${key}.`,
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

function resultFailureDomains(result: V9EvaluatedAsset): V9FailureDomainRef[] {
  return canonicalDomains([
    ...result.backing.failureDomains,
    ...result.control.failureDomains,
    ...result.exit.routes.flatMap((route) => {
      if (!route.included) return [];
      const source = result.stressState.exitPortfolio?.routes.find(
        (candidate) => candidate.routeKey === route.routeKey,
      );
      return (
        source?.failureDomains.flatMap((key) => {
          const separator = key.indexOf(":");
          if (separator <= 0) return [];
          return [{ kind: key.slice(0, separator), key: key.slice(separator + 1) } as V9FailureDomainRef];
        }) ?? []
      );
    }),
  ]);
}

function resolvedBackingExposures(
  asset: V9AssetFactsV2,
  dependencyInputs: V9ResolvedDependencyInputs,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
  unavailabilityRootsById: ReadonlyMap<string, readonly string[]>,
  envelope: V9ValidatedPolicyEnvelope,
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
    const unavailable = upstream?.trace.finalScore === null;
    const failureRootAssetIds = unavailable
      ? (unavailabilityRootsById.get(dependency.upstreamAssetId) ?? [dependency.upstreamAssetId])
      : [dependency.upstreamAssetId];
    return [
      {
        exposureKey: exposure.exposureKey,
        upstreamAssetId: dependency.upstreamAssetId,
        score: upstream?.trace.finalScore ?? null,
        evidenceLevel: upstream ? worstEvidenceLevel(upstream.scoreInput.pillars, envelope) : "insufficient",
        reasonCodes: [],
        failureDomains: upstream ? resultFailureDomains(upstream) : [],
        failureRootAssetIds,
      },
    ];
  });
}

function dependencyReasons(
  asset: V9AssetFactsV2,
  inputs: V9ResolvedDependencyInputs,
  plan: V9DependencyEvaluationPlan,
  envelope: V9ValidatedPolicyEnvelope,
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
    reasons.push(pillarReason(envelope, "unreviewed-dependency-relationships", "dependency:graph"));
  }
  const mappedWeightByUpstream = new Map<string, number>();
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
        pillarReason(
          envelope,
          "unreviewed-dependency-relationships",
          `dependency:collateral:${dependency.upstreamAssetId}`,
          `Collateral dependency ${dependency.upstreamAssetId} is not exactly mapped to reserve exposures.`,
        ),
      );
    }
  }
  const cycleMembers = new Set(plan.cyclicComponents.flat());
  if (cycleMembers.has(asset.assetId)) {
    reasons.push(pillarReason(envelope, "implementation-parent-cycle", "dependency:cycle"));
  } else if (plan.serialBlockedDescendants.includes(asset.assetId)) {
    reasons.push(pillarReason(envelope, "parent-cycle", "dependency:serial-ancestor-cycle"));
  }
  for (const serial of inputs.serial.filter((dependency) => dependency.blocked)) {
    reasons.push(
      pillarReason(
        envelope,
        "missing-parent-score",
        `dependency:serial:${serial.upstreamAssetId}`,
        `Required upstream ${serial.upstreamAssetId} is not rateable.`,
      ),
    );
  }
  return canonicalReasons(reasons);
}

function pegInput(asset: V9AssetFactsV2, envelope: V9ValidatedPolicyEnvelope): V9ProductionScoreInput["peg"] {
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
  inputs: V9ResolvedDependencyInputs,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
): V9ProductionScoreInput["parent"] {
  const required = inputs.serial.length > 0 || inputs.cycleBlocked;
  const availableScores = inputs.serial.flatMap((dependency) =>
    dependency.blocked || dependency.score === null ? [] : [dependency.score],
  );
  const score =
    !required || inputs.cycleBlocked || availableScores.length !== inputs.serial.length
      ? null
      : Math.min(...availableScores);
  const propagatedReasons = inputs.serial.flatMap((dependency) => {
    const upstream = evaluatedById.get(dependency.upstreamAssetId);
    return upstream?.trace.nrReasons ?? [];
  });
  return { required, score, propagatedReasons };
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
      stressStateDigest: asset.stressState.stateDigest,
    })),
  };
}

/** Evaluate one exact, compiled active-asset set under one explicit candidate policy. */
export function evaluateV9FactSet(
  input: CompiledV9FactSetV2,
  envelope: V9ValidatedPolicyEnvelope,
): Readonly<V9EvaluatedSet> {
  assertV9ValidatedPolicyEnvelope(envelope);
  const factSet = parseCompiledV9FactSetV2(input);
  const assetsById = new Map(factSet.assets.map((asset) => [asset.assetId, asset]));
  const dependencyPlan = buildV9DependencyEvaluationPlan({
    activeAssetIds: factSet.activeAssetIds,
    assets: factSet.assets,
  });
  const commonSignals = commonModeSignalsByAsset(dependencyPlan, envelope);
  const evaluatedById = new Map<string, V9EvaluatedAsset>();
  // Terminal unavailable-asset roots per evaluated asset, propagated in
  // topological order: an unavailable asset inherits the union of the roots of
  // its own unavailable upstreams, or is its own root when nothing upstream is
  // unavailable. Backing aggregates materiality by these roots (VER2-001).
  const unavailabilityRootsById = new Map<string, readonly string[]>();
  const identity = {
    factSetDigest: factSet.v9FactSetDigest,
    baseInputGenerationId: factSet.baseInputGenerationId,
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    asOfSec: factSet.asOfSec,
    sourceGenerations: sourceGenerations(factSet),
  };

  for (const assetId of dependencyPlan.topologicalOrder) {
    const asset = assetsById.get(assetId);
    if (!asset) throw new Error(`Safety Score v9 dependency plan references missing asset ${assetId}`);
    const resolved = resolveV9DependencyInputs(
      dependencyPlan,
      [...evaluatedById.values()].map((result) => ({ assetId: result.assetId, score: result.trace.finalScore })),
    ).find((candidate) => candidate.assetId === assetId);
    if (!resolved) throw new Error(`Safety Score v9 dependency inputs are missing for ${assetId}`);

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
        envelope,
      ),
      seriallyResolvedUpstreamAssetIds: resolved.serial.map((dependency) => dependency.upstreamAssetId),
    };
    const backing =
      asset.mechanismRiskReview.review === null
        ? createUnavailableV9BackingResult(asset, envelope)
        : evaluateV9Backing(backingAsset, asset.mechanismRiskReview.review, envelope);
    const exit = evaluateV9ExitAssetFacts(asset, envelope);
    const control = evaluateV9EconomicControlAssetFacts(
      asset,
      { assetId: asset.assetId, ...asset.economicControlReview },
      envelope,
    );
    const access = evaluateV9AccessPosture({
      policy: envelope,
      facts: asset,
      transfer: asset.accessReview.transfer,
      freezeReviews: asset.accessReview.freeze.reviews,
    });
    const pillars = {
      backing: backingPillar(backing, envelope),
      exit: exitPillar(asset, exit, envelope),
      control: controlPillar(control),
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
    const scoreInput: V9ProductionScoreInput = {
      assetId,
      identity,
      pillars,
      peg: pegInput(asset, envelope),
      trackRecordMonths: conservativeTrackRecordMonths(asset.implementation.launchedAtSec, factSet.asOfSec),
      parent: parentInput(resolved, evaluatedById),
      dependencyReasons: dependencyReasons(asset, resolved, dependencyPlan, envelope),
      dependencyStructuralSignals: commonSignals.get(assetId) ?? [],
      methodologyReasons,
    };
    const trace = scoreV9EvaluatedAsset(scoreInput, envelope);
    const unavailableUpstreamRoots = uniqueSorted(
      [...resolved.basket, ...resolved.serial]
        .filter((dependency) => evaluatedById.get(dependency.upstreamAssetId)?.trace.finalScore === null)
        .flatMap((dependency) => unavailabilityRootsById.get(dependency.upstreamAssetId) ?? [dependency.upstreamAssetId]),
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
    });
  }

  const assets = [...evaluatedById.values()].sort((left, right) => compareText(left.assetId, right.assetId));
  const core: Omit<V9EvaluatedSet, "evaluatedSetDigest"> = {
    schemaVersion: 1,
    factSetDigest: factSet.v9FactSetDigest,
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
