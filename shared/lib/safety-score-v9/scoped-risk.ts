import { assertScore, compareText, uniqueSorted } from "./primitives";
import type { V9DeploymentControlFactV2 } from "../../types/safety-score-v9-facts";

export type V9EconomicLossScope = "access-only" | "deployment" | "reserve-claim" | "global-claim";

/** Compiled authority/contributor keys identify controllers; deployment and asset labels do not. */
export function effectiveV9ControllerKeys(
  control: Pick<V9DeploymentControlFactV2, "authority" | "executionScopeContributors">,
): readonly string[] {
  if (control.executionScopeContributors !== undefined) {
    return uniqueSorted(control.executionScopeContributors.map((contributor) => contributor.authorityKey));
  }
  return control.authority !== null && control.authority.model !== "none"
    ? [control.authority.authorityKey] : [];
}

/** Shared potential authority is already priced; distinct measured slice risks remain additive. */
export function isV9DeploymentControllerAlreadyPriced(
  sliceControllerKeys: readonly string[],
  pricedControllerKeys: ReadonlySet<string>,
  measuredSliceRisk: boolean,
): boolean {
  return !measuredSliceRisk && sliceControllerKeys.length > 0 &&
    sliceControllerKeys.every((key) => pricedControllerKeys.has(key));
}

export interface V9ScopedRiskSignal {
  signalKey: string;
  exposureKey: string;
  riskEventKey: string;
  failureDomainKeys: readonly string[];
  economicLossScope: V9EconomicLossScope;
  exposedScore: number;
  exposureShare: number | null;
  reason: string;
}

export interface V9ScopedRiskAdjustment {
  signalKey: string;
  sourceSignalKeys: readonly string[];
  exposureKey: string;
  riskEventKey: string;
  failureDomainKey: string;
  nominalExposureShare: number;
  exposureShare: number;
  exposedScore: number;
  scoreBefore: number;
  scoreAfter: number;
  adjustmentPoints: number;
  reason: string;
}

export interface V9ScopedRiskResolution {
  baseScore: number;
  finalScore: number;
  adjustments: readonly V9ScopedRiskAdjustment[];
  unresolvedDeploymentSignals: readonly V9ScopedRiskSignal[];
}

interface V9CoalescedScopedRiskSignal extends V9ScopedRiskSignal {
  sourceSignalKeys: readonly string[];
}

function applyV9AllocatedScopedRiskAdjustments(
  baseScore: number,
  adjustments: readonly { exposureShare: number; exposedScore: number }[],
): number {
  assertScore(baseScore, "base score");
  const totalExposureShare = adjustments.reduce((sum, adjustment) => {
    assertScore(adjustment.exposedScore, "allocated exposed score");
    if (
      !Number.isFinite(adjustment.exposureShare) ||
      adjustment.exposureShare < 0 ||
      adjustment.exposureShare > 1
    ) {
      throw new Error("Safety Score v9 allocated exposure share must be between 0 and 1");
    }
    return sum + adjustment.exposureShare;
  }, 0);
  const normalization = totalExposureShare > 1 ? 1 / totalExposureShare : 1;
  const totalAdjustment = adjustments.reduce((sum, adjustment) => {
    const exposedScore = Math.min(baseScore, adjustment.exposedScore);
    return sum + (baseScore - exposedScore) * adjustment.exposureShare * normalization;
  }, 0);
  return Math.max(0, baseScore - totalAdjustment);
}

function compareSignal(left: V9ScopedRiskSignal, right: V9ScopedRiskSignal): number {
  return (
    compareText(left.exposureKey, right.exposureKey) ||
    compareText(left.riskEventKey, right.riskEventKey) ||
    compareText(left.failureDomainKeys.join("+"), right.failureDomainKeys.join("+")) ||
    compareText(left.signalKey, right.signalKey)
  );
}

function coalesceIdenticalDeploymentEvents(
  baseScore: number,
  signals: readonly V9ScopedRiskSignal[],
): V9CoalescedScopedRiskSignal[] {
  const groups = new Map<string, V9ScopedRiskSignal[]>();
  for (const signal of [...signals].sort(compareSignal)) {
    const key = [
      signal.economicLossScope,
      signal.exposureKey,
      signal.riskEventKey,
      signal.exposureShare === null ? "unresolved" : "measured",
    ].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), signal]);
  }

  return [...groups.values()].map((group) => {
    const selected = [...group].sort(
      (left, right) =>
        modeledLoss(baseScore, right) - modeledLoss(baseScore, left) ||
        compareSignal(left, right),
    )[0]!;
    return {
      ...selected,
      signalKey: [...new Set(group.map((signal) => signal.signalKey))].sort().join("+"),
      sourceSignalKeys: [...new Set(group.map((signal) => signal.signalKey))].sort(),
      failureDomainKeys: [...selected.failureDomainKeys].sort(),
    };
  }).sort(compareSignal);
}

function modeledLoss(baseScore: number, signal: V9ScopedRiskSignal): number {
  if (signal.exposureShare === null) return 0;
  return (baseScore - Math.min(baseScore, signal.exposedScore)) * signal.exposureShare;
}

function selectWorstEventPerExposure(
  baseScore: number,
  signals: readonly V9CoalescedScopedRiskSignal[],
): V9CoalescedScopedRiskSignal[] {
  const groups = new Map<string, V9CoalescedScopedRiskSignal[]>();
  for (const signal of signals) {
    groups.set(signal.exposureKey, [...(groups.get(signal.exposureKey) ?? []), signal]);
  }
  return [...groups.values()]
    .map(
      (group) =>
        [...group].sort(
          (left, right) =>
            modeledLoss(baseScore, right) - modeledLoss(baseScore, left) ||
            compareSignal(left, right),
        )[0]!,
    )
    .sort(compareSignal);
}

/**
 * Resolve claim scope before final caps. Deployment-local failures affect the
 * average holder in proportion to measured supply exposure. Reserve signals
 * remain owned by backing, access-only signals remain owned by access/exit,
 * and global-claim signals are returned as hard-cap candidates.
 */
export function resolveV9ScopedRisk(
  baseScore: number,
  rawSignals: readonly V9ScopedRiskSignal[],
): V9ScopedRiskResolution {
  assertScore(baseScore, "base score");
  for (const signal of rawSignals) {
    assertScore(signal.exposedScore, `exposed score for ${signal.signalKey}`);
    if (
      signal.exposureShare !== null &&
      (!Number.isFinite(signal.exposureShare) || signal.exposureShare < 0 || signal.exposureShare > 1)
    ) {
      throw new Error(`Safety Score v9 exposure share for ${signal.signalKey} must be between 0 and 1`);
    }
  }

  const signals = [...rawSignals].sort(compareSignal);
  const deploymentSignals: V9ScopedRiskSignal[] = [];
  const unresolvedDeploymentSignals: V9ScopedRiskSignal[] = [];

  for (const signal of signals) {
    if (signal.failureDomainKeys.length === 0) {
      throw new Error(`Safety Score v9 scoped signal ${signal.signalKey} requires a failure domain`);
    }
    if (signal.economicLossScope === "deployment") deploymentSignals.push(signal);
  }

  const coalescedDeploymentSignals = coalesceIdenticalDeploymentEvents(baseScore, deploymentSignals);
  const knownDeploymentSignals = coalescedDeploymentSignals.filter((signal) => {
    if (signal.exposureShare === null) {
      const { sourceSignalKeys: _sourceSignalKeys, ...unresolvedSignal } = signal;
      unresolvedDeploymentSignals.push(unresolvedSignal);
      return false;
    }
    return true;
  });
  const selectedDeploymentSignals = selectWorstEventPerExposure(baseScore, knownDeploymentSignals);
  const maximumNominalShareByExposure = new Map<string, number>();
  for (const signal of knownDeploymentSignals) {
    maximumNominalShareByExposure.set(
      signal.exposureKey,
      Math.max(maximumNominalShareByExposure.get(signal.exposureKey) ?? 0, signal.exposureShare!),
    );
  }
  const totalNominalExposureShare = [...maximumNominalShareByExposure.values()].reduce(
    (sum, share) => sum + share,
    0,
  );
  const exposureNormalization =
    totalNominalExposureShare > 1 ? 1 / totalNominalExposureShare : 1;
  const adjustments: V9ScopedRiskAdjustment[] = [];
  let score = baseScore;
  for (const signal of selectedDeploymentSignals) {
    const nominalExposureShare = signal.exposureShare!;
    const exposureShare = nominalExposureShare * exposureNormalization;
    const exposedScore = Math.min(baseScore, signal.exposedScore);
    const adjustmentPoints = (baseScore - exposedScore) * exposureShare;
    const scoreAfter = Math.max(0, score - adjustmentPoints);
    adjustments.push({
      signalKey: signal.signalKey,
      sourceSignalKeys: signal.sourceSignalKeys,
      exposureKey: signal.exposureKey,
      riskEventKey: signal.riskEventKey,
      failureDomainKey: signal.failureDomainKeys.join("+"),
      nominalExposureShare,
      exposureShare,
      exposedScore: signal.exposedScore,
      scoreBefore: score,
      scoreAfter,
      adjustmentPoints,
      reason: signal.reason,
    });
    score = scoreAfter;
  }
  score = applyV9AllocatedScopedRiskAdjustments(baseScore, adjustments);

  return {
    baseScore,
    finalScore: score,
    adjustments,
    unresolvedDeploymentSignals,
  };
}
