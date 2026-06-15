#!/usr/bin/env tsx

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  deriveModelConfidenceWithDetails,
  resolveCapacityConfidence,
  resolveFeeConfidence,
  resolveFeeModelKind,
} from "../../shared/lib/redemption-backstop-confidence";
import { REDEMPTION_BACKSTOP_CONFIGS } from "../../shared/lib/redemption-backstop-configs";
import { resolveDefaultHolderEligibility, type RedemptionBackstopConfig } from "../../shared/lib/redemption-backstop-configs/shared";
import {
  computeCapacityScore,
  REDEMPTION_ACCESS_SCORES,
  REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
  REDEMPTION_EXECUTION_SCORES,
  REDEMPTION_OUTPUT_ASSET_SCORES,
  REDEMPTION_ROUTE_FAMILY_CAPS,
  REDEMPTION_SETTLEMENT_SCORES,
} from "../../shared/lib/redemption-backstop-scoring";
import type {
  RedemptionModelConfidence,
  RedemptionRouteFamily,
} from "../../shared/types/redemption";

const ROOT = process.cwd();
const DEFAULT_SUPPLY_USD = 1_000_000_000;
const DEFAULT_DELTA_THRESHOLD = 10;

type ComponentWeights = typeof REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS;
type RouteFamilyCaps = typeof REDEMPTION_ROUTE_FAMILY_CAPS;
type OutputAssetScores = typeof REDEMPTION_OUTPUT_ASSET_SCORES;

interface ScoreProfile {
  label: string;
  componentWeights: ComponentWeights;
  routeFamilyCaps: RouteFamilyCaps;
  outputAssetScores: OutputAssetScores;
}

interface ScoreDiffArgs {
  supplyUsd: number;
  threshold: number;
  format: "json" | "markdown";
  nowSec: number;
  outPath?: string;
  v4ProfilePath?: string;
}

interface RouteScoreSnapshot {
  stablecoinId: string;
  routeFamily: RedemptionRouteFamily;
  score: number | null;
  eventualRedeemabilityScore: number | null;
  modelConfidence: RedemptionModelConfidence;
  capacityScore: number | null;
  immediateCapacityUsd: number | null;
  immediateCapacityRatio: number | null;
  scoringCapacityUsd: number | null;
  scoringCapacityRatio: number | null;
  capacityConfidence: ReturnType<typeof resolveCapacityConfidence>;
  feeConfidence: ReturnType<typeof resolveFeeConfidence>;
  feeModelKind: ReturnType<typeof resolveFeeModelKind>;
  capsApplied: string[];
  reasonCodes: string[];
}

interface RouteScoreDiff {
  stablecoinId: string;
  routeFamily: RedemptionRouteFamily;
  oldScore: number | null;
  newScore: number | null;
  delta: number | null;
  oldEventualRedeemabilityScore: number | null;
  newEventualRedeemabilityScore: number | null;
  oldConfidence: RedemptionModelConfidence;
  newConfidence: RedemptionModelConfidence;
  oldCapacityScore: number | null;
  newCapacityScore: number | null;
  oldCapsApplied: string[];
  newCapsApplied: string[];
  reasonCodes: string[];
  flagged: boolean;
}

const CURRENT_PROFILE: ScoreProfile = {
  label: "current-scoring-constants",
  componentWeights: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
  routeFamilyCaps: REDEMPTION_ROUTE_FAMILY_CAPS,
  outputAssetScores: REDEMPTION_OUTPUT_ASSET_SCORES,
};

function parseArgs(argv: readonly string[]): ScoreDiffArgs {
  const args: ScoreDiffArgs = {
    supplyUsd: DEFAULT_SUPPLY_USD,
    threshold: DEFAULT_DELTA_THRESHOLD,
    format: "json",
    nowSec: Math.floor(Date.now() / 1000),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--supply-usd" && next) {
      args.supplyUsd = Number(next);
      index += 1;
    } else if (arg === "--threshold" && next) {
      args.threshold = Number(next);
      index += 1;
    } else if (arg === "--format" && (next === "json" || next === "markdown")) {
      args.format = next;
      index += 1;
    } else if (arg === "--out" && next) {
      args.outPath = next;
      index += 1;
    } else if (arg === "--v4-profile" && next) {
      args.v4ProfilePath = next;
      index += 1;
    } else if (arg === "--now-sec" && next) {
      args.nowSec = Number(next);
      index += 1;
    } else if (arg === "--help") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.supplyUsd) || args.supplyUsd <= 0) {
    throw new Error("--supply-usd must be a positive finite number");
  }
  if (!Number.isFinite(args.threshold) || args.threshold < 0) {
    throw new Error("--threshold must be a non-negative finite number");
  }
  if (!Number.isInteger(args.nowSec) || args.nowSec <= 0) {
    throw new Error("--now-sec must be a positive integer Unix timestamp in seconds");
  }

  return args;
}

function printUsage(): void {
  console.log("Usage: tsx scripts/maintenance/audit-redemption-v4-score-diff.ts [--out <path>] [--format json|markdown]");
  console.log("       [--threshold <points>] [--supply-usd <usd>] [--v4-profile <json>] [--now-sec <unix-sec>]");
}

function loadV4ProfileOverride(base: ScoreProfile, path: string | undefined): ScoreProfile {
  if (!path) return base;
  const resolved = resolve(ROOT, path);
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as Partial<ScoreProfile>;
  return {
    label: parsed.label ?? `${base.label}+override`,
    componentWeights: { ...base.componentWeights, ...(parsed.componentWeights ?? {}) },
    routeFamilyCaps: { ...base.routeFamilyCaps, ...(parsed.routeFamilyCaps ?? {}) },
    outputAssetScores: { ...base.outputAssetScores, ...(parsed.outputAssetScores ?? {}) },
  };
}

function buildDiffReport(args: ScoreDiffArgs) {
  const v4Profile = loadV4ProfileOverride(CURRENT_PROFILE, args.v4ProfilePath);
  const rows = Object.entries(REDEMPTION_BACKSTOP_CONFIGS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([stablecoinId, config]) => {
      const oldSnapshot = buildRouteSnapshot(stablecoinId, config, CURRENT_PROFILE, args.supplyUsd, "v3997", args.nowSec);
      const newSnapshot = buildRouteSnapshot(stablecoinId, config, v4Profile, args.supplyUsd, "v4", args.nowSec);
      return buildDiff(oldSnapshot, newSnapshot, args.threshold);
    });

  const flaggedRows = rows.filter((row) => row.flagged);
  const numericDeltas = rows
    .map((row) => row.delta)
    .filter((delta): delta is number => delta != null);
  return {
    generatedAt: new Date().toISOString(),
    assumptions: {
      oldProfile: CURRENT_PROFILE.label,
      newProfile: v4Profile.label,
      supplyUsd: args.supplyUsd,
      deltaThreshold: args.threshold,
      nowSec: args.nowSec,
      liveReserveTelemetry: "not used; reserve-sync routes use configured fallbacks only",
      activeDepegOverlay: "not used; this is a static formula/config diff",
    },
    summary: {
      routeCount: rows.length,
      flaggedCount: flaggedRows.length,
      changedCount: rows.filter((row) => row.delta !== 0 || row.oldConfidence !== row.newConfidence).length,
      currentScoreRemovedCount: rows.filter((row) => row.oldScore != null && row.newScore == null).length,
      currentScoreAddedCount: rows.filter((row) => row.oldScore == null && row.newScore != null).length,
      numericDeltaCount: numericDeltas.length,
      maxAbsoluteDelta: numericDeltas.reduce((max, delta) => Math.max(max, Math.abs(delta)), 0),
    },
    rows,
  };
}

function buildRouteSnapshot(
  stablecoinId: string,
  config: RedemptionBackstopConfig,
  profile: ScoreProfile,
  supplyUsd: number,
  mode: "v3997" | "v4",
  nowSec: number,
): RouteScoreSnapshot {
  const capacity = resolveStaticCapacity(config, supplyUsd, mode);
  const capacityScoring = computeCapacityScore({
    immediateCapacityUsd: capacity.scoringCapacityUsd,
    immediateCapacityRatio: capacity.scoringCapacityRatio,
    absoluteOnlyMode: capacity.capacityScoreMode,
  });
  const capacityScore = capacityScoring.score;
  const accessScore = REDEMPTION_ACCESS_SCORES[config.accessModel];
  const settlementScore = REDEMPTION_SETTLEMENT_SCORES[config.settlementModel];
  const executionCertaintyScore = REDEMPTION_EXECUTION_SCORES[config.executionModel];
  const outputAssetQualityScore = profile.outputAssetScores[config.outputAssetType];
  const costScore = resolveStaticCostScore(config);
  const scored = computeProfileScore({
    routeFamily: config.routeFamily,
    accessScore,
    settlementScore,
    executionCertaintyScore,
    capacityScore,
    outputAssetQualityScore,
    costScore,
    totalScoreCap: config.totalScoreCap,
    profile,
  });
  const eventualCapacityScoring = computeCapacityScore({
    immediateCapacityUsd: capacity.eventualCapacityUsd,
    immediateCapacityRatio: capacity.eventualCapacityRatio,
  });
  const eventualRedeemabilityScore =
    eventualCapacityScoring.score == null
      ? null
      : computeProfileScore({
          routeFamily: config.routeFamily,
          accessScore,
          settlementScore,
          executionCertaintyScore,
          capacityScore: eventualCapacityScoring.score,
          outputAssetQualityScore,
          costScore,
          totalScoreCap: config.totalScoreCap,
          profile,
        }).score;
  const capacityConfidence = resolveCapacityConfidence(config.capacityModel);
  const feeConfidence = resolveFeeConfidence(config.costModel);
  const resolutionState = capacityScore == null && eventualRedeemabilityScore == null ? "missing-capacity" : "resolved";
  const modelConfidence =
    mode === "v3997"
      ? deriveLegacyModelConfidence({ resolutionState, capacityConfidence, feeConfidence })
      : deriveModelConfidenceWithDetails({
          resolutionState,
          capacityConfidence,
          feeConfidence,
          routeStatus: config.routeStatus ?? "open",
          routeStatusSource: "static-config",
          reviewedAt: config.reviewedAt,
          holderEligibility: config.holderEligibility ?? resolveDefaultHolderEligibility(config),
          sourceMode: capacity.sourceMode,
          now: nowSec,
        }).modelConfidence;

  return {
    stablecoinId,
    routeFamily: config.routeFamily,
    score: scored.score,
    eventualRedeemabilityScore,
    modelConfidence,
    capacityScore,
    immediateCapacityUsd: capacity.immediateCapacityUsd,
    immediateCapacityRatio: capacity.immediateCapacityRatio,
    scoringCapacityUsd: capacity.scoringCapacityUsd,
    scoringCapacityRatio: capacity.scoringCapacityRatio,
    capacityConfidence,
    feeConfidence,
    feeModelKind: resolveFeeModelKind(config.costModel),
    capsApplied: scored.capsApplied,
    reasonCodes: [...capacity.reasonCodes, ...scored.capsApplied],
  };
}

function resolveStaticCapacity(
  config: RedemptionBackstopConfig,
  supplyUsd: number,
  mode: "v3997" | "v4",
): {
  immediateCapacityUsd: number | null;
  immediateCapacityRatio: number | null;
  scoringCapacityUsd: number | null;
  scoringCapacityRatio: number | null;
  eventualCapacityUsd: number | null;
  eventualCapacityRatio: number | null;
  capacityScoreMode?: "interpolated" | "tier-floor";
  sourceMode: "dynamic" | "estimated" | "static";
  reasonCodes: string[];
} {
  const reasonCodes: string[] = [];
  const model = config.capacityModel;

  if (mode === "v3997" && model.kind === "supply-full") {
    return {
      immediateCapacityUsd: supplyUsd,
      immediateCapacityRatio: 1,
      scoringCapacityUsd: supplyUsd,
      scoringCapacityRatio: 1,
      eventualCapacityUsd: null,
      eventualCapacityRatio: null,
      sourceMode: "estimated",
      reasonCodes,
    };
  }

  if (model.kind === "supply-full") {
    reasonCodes.push("v4-eventual-only-current-score");
    return {
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      scoringCapacityUsd: null,
      scoringCapacityRatio: null,
      eventualCapacityUsd: supplyUsd,
      eventualCapacityRatio: 1,
      sourceMode: "estimated",
      reasonCodes,
    };
  }

  if (model.kind === "supply-ratio") {
    const immediateCapacityUsd = supplyUsd * model.ratio;
    const scoringCapacityUsd =
      mode === "v4" && model.dailyLimitUsd != null
        ? Math.min(immediateCapacityUsd, model.dailyLimitUsd)
        : immediateCapacityUsd;
    if (scoringCapacityUsd < immediateCapacityUsd) reasonCodes.push("v4-daily-limit-capacity");
    return {
      immediateCapacityUsd,
      immediateCapacityRatio: model.ratio,
      scoringCapacityUsd,
      scoringCapacityRatio: Math.min(1, scoringCapacityUsd / supplyUsd),
      eventualCapacityUsd: null,
      eventualCapacityRatio: null,
      sourceMode: "static",
      reasonCodes,
    };
  }

  if (model.kind === "fixed-usd") {
    const immediateCapacityUsd = Math.min(supplyUsd, model.amountUsd);
    const scoringCapacityUsd =
      mode === "v4" && model.dailyLimitUsd != null
        ? Math.min(immediateCapacityUsd, model.dailyLimitUsd)
        : immediateCapacityUsd;
    if (scoringCapacityUsd < immediateCapacityUsd) reasonCodes.push("v4-daily-limit-capacity");
    return {
      immediateCapacityUsd,
      immediateCapacityRatio: Math.min(1, immediateCapacityUsd / supplyUsd),
      scoringCapacityUsd,
      scoringCapacityRatio: Math.min(1, scoringCapacityUsd / supplyUsd),
      eventualCapacityUsd: null,
      eventualCapacityRatio: null,
      sourceMode: "static",
      reasonCodes,
    };
  }

  if (model.fallbackRatio != null) {
    return {
      immediateCapacityUsd: supplyUsd * model.fallbackRatio,
      immediateCapacityRatio: model.fallbackRatio,
      scoringCapacityUsd: supplyUsd * model.fallbackRatio,
      scoringCapacityRatio: model.fallbackRatio,
      eventualCapacityUsd: mode === "v4" ? supplyUsd : null,
      eventualCapacityRatio: mode === "v4" ? 1 : null,
      sourceMode: "dynamic",
      reasonCodes: ["reserve-sync-fallback-ratio"],
    };
  }

  if (model.fallbackUsd != null) {
    const immediateCapacityUsd = Math.min(supplyUsd, model.fallbackUsd);
    return {
      immediateCapacityUsd,
      immediateCapacityRatio: Math.min(1, immediateCapacityUsd / supplyUsd),
      scoringCapacityUsd: immediateCapacityUsd,
      scoringCapacityRatio: Math.min(1, immediateCapacityUsd / supplyUsd),
      eventualCapacityUsd: null,
      eventualCapacityRatio: null,
      sourceMode: "dynamic",
      reasonCodes: ["reserve-sync-fallback-usd"],
    };
  }

  return {
    immediateCapacityUsd: null,
    immediateCapacityRatio: null,
    scoringCapacityUsd: null,
    scoringCapacityRatio: null,
    eventualCapacityUsd: null,
    eventualCapacityRatio: null,
    sourceMode: "dynamic",
    reasonCodes: ["reserve-sync-live-only"],
  };
}

function resolveStaticCostScore(config: RedemptionBackstopConfig): number {
  if (config.costModel.kind === "dynamic-or-unclear") {
    return config.costModel.feeDescription && config.costModel.confidence !== "undisclosed-reviewed" ? 60 : 40;
  }
  const feeBps = Math.max(0, config.costModel.feeBps);
  if (feeBps <= 10) return 100;
  if (feeBps <= 50) return 80;
  if (feeBps <= 100) return 60;
  return 40;
}

function computeProfileScore(args: {
  routeFamily: RedemptionRouteFamily;
  accessScore: number;
  settlementScore: number;
  executionCertaintyScore: number;
  capacityScore: number | null;
  outputAssetQualityScore: number;
  costScore: number;
  totalScoreCap?: number;
  profile: ScoreProfile;
}): { score: number | null; capsApplied: string[] } {
  if (args.capacityScore == null) return { score: null, capsApplied: [] };
  const weights = args.profile.componentWeights;
  let score =
    args.accessScore * weights.access +
    args.settlementScore * weights.settlement +
    args.executionCertaintyScore * weights.executionCertainty +
    args.capacityScore * weights.capacity +
    args.outputAssetQualityScore * weights.outputAssetQuality +
    args.costScore * weights.cost;
  const capsApplied: string[] = [];

  if (args.routeFamily === "queue-redeem" && score > args.profile.routeFamilyCaps.queueRedeem) {
    score = args.profile.routeFamilyCaps.queueRedeem;
    capsApplied.push("queue-route-cap");
  }
  if (args.routeFamily === "offchain-issuer" && score > args.profile.routeFamilyCaps.offchainIssuer) {
    score = args.profile.routeFamilyCaps.offchainIssuer;
    capsApplied.push("offchain-route-cap");
  }
  if (args.totalScoreCap != null && score > args.totalScoreCap) {
    score = args.totalScoreCap;
    capsApplied.push("config-cap");
  }

  return { score: Math.round(Math.max(0, Math.min(100, score))), capsApplied };
}

function deriveLegacyModelConfidence(args: {
  resolutionState: "resolved" | "missing-capacity";
  capacityConfidence: ReturnType<typeof resolveCapacityConfidence>;
  feeConfidence: ReturnType<typeof resolveFeeConfidence>;
}): RedemptionModelConfidence {
  if (args.resolutionState !== "resolved") return "low";
  if (args.capacityConfidence === "heuristic") return "low";
  if (args.capacityConfidence === "live-direct" && args.feeConfidence !== "undisclosed-reviewed") return "high";
  return "medium";
}

function buildDiff(
  oldSnapshot: RouteScoreSnapshot,
  newSnapshot: RouteScoreSnapshot,
  threshold: number,
): RouteScoreDiff {
  const delta =
    oldSnapshot.score == null || newSnapshot.score == null ? null : newSnapshot.score - oldSnapshot.score;
  const reasonCodes = new Set<string>([...oldSnapshot.reasonCodes, ...newSnapshot.reasonCodes]);
  if (oldSnapshot.score !== newSnapshot.score) reasonCodes.add("score-change");
  if (oldSnapshot.capacityScore !== newSnapshot.capacityScore) reasonCodes.add("capacity-score-change");
  if (oldSnapshot.modelConfidence !== newSnapshot.modelConfidence) reasonCodes.add("confidence-change");
  if (oldSnapshot.score != null && newSnapshot.score == null) reasonCodes.add("current-score-removed");
  if (oldSnapshot.score == null && newSnapshot.score != null) reasonCodes.add("current-score-added");
  if (delta != null && Math.abs(delta) >= threshold) reasonCodes.add("threshold-delta");

  const flagged =
    (delta != null && Math.abs(delta) >= threshold) ||
    oldSnapshot.score !== newSnapshot.score && (oldSnapshot.score == null || newSnapshot.score == null) ||
    oldSnapshot.modelConfidence !== newSnapshot.modelConfidence;

  return {
    stablecoinId: oldSnapshot.stablecoinId,
    routeFamily: oldSnapshot.routeFamily,
    oldScore: oldSnapshot.score,
    newScore: newSnapshot.score,
    delta,
    oldEventualRedeemabilityScore: oldSnapshot.eventualRedeemabilityScore,
    newEventualRedeemabilityScore: newSnapshot.eventualRedeemabilityScore,
    oldConfidence: oldSnapshot.modelConfidence,
    newConfidence: newSnapshot.modelConfidence,
    oldCapacityScore: oldSnapshot.capacityScore,
    newCapacityScore: newSnapshot.capacityScore,
    oldCapsApplied: oldSnapshot.capsApplied,
    newCapsApplied: newSnapshot.capsApplied,
    reasonCodes: [...reasonCodes].sort(),
    flagged,
  };
}

function renderMarkdown(report: ReturnType<typeof buildDiffReport>): string {
  const flagged = report.rows.filter((row) => row.flagged);
  const lines = [
    "# Redemption Backstop v4 Score Diff",
    "",
    `Generated: ${report.generatedAt}`,
    `Routes: ${report.summary.routeCount}`,
    `Flagged: ${report.summary.flaggedCount}`,
    `Changed: ${report.summary.changedCount}`,
    `Max absolute delta: ${report.summary.maxAbsoluteDelta}`,
    "",
    "| ID | Family | Old | New | Delta | Old confidence | New confidence | Reasons |",
    "| --- | --- | ---: | ---: | ---: | --- | --- | --- |",
  ];

  for (const row of flagged) {
    lines.push(
      `| ${row.stablecoinId} | ${row.routeFamily} | ${formatScore(row.oldScore)} | ${formatScore(row.newScore)} | ${formatScore(row.delta)} | ${row.oldConfidence} | ${row.newConfidence} | ${row.reasonCodes.join(", ")} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function formatScore(value: number | null): string {
  return value == null ? "null" : String(value);
}

function writeOutput(path: string, content: string): void {
  const resolved = resolve(ROOT, path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, content);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildDiffReport(args);
  const output = args.format === "markdown" ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`;

  if (args.outPath) {
    writeOutput(args.outPath, output);
    console.log(`Wrote ${args.format} score diff to ${args.outPath}`);
  } else {
    process.stdout.write(output);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  printUsage();
  process.exit(1);
}
