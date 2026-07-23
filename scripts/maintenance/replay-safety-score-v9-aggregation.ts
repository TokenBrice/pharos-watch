import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  aggregateV9GeneralizedMean,
  aggregateV9SmoothBoundedHeadroom,
  type V9AggregationPillars,
  type V9WeakestPathAggregationTrace,
} from "../../shared/lib/safety-score-v9/aggregation";
import { decimalSnap } from "../../shared/lib/safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../../shared/lib/safety-score-v9/policy";
import { applyV9AllocatedScopedRiskAdjustments } from "../../shared/lib/safety-score-v9/scoped-risk";

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
          scoreInput: z.object({
            pillars: z.object({
              backing: z.object({ score: z.number().nullable() }).passthrough(),
              exit: z.object({ score: z.number().nullable() }).passthrough(),
              control: z.object({ score: z.number().nullable() }).passthrough(),
            }),
          }).passthrough(),
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
              }).passthrough(),
            ).default([]),
            caps: z.array(
              z.object({
                source: z.string(),
                kind: z.string(),
                limit: z.number(),
              }).passthrough(),
            ),
            adverseAttribution: z.array(z.unknown()).default([]),
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
      const pillars = {
        backing: asset.scoreInput.pillars.backing.score,
        exit: asset.scoreInput.pillars.exit.score,
        control: asset.scoreInput.pillars.control.score,
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
        .sort((left, right) => left.limit - right.limit || left.kind.localeCompare(right.kind))[0] ?? null;
      const rawScore = Math.min(preCap, bindingCap?.limit ?? 100);
      const candidateScore = quantize(rawScore, bindingCap !== null);
      const candidateGrade = gradeForScore(candidateScore);
      const score =
        (candidateGrade === "D" || candidateGrade === "F") &&
        asset.trace.adverseAttribution.length === 0
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
        "peg multiplier, scoped deployment semantics, non-compensability caps, baseline rateability, and D/F adverse-attribution requirements",
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
