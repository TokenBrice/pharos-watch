import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import type {
  V9StructuralSignal,
  V9ValidatedPolicyEnvelope,
} from "@shared/types/safety-score-v9";
import { clampShare } from "../math";
import {
  projectV9ExitEvaluationRoute,
  resolveV9DistinctExitCapacity,
  type V9ExitEvaluationResult,
} from "./exit";
import type {
  V9OperationalResilienceBlockers,
  V9OperationalResilienceMeasuredMarketDepth,
  V9OperationalResilienceResult,
} from "./operational-resilience";
import { resolveV9ReasonPolicy } from "./policy";
import { uniqueSorted } from "./primitives";
import type {
  V9PillarEvaluation,
  V9PillarReason,
  V9ProductionScoreInput,
} from "./score";
import type { V9ResolvedDependencyInputs } from "./dependencies";

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

export {
  applyOperationalResilienceCredits,
  measuredOperationalMarketDepth,
  operationalResilienceBlockers,
};
