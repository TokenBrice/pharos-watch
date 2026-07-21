import {
  V9ScoringInputSchema,
  type V9CapSource,
  type V9Grade,
  type V9QualityPillar,
  type V9ReasonCode,
  type V9ScoringInput,
  type V9StructuralSignal,
  type V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import {
  assertV9ReasonCodesRegistered,
  assertV9UnresolvedFactsMatchPolicy,
  assertV9ValidatedPolicyEnvelope,
  resolveV9ReasonPolicy,
} from "./policy";

const V9_QUALITY_PILLARS = ["backing", "exit", "control"] as const satisfies readonly V9QualityPillar[];

export interface V9StructuralCap {
  kind: string;
  limit: number;
  reason: string;
}

export type V9NRReasonCode = V9ReasonCode;

export interface V9NRReason {
  code: V9NRReasonCode;
  message: string;
  field?: string;
}

export interface V9CapTrace extends V9StructuralCap {
  source: V9CapSource;
  binding: boolean;
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
  pegMultiplier: number | null;
  preCapScore: number | null;
  caps: readonly V9CapTrace[];
  bindingCap: V9CapTrace | null;
  structuralSignals: readonly V9StructuralSignal[];
  finalScore: number | null;
  finalGrade: V9Grade;
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
// Cap sources that do not hold an F on the merits: a binding cap from any of
// these is an evidence/compensability/track-record ceiling, not adverse.
const NON_ADVERSE_CAP_SOURCES = new Set<V9CapSource>(["bounded-compensability", "evidence", "track-record"]);

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

function gradeForScore(score: number, policy: V9ValidatedPolicyEnvelope): V9Grade {
  return policy.policy.semantic.formula.gradeThresholds.find((threshold) => score >= threshold.minScore)?.grade ?? "F";
}

function signalLimit(signal: V9StructuralSignal, policy: V9ValidatedPolicyEnvelope): number | null {
  if (
    signal.kind === "material-bridge" &&
    (signal.materialSharePct ?? 100) < policy.policy.semantic.materiality.deploymentMaterialSharePct
  ) {
    return null;
  }
  return policy.policy.semantic.structural.signalLimits[signal.kind][signal.severity];
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
  const firedCriticalSignal = resolveV9StructuralCaps(input.structuralSignals, policy).some(
    (cap) => cap.kind.startsWith("signal:") && cap.kind.endsWith(":critical"),
  );
  // (2) Active depeg in any band.
  const activeDepeg = input.activeDepegBps !== null && input.activeDepegBps > 0;
  // (3) A required, rated parent imposes a parent cap.
  const parentCap = input.parentRequired && input.parentScore !== null;
  // (4) Centralized mint: critical always; high only for the withhold gate.
  const centralizedMint = input.structuralSignals.some(
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
  const activeControlIncident = input.structuralSignals.some(
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

function capPriority(source: V9CapTrace["source"], policy: V9ValidatedPolicyEnvelope): number {
  const priority = policy.policy.semantic.formula.capTiePriority.indexOf(source);
  return priority === -1 ? policy.policy.semantic.formula.capTiePriority.length : priority;
}

function scoreV9InputWithCaps(
  rawInput: V9ScoringInput,
  policy: V9ValidatedPolicyEnvelope,
  scenarioCaps: readonly V9StructuralCap[],
  propagatedParentReasons: readonly V9NRReason[] = [],
  limitedPillarCount = 0,
  backingLimited = false,
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
    if (resolved.critical) {
      nrReasons.push({ code: fact.code, field: fact.path, message: fact.reason });
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
  const pegMultiplierRaw = input.pegApplicable
    ? input.pegScore === null
      ? pegUnverified
        ? 1
        : null
      : input.pegScore === 0
        ? 0
        : (input.pegScore / 100) ** formula.pegExponent
    : 1;
  const preCapScoreRaw =
    weightedQualityRaw === null || pegMultiplierRaw === null ? null : clampScore(weightedQualityRaw * pegMultiplierRaw);

  const capCandidates: Omit<V9CapTrace, "binding">[] = [];
  capCandidates.push(...reasonCeilings);
  if (weakestPillar) {
    // Triple-count fix, not a "conditional risk" discount. A centralized or
    // unbounded mint is a control fact that the score already prices twice: (1)
    // directly in the control pillar score, and (2) in the centralized-mint
    // structural signal ladder (high@59 / critical@39). Applying the flat +20
    // compensability cap to a control-weakest composite priced it a THIRD time —
    // re-cutting the same fact that both the pillar and the signal ladder had
    // already absorbed. The larger control-specific headroom removes that third
    // count so the composite reflects the honest pillar blend; the signal ladder
    // still binds for genuinely-worse cases. Backing/exit-weakest assets keep the
    // base headroom, where the compensability cap duplicates no structural signal.
    const headroom =
      weakestPillar.pillar === "control"
        ? formula.controlCompensabilityHeadroom
        : formula.compensabilityHeadroom;
    capCandidates.push({
      source: "bounded-compensability",
      kind: "bounded-compensability",
      limit: decimalSnap(clampScore(weakestPillar.score + headroom)),
      reason: `${weakestPillar.pillar} is the weakest pillar; compensation is bounded.`,
    });
  }
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
  for (const cap of resolveV9StructuralCaps(input.structuralSignals, policy)) {
    capCandidates.push({ source: "structural", ...cap });
  }
  for (const cap of scenarioCaps) capCandidates.push({ source: "structural", ...cap });

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
    unresolvedCodes: input.unresolved.map((fact) => fact.code),
  };
  const withholdDangerPresent = hasV9DangerSignal(dangerSignalInput, policy, "withhold");
  const fGateDangerPresent = hasV9DangerSignal(dangerSignalInput, policy, "f-gate");

  const effectiveNrReasons = [...nrReasons];
  let finalScore = baseFinalScore;
  let finalCaps: readonly V9CapTrace[] = caps;
  let finalBindingCap: V9CapTrace | null = bindingCandidate ? { ...bindingCandidate, binding: true } : null;

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

  // LEVER 2 — danger-gate F. A would-be-F composite with no danger and no
  // strictly sub-floor pillar, bound only by null / a non-adverse cap, is
  // floored to D; a synthetic `evidence-floor:d` cap preserves attribution.
  const dFloorScore = formula.gradeThresholds.find((threshold) => threshold.grade === "D")?.minScore ?? null;
  if (
    finalScore !== null &&
    dFloorScore !== null &&
    gradeForScore(finalScore, policy) === "F" &&
    !fGateDangerPresent &&
    !anyPillarBelowFloor(input.pillars, policy, "f-gate") &&
    (finalBindingCap === null || NON_ADVERSE_CAP_SOURCES.has(finalBindingCap.source))
  ) {
    const floorRow: V9CapTrace = {
      source: "evidence",
      kind: "evidence-floor:d",
      limit: dFloorScore,
      reason: "Evidence-gap composite floored to D; F is reserved for measured danger.",
      binding: true,
    };
    finalCaps = [...caps.map((cap) => ({ ...cap, binding: false })), floorRow];
    finalBindingCap = { ...floorRow };
    finalScore = dFloorScore;
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
    pegMultiplier: pegMultiplierRaw === null ? null : roundTo(pegMultiplierRaw, 6),
    preCapScore: preCapScoreRaw === null ? null : roundTo(preCapScoreRaw, 4),
    caps: finalCaps,
    bindingCap: finalBindingCap,
    structuralSignals: input.structuralSignals,
    finalScore,
    finalGrade: finalScore === null ? "NR" : gradeForScore(finalScore, policy),
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
): V9ScoreTrace {
  return scoreV9InputWithCaps(rawInput, policy, [], propagatedParentReasons, limitedPillarCount, backingLimited);
}

/** @internal Golden-corpus adapter; arbitrary caps are not accepted by production scoring input. */
export function scoreV9InputWithScenarioCaps(
  rawInput: V9ScoringInput,
  policy: V9ValidatedPolicyEnvelope,
  scenarioCaps: readonly V9StructuralCap[],
): V9ScoreTrace {
  return scoreV9InputWithCaps(rawInput, policy, scenarioCaps);
}
