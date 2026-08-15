import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  aggregateV9GeneralizedMean,
  aggregateV9SmoothBoundedHeadroom,
  type V9AggregationPillars,
  type V9WeakestPathAggregationTrace,
} from "@shared/lib/safety-score-v9/aggregation";
import { decimalSnap } from "@shared/lib/safety-score-v9/formula";
import {
  resolveV9ReasonPolicy,
  V9_CANDIDATE_POLICY_V1,
} from "@shared/lib/safety-score-v9/policy";
import { applyV9AllocatedScopedRiskAdjustments } from "@shared/lib/safety-score-v9/scoped-risk";
import {
  V9CapSourceSchema,
  V9ReasonCodeSchema,
  V9StructuralSignalSchema,
} from "@shared/types/safety-score-v9";
import { V9EvidenceResponsibilitySchema } from "@shared/types/safety-score-v9-fact-primitives";

const AdverseAttributionSchema = z.object({
  source: z.enum([
    "active-depeg",
    "parent-score",
    "peg-performance",
    "pillar-score",
    "reason",
    "structural-signal",
    "track-record",
    "wrapper-local",
  ]),
  path: z.string().min(1),
  message: z.string().min(1),
  responsibility: z.literal("measured-adverse"),
}).strict();

const BoundedUncertaintyAttributionSchema = z.object({
  source: z.enum(["parent-score", "reason", "wrapper-local"]),
  code: V9ReasonCodeSchema,
  path: z.string().min(1),
  message: z.string().min(1),
  responsibility: V9EvidenceResponsibilitySchema.exclude(["measured-adverse"]),
  boundedness: z.enum(["exposure-bounded", "globally-bounded"]),
}).strict();

const PillarReasonSchema = z.object({
  code: V9ReasonCodeSchema,
  path: z.string().min(1),
  message: z.string().min(1),
  responsibility: V9EvidenceResponsibilitySchema,
}).strict();

const PillarAdverseAttributionSchema = AdverseAttributionSchema.extend({
  source: z.literal("pillar-score"),
});

const ReplayPillarSchema = z.object({
  score: z.number().nullable(),
  reasons: z.array(PillarReasonSchema).default([]),
  structuralSignals: z.array(V9StructuralSignalSchema).default([]),
  adverseAttribution: z.array(PillarAdverseAttributionSchema).default([]),
}).passthrough();

const ReplayPillarsSchema = z.object({
  backing: ReplayPillarSchema,
  exit: ReplayPillarSchema,
  control: ReplayPillarSchema,
});

const ReplayScoreInputSchema = z.object({
  pillars: ReplayPillarsSchema,
  peg: z.object({
    activeDepegBps: z.number().nonnegative().nullable(),
    reasons: z.array(PillarReasonSchema).default([]),
  }).passthrough().default({ activeDepegBps: null, reasons: [] }),
  parent: z.object({
    score: z.number().nullable(),
  }).passthrough().default({ score: null }),
  dependencyReasons: z.array(PillarReasonSchema).default([]),
  methodologyReasons: z.array(PillarReasonSchema).default([]),
  dependencyStructuralSignals: z.array(V9StructuralSignalSchema).default([]),
}).passthrough();

const ReplaySchema = z.object({
  pipeline: z.object({
    evaluatedSet: z.object({
      policyId: z.string(),
      policyDigest: z.string(),
      evaluationBuildDigest: z.string(),
      factSetDigest: z.string(),
      baseInputGenerationId: z.string(),
      asOfSec: z.number().int(),
      assets: z.array(
        z.object({
          assetId: z.string(),
          scoreInput: ReplayScoreInputSchema,
          trace: z.object({
            finalScore: z.number().nullable(),
            finalGrade: z.string(),
            pegMultiplier: z.number().nullable(),
            deploymentAdjustments: z.array(
              z.object({
                signalKey: z.string(),
                exposureKey: z.string(),
                riskEventKey: z.string(),
                failureDomainKey: z.string(),
                nominalExposureShare: z.number().min(0).max(1),
                  exposureShare: z.number().min(0).max(1),
                  exposedScore: z.number().min(0).max(100),
                  sourceSignalKeys: z.array(z.string().min(1)).default([]),
                }).passthrough(),
            ).default([]),
            caps: z.array(
              z.object({
                source: V9CapSourceSchema,
                kind: z.string(),
                limit: z.number(),
                reason: z.string().min(1),
              }).passthrough(),
            ),
            adverseAttribution: z.array(AdverseAttributionSchema),
            boundedUncertaintyAttribution: z.array(BoundedUncertaintyAttributionSchema).default([]),
          }).passthrough(),
        }),
      ),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const WEIGHTS = V9_CANDIDATE_POLICY_V1.policy.semantic.formula.pillarWeights;
const SCORE_DECIMALS = V9_CANDIDATE_POLICY_V1.policy.semantic.formula.scoreDecimals;
const POLICY_HEADROOM = V9_CANDIDATE_POLICY_V1.policy.semantic.formula.compensabilityHeadroom;
const POLICY_CONTROL_HEADROOM =
  V9_CANDIDATE_POLICY_V1.policy.semantic.formula.controlCompensabilityHeadroom;
const C_MINUS_FLOOR =
  V9_CANDIDATE_POLICY_V1.policy.semantic.formula.gradeThresholds.find(
    (threshold) => threshold.grade === "C-",
  )!.minScore;

interface Candidate {
  id: string;
  aggregate(pillars: V9AggregationPillars): V9WeakestPathAggregationTrace;
}

function weakestPillar(pillars: V9AggregationPillars): keyof V9AggregationPillars {
  return (["backing", "exit", "control"] as const).reduce((weakest, pillar) =>
    pillars[pillar] < pillars[weakest] ? pillar : weakest,
  );
}

const CANDIDATES: readonly Candidate[] = [
  {
    id: "smooth-bounded-headroom:policy",
    aggregate: (pillars) =>
      aggregateV9SmoothBoundedHeadroom(pillars, WEIGHTS, POLICY_HEADROOM),
  },
  {
    id: "smooth-bounded-headroom:legacy-control-selector",
    aggregate: (pillars) =>
      aggregateV9SmoothBoundedHeadroom(
        pillars,
        WEIGHTS,
        weakestPillar(pillars) === "control" ? POLICY_CONTROL_HEADROOM : POLICY_HEADROOM,
      ),
  },
  {
    id: "smooth-bounded-headroom:h20",
    aggregate: (pillars) => aggregateV9SmoothBoundedHeadroom(pillars, WEIGHTS, 20),
  },
  {
    id: "smooth-bounded-headroom:h30",
    aggregate: (pillars) => aggregateV9SmoothBoundedHeadroom(pillars, WEIGHTS, 30),
  },
  {
    id: "smooth-bounded-headroom:h45",
    aggregate: (pillars) => aggregateV9SmoothBoundedHeadroom(pillars, WEIGHTS, 45),
  },
  {
    id: "smooth-bounded-headroom:h45-control30",
    aggregate: (pillars) =>
      aggregateV9SmoothBoundedHeadroom(
        pillars,
        WEIGHTS,
        weakestPillar(pillars) === "control" ? 30 : 45,
      ),
  },
  {
    id: "smooth-bounded-headroom:h60",
    aggregate: (pillars) => aggregateV9SmoothBoundedHeadroom(pillars, WEIGHTS, 60),
  },
  {
    id: "generalized-mean:p-2",
    aggregate: (pillars) => aggregateV9GeneralizedMean(pillars, WEIGHTS, -2),
  },
  {
    id: "generalized-mean:p-4",
    aggregate: (pillars) => aggregateV9GeneralizedMean(pillars, WEIGHTS, -4),
  },
];

function quantize(value: number, capped: boolean): number {
  const factor = 10 ** SCORE_DECIMALS;
  return (capped ? Math.floor(decimalSnap(value * factor)) : Math.round(decimalSnap(value * factor))) / factor;
}

function applyDeploymentAdjustments(
  baseScore: number,
  adjustments: readonly {
    exposureShare: number;
    exposedScore: number;
  }[],
): number {
  return applyV9AllocatedScopedRiskAdjustments(baseScore, adjustments);
}

function gradeForScore(score: number): string {
  return (
    V9_CANDIDATE_POLICY_V1.policy.semantic.formula.gradeThresholds.find(
      (threshold) => score >= threshold.minScore,
    )?.grade ?? "F"
  );
}

function capPriority(source: z.infer<typeof V9CapSourceSchema>): number {
  const priority =
    V9_CANDIDATE_POLICY_V1.policy.semantic.formula.capTiePriority.indexOf(source);
  return priority === -1
    ? V9_CANDIDATE_POLICY_V1.policy.semantic.formula.capTiePriority.length
    : priority;
}

type ReplayScoreInput = z.infer<typeof ReplayScoreInputSchema>;
type ReplayCap = {
  source: z.infer<typeof V9CapSourceSchema>;
  kind: string;
  limit: number;
  reason: string;
};
type ReplayDeploymentAdjustment = {
  exposureShare: number;
  exposedScore: number;
  sourceSignalKeys: readonly string[];
};

function scoreInputReasons(input: ReplayScoreInput): z.infer<typeof PillarReasonSchema>[] {
  return [
    ...input.pillars.backing.reasons,
    ...input.pillars.exit.reasons,
    ...input.pillars.control.reasons,
    ...input.peg.reasons,
    ...input.dependencyReasons,
    ...input.methodologyReasons,
  ];
}

function scoreInputStructuralSignals(
  input: ReplayScoreInput,
): z.infer<typeof V9StructuralSignalSchema>[] {
  return [
    ...input.pillars.backing.structuralSignals,
    ...input.pillars.exit.structuralSignals,
    ...input.pillars.control.structuralSignals,
    ...input.dependencyStructuralSignals,
  ];
}

function scopedSignalKey(signal: z.infer<typeof V9StructuralSignalSchema>): string {
  const domains = [...signal.failureDomainKeys].sort();
  return [
    "signal",
    signal.kind,
    signal.severity,
    signal.exposureKey ?? "unscoped",
    signal.riskEventKey ?? "event-unidentified",
    domains.join("+") || signal.reason,
  ].join(":");
}

function structuralAttributionApplies(
  item: z.infer<typeof AdverseAttributionSchema>,
  input: ReplayScoreInput,
  bindingCap: ReplayCap | null,
  baseAssetScore: number,
  deploymentAdjustments: readonly ReplayDeploymentAdjustment[],
): boolean {
  const signals = scoreInputStructuralSignals(input);
  const matchingSignals = signals.filter(
    (signal) =>
      signal.responsibility === "measured-adverse" &&
      item.path === `structural:${signal.kind}:${signal.severity}` &&
      item.message === signal.reason,
  );
  return matchingSignals.some((signal) => {
    if (
      signal.pricedInPillar !== undefined &&
      input.pillars[signal.pricedInPillar].structuralSignals.some(
        (candidate) =>
          candidate.kind === signal.kind &&
          candidate.severity === signal.severity &&
          candidate.reason === signal.reason &&
          candidate.responsibility === signal.responsibility,
      )
    ) {
      return true;
    }
    if (
      signal.economicLossScope === "deployment" &&
      deploymentAdjustments.some(
        (adjustment) =>
          adjustment.sourceSignalKeys.includes(scopedSignalKey(signal)) &&
          adjustment.exposureShare > 0 &&
          baseAssetScore > adjustment.exposedScore,
      )
    ) {
      return true;
    }
    if (bindingCap?.source !== "structural") return false;
    if (
      bindingCap.kind === `signal:${signal.kind}:${signal.severity}` &&
      bindingCap.reason === signal.reason
    ) {
      return true;
    }
    if (
      bindingCap.kind !== "signal:common-mode-oracle" ||
      signal.kind !== "weak-oracle-branch"
    ) {
      return false;
    }
    const oracleDomainCounts = new Map<string, number>();
    for (const candidate of signals.filter(
      (value) =>
        value.kind === "weak-oracle-branch" &&
        value.responsibility === "measured-adverse",
    )) {
      for (const domain of new Set(candidate.failureDomainKeys)) {
        oracleDomainCounts.set(domain, (oracleDomainCounts.get(domain) ?? 0) + 1);
      }
    }
    return signal.failureDomainKeys.some((domain) => {
      const count = oracleDomainCounts.get(domain) ?? 0;
      return (
        count >=
          V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.commonModeOracleMinBranches &&
        bindingCap.reason === `${count} weak oracle branches share ${domain}.`
      );
    });
  });
}

export function adverseAttributionApplies(
  item: z.infer<typeof AdverseAttributionSchema>,
  input: ReplayScoreInput,
  pegMultiplier: number,
  bindingCap: ReplayCap | null,
  baseAssetScore: number,
  deploymentAdjustments: readonly ReplayDeploymentAdjustment[],
): boolean {
  if (item.source === "parent-score" || item.source === "wrapper-local") {
    return (
      bindingCap?.source === "parent" &&
      input.parent.score !== null &&
      bindingCap.limit === input.parent.score
    );
  }
  if (item.source === "active-depeg") {
    return (
      item.path === "peg:active-depeg" &&
      input.peg.activeDepegBps !== null &&
      input.peg.activeDepegBps > 0 &&
      bindingCap?.source === "active-depeg"
    );
  }
  if (item.source === "peg-performance") {
    return item.path === "peg:historical-performance" && pegMultiplier < 0.9;
  }
  if (item.source === "pillar-score") {
    return (["backing", "exit", "control"] as const).some((pillar) =>
      input.pillars[pillar].adverseAttribution.some(
        (candidate) =>
          candidate.path === item.path &&
          candidate.message === item.message &&
          candidate.responsibility === item.responsibility,
      ),
    );
  }
  if (item.source === "reason") {
    return scoreInputReasons(input).some((candidate) => {
      if (
        candidate.path !== item.path ||
        candidate.message !== item.message ||
        candidate.responsibility !== item.responsibility
      ) {
        return false;
      }
      const policyReason = resolveV9ReasonPolicy(
        V9_CANDIDATE_POLICY_V1,
        candidate.code,
      );
      if (policyReason.critical || policyReason.reason.defaultTreatment === "pillar") {
        return true;
      }
      return (
        policyReason.reason.defaultTreatment === "ceiling" &&
        bindingCap?.source === "evidence" &&
        bindingCap.kind === `reason:${candidate.code}` &&
        bindingCap.reason === item.message
      );
    });
  }
  if (item.source === "structural-signal") {
    return structuralAttributionApplies(
      item,
      input,
      bindingCap,
      baseAssetScore,
      deploymentAdjustments,
    );
  }
  return false;
}

export function boundedAttributionApplies(
  item: z.infer<typeof BoundedUncertaintyAttributionSchema>,
  pillars: z.infer<typeof ReplayPillarsSchema>,
  bindingCap: ReplayCap | null,
): boolean {
  if (item.source === "parent-score" || item.source === "wrapper-local") {
    return bindingCap?.source === "parent";
  }
  const reason = V9_CANDIDATE_POLICY_V1.policy.reasonRegistry.find(
    (entry) => entry.code === item.code,
  );
  const matchesLowPillarReason = (["backing", "exit", "control"] as const).some(
    (pillar) =>
      pillars[pillar].score !== null &&
      pillars[pillar].score! < C_MINUS_FLOOR &&
      pillars[pillar].reasons.some(
        (candidate) =>
          candidate.code === item.code &&
          candidate.path === item.path &&
          candidate.message === item.message &&
          candidate.responsibility === item.responsibility,
      ),
  );
  if (matchesLowPillarReason) return true;
  return (
    reason?.defaultTreatment === "ceiling" &&
    bindingCap?.source === "evidence" &&
    bindingCap.kind === `reason:${item.code}` &&
    bindingCap.reason === item.message
  );
}

function histogram(rows: readonly { grade: string }[]): Record<string, number> {
  return Object.fromEntries(
    ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F", "NR"].map((grade) => [
      grade,
      rows.filter((row) => row.grade === grade).length,
    ]),
  );
}

function exactScorePileups(rows: readonly { score: number | null }[]) {
  const rated = rows.filter((row): row is { score: number } => row.score !== null);
  const counts = new Map<number, number>();
  for (const row of rated) counts.set(row.score, (counts.get(row.score) ?? 0) + 1);
  return [...counts.entries()]
    .map(([score, count]) => ({ score, count, share: count / rated.length }))
    .sort((left, right) => right.count - left.count || left.score - right.score);
}

export function buildV9AggregationCounterfactual(input: unknown, inputPath = "<memory>") {
  const replay = ReplaySchema.parse(input);
  const evaluated = replay.pipeline.evaluatedSet;
  const results = CANDIDATES.map((candidate) => {
    const assets = evaluated.assets.map((asset) => {
      const pillarInputs = asset.scoreInput.pillars;
      const pillars = {
        backing: pillarInputs.backing.score,
        exit: pillarInputs.exit.score,
        control: pillarInputs.control.score,
      };
      if (asset.trace.finalScore === null || asset.trace.pegMultiplier === null || Object.values(pillars).includes(null)) {
        return {
          assetId: asset.assetId,
          baselineScore: asset.trace.finalScore,
          baselineGrade: asset.trace.finalGrade,
          score: null,
          grade: "NR",
          aggregation: null,
          bindingCap: null,
        };
      }
      const aggregation = candidate.aggregate(pillars as V9AggregationPillars);
      const baseAssetScore = aggregation.score * asset.trace.pegMultiplier;
      const preCap = applyDeploymentAdjustments(baseAssetScore, asset.trace.deploymentAdjustments);
      const retainedCaps = asset.trace.caps.filter((cap) => cap.source !== "bounded-compensability");
      const bindingCap = retainedCaps
        .filter((cap) => cap.limit < quantize(preCap, false))
        .sort(
          (left, right) =>
            left.limit - right.limit ||
            capPriority(left.source) - capPriority(right.source) ||
            left.kind.localeCompare(right.kind),
        )[0] ?? null;
      const rawScore = Math.min(preCap, bindingCap?.limit ?? 100);
      const candidateScore = quantize(rawScore, bindingCap !== null);
      const candidateGrade = gradeForScore(candidateScore);
      const adverseAttribution = asset.trace.adverseAttribution.filter((item) =>
        adverseAttributionApplies(
          item,
          asset.scoreInput,
          asset.trace.pegMultiplier!,
          bindingCap,
          baseAssetScore,
          asset.trace.deploymentAdjustments,
        ),
      );
      const boundedUncertaintyAttribution =
        asset.trace.boundedUncertaintyAttribution.filter((item) =>
          boundedAttributionApplies(item, pillarInputs, bindingCap),
        );
      const score =
        (
          candidateGrade === "F" &&
          adverseAttribution.length === 0
        ) ||
        (
          candidateGrade === "D" &&
          adverseAttribution.length === 0 &&
          boundedUncertaintyAttribution.length === 0
        )
          ? null
          : candidateScore;
      return {
        assetId: asset.assetId,
        baselineScore: asset.trace.finalScore,
        baselineGrade: asset.trace.finalGrade,
        score,
        grade: score === null ? "NR" : candidateGrade,
        aggregation,
        baseAssetScore,
        deploymentAdjustedScore: preCap,
        bindingCap,
      };
    });
    const rated = assets.filter((asset) => asset.score !== null);
    return {
      candidateId: candidate.id,
      ratedCount: rated.length,
      histogram: histogram(assets),
      exactScorePileups: exactScorePileups(assets).slice(0, 20),
      assets,
    };
  });
  const output = {
    schemaVersion: 1,
    kind: "safety-score-v9-aggregation-counterfactual",
    input: {
      path: inputPath === "<memory>" ? inputPath : resolve(inputPath),
      policyId: evaluated.policyId,
      policyDigest: evaluated.policyDigest,
      evaluationBuildDigest: evaluated.evaluationBuildDigest,
      factSetDigest: evaluated.factSetDigest,
      baseInputGenerationId: evaluated.baseInputGenerationId,
      asOfSec: evaluated.asOfSec,
    },
    isolation: {
      retained:
        "peg multiplier, scoped deployment semantics, non-compensability caps, baseline rateability, D measured-or-bounded attribution, and F measured-adverse attribution",
      changed: "only the weakest-path aggregation",
    },
    results,
  };
  return output;
}

export function runV9AggregationCounterfactualCli(argv: readonly string[]): void {
  const inputPath = argv[0];
  const outputPath = argv[1];
  if (!inputPath) {
    throw new Error(
      "Usage: tsx scripts/maintenance/replay-safety-score-v9-aggregation.ts <replay.json> [output.json]",
    );
  }
  const output = buildV9AggregationCounterfactual(
    JSON.parse(readFileSync(resolve(inputPath), "utf8")),
    inputPath,
  );
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (outputPath) writeFileSync(resolve(outputPath), serialized);
  else process.stdout.write(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runV9AggregationCounterfactualCli(process.argv.slice(2));
}
