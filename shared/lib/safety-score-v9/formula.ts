import {
  V9ScoringInputSchema,
  type V9CapSource,
  type V9Grade,
  type V9QualityPillar,
  type V9ReasonCode,
  type V9ScoringInput,
  type V9StructuralSignal,
  type V9UnresolvedFact,
  type V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import type { V9EvidenceResponsibility } from "../../types/safety-score-v9-facts";
import {
  aggregateV9SmoothBoundedHeadroom,
  type V9WeakestPathAggregationTrace,
} from "./aggregation";
import {
  assertV9ReasonCodesRegistered,
  assertV9UnresolvedFactsMatchPolicy,
  assertV9ValidatedPolicyEnvelope,
  resolveV9ReasonPolicy,
} from "./policy";
import {
  resolveV9ScopedRisk,
  type V9ScopedRiskAdjustment,
  type V9ScopedRiskSignal,
} from "./scoped-risk";

const V9_QUALITY_PILLARS = ["backing", "exit", "control"] as const satisfies readonly V9QualityPillar[];

export interface V9StructuralCap {
  kind: string;
  limit: number;
  reason: string;
}

export interface V9AttributedScenarioCap extends V9StructuralCap {
  responsibility: "measured-adverse";
  pricedInPillar?: V9QualityPillar;
}

export type V9NRReasonCode = V9ReasonCode;

export interface V9NRReason {
  code: V9NRReasonCode;
  message: string;
  field?: string;
  responsibility?: V9EvidenceResponsibility;
}

export interface V9CapTrace extends V9StructuralCap {
  source: V9CapSource;
  binding: boolean;
}

export interface V9AdverseAttribution {
  source:
    | "active-depeg"
    | "parent-score"
    | "peg-performance"
    | "pillar-score"
    | "reason"
    | "structural-signal"
    | "wrapper-local";
  path: string;
  message: string;
  responsibility: "measured-adverse";
}

export type V9PillarAdverseAttribution = V9AdverseAttribution & {
  source: "pillar-score";
};

export type V9ParentAdverseAttribution = V9AdverseAttribution & {
  source: "parent-score";
};

export type V9BoundedUncertaintyResponsibility = Exclude<
  V9EvidenceResponsibility,
  "measured-adverse"
>;

export interface V9BoundedUncertaintyAttribution {
  source: "parent-score" | "reason" | "wrapper-local";
  code: V9ReasonCode;
  path: string;
  message: string;
  responsibility: V9BoundedUncertaintyResponsibility;
  boundedness: "exposure-bounded" | "globally-bounded";
}

export type V9ParentBoundedUncertaintyAttribution = V9BoundedUncertaintyAttribution & {
  source: "parent-score";
};

export interface V9PillarReasonProvenance {
  pillar: V9QualityPillar;
  fact: V9UnresolvedFact;
}

export interface V9ScoreTrace {
  assetId: string;
  policyId: string;
  policyDigest: string;
  configName: string;
  pillarContributions: readonly {
    pillar: V9QualityPillar;
    score: number;
    weight: number;
    weightedContribution: number;
  }[];
  weightedQuality: number | null;
  weakestPillar: { pillar: V9QualityPillar; score: number } | null;
  aggregation: (V9WeakestPathAggregationTrace & { headroom: number }) | null;
  pegMultiplier: number | null;
  baseAssetScore: number | null;
  deploymentAdjustedScore: number | null;
  deploymentAdjustments: readonly V9ScopedRiskAdjustment[];
  unresolvedDeploymentSignals: readonly V9ScopedRiskSignal[];
  preCapScore: number | null;
  caps: readonly V9CapTrace[];
  bindingCap: V9CapTrace | null;
  structuralSignals: readonly V9StructuralSignal[];
  finalScore: number | null;
  finalGrade: V9Grade;
  adverseAttribution: readonly V9AdverseAttribution[];
  boundedUncertaintyAttribution: readonly V9BoundedUncertaintyAttribution[];
  unresolvedFacts: readonly V9UnresolvedFact[];
  nrReasons: readonly V9NRReason[];
  propagatedParentReasons: readonly V9NRReason[];
}

const SCORE_MIN = 0;
const SCORE_MAX = 100;
// Withhold band (Lever 1): a would-be final score at or above this does not need
// an insufficient-evidence withhold even with >=2 limited pillars. Tunable.
const WITHHOLD_BAND_MAX_SCORE = 55;
// Measured peg-history danger floor: a measured peg multiplier below this is a
// danger signal (matches the calibration runner's MEASURED_PEG_MULTIPLIER_FLOOR).
const DANGER_PEG_MULTIPLIER_FLOOR = 0.9;
// F-gate peg floor (owner ruling 2026-07-21, reshape-v2 D1): a measured peg
// multiplier in [0.8, 0.9) reads as degraded (D-range), not failing (F).
// Deliberately DECOUPLED from the frozen D3 attribution predicate (0.90),
// which is not a tunable knob and is untouched by this constant.
const F_GATE_PEG_MULTIPLIER_FLOOR = 0.8;
const DANGER_ONLY_GRADES = new Set<V9Grade>(["F"]);

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clampScore(value: number): number {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, value));
}

/**
 * Snap binary float noise to the nearest 15-significant-digit decimal before
 * quantizing: an additive Number.EPSILON is magnitude-blind (one ULP at ~59.5
 * is ~30x larger), so exact decimal halves could round down (VER-002). The
 * window is 15 digits (~22 ULPs), NOT wider: a coarser snap can lift a
 * genuine sub-boundary value across a rounding or floor boundary (VER2-009).
 */
export function decimalSnap(value: number): number {
  return Number(value.toPrecision(15));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(decimalSnap(value * factor)) / factor;
}

function floorTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(decimalSnap(value * factor)) / factor;
}

function canonicalAdverseAttribution(
  values: readonly V9AdverseAttribution[],
): V9AdverseAttribution[] {
  return [
    ...new Map(
      values.map((value) => [
        `${value.source}\u0000${value.path}\u0000${value.message}`,
        value,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      compareCodeUnits(left.source, right.source) ||
      compareCodeUnits(left.path, right.path) ||
      compareCodeUnits(left.message, right.message),
  );
}

function canonicalBoundedUncertaintyAttribution(
  values: readonly V9BoundedUncertaintyAttribution[],
): V9BoundedUncertaintyAttribution[] {
  return [
    ...new Map(
      values.map((value) => [
        [
          value.source,
          value.code,
          value.path,
          value.message,
          value.responsibility,
          value.boundedness,
        ].join("\u0000"),
        value,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      compareCodeUnits(left.source, right.source) ||
      compareCodeUnits(left.code, right.code) ||
      compareCodeUnits(left.path, right.path) ||
      compareCodeUnits(left.message, right.message) ||
      compareCodeUnits(left.responsibility, right.responsibility) ||
      compareCodeUnits(left.boundedness, right.boundedness),
  );
}

function gradeForScore(score: number, policy: V9ValidatedPolicyEnvelope): V9Grade {
  return policy.policy.semantic.formula.gradeThresholds.find((threshold) => score >= threshold.minScore)?.grade ?? "F";
}

function signalLimit(signal: V9StructuralSignal, policy: V9ValidatedPolicyEnvelope): number | null {
  // An unreviewed upgrade path is an evidence disposition, not an observed
  // exploitability or control event. V3 carries its owner as an explicit gap,
  // which can still bind through the issuer-evidence ceiling or withhold to NR.
  if (signal.kind === "unreviewed-upgrade") return null;
  if (
    signal.kind === "material-bridge" &&
    (signal.materialSharePct ?? 100) < policy.policy.semantic.materiality.deploymentMaterialSharePct
  ) {
    return null;
  }
  return policy.policy.semantic.structural.signalLimits[signal.kind][signal.severity];
}

function scopedSignalKey(signal: V9StructuralSignal): string {
  const domains = [...signal.failureDomainKeys].sort(compareCodeUnits);
  return [
    "signal",
    signal.kind,
    signal.severity,
    signal.exposureKey ?? "unscoped",
    signal.riskEventKey ?? "event-unidentified",
    domains.join("+") || signal.reason,
  ].join(":");
}

function scopedRiskSignal(
  signal: V9StructuralSignal,
  policy: V9ValidatedPolicyEnvelope,
): V9ScopedRiskSignal | null {
  const limit = signalLimit(signal, policy);
  if (signal.economicLossScope === undefined || limit === null) return null;
  const failureDomainKey =
    [...signal.failureDomainKeys].sort(compareCodeUnits).join("+") ||
    `signal:${signal.kind}:${signal.reason}`;
  const rawShare = signal.materialSharePct === undefined ? null : signal.materialSharePct / 100;
  if (
    signal.responsibility !== "measured-adverse" &&
    !(signal.economicLossScope === "deployment" && rawShare === null)
  ) {
    return null;
  }
  const lossAbsorption = (signal.lossAbsorptionPct ?? 0) / 100;
  return {
    signalKey: scopedSignalKey(signal),
    exposureKey: signal.exposureKey ?? scopedSignalKey(signal),
    riskEventKey: signal.riskEventKey ?? scopedSignalKey(signal),
    failureDomainKeys: [...signal.failureDomainKeys].sort(compareCodeUnits).length > 0
      ? [...signal.failureDomainKeys].sort(compareCodeUnits)
      : [failureDomainKey],
    economicLossScope: signal.economicLossScope,
    exposedScore: limit,
    exposureShare: rawShare === null ? null : rawShare * (1 - lossAbsorption),
    reason: signal.reason,
  };
}

function structuralSignalNeedsHardCap(signal: V9StructuralSignal): boolean {
  // Retained V2 signals predate explicit loss scope and keep their legacy cap.
  if (signal.economicLossScope === undefined) {
    return signal.responsibility === undefined || signal.responsibility === "measured-adverse";
  }
  if (signal.responsibility !== "measured-adverse") return false;
  // Reserve and access facts are already owned by backing/exit. A reserve
  // condition that can impair the whole claim must be emitted as global-claim;
  // treating every reserve slice as global charges the same exposure twice.
  if (
    signal.economicLossScope === "access-only" ||
    signal.economicLossScope === "reserve-claim"
  ) {
    return false;
  }
  if (signal.economicLossScope === "global-claim") return true;
  // Deployment facts belong to the scoped-risk resolver. Known exposure is
  // priced proportionally; unknown exposure remains an explicit evidence
  // limitation and must not be promoted to a whole-asset adverse cap.
  return false;
}

function structuralSignalAffectedScore(
  signal: V9StructuralSignal,
  allSignals: readonly V9StructuralSignal[],
  scopedRisk: ReturnType<typeof resolveV9ScopedRisk> | null,
  bindingCap: Omit<V9CapTrace, "binding"> | null,
  policy: V9ValidatedPolicyEnvelope,
): boolean {
  // Structural presence alone is not causal proof. Producers must identify the
  // underlying fact as known adverse; missing/stale/unsupported evidence can
  // still shape the latent score, but cannot justify a public D/F claim.
  if (signal.responsibility !== "measured-adverse") return false;
  // A measured signal explicitly owned by a pillar is already part of that
  // pillar's quality result, so no second composite adjustment/cap is required
  // to establish causality.
  if (signal.pricedInPillar !== undefined) return true;

  const scopedKey = scopedSignalKey(signal);
  if (
    scopedRisk?.adjustments.some(
      (adjustment) =>
        adjustment.adjustmentPoints > 0 &&
        adjustment.sourceSignalKeys.includes(scopedKey),
    )
  ) {
    return true;
  }

  if (bindingCap?.source !== "structural") return false;
  if (bindingCap.kind === `signal:${signal.kind}:${signal.severity}`) return true;
  if (bindingCap.kind !== "signal:common-mode-oracle" || signal.kind !== "weak-oracle-branch") {
    return false;
  }

  const oracleDomains = new Map<string, number>();
  for (const candidate of allSignals.filter(
    (item) => item.kind === "weak-oracle-branch" && item.responsibility === "measured-adverse",
  )) {
    for (const domain of new Set(candidate.failureDomainKeys)) {
      oracleDomains.set(domain, (oracleDomains.get(domain) ?? 0) + 1);
    }
  }
  return signal.failureDomainKeys.some(
    (domain) =>
      (oracleDomains.get(domain) ?? 0) >=
      policy.policy.semantic.materiality.commonModeOracleMinBranches,
  );
}

function unresolvedFactAffectedScore(
  fact: V9UnresolvedFact,
  bindingCap: Omit<V9CapTrace, "binding"> | null,
  policy: V9ValidatedPolicyEnvelope,
): boolean {
  if (fact.responsibility !== "measured-adverse") return false;
  const resolved = resolveV9ReasonPolicy(policy, fact.code);
  if (
    resolved.reason.boundedness === "exposure-bounded" ||
    resolved.reason.boundedness === "globally-bounded"
  ) {
    return false;
  }
  if (resolved.critical || resolved.reason.defaultTreatment === "pillar") return true;
  return (
    resolved.ceiling !== null &&
    bindingCap?.source === "evidence" &&
    bindingCap.kind === resolved.ceiling.kind &&
    bindingCap.limit === resolved.ceiling.limit
  );
}

function boundedUncertaintyForFact(
  fact: V9UnresolvedFact,
  pillars: V9ScoringInput["pillars"],
  bindingCap: Omit<V9CapTrace, "binding"> | null,
  policy: V9ValidatedPolicyEnvelope,
  pillarReasonProvenance: readonly V9PillarReasonProvenance[],
): V9BoundedUncertaintyAttribution | null {
  if (
    fact.responsibility === undefined ||
    fact.responsibility === "measured-adverse" ||
    fact.path === undefined
  ) {
    return null;
  }
  const resolved = resolveV9ReasonPolicy(policy, fact.code);
  if (
    resolved.critical ||
    (
      resolved.reason.boundedness !== "exposure-bounded" &&
      resolved.reason.boundedness !== "globally-bounded"
    ) ||
    (
      resolved.reason.defaultTreatment !== "pillar" &&
      resolved.reason.defaultTreatment !== "ceiling"
    )
  ) {
    return null;
  }
  const cMinusFloor =
    policy.policy.semantic.formula.gradeThresholds.find((threshold) => threshold.grade === "C-")?.minScore;
  if (cMinusFloor === undefined) {
    throw new Error("Safety Score v9 policy has no C- grade threshold");
  }
  const pillarReasonAffectedScore = pillarReasonProvenance.some(
    (candidate) =>
      candidate.fact.code === fact.code &&
      candidate.fact.path === fact.path &&
      candidate.fact.reason === fact.reason &&
      candidate.fact.responsibility === fact.responsibility &&
      pillars[candidate.pillar] !== null &&
      pillars[candidate.pillar]! < cMinusFloor,
  );
  const ceilingAffectedScore =
    resolved.reason.defaultTreatment === "ceiling" &&
    resolved.ceiling !== null &&
    bindingCap?.source === "evidence" &&
    bindingCap.kind === resolved.ceiling.kind &&
    bindingCap.limit === resolved.ceiling.limit &&
    bindingCap.reason === fact.reason;
  if (!pillarReasonAffectedScore && !ceilingAffectedScore) return null;
  return {
    source: "reason",
    code: fact.code,
    path: fact.path,
    message: fact.reason,
    responsibility: fact.responsibility,
    boundedness: resolved.reason.boundedness,
  };
}

export interface V9ReserveLossFacts {
  exposurePct: number;
  lossAbsorptionPct: number;
  failureDomainKey: string;
}

export interface V9WindowedPegScoreFacts {
  pegScore: number | null;
  activeDepeg: boolean | null | undefined;
  lastEventAt: number | null | undefined;
  clockSec: number;
  windowSec: number;
  quietHistoryFloor: number;
}

/**
 * Apply the matrix-verified R5 proxy at the V9 adapter boundary. Capture input
 * carries only an aggregate peg summary, so this cannot recompute event-level
 * history; it only removes a legacy penalty after a proven quiet window.
 */
export function deriveV9WindowedPegScore(facts: V9WindowedPegScoreFacts): number | null {
  if (!Number.isInteger(facts.clockSec)) throw new Error("clockSec must be an integer Unix timestamp");
  if (!Number.isInteger(facts.windowSec) || facts.windowSec <= 0) {
    throw new Error("windowSec must be a positive integer");
  }
  if (!Number.isFinite(facts.quietHistoryFloor) || facts.quietHistoryFloor < 0 || facts.quietHistoryFloor > 100) {
    throw new Error("quietHistoryFloor must be between 0 and 100");
  }
  if (facts.pegScore === null || facts.activeDepeg !== false || facts.pegScore >= facts.quietHistoryFloor) {
    return facts.pegScore;
  }
  const cutoffSec = facts.clockSec - facts.windowSec;
  if (facts.lastEventAt !== null && facts.lastEventAt !== undefined && facts.lastEventAt >= cutoffSec) {
    return facts.pegScore;
  }
  return facts.quietHistoryFloor;
}

/** Convert reserve exposure and loss absorption facts into a cap-free structural signal. */
export function deriveV9ReserveLossSignal(
  facts: V9ReserveLossFacts,
  policy: V9ValidatedPolicyEnvelope,
): V9StructuralSignal {
  assertV9ValidatedPolicyEnvelope(policy);
  for (const [field, value] of [
    ["exposurePct", facts.exposurePct],
    ["lossAbsorptionPct", facts.lossAbsorptionPct],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`${field} must be a finite percentage between 0 and 100`);
    }
  }
  if (facts.failureDomainKey.length === 0) throw new Error("failureDomainKey is required");

  const unabsorbedExposurePct = facts.exposurePct * (1 - facts.lossAbsorptionPct / 100);
  const thresholds = policy.policy.semantic.backing.structural.severityShares;
  const unabsorbedExposureShare = unabsorbedExposurePct / 100;
  const severity =
    unabsorbedExposureShare >= thresholds.critical
      ? "critical"
      : unabsorbedExposureShare >= thresholds.high
        ? "high"
        : unabsorbedExposureShare >= thresholds.moderate
          ? "moderate"
          : "low";
  return {
    kind: "unsafe-backing",
    severity,
    responsibility: "measured-adverse",
    reason: `${facts.exposurePct}% reserve exposure has ${facts.lossAbsorptionPct}% loss absorption, leaving ${roundTo(unabsorbedExposurePct, 4)}% unabsorbed.`,
    materialSharePct: roundTo(unabsorbedExposurePct, 4),
    failureDomainKeys: [facts.failureDomainKey],
    evidence: [],
  };
}

/** Resolve fact-shaped structural signals to methodology ceilings. */
export function resolveV9StructuralCaps(
  signals: readonly V9StructuralSignal[],
  policy: V9ValidatedPolicyEnvelope,
): V9StructuralCap[] {
  assertV9ValidatedPolicyEnvelope(policy);
  const sorted = [...signals].sort(
    (left, right) =>
      compareCodeUnits(left.kind, right.kind) ||
      compareCodeUnits(left.reason, right.reason) ||
      (left.materialSharePct ?? -1) - (right.materialSharePct ?? -1),
  );
  const caps = sorted.flatMap((signal) => {
    const limit = signalLimit(signal, policy);
    return limit === null ? [] : [{ kind: `signal:${signal.kind}:${signal.severity}`, limit, reason: signal.reason }];
  });
  const oracleDomainCounts = new Map<string, number>();
  for (const signal of sorted.filter((item) => item.kind === "weak-oracle-branch")) {
    for (const key of new Set(signal.failureDomainKeys)) {
      oracleDomainCounts.set(key, (oracleDomainCounts.get(key) ?? 0) + 1);
    }
  }
  for (const [failureDomain, count] of [...oracleDomainCounts].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    if (count < policy.policy.semantic.materiality.commonModeOracleMinBranches) continue;
    caps.push({
      kind: "signal:common-mode-oracle",
      limit: policy.policy.semantic.structural.commonModeOracleLimit,
      reason: `${count} weak oracle branches share ${failureDomain}.`,
    });
  }
  return caps;
}

function v9PillarBoundedUnknownFloor(pillar: V9QualityPillar, policy: V9ValidatedPolicyEnvelope): number {
  const semantic = policy.policy.semantic;
  return pillar === "backing"
    ? semantic.backing.boundedUnknownQuality
    : pillar === "exit"
      ? semantic.exit.boundedUnknownScore
      : semantic.control.boundedUnknownQuality;
}

function anyPillarBelowFloor(
  pillars: V9ScoringInput["pillars"],
  policy: V9ValidatedPolicyEnvelope,
  gate: V9DangerGate = "withhold",
): boolean {
  return V9_QUALITY_PILLARS.some((pillar) => {
    const score = pillars[pillar];
    if (score === null) return false;
    // F-gate control threshold (owner rulings 2026-07-21, D1+D5): control 25 is
    // the ladder's DEFINED measured minimum (`unbounded-or-compromised`), not a
    // below-plausible reading — a verified-adverse mint is a D-range fact
    // priced in-pillar, so only a control score below the measured scale reads
    // as danger for the F-vs-D decision. The withhold gate keeps the
    // bounded-unknown floor (45): a measured-adverse control must stay rated,
    // never NR. Backing/exit floors (35) are identical under both gates.
    if (gate === "f-gate" && pillar === "control") {
      const postureFloor = Math.min(...Object.values(policy.policy.semantic.control.mintPostureQuality));
      return score < postureFloor;
    }
    return score < v9PillarBoundedUnknownFloor(pillar, policy);
  });
}

export interface V9DangerSignalInput {
  pillars: V9ScoringInput["pillars"];
  structuralSignals: readonly V9StructuralSignal[];
  pegMultiplier: number | null;
  activeDepegBps: number | null;
  parentRequired: boolean;
  parentScore: number | null;
  unresolvedCodes: readonly V9ReasonCode[];
}

/**
 * The two reshape gates read danger through different lenses (owner ruling
 * 2026-07-21, reshape-v2 D1):
 * - "withhold" (Lever 1 blocker): the FULL predicate — any measured adverse
 *   fact (incl. centralized-mint >= high, peg multiplier < 0.9) keeps an asset
 *   rated instead of NR-withheld.
 * - "f-gate" (Lever 2): the NARROW predicate — F is reserved for hard danger.
 *   Centralized-mint counts at critical only (a concentrated-but-verified mint
 *   is already priced at control 25 + the high@59 cap; re-branding the D-range
 *   blend as F double-counts it), and the peg floor drops to 0.8.
 */
export type V9DangerGate = "withhold" | "f-gate";

/**
 * Shared danger predicate for the reshape gates (Levers 1 & 2). TRUE when a
 * would-be low/F score is held by a measured adverse fact rather than by an
 * evidence gap: it is the union of the calibration runner's
 * `measuredAdverseFDrivers`, fired `signal:*:critical` caps (presence, not
 * bindingness), and gate-dependent centralized-mint / measured-peg clauses
 * (see `V9DangerGate`). Withholding (L1) and the danger-gate floor (L2) defer
 * to their respective gates so F stays danger-only without ever withholding a
 * measured-adverse asset.
 */
export function hasV9DangerSignal(
  input: V9DangerSignalInput,
  policy: V9ValidatedPolicyEnvelope,
  gate: V9DangerGate = "withhold",
): boolean {
  assertV9ValidatedPolicyEnvelope(policy);
  // (1) A fired signal:*:critical structural cap — presence, not bindingness.
  const measuredStructuralSignals = input.structuralSignals.filter(
    (signal) => signal.responsibility === "measured-adverse",
  );
  const firedCriticalSignal = resolveV9StructuralCaps(measuredStructuralSignals, policy).some(
    (cap) => cap.kind.startsWith("signal:") && cap.kind.endsWith(":critical"),
  );
  // (2) Active depeg in any band.
  const activeDepeg = input.activeDepegBps !== null && input.activeDepegBps > 0;
  // (3) A required, rated parent imposes a parent cap.
  const parentCap = input.parentRequired && input.parentScore !== null;
  // (4) Centralized mint: critical always; high only for the withhold gate.
  const centralizedMint = measuredStructuralSignals.some(
    (signal) =>
      signal.kind === "centralized-mint" &&
      (signal.severity === "critical" || (gate === "withhold" && signal.severity === "high")),
  );
  // (5) Measured peg history below the gate's danger floor.
  const pegFloor = gate === "f-gate" ? F_GATE_PEG_MULTIPLIER_FLOOR : DANGER_PEG_MULTIPLIER_FLOOR;
  const measuredPeg = typeof input.pegMultiplier === "number" && input.pegMultiplier < pegFloor;
  // (6) Any pillar strictly below its bounded-unknown floor.
  const subFloorPillar = anyPillarBelowFloor(input.pillars, policy, gate);
  // (7) A registry-classified unsupported-design reason.
  const unsupportedDesign = input.unresolvedCodes.some(
    (code) => resolveV9ReasonPolicy(policy, code).reason.auditClassification === "unsupported-design",
  );
  // (8) An active control-compromise incident, at ANY severity — a live incident
  // is danger even if its signal is graded below critical, so it is never
  // withheld-to-NR or D-floored as a mere evidence gap.
  const activeControlIncident = measuredStructuralSignals.some(
    (signal) => signal.kind === "active-control-incident",
  );
  return (
    firedCriticalSignal ||
    activeDepeg ||
    parentCap ||
    centralizedMint ||
    measuredPeg ||
    subFloorPillar ||
    unsupportedDesign ||
    activeControlIncident
  );
}

export interface V9PreExitDangerInput {
  structuralSignals: readonly V9StructuralSignal[];
  pegScore: number | null;
  pegApplicable: boolean;
  activeDepegBps: number | null;
}

/**
 * The pre-exit subset of the danger predicate, used to withhold the SIM-EXIT-L2
 * undisclosed-fee exit credit from an asset already held down by a non-exit
 * adverse fact (owner ruling 2026-07-23). Deliberately a strict subset of
 * `hasV9DangerSignal`: it keeps the active-depeg, sub-0.9 measured-peg,
 * fired-`signal:*:critical`-cap and active-control-incident clauses, and drops
 * every clause that exit credit can itself move — the sub-floor-pillar,
 * parent-cap, and unsupported-design clauses — so the exit lever can never feed
 * back into the gate that governs it. Centralized mint is taken at the `f-gate`
 * threshold (critical only), not `>= high`: a concentrated-but-verified mint is
 * already priced in-pillar (control 25 + the high@59 cap), so withholding a
 * measured exit route for it would double-count a fact the score already carries
 * and would wrongly floor an otherwise-creditable measured exit (e.g. the Nest
 * RWA coins, which carry centralized-mint:high yet have no other pre-exit
 * danger and are owner-ruled to keep their measured sub-floor exits).
 */
export function hasV9PreExitDangerSignal(input: V9PreExitDangerInput, policy: V9ValidatedPolicyEnvelope): boolean {
  assertV9ValidatedPolicyEnvelope(policy);
  const measuredStructuralSignals = input.structuralSignals.filter(
    (signal) => signal.responsibility === "measured-adverse",
  );
  const firedCriticalSignal = resolveV9StructuralCaps(measuredStructuralSignals, policy).some(
    (cap) => cap.kind.startsWith("signal:") && cap.kind.endsWith(":critical"),
  );
  const activeDepeg = input.activeDepegBps !== null && input.activeDepegBps > 0;
  const centralizedMint = measuredStructuralSignals.some(
    (signal) => signal.kind === "centralized-mint" && signal.severity === "critical",
  );
  // Mirrors the formula's `pegMultiplierRaw` for the danger check: an unverified
  // or not-applicable peg reads as par (1), never as a measured-peg danger.
  const pegMultiplier =
    input.pegApplicable && input.pegScore !== null
      ? input.pegScore === 0
        ? 0
        : (input.pegScore / 100) ** policy.policy.semantic.formula.pegExponent
      : 1;
  const measuredPeg = pegMultiplier < DANGER_PEG_MULTIPLIER_FLOOR;
  const activeControlIncident = measuredStructuralSignals.some((signal) => signal.kind === "active-control-incident");
  return firedCriticalSignal || activeDepeg || centralizedMint || measuredPeg || activeControlIncident;
}

function capPriority(source: V9CapTrace["source"], policy: V9ValidatedPolicyEnvelope): number {
  const priority = policy.policy.semantic.formula.capTiePriority.indexOf(source);
  return priority === -1 ? policy.policy.semantic.formula.capTiePriority.length : priority;
}

function scoreV9InputWithCaps(
  rawInput: V9ScoringInput,
  policy: V9ValidatedPolicyEnvelope,
  scenarioCaps: readonly V9AttributedScenarioCap[],
  propagatedParentReasons: readonly V9NRReason[] = [],
  limitedPillarCount = 0,
  backingLimited = false,
  propagatedParentAdverseAttribution: readonly V9ParentAdverseAttribution[] = [],
  measuredPillarAdverseAttribution: readonly V9PillarAdverseAttribution[] = [],
  propagatedParentBoundedUncertaintyAttribution:
    readonly V9ParentBoundedUncertaintyAttribution[] = [],
  wrapperLocalAdverseAttribution: readonly V9AdverseAttribution[] = [],
  wrapperLocalBoundedUncertaintyAttribution:
    readonly V9BoundedUncertaintyAttribution[] = [],
  pillarReasonProvenance: readonly V9PillarReasonProvenance[] = [],
): V9ScoreTrace {
  assertV9ValidatedPolicyEnvelope(policy);
  const input = V9ScoringInputSchema.parse(rawInput);
  assertV9UnresolvedFactsMatchPolicy(policy, input.unresolved);
  const formula = policy.policy.semantic.formula;
  const nrReasons: V9NRReason[] = [];
  const reasonCeilings: Omit<V9CapTrace, "binding">[] = [];
  const pillarContributions: V9ScoreTrace["pillarContributions"][number][] = [];

  for (const pillar of V9_QUALITY_PILLARS) {
    const score = input.pillars[pillar];
    if (score === null) {
      nrReasons.push({
        code: "missing-pillar",
        field: `pillars.${pillar}`,
        message: `Required ${pillar} pillar is missing; weights are not redistributed.`,
      });
    } else {
      const weight = formula.pillarWeights[pillar];
      pillarContributions.push({
        pillar,
        score,
        weight,
        weightedContribution: roundTo(score * weight, 4),
      });
    }
  }

  if (input.evidenceLevel === "insufficient") {
    nrReasons.push({
      code: "insufficient-evidence",
      field: "evidenceLevel",
      message: "Critical evidence is insufficient for a v9 research rating.",
    });
  }
  let pegUnverified = false;
  if (input.pegApplicable && input.pegScore === null) {
    const missingPegPolicy = resolveV9ReasonPolicy(policy, "missing-applicable-peg");
    if (missingPegPolicy.critical) {
      nrReasons.push({
        code: "missing-applicable-peg",
        field: "pegScore",
        message: "A peg score is required when peg risk applies.",
      });
    } else {
      pegUnverified = true;
      if (missingPegPolicy.ceiling) {
        reasonCeilings.push({
          source: "evidence",
          ...missingPegPolicy.ceiling,
          reason: "Peg risk applies but no peg evidence is available; the peg multiplier is bounded at par.",
        });
      }
    }
  }
  if (input.parentRequired && input.parentScore === null) {
    nrReasons.push({
      code: "missing-parent-score",
      field: "parentScore",
      message: "A required parent must be rated before its child.",
    });
  }
  const unresolvedFacts = [...input.unresolved].sort(
    (left, right) =>
      compareCodeUnits(left.code, right.code) ||
      compareCodeUnits(left.path ?? "", right.path ?? "") ||
      compareCodeUnits(left.reason, right.reason),
  );
  for (const fact of unresolvedFacts) {
    const resolved = resolveV9ReasonPolicy(policy, fact.code);
    const responsibility = fact.responsibility;
    const uncertaintyIsUnbounded =
      responsibility !== "measured-adverse" &&
      resolved.reason.boundedness === "unbounded";
    if (responsibility === "integration-missing") {
      // Integration-owned gaps remain explicit confidence diagnostics when the
      // compiler can still produce a bounded pillar. Missing pillars are
      // withheld above, so turning every integration backlog item into NR
      // would erase otherwise rateable assets and let Pharos coverage dictate
      // the public risk distribution.
      if (resolved.critical || uncertaintyIsUnbounded) {
        nrReasons.push({
          code: fact.code,
          field: fact.path,
          message: fact.reason,
          responsibility,
        });
      } else if (resolved.ceiling) {
        reasonCeilings.push({ source: "evidence", ...resolved.ceiling, reason: fact.reason });
      }
      continue;
    }
    if (responsibility === "producer-failed") {
      // A producer outage is an availability state, not evidence that the
      // asset became unsafe. Fresh LKG facts do not enter this score-bearing
      // list. When the compiler can still produce a policy-bounded pillar,
      // retain the score under that reason's ceiling; a genuinely missing or
      // unbounded required fact is still withheld by the pillar/critical gates.
      if (resolved.critical || uncertaintyIsUnbounded) {
        nrReasons.push({
          code: fact.code,
          field: fact.path,
          message: fact.reason,
          responsibility,
        });
      } else if (resolved.ceiling) {
        reasonCeilings.push({ source: "evidence", ...resolved.ceiling, reason: fact.reason });
      }
      continue;
    }
    if (responsibility === "method-unsupported") {
      // Method responsibility describes why the fact is unresolved; the
      // reviewed reason registry still owns its treatment. A globally bounded
      // unsupported method is provisional under its ceiling, while genuinely
      // unbounded applicability/integrity failures remain NR.
      if (resolved.critical || uncertaintyIsUnbounded) {
        nrReasons.push({
          code: fact.code,
          field: fact.path,
          message: fact.reason,
          responsibility,
        });
      } else if (resolved.ceiling) {
        reasonCeilings.push({ source: "evidence", ...resolved.ceiling, reason: fact.reason });
      }
      continue;
    }
    if (resolved.critical || uncertaintyIsUnbounded) {
      nrReasons.push({
        code: fact.code,
        field: fact.path,
        message: fact.reason,
        responsibility,
      });
    } else if (resolved.ceiling) {
      reasonCeilings.push({ source: "evidence", ...resolved.ceiling, reason: fact.reason });
    }
  }

  const pillarsComplete = pillarContributions.length === V9_QUALITY_PILLARS.length;
  const weightedQualityRaw = pillarsComplete
    ? pillarContributions.reduce((sum, contribution) => sum + contribution.score * contribution.weight, 0)
    : null;
  const weakestPillar = pillarsComplete
    ? pillarContributions.reduce(
        (weakest, contribution) =>
          contribution.score < weakest.score ? { pillar: contribution.pillar, score: contribution.score } : weakest,
        { pillar: pillarContributions[0]!.pillar, score: pillarContributions[0]!.score },
      )
    : null;
  // A pillar-dependent headroom changes discontinuously when two pillars cross
  // and can make an improved control score lower the composite. The selected
  // smooth aggregator therefore uses one policy headroom for every pillar.
  const aggregationHeadroom =
    weakestPillar === null ? null : formula.compensabilityHeadroom;
  const aggregationRaw =
    pillarsComplete && aggregationHeadroom !== null
      ? aggregateV9SmoothBoundedHeadroom(
          {
            backing: input.pillars.backing!,
            exit: input.pillars.exit!,
            control: input.pillars.control!,
          },
          formula.pillarWeights,
          aggregationHeadroom,
        )
      : null;
  const pegMultiplierRaw = input.pegApplicable
    ? input.pegScore === null
      ? pegUnverified
        ? 1
        : null
      : input.pegScore === 0
        ? 0
        : (input.pegScore / 100) ** formula.pegExponent
    : 1;
  const baseAssetScoreRaw =
    aggregationRaw === null || pegMultiplierRaw === null
      ? null
      : clampScore(aggregationRaw.score * pegMultiplierRaw);
  const compositeScopedSignals = input.structuralSignals.flatMap((signal) => {
    if (signal.pricedInPillar !== undefined) return [];
    const scoped = scopedRiskSignal(signal, policy);
    return scoped === null ? [] : [scoped];
  });
  const scopedRisk =
    baseAssetScoreRaw === null ? null : resolveV9ScopedRisk(baseAssetScoreRaw, compositeScopedSignals);
  const preCapScoreRaw = scopedRisk?.finalScore ?? null;

  const capCandidates: Omit<V9CapTrace, "binding">[] = [];
  capCandidates.push(...reasonCeilings);
  const evidenceCeiling = policy.policy.semantic.evidence.ceilings[input.evidenceLevel];
  if (evidenceCeiling !== null) {
    capCandidates.push({
      source: "evidence",
      kind: `evidence:${input.evidenceLevel}`,
      limit: evidenceCeiling,
      reason: `${input.evidenceLevel} evidence ceiling.`,
    });
  }
  const trackRecordBand = formula.trackRecordCeilings.find(
    (band) =>
      input.trackRecordMonths >= band.minMonthsInclusive &&
      (band.maxMonthsExclusive === null || input.trackRecordMonths < band.maxMonthsExclusive),
  );
  if (!trackRecordBand) throw new Error(`No track-record ceiling covers ${input.trackRecordMonths} months`);
  if (trackRecordBand.limit !== null) {
    capCandidates.push({
      source: "track-record",
      kind: trackRecordBand.kind,
      limit: trackRecordBand.limit,
      reason: trackRecordBand.reason,
    });
  }
  if (input.activeDepegBps !== null) {
    const activeCap = [...formula.activeDepegCaps]
      .sort((left, right) => right.minimumBps - left.minimumBps)
      .find((cap) => input.activeDepegBps! >= cap.minimumBps);
    if (activeCap) {
      capCandidates.push({
        source: "active-depeg",
        limit: activeCap.limit,
        kind: activeCap.kind,
        reason: activeCap.reason,
      });
    }
  }
  if (input.parentRequired && input.parentScore !== null) {
    capCandidates.push({
      source: "parent",
      kind: "parent",
      limit: input.parentScore,
      reason: "A child cannot rate above its required parent.",
    });
  }
  for (const cap of resolveV9StructuralCaps(input.structuralSignals.filter(structuralSignalNeedsHardCap), policy)) {
    capCandidates.push({ source: "structural", ...cap });
  }
  for (const {
    responsibility: _responsibility,
    pricedInPillar: _pricedInPillar,
    ...cap
  } of scenarioCaps) {
    capCandidates.push({ source: "structural", ...cap });
  }

  // Identical (source, kind, limit) candidates collapse to one trace row; the
  // deterministically first reason survives so repeated shared-path signals do
  // not flood the published cap list.
  const dedupedCandidates = [
    ...new Map(
      [...capCandidates]
        .sort(
          (left, right) =>
            left.limit - right.limit ||
            capPriority(left.source, policy) - capPriority(right.source, policy) ||
            compareCodeUnits(left.kind, right.kind) ||
            compareCodeUnits(left.reason, right.reason),
        )
        .reverse()
        .map((cap) => [`${cap.source}\u0000${cap.kind}\u0000${cap.limit}`, cap]),
    ).values(),
  ].reverse();
  // Caps bind in the QUANTIZED score space: a cap constrains the published
  // score whenever the rounded uncapped score would exceed the floored cap
  // limit, even if the raw score sits below the fractional limit (VER-001).
  const quantizedUncapped = preCapScoreRaw === null ? null : roundTo(preCapScoreRaw, formula.scoreDecimals);
  const bindingCandidate =
    preCapScoreRaw === null || quantizedUncapped === null
      ? null
      : ([...dedupedCandidates]
          .filter((cap) => floorTo(cap.limit, formula.scoreDecimals) < quantizedUncapped)
          .sort(
            (left, right) =>
              left.limit - right.limit ||
              capPriority(left.source, policy) - capPriority(right.source, policy) ||
              compareCodeUnits(left.kind, right.kind),
          )[0] ?? null);
  const caps = dedupedCandidates.map<V9CapTrace>((cap) => ({ ...cap, binding: cap === bindingCandidate }));
  const rateable = nrReasons.length === 0 && preCapScoreRaw !== null;
  const rawFinal = rateable ? Math.min(preCapScoreRaw!, bindingCandidate?.limit ?? SCORE_MAX) : null;
  const baseFinalScore =
    rawFinal === null
      ? null
      : bindingCandidate
        ? floorTo(rawFinal, formula.scoreDecimals)
        : roundTo(rawFinal, formula.scoreDecimals);

  // Reshape gates (Levers 1 & 2) read danger through per-gate lenses (D1):
  // the withhold gate keeps the full predicate (measured-adverse is never
  // NR-withheld), the F-gate narrows to hard danger (F stays danger-only).
  const dangerSignalInput = {
    pillars: input.pillars,
    structuralSignals: input.structuralSignals,
    pegMultiplier: pegMultiplierRaw,
    activeDepegBps: input.activeDepegBps,
    parentRequired: input.parentRequired,
    parentScore: input.parentScore,
    unresolvedCodes: input.unresolved
      .filter((fact) => fact.responsibility === "measured-adverse")
      .map((fact) => fact.code),
  };
  const withholdDangerPresent = hasV9DangerSignal(dangerSignalInput, policy, "withhold");

  const effectiveNrReasons = [...nrReasons];
  let finalScore = baseFinalScore;
  const finalCaps: readonly V9CapTrace[] = caps;
  const finalBindingCap: V9CapTrace | null = bindingCandidate ? { ...bindingCandidate, binding: true } : null;

  // LEVER 1 — widen the insufficient-evidence withhold. Evaluated BEFORE Lever 2:
  // a withheld asset returns NR (finalScore null) and never reaches the gate.
  // The withhold requires the BACKING pillar itself to be unverifiable: an asset
  // with strong/adequate backing is assessable (a low exit/control score is a
  // real partial rating), so only genuinely-opaque assets (backing limited too)
  // are withheld — this keeps strong-backing majors from ever going NR.
  if (
    finalScore !== null &&
    limitedPillarCount >= 2 &&
    backingLimited &&
    !withholdDangerPresent &&
    finalScore < WITHHOLD_BAND_MAX_SCORE
  ) {
    effectiveNrReasons.push({
      code: "insufficient-evidence",
      field: "evidenceLevel",
      message: "Critical evidence is insufficient for a v9 research rating.",
    });
    finalScore = null;
  }

  const adverseAttribution = canonicalAdverseAttribution([
    ...measuredPillarAdverseAttribution,
    ...unresolvedFacts.flatMap<V9AdverseAttribution>((fact) =>
      unresolvedFactAffectedScore(fact, bindingCandidate, policy)
        ? [{
            source: "reason",
            path: fact.path ?? `reason:${fact.code}`,
            message: fact.reason,
            responsibility: "measured-adverse",
          }]
        : [],
    ),
    ...input.structuralSignals.flatMap<V9AdverseAttribution>((signal) =>
      signal.severity === "low" ||
      signalLimit(signal, policy) === null ||
      !structuralSignalAffectedScore(signal, input.structuralSignals, scopedRisk, bindingCandidate, policy)
        ? []
        : [{
            source: "structural-signal",
            path: `structural:${signal.kind}:${signal.severity}`,
            message: signal.reason,
            responsibility: "measured-adverse",
          }],
    ),
    ...scenarioCaps.flatMap<V9AdverseAttribution>((cap) =>
      (cap.pricedInPillar !== undefined ||
        (bindingCandidate?.source === "structural" &&
          bindingCandidate.kind === cap.kind &&
          bindingCandidate.limit === cap.limit))
        ? [{
            source: "structural-signal",
            path:
              cap.pricedInPillar === undefined
                ? `scenario-cap:${cap.kind}`
                : `scenario-pillar:${cap.pricedInPillar}:${cap.kind}`,
            message: cap.reason,
            responsibility: cap.responsibility,
          }]
        : [],
    ),
    ...(bindingCandidate?.source === "parent"
      ? propagatedParentAdverseAttribution
      : []),
    ...(bindingCandidate?.source === "parent"
      ? wrapperLocalAdverseAttribution
      : []),
    ...(bindingCandidate?.source === "active-depeg"
      ? [{
          source: "active-depeg" as const,
          path: "peg:active-depeg",
          message: `Active depeg peak is ${input.activeDepegBps} bps.`,
          responsibility: "measured-adverse" as const,
        }]
      : []),
    ...(typeof pegMultiplierRaw === "number" && pegMultiplierRaw < DANGER_PEG_MULTIPLIER_FLOOR
      ? [{
          source: "peg-performance" as const,
          path: "peg:historical-performance",
          message: `Measured peg multiplier is ${roundTo(pegMultiplierRaw, 6)}.`,
          responsibility: "measured-adverse" as const,
        }]
      : []),
  ]);
  const boundedUncertaintyAttribution = canonicalBoundedUncertaintyAttribution([
    ...unresolvedFacts.flatMap((fact) => {
      const attribution = boundedUncertaintyForFact(
        fact,
        input.pillars,
        bindingCandidate,
        policy,
        pillarReasonProvenance,
      );
      return attribution === null ? [] : [attribution];
    }),
    ...(bindingCandidate?.source === "parent"
      ? propagatedParentBoundedUncertaintyAttribution
      : []),
    ...(bindingCandidate?.source === "parent"
      ? wrapperLocalBoundedUncertaintyAttribution
      : []),
  ]);

  // A low public grade needs a causal account. D may be measured weakness or a
  // provisional result shaped by explicit policy-bounded uncertainty. F remains
  // danger-only and therefore always requires measured-adverse attribution.
  const attributedGrade =
    finalScore === null ? null : gradeForScore(finalScore, policy);
  if (
    finalScore !== null &&
    attributedGrade === "D" &&
    adverseAttribution.length === 0 &&
    boundedUncertaintyAttribution.length === 0
  ) {
    effectiveNrReasons.push({
      code: "insufficient-evidence",
      field: "boundedUncertaintyAttribution",
      message: "A D rating requires causal measured-adverse or bounded-uncertainty attribution.",
      responsibility: "method-unsupported",
    });
    finalScore = null;
  } else if (
    finalScore !== null &&
    attributedGrade !== null &&
    DANGER_ONLY_GRADES.has(attributedGrade) &&
    adverseAttribution.length === 0
  ) {
    effectiveNrReasons.push({
      code: "insufficient-evidence",
      field: "adverseAttribution",
      message: "An F rating requires at least one attributable measured-adverse fact.",
      responsibility: "method-unsupported",
    });
    finalScore = null;
  }

  assertV9ReasonCodesRegistered(
    policy,
    effectiveNrReasons.map((reason) => reason.code),
  );

  return {
    assetId: input.assetId,
    policyId: policy.policy.policyId,
    policyDigest: policy.semanticDigest,
    configName: policy.policy.policyId,
    pillarContributions,
    weightedQuality: weightedQualityRaw === null ? null : roundTo(weightedQualityRaw, 4),
    weakestPillar,
    aggregation:
      aggregationRaw === null || aggregationHeadroom === null
        ? null
        : {
            ...aggregationRaw,
            score: roundTo(aggregationRaw.score, 4),
            weightedQuality: roundTo(aggregationRaw.weightedQuality, 4),
            weakestScore: roundTo(aggregationRaw.weakestScore, 4),
            headroom: aggregationHeadroom,
          },
    pegMultiplier: pegMultiplierRaw === null ? null : roundTo(pegMultiplierRaw, 6),
    baseAssetScore: baseAssetScoreRaw === null ? null : roundTo(baseAssetScoreRaw, 4),
    deploymentAdjustedScore: scopedRisk === null ? null : roundTo(scopedRisk.finalScore, 4),
    deploymentAdjustments:
      scopedRisk?.adjustments.map((adjustment) => ({
        ...adjustment,
        scoreBefore: roundTo(adjustment.scoreBefore, 4),
        scoreAfter: roundTo(adjustment.scoreAfter, 4),
        adjustmentPoints: roundTo(adjustment.adjustmentPoints, 4),
      })) ?? [],
    unresolvedDeploymentSignals: scopedRisk?.unresolvedDeploymentSignals ?? [],
    preCapScore: preCapScoreRaw === null ? null : roundTo(preCapScoreRaw, 4),
    caps: finalCaps,
    bindingCap: finalBindingCap,
    structuralSignals: input.structuralSignals,
    finalScore,
    finalGrade: finalScore === null ? "NR" : gradeForScore(finalScore, policy),
    adverseAttribution,
    boundedUncertaintyAttribution,
    unresolvedFacts,
    nrReasons: effectiveNrReasons,
    propagatedParentReasons,
  };
}

/** Score expectation-free V9 facts under one explicit, validated policy. */
export function scoreV9Input(
  rawInput: V9ScoringInput,
  policy: V9ValidatedPolicyEnvelope,
  propagatedParentReasons: readonly V9NRReason[] = [],
  limitedPillarCount = 0,
  backingLimited = false,
  propagatedParentAdverseAttribution: readonly V9ParentAdverseAttribution[] = [],
  measuredPillarAdverseAttribution: readonly V9PillarAdverseAttribution[] = [],
  propagatedParentBoundedUncertaintyAttribution:
    readonly V9ParentBoundedUncertaintyAttribution[] = [],
  wrapperLocalAdverseAttribution: readonly V9AdverseAttribution[] = [],
  wrapperLocalBoundedUncertaintyAttribution:
    readonly V9BoundedUncertaintyAttribution[] = [],
  pillarReasonProvenance: readonly V9PillarReasonProvenance[] = [],
): V9ScoreTrace {
  return scoreV9InputWithCaps(
    rawInput,
    policy,
    [],
    propagatedParentReasons,
    limitedPillarCount,
    backingLimited,
    propagatedParentAdverseAttribution,
    measuredPillarAdverseAttribution,
    propagatedParentBoundedUncertaintyAttribution,
    wrapperLocalAdverseAttribution,
    wrapperLocalBoundedUncertaintyAttribution,
    pillarReasonProvenance,
  );
}

/** @internal Golden-corpus adapter; arbitrary caps are not accepted by production scoring input. */
export function scoreV9InputWithScenarioCaps(
  rawInput: V9ScoringInput,
  policy: V9ValidatedPolicyEnvelope,
  scenarioCaps: readonly V9AttributedScenarioCap[],
): V9ScoreTrace {
  return scoreV9InputWithCaps(rawInput, policy, scenarioCaps);
}
