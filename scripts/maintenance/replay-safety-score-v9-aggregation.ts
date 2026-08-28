import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertCliUsage,
  parseStrictCliArgs,
  requireCliString,
  runDirectCli,
  writeCliHelpIfRequested,
  writeJsonOutput,
} from "../lib/cli-args.mjs";
import { z } from "zod";
import {
  aggregateV9GeneralizedMean,
  aggregateV9SmoothBoundedHeadroom,
  type V9AggregationStrategy,
} from "@shared/lib/safety-score-v9/aggregation";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import {
  scoreV9EvaluatedAsset,
  type V9ProductionScoreInput,
} from "@shared/lib/safety-score-v9/score";
import {
  V9EvidenceLevelSchema,
  V9ReasonCodeSchema,
  V9StructuralSignalSchema,
} from "@shared/types/safety-score-v9";
import { V9EvidenceResponsibilitySchema } from "@shared/types/safety-score-v9-fact-primitives";

const PillarReasonSchema = z.object({
  code: V9ReasonCodeSchema,
  path: z.string().min(1),
  message: z.string().min(1),
  responsibility: V9EvidenceResponsibilitySchema,
}).passthrough();

const ReplayPillarSchema = z.object({
  score: z.number().nullable(),
  evidenceLevel: V9EvidenceLevelSchema,
  reasons: z.array(PillarReasonSchema).default([]),
  structuralSignals: z.array(V9StructuralSignalSchema).default([]),
  adverseAttribution: z.array(z.unknown()).default([]),
}).passthrough();

const ReplayPillarsSchema = z.object({
  backing: ReplayPillarSchema,
  exit: ReplayPillarSchema,
  control: ReplayPillarSchema,
});

const ReplayScoreInputSchema = z.object({
  pillars: ReplayPillarsSchema,
  peg: z.object({
    applicable: z.boolean(),
    score: z.number().nullable(),
    activeDepegBps: z.number().nonnegative().nullable(),
    reasons: z.array(PillarReasonSchema).default([]),
  }).passthrough(),
  parent: z.object({
    required: z.boolean(),
    score: z.number().nullable(),
    propagatedReasons: z.array(z.unknown()),
  }).passthrough(),
  dependencyReasons: z.array(PillarReasonSchema).default([]),
  methodologyReasons: z.array(PillarReasonSchema).default([]),
  dependencyStructuralSignals: z.array(V9StructuralSignalSchema).default([]),
  assetId: z.string().min(1),
  identity: z.object({
    factSetDigest: z.string().min(1),
    baseInputGenerationId: z.string().min(1),
    evaluationBuildDigest: z.string().min(1),
    asOfSec: z.number().int(),
    sourceGenerations: z.record(z.string(), z.string()),
  }),
  trackRecordMonths: z.number().nonnegative(),
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
          }).passthrough(),
        }),
      ),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const POLICY_CONTROL_HEADROOM =
  V9_CANDIDATE_POLICY_V1.policy.semantic.formula.controlCompensabilityHeadroom;

interface Candidate {
  id: string;
  aggregate: V9AggregationStrategy;
}

const CANDIDATES: readonly Candidate[] = [
  {
    id: "smooth-bounded-headroom:policy",
    aggregate: aggregateV9SmoothBoundedHeadroom,
  },
  {
    id: "smooth-bounded-headroom:legacy-control-selector",
    aggregate: (pillars, weights, policyHeadroom) =>
      aggregateV9SmoothBoundedHeadroom(
        pillars,
        weights,
        pillars.control < pillars.backing && pillars.control < pillars.exit
          ? POLICY_CONTROL_HEADROOM
          : policyHeadroom,
      ),
  },
  {
    id: "smooth-bounded-headroom:h20",
    aggregate: (pillars, weights) => aggregateV9SmoothBoundedHeadroom(pillars, weights, 20),
  },
  {
    id: "smooth-bounded-headroom:h30",
    aggregate: (pillars, weights) => aggregateV9SmoothBoundedHeadroom(pillars, weights, 30),
  },
  {
    id: "smooth-bounded-headroom:h45",
    aggregate: (pillars, weights) => aggregateV9SmoothBoundedHeadroom(pillars, weights, 45),
  },
  {
    id: "smooth-bounded-headroom:h45-control30",
    aggregate: (pillars, weights) =>
      aggregateV9SmoothBoundedHeadroom(
        pillars,
        weights,
        pillars.control < pillars.backing && pillars.control < pillars.exit ? 30 : 45,
      ),
  },
  {
    id: "smooth-bounded-headroom:h60",
    aggregate: (pillars, weights) => aggregateV9SmoothBoundedHeadroom(pillars, weights, 60),
  },
  {
    id: "generalized-mean:p-2",
    aggregate: (pillars, weights) => aggregateV9GeneralizedMean(pillars, weights, -2),
  },
  {
    id: "generalized-mean:p-4",
    aggregate: (pillars, weights) => aggregateV9GeneralizedMean(pillars, weights, -4),
  },
];

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
      const trace = scoreV9EvaluatedAsset(
        asset.scoreInput as V9ProductionScoreInput,
        V9_CANDIDATE_POLICY_V1,
        candidate.aggregate,
      );
      return {
        assetId: asset.assetId,
        baselineScore: asset.trace.finalScore,
        baselineGrade: asset.trace.finalGrade,
        score: trace.finalScore,
        grade: trace.finalGrade,
        aggregation: trace.aggregation,
        baseAssetScore: trace.baseAssetScore,
        deploymentAdjustedScore: trace.deploymentAdjustedScore,
        bindingCap: trace.bindingCap,
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

const USAGE = `Usage: tsx scripts/maintenance/replay-safety-score-v9-aggregation.ts <replay.json> [output.json]

Options:
  -h, --help   Show this help`;

export function runV9AggregationCounterfactualCli(argv: readonly string[]): void {
  const { positionals, values } = parseStrictCliArgs(argv, { allowPositionals: true });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(positionals.length <= 2, "Expected a replay JSON path and optional output JSON path");
  const inputPath = requireCliString(positionals[0], "replay JSON input");
  const outputPath = positionals[1];
  const output = buildV9AggregationCounterfactual(
    JSON.parse(readFileSync(resolve(inputPath), "utf8")),
    inputPath,
  );
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (outputPath) writeJsonOutput(resolve(outputPath), serialized);
  else process.stdout.write(serialized);
}

runDirectCli(import.meta.url, () => runV9AggregationCounterfactualCli(process.argv.slice(2)), {
  label: "safety-score-v9:aggregation-counterfactual",
  usage: USAGE,
});
