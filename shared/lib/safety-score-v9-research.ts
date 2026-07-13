import {
  CompiledV9AssetInputSchema,
  V9ScoringInputSchema,
  type CompiledV9AssetInput,
  type V9EvidenceLevel,
  type V9Grade,
  type V9QualityPillar,
  type V9ScoringInput,
  type V9StructuralSignal,
  type V9UnresolvedFact,
} from "../types/safety-score-v9";

const V9_QUALITY_PILLARS = ["backing", "exit", "control"] as const satisfies readonly V9QualityPillar[];

export interface V9StructuralCap {
  kind: string;
  limit: number;
  reason: string;
}

export interface V9ScoringConfig {
  name: string;
  pillarWeights: Readonly<Record<V9QualityPillar, number>>;
  compensabilityHeadroom: number;
  pegExponent: number;
  evidenceCeilings: Readonly<Record<V9EvidenceLevel, number | null>>;
  trackRecordCeilings: readonly {
    minMonthsInclusive: number;
    maxMonthsExclusive: number | null;
    limit: number | null;
    kind: string;
    reason: string;
  }[];
  gradeThresholds: readonly { grade: Exclude<V9Grade, "NR">; minScore: number }[];
  scoreDecimals: number;
}

const PROVISIONAL_V9_RESEARCH_CONFIG = {
  name: "v9-readiness-shadow-1",
  pillarWeights: { backing: 0.4, exit: 0.35, control: 0.25 },
  compensabilityHeadroom: 20,
  pegExponent: 0.4,
  evidenceCeilings: { strong: null, adequate: 84, limited: 69, insufficient: null },
  trackRecordCeilings: [
    {
      minMonthsInclusive: 0,
      maxMonthsExclusive: 6,
      limit: 79,
      kind: "track-record:<6m",
      reason: "Less than six months of implementation history.",
    },
    {
      minMonthsInclusive: 6,
      maxMonthsExclusive: 24,
      limit: 84,
      kind: "track-record:<24m",
      reason: "Less than two years of implementation history.",
    },
    {
      minMonthsInclusive: 24,
      maxMonthsExclusive: 36,
      limit: 86,
      kind: "track-record:<36m",
      reason: "Less than three years of implementation history.",
    },
    {
      minMonthsInclusive: 36,
      maxMonthsExclusive: null,
      limit: null,
      kind: "track-record:>=36m",
      reason: "At least three years of implementation history.",
    },
  ],
  gradeThresholds: [
    { grade: "A+", minScore: 87 },
    { grade: "A", minScore: 83 },
    { grade: "A-", minScore: 80 },
    { grade: "B+", minScore: 75 },
    { grade: "B", minScore: 70 },
    { grade: "B-", minScore: 65 },
    { grade: "C+", minScore: 60 },
    { grade: "C", minScore: 55 },
    { grade: "C-", minScore: 50 },
    { grade: "D", minScore: 40 },
    { grade: "F", minScore: 0 },
  ],
  scoreDecimals: 0,
} as const satisfies V9ScoringConfig;

export type V9NRReasonCode =
  | "missing-pillar"
  | "insufficient-evidence"
  | "missing-applicable-peg"
  | "missing-parent-score"
  | "critical-unresolved"
  | "parent-cycle";

export interface V9NRReason {
  code: V9NRReasonCode;
  message: string;
  field?: string;
}

export interface V9CapTrace extends V9StructuralCap {
  source: "active-depeg" | "structural" | "parent" | "evidence" | "track-record" | "bounded-compensability";
  binding: boolean;
}

export interface V9ScoreTrace {
  assetId: string;
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

function gradeForScore(score: number, config: V9ScoringConfig): V9Grade {
  return config.gradeThresholds.find((threshold) => score >= threshold.minScore)?.grade ?? "F";
}

function signalLimit(signal: V9StructuralSignal): number | null {
  const severityLimit = { low: 84, moderate: 74, high: 59, critical: 39 } as const;
  switch (signal.kind) {
    case "unsafe-backing":
    case "algorithmic-reflexivity":
    case "active-control-incident":
      return severityLimit[signal.severity];
    case "speculative-credit":
      return Math.min(79, severityLimit[signal.severity]);
    case "centralized-mint":
    case "unreviewed-upgrade":
    case "weak-oracle-branch":
      return signal.severity === "low" ? null : severityLimit[signal.severity];
    case "critical-dependency":
      return signal.severity === "critical" ? 49 : signal.severity === "high" ? 64 : null;
    case "material-bridge":
      return (signal.materialSharePct ?? 100) >= 10 && signal.severity !== "low"
        ? severityLimit[signal.severity]
        : null;
    case "bounded-unknown":
      return signal.severity === "critical" ? 49 : signal.severity === "high" ? 69 : null;
    case "peripheral-bridge":
      return null;
  }
}

/** Resolve fact-shaped structural signals to provisional methodology ceilings. */
export function resolveV9StructuralCaps(signals: readonly V9StructuralSignal[]): V9StructuralCap[] {
  const sorted = [...signals].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.reason.localeCompare(right.reason) ||
      (left.materialSharePct ?? -1) - (right.materialSharePct ?? -1),
  );
  const caps = sorted.flatMap((signal) => {
    const limit = signalLimit(signal);
    return limit === null ? [] : [{ kind: `signal:${signal.kind}:${signal.severity}`, limit, reason: signal.reason }];
  });
  const oracleDomainCounts = new Map<string, number>();
  for (const signal of sorted.filter((item) => item.kind === "weak-oracle-branch")) {
    for (const key of new Set(signal.failureDomainKeys)) {
      oracleDomainCounts.set(key, (oracleDomainCounts.get(key) ?? 0) + 1);
    }
  }
  for (const [failureDomain, count] of [...oracleDomainCounts].sort(([left], [right]) => left.localeCompare(right))) {
    if (count < 2) continue;
    caps.push({
      kind: "signal:common-mode-oracle",
      limit: 49,
      reason: `${count} weak oracle branches share ${failureDomain}.`,
    });
  }
  return caps;
}

const CAP_PRIORITY: Readonly<Record<V9CapTrace["source"], number>> = {
  "active-depeg": 0,
  structural: 1,
  parent: 2,
  evidence: 3,
  "track-record": 4,
  "bounded-compensability": 5,
};

/** Score an expectation-free v9 research input without reading external state. */
export function scoreV9Input(
  rawInput: V9ScoringInput,
  config: V9ScoringConfig = PROVISIONAL_V9_RESEARCH_CONFIG,
  propagatedParentReasons: readonly V9NRReason[] = [],
): V9ScoreTrace {
  const input = V9ScoringInputSchema.parse(rawInput);
  const nrReasons: V9NRReason[] = [];
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
      const weight = config.pillarWeights[pillar];
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
  for (const fact of input.unresolved.filter((item) => item.critical)) {
    nrReasons.push({ code: "critical-unresolved", field: fact.path, message: `${fact.code}: ${fact.reason}` });
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
        : (input.pegScore / 100) ** config.pegExponent
    : 1;
  const preCapScoreRaw =
    weightedQualityRaw === null || pegMultiplierRaw === null ? null : clampScore(weightedQualityRaw * pegMultiplierRaw);

  const capCandidates: Omit<V9CapTrace, "binding">[] = [];
  if (weakestPillar) {
    capCandidates.push({
      source: "bounded-compensability",
      kind: "bounded-compensability",
      limit: clampScore(weakestPillar.score + config.compensabilityHeadroom),
      reason: `${weakestPillar.pillar} is the weakest pillar; compensation is bounded.`,
    });
  }
  const evidenceCeiling = config.evidenceCeilings[input.evidenceLevel];
  if (evidenceCeiling !== null) {
    capCandidates.push({
      source: "evidence",
      kind: `evidence:${input.evidenceLevel}`,
      limit: evidenceCeiling,
      reason: `${input.evidenceLevel} evidence ceiling.`,
    });
  }
  const trackRecordBand = config.trackRecordCeilings.find(
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
    const activeCap =
      input.activeDepegBps >= 2_500
        ? { limit: 39, kind: "active-depeg:f" }
        : input.activeDepegBps >= 1_000
          ? { limit: 49, kind: "active-depeg:d" }
          : null;
    if (activeCap) {
      capCandidates.push({
        source: "active-depeg",
        ...activeCap,
        reason: "Active peg impairment limits the candidate rating.",
      });
    }
  }
  if (input.parentScore !== null) {
    capCandidates.push({
      source: "parent",
      kind: "parent",
      limit: input.parentScore,
      reason: "A child cannot rate above its required parent.",
    });
  }
  for (const cap of input.structuralCaps) capCandidates.push({ source: "structural", ...cap });

  const bindingCandidate =
    preCapScoreRaw === null
      ? null
      : ([...capCandidates]
          .filter((cap) => cap.limit < preCapScoreRaw - EPSILON)
          .sort(
            (left, right) =>
              left.limit - right.limit ||
              CAP_PRIORITY[left.source] - CAP_PRIORITY[right.source] ||
              left.kind.localeCompare(right.kind),
          )[0] ?? null);
  const caps = capCandidates.map<V9CapTrace>((cap) => ({ ...cap, binding: cap === bindingCandidate }));
  const rateable = nrReasons.length === 0 && preCapScoreRaw !== null;
  const rawFinal = rateable ? Math.min(preCapScoreRaw!, bindingCandidate?.limit ?? SCORE_MAX) : null;
  const finalScore =
    rawFinal === null
      ? null
      : bindingCandidate
        ? floorTo(rawFinal, config.scoreDecimals)
        : roundTo(rawFinal, config.scoreDecimals);

  return {
    assetId: input.assetId,
    configName: config.name,
    pillarContributions,
    weightedQuality: weightedQualityRaw === null ? null : roundTo(weightedQualityRaw, 4),
    weakestPillar,
    pegMultiplier: pegMultiplierRaw === null ? null : roundTo(pegMultiplierRaw, 6),
    preCapScore: preCapScoreRaw === null ? null : roundTo(preCapScoreRaw, 4),
    caps,
    bindingCap: bindingCandidate ? { ...bindingCandidate, binding: true } : null,
    structuralSignals: input.structuralSignals,
    finalScore,
    finalGrade: finalScore === null ? "NR" : gradeForScore(finalScore, config),
    nrReasons,
    propagatedParentReasons,
  };
}

const EVIDENCE_RANK: Readonly<Record<V9EvidenceLevel, number>> = {
  strong: 0,
  adequate: 1,
  limited: 2,
  insufficient: 3,
};

function weakestEvidenceLevel(input: CompiledV9AssetInput): V9EvidenceLevel {
  return V9_QUALITY_PILLARS.map((pillar) => input.pillars[pillar].evidenceLevel).sort(
    (left, right) => EVIDENCE_RANK[right] - EVIDENCE_RANK[left],
  )[0]!;
}

function scoringInputFromCompiled(input: CompiledV9AssetInput, parentScore: number | null): V9ScoringInput {
  const unresolved: V9UnresolvedFact[] = [
    ...input.unresolved,
    ...input.peg.unresolved,
    ...V9_QUALITY_PILLARS.flatMap((pillar) => input.pillars[pillar].unresolved),
  ];
  return V9ScoringInputSchema.parse({
    assetId: input.assetId,
    pillars: {
      backing: input.pillars.backing.score,
      exit: input.pillars.exit.score,
      control: input.pillars.control.score,
    },
    pegScore: input.peg.score,
    pegApplicable: input.peg.applicable,
    evidenceLevel: weakestEvidenceLevel(input),
    trackRecordMonths: input.trackRecordMonths,
    activeDepegBps: input.peg.activeDepegBps,
    parentRequired: input.parent?.required ?? false,
    parentScore,
    structuralCaps: resolveV9StructuralCaps(input.structuralSignals),
    structuralSignals: input.structuralSignals,
    unresolved,
  });
}

/** Score one compiled asset. Numeric ceilings are resolved here, never stored in metadata. */
export function scoreCompiledAsset(
  rawInput: CompiledV9AssetInput,
  parentTrace: V9ScoreTrace | null = null,
  config: V9ScoringConfig = PROVISIONAL_V9_RESEARCH_CONFIG,
): V9ScoreTrace {
  const input = CompiledV9AssetInputSchema.parse(rawInput);
  return scoreV9Input(
    scoringInputFromCompiled(input, parentTrace?.finalScore ?? null),
    config,
    parentTrace?.nrReasons ?? [],
  );
}

export interface V9CompiledAssetSetResult {
  traces: readonly V9ScoreTrace[];
  evaluatedOrder: readonly string[];
}

/** Deterministic parent-first evaluation with explicit cycle and missing-parent NR traces. */
export function scoreCompiledAssetSet(
  rawInputs: readonly CompiledV9AssetInput[],
  config: V9ScoringConfig = PROVISIONAL_V9_RESEARCH_CONFIG,
): V9CompiledAssetSetResult {
  const inputs = rawInputs.map((input) => CompiledV9AssetInputSchema.parse(input));
  const byId = new Map<string, CompiledV9AssetInput>();
  for (const input of inputs) {
    if (byId.has(input.assetId)) throw new Error(`Duplicate compiled v9 asset ID: ${input.assetId}`);
    byId.set(input.assetId, input);
  }

  const traces = new Map<string, V9ScoreTrace>();
  const visiting = new Set<string>();
  const evaluatedOrder: string[] = [];

  const visit = (assetId: string): V9ScoreTrace => {
    const cached = traces.get(assetId);
    if (cached) return cached;
    const input = byId.get(assetId);
    if (!input) throw new Error(`Unknown compiled v9 asset: ${assetId}`);

    if (visiting.has(assetId)) {
      const trace = scoreCompiledAsset(input, null, config);
      const cycleTrace: V9ScoreTrace = {
        ...trace,
        finalScore: null,
        finalGrade: "NR",
        nrReasons: [
          ...trace.nrReasons.filter((reason) => reason.code !== "missing-parent-score"),
          { code: "parent-cycle", field: "parent.assetId", message: `Parent cycle includes ${assetId}.` },
        ],
      };
      traces.set(assetId, cycleTrace);
      return cycleTrace;
    }

    visiting.add(assetId);
    const parentTrace = input.parent && byId.has(input.parent.assetId) ? visit(input.parent.assetId) : null;
    visiting.delete(assetId);
    if (traces.has(assetId)) return traces.get(assetId)!;
    const trace = scoreCompiledAsset(input, parentTrace, config);
    traces.set(assetId, trace);
    evaluatedOrder.push(assetId);
    return trace;
  };

  for (const assetId of [...byId.keys()].sort()) visit(assetId);
  return {
    traces: [...traces.values()].sort((left, right) => left.assetId.localeCompare(right.assetId)),
    evaluatedOrder,
  };
}
