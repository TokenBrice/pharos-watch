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
const EPSILON = 1e-9;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clampScore(value: number): number {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, value));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function floorTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
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

function capPriority(source: V9CapTrace["source"], policy: V9ValidatedPolicyEnvelope): number {
  const priority = policy.policy.semantic.formula.capTiePriority.indexOf(source);
  return priority === -1 ? policy.policy.semantic.formula.capTiePriority.length : priority;
}

function scoreV9InputWithCaps(
  rawInput: V9ScoringInput,
  policy: V9ValidatedPolicyEnvelope,
  scenarioCaps: readonly V9StructuralCap[],
  propagatedParentReasons: readonly V9NRReason[] = [],
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
  if (input.pegApplicable && input.pegScore === null) {
    nrReasons.push({
      code: "missing-applicable-peg",
      field: "pegScore",
      message: "A peg score is required when peg risk applies.",
    });
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
      ? null
      : input.pegScore === 0
        ? 0
        : (input.pegScore / 100) ** formula.pegExponent
    : 1;
  const preCapScoreRaw =
    weightedQualityRaw === null || pegMultiplierRaw === null ? null : clampScore(weightedQualityRaw * pegMultiplierRaw);

  const capCandidates: Omit<V9CapTrace, "binding">[] = [];
  capCandidates.push(...reasonCeilings);
  if (weakestPillar) {
    capCandidates.push({
      source: "bounded-compensability",
      kind: "bounded-compensability",
      limit: clampScore(weakestPillar.score + formula.compensabilityHeadroom),
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

  const bindingCandidate =
    preCapScoreRaw === null
      ? null
      : ([...capCandidates]
          .filter((cap) => cap.limit < preCapScoreRaw - EPSILON)
          .sort(
            (left, right) =>
              left.limit - right.limit ||
              capPriority(left.source, policy) - capPriority(right.source, policy) ||
              compareCodeUnits(left.kind, right.kind),
          )[0] ?? null);
  const caps = capCandidates.map<V9CapTrace>((cap) => ({ ...cap, binding: cap === bindingCandidate }));
  const rateable = nrReasons.length === 0 && preCapScoreRaw !== null;
  const rawFinal = rateable ? Math.min(preCapScoreRaw!, bindingCandidate?.limit ?? SCORE_MAX) : null;
  const finalScore =
    rawFinal === null
      ? null
      : bindingCandidate
        ? floorTo(rawFinal, formula.scoreDecimals)
        : roundTo(rawFinal, formula.scoreDecimals);

  assertV9ReasonCodesRegistered(
    policy,
    nrReasons.map((reason) => reason.code),
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
    caps,
    bindingCap: bindingCandidate ? { ...bindingCandidate, binding: true } : null,
    structuralSignals: input.structuralSignals,
    finalScore,
    finalGrade: finalScore === null ? "NR" : gradeForScore(finalScore, policy),
    nrReasons,
    propagatedParentReasons,
  };
}

/** Score expectation-free V9 facts under one explicit, validated policy. */
export function scoreV9Input(
  rawInput: V9ScoringInput,
  policy: V9ValidatedPolicyEnvelope,
  propagatedParentReasons: readonly V9NRReason[] = [],
): V9ScoreTrace {
  return scoreV9InputWithCaps(rawInput, policy, [], propagatedParentReasons);
}

/** @internal Golden-corpus adapter; arbitrary caps are not accepted by production scoring input. */
export function scoreV9InputWithScenarioCaps(
  rawInput: V9ScoringInput,
  policy: V9ValidatedPolicyEnvelope,
  scenarioCaps: readonly V9StructuralCap[],
): V9ScoreTrace {
  return scoreV9InputWithCaps(rawInput, policy, scenarioCaps);
}
