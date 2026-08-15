#!/usr/bin/env tsx
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { computePYS, computePysComponents, yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";
import { clamp } from "@shared/lib/math";
import { percentileNearestRank } from "@shared/lib/stats";
import { formatPercentFromRatio } from "@shared/lib/format";
import { YieldRankingsResponseSchema, type YieldRanking } from "@shared/types/yield";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const DEFAULT_OUTPUT = "agents/yield-pys-v8-calibration-template.md";
const MAX_SOURCE_RISK_PENALTY = 2.5;
const DEFAULT_SCALING_FACTOR = 8;
const GOLDEN_FIXTURES = [
  "reward-heavy",
  "stale",
  "low-depth",
  "source-switch",
  "bootstrap",
  "negative-zero",
  "missing-safety",
] as const;

const CALIBRATION_FIELDS = [
  "sourceRiskScore",
  "sourceRiskPenalty",
  "rewardShare",
  "sourceDepthRatio",
  "sourceAgeSeconds",
  "sourceSwitchCount30d",
  "observationCount30d",
  "venueRiskTier",
] as const;

type CalibrationField = (typeof CALIBRATION_FIELDS)[number];

export interface Args {
  inputPath: string | null;
  outputPath: string;
  generatedAt: string;
}

export interface RankingWithRisk extends YieldRanking {
  // Legacy flat fields are accepted for old local calibration artifacts only.
  sourceRiskPenalty?: number | null;
  sourceRiskScore?: number | null;
  rewardShare?: number | null;
  sourceDepthRatio?: number | null;
  sourceAgeSeconds?: number | null;
  sourceSwitchCount30d?: number | null;
  observationCount30d?: number | null;
  venueRiskTier?: "low" | "medium" | "high" | "unknown" | string | null;
}

interface ScoredRow {
  id: string;
  symbol: string;
  name: string;
  peg: string;
  sourceKey: string;
  yieldSource: string;
  dataSource: string;
  currentApy: number;
  apy30d: number;
  benchmarkRate: number | null;
  safetyScore: number | null;
  v7Score: number;
  v8Score: number;
  beforeRank: number;
  afterRank: number;
  rankDelta: number;
  cappedBefore: boolean;
  cappedAfter: boolean;
  driver: string;
  sourceRiskPenalty: number;
  warningSignals: string[];
}

export function parseArgs(argv: string[], now = new Date()): Args {
  let inputPath: string | null = null;
  let outputPath = DEFAULT_OUTPUT;
  let generatedAt = now.toISOString();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") {
      inputPath = requireValue(argv, i, "--input");
      i += 1;
    } else if (arg === "--out" || arg === "--report") {
      outputPath = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === "--generated-at") {
      generatedAt = requireValue(argv, i, "--generated-at");
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { inputPath, outputPath, generatedAt };
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function loadRankings(inputPath: string | null): RankingWithRisk[] {
  if (!inputPath) return [];
  const raw = JSON.parse(readFileSync(inputPath, "utf8"));
  YieldRankingsResponseSchema.parse(raw);
  return raw.rankings as RankingWithRisk[];
}

export function buildCalibrationReport(rankings: RankingWithRisk[], generatedAt: string): string {
  const scoredRows = scoreRows(rankings);
  const topBefore = [...scoredRows].sort(sortByBeforeRank).slice(0, 20);
  const topAfter = [...scoredRows].sort(sortByAfterRank).slice(0, 20);
  const movers = [...scoredRows].sort((a, b) => Math.abs(b.rankDelta) - Math.abs(a.rankDelta)).slice(0, 20);
  const distribution = summarizeDistribution(scoredRows.map((row) => row.v8Score));
  const nullCoverage = summarizeNullCoverage(rankings);
  const nonUsd = summarizeNonUsd(scoredRows);

  return [
    "# Yield PYS v8 Calibration Artifact",
    "",
    `Generated: ${generatedAt}`,
    "",
    "Scope: rollout calibration for the methodology v8 PYS source-risk layer. This artifact is evidence only and does not change runtime behavior.",
    "",
    "## Candidate Formula For Analysis",
    "",
    "```text",
    "sourceRiskPenalty = clamp(row.sourceRisk?.sourceRiskPenalty ?? legacy row.sourceRiskPenalty ?? derivedNeutralPenalty, 1, 2.5)",
    "sourceAdjustedUtility = current effectiveYield / sourceRiskPenalty",
    "yieldEfficiency = sourceAdjustedUtility / adjustedRiskPenalty",
    "pysV8 = clamp(round(yieldEfficiency * sustainabilityMultiplier * scalingFactor), 0, 100)",
    "```",
    "",
    "Unknown source-risk inputs are neutral. The before column recomputes the v7 baseline without source-risk penalties; the after column applies the v8 candidate penalty.",
    "",
    "## Distribution",
    "",
    `Rows analyzed: ${scoredRows.length}`,
    "",
    "| metric | PYS v8 candidate |",
    "| --- | ---: |",
    `| p10 | ${formatNumber(distribution.p10)} |`,
    `| p50 | ${formatNumber(distribution.p50)} |`,
    `| p90 | ${formatNumber(distribution.p90)} |`,
    `| max | ${formatNumber(distribution.max)} |`,
    "",
    "## Capped Scores",
    "",
    "| side | count capped at 100 |",
    "| --- | ---: |",
    `| before | ${scoredRows.filter((row) => row.cappedBefore).length} |`,
    `| after | ${scoredRows.filter((row) => row.cappedAfter).length} |`,
    "",
    "## Null-Rate Coverage",
    "",
    "| field | present | null/missing | null rate |",
    "| --- | ---: | ---: | ---: |",
    ...CALIBRATION_FIELDS.map((field) => {
      const stats = nullCoverage[field];
      return `| ${field} | ${stats.present} | ${stats.missing} | ${formatPercentFromRatio(stats.nullRate, 1)} |`;
    }),
    "",
    "## Non-USD Cohort Checks",
    "",
    "| cohort | rows | p50 PYS | p90 PYS | max PYS | capped at 100 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...nonUsd.map(
      (row) =>
        `| ${row.peg} | ${row.count} | ${formatNumber(row.p50)} | ${formatNumber(row.p90)} | ${formatNumber(row.max)} | ${row.capped} |`,
    ),
    "",
    "## Top 20 Before",
    "",
    renderRankTable(topBefore, "before"),
    "",
    "## Top 20 After",
    "",
    renderRankTable(topAfter, "after"),
    "",
    "## Largest Rank Movers",
    "",
    renderMoverTable(movers),
    "",
    "## Golden Fixture List",
    "",
    "| fixture | required assertion |",
    "| --- | --- |",
    "| reward-heavy | high rewardShare produces a driver label and cannot improve from source-risk treatment alone |",
    "| stale | stale sourceAgeSeconds produces a freshness driver when it is the largest penalty |",
    "| low-depth | low sourceDepthRatio produces a depth driver and avoids top-rank promotion from APY alone |",
    "| source-switch | sourceSwitchCount30d or provenance.sourceSwitch labels churn-driven movement |",
    "| bootstrap | low observationCount30d labels bootstrap uncertainty without breaking seed rows |",
    "| negative-zero | zero or negative APY scores 0 and preserves deterministic rank behavior |",
    "| missing-safety | null safetyScore keeps existing default-safety behavior and records coverage |",
    "",
    "## Implementation Notes",
    "",
    "- Feed this script a saved `/api/yield-rankings` response; if the payload predates public `sourceRisk.*` fields, treat null-rate coverage as a production baseline rather than final v8 source-risk calibration.",
    "- Keep point-in-time calibration reports under `/agents/`; record reviewed methodology decisions in `docs/yield-intelligence.md` and the structured yield methodology changelog.",
    "- Pair production-snapshot reports with golden-fixture evidence when live payloads do not yet include populated source-risk fields.",
    "",
  ].join("\n");
}

export function scoreRows(rankings: RankingWithRisk[]): ScoredRow[] {
  const rows = rankings.map((row) => {
    const apyVarianceScore = resolveApyVarianceScore(row);
    const benchmarkRate = typeof row.benchmarkRate === "number" ? row.benchmarkRate : null;
    const scalingFactor = DEFAULT_SCALING_FACTOR;
    const v7Score = computePYS({
      apy30d: row.apy30d,
      safetyScore: row.safetyScore,
      apyVarianceScore,
      scalingFactor,
      benchmarkRate,
    });
    const sourceRiskPenalty = resolveSourceRiskPenalty(row);
    const v8Score = computeCandidateV8Score({
      apy30d: row.apy30d,
      safetyScore: row.safetyScore,
      apyVarianceScore,
      scalingFactor,
      benchmarkRate,
      sourceRiskPenalty,
    });

    return {
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      peg: row.benchmarkKey ?? row.benchmarkCurrency ?? "USD",
      sourceKey: row.provenance?.sourceKey ?? row.yieldSource,
      yieldSource: row.yieldSource,
      dataSource: row.dataSource,
      currentApy: row.currentApy,
      apy30d: row.apy30d,
      benchmarkRate,
      safetyScore: row.safetyScore,
      v7Score,
      v8Score,
      beforeRank: 0,
      afterRank: 0,
      rankDelta: 0,
      cappedBefore: v7Score >= 100,
      cappedAfter: v8Score >= 100,
      driver: classifyDriver(row),
      sourceRiskPenalty,
      warningSignals: row.warningSignals,
    };
  });

  [...rows]
    .sort((a, b) => b.v7Score - a.v7Score || b.apy30d - a.apy30d || a.id.localeCompare(b.id))
    .forEach((row, index) => {
      row.beforeRank = index + 1;
    });
  [...rows]
    .sort((a, b) => b.v8Score - a.v8Score || b.apy30d - a.apy30d || a.id.localeCompare(b.id))
    .forEach((row, index) => {
      row.afterRank = index + 1;
    });
  rows.forEach((row) => {
    row.rankDelta = row.beforeRank - row.afterRank;
  });

  return rows;
}

function computeCandidateV8Score(input: {
  apy30d: number;
  safetyScore: number | null;
  apyVarianceScore: number;
  scalingFactor: number;
  benchmarkRate: number | null;
  sourceRiskPenalty: number;
}): number {
  if (input.apy30d <= 0) return 0;
  const { adjustedRiskPenalty, effectiveYield, sustainabilityMultiplier } = computePysComponents({
    apy30d: input.apy30d,
    safetyScore: input.safetyScore,
    apyVarianceScore: input.apyVarianceScore,
    benchmarkRate: input.benchmarkRate,
  });
  if (effectiveYield <= 0) return 0;
  const sourceAdjustedUtility = effectiveYield / input.sourceRiskPenalty;
  const yieldEfficiency = sourceAdjustedUtility / adjustedRiskPenalty;
  return Math.min(100, Math.round(yieldEfficiency * sustainabilityMultiplier * input.scalingFactor));
}

function resolveApyVarianceScore(row: RankingWithRisk): number {
  if (typeof row.apyVariance30d === "number" && Number.isFinite(row.apyVariance30d)) {
    return Math.max(0, Math.min(1, row.apyVariance30d));
  }
  return yieldStabilityToApyVarianceScore(row.yieldStability);
}

function resolveSourceRiskPenalty(row: RankingWithRisk): number {
  const sourceRiskPenalty = readRiskNumber(row, "sourceRiskPenalty");
  if (typeof sourceRiskPenalty === "number" && Number.isFinite(sourceRiskPenalty)) {
    return clamp(sourceRiskPenalty, 1, MAX_SOURCE_RISK_PENALTY);
  }
  return clamp(1 + derivePenalty(row), 1, MAX_SOURCE_RISK_PENALTY);
}

function derivePenalty(row: RankingWithRisk): number {
  let penalty = 0;
  const rewardShare = readRiskNumber(row, "rewardShare");
  const sourceDepthRatio = readRiskNumber(row, "sourceDepthRatio");
  const sourceAgeSeconds = readRiskNumber(row, "sourceAgeSeconds");
  const sourceSwitchCount30d = readRiskNumber(row, "sourceSwitchCount30d");
  const observationCount30d = readRiskNumber(row, "observationCount30d");
  const venueRiskTier = readVenueRiskTier(row);
  if (typeof rewardShare === "number" && rewardShare > 0.5) penalty += Math.min(0.5, rewardShare - 0.5);
  if (typeof sourceDepthRatio === "number" && sourceDepthRatio < 0.001) penalty += 0.35;
  if (typeof sourceAgeSeconds === "number" && sourceAgeSeconds > 6 * 60 * 60) penalty += 0.25;
  if (typeof sourceSwitchCount30d === "number" && sourceSwitchCount30d > 0)
    penalty += Math.min(0.3, sourceSwitchCount30d * 0.1);
  if (typeof observationCount30d === "number" && observationCount30d > 0 && observationCount30d < 7) penalty += 0.2;
  if (venueRiskTier === "high") penalty += 0.35;
  return penalty;
}

function classifyDriver(row: RankingWithRisk): string {
  const rewardShare = readRiskNumber(row, "rewardShare");
  const sourceDepthRatio = readRiskNumber(row, "sourceDepthRatio");
  const sourceAgeSeconds = readRiskNumber(row, "sourceAgeSeconds");
  const sourceSwitchCount30d = readRiskNumber(row, "sourceSwitchCount30d");
  const observationCount30d = readRiskNumber(row, "observationCount30d");
  const venueRiskTier = readVenueRiskTier(row);
  const candidates = [
    { label: "reward-heavy", value: typeof rewardShare === "number" ? Math.max(0, rewardShare - 0.5) : 0 },
    { label: "low-depth", value: typeof sourceDepthRatio === "number" && sourceDepthRatio < 0.001 ? 0.35 : 0 },
    { label: "stale", value: typeof sourceAgeSeconds === "number" && sourceAgeSeconds > 6 * 60 * 60 ? 0.25 : 0 },
    { label: "source-switch", value: row.provenance?.sourceSwitch || (sourceSwitchCount30d ?? 0) > 0 ? 0.2 : 0 },
    {
      label: "bootstrap",
      value: typeof observationCount30d === "number" && observationCount30d > 0 && observationCount30d < 7 ? 0.2 : 0,
    },
    { label: "venue-risk", value: venueRiskTier === "high" ? 0.35 : 0 },
    { label: "missing-safety", value: row.safetyScore == null ? 0.1 : 0 },
    { label: "negative-zero", value: row.apy30d <= 0 ? 0.1 : 0 },
  ].sort((a, b) => b.value - a.value);
  return candidates[0]?.value ? candidates[0].label : "apy-or-baseline";
}

function readRiskNumber(
  row: RankingWithRisk,
  field:
    | "sourceRiskScore"
    | "sourceRiskPenalty"
    | "rewardShare"
    | "sourceDepthRatio"
    | "sourceAgeSeconds"
    | "sourceSwitchCount30d"
    | "observationCount30d",
): number | null {
  const nested = row.sourceRisk?.[field];
  if (typeof nested === "number" && Number.isFinite(nested)) return nested;
  const flat = row[field];
  return typeof flat === "number" && Number.isFinite(flat) ? flat : null;
}

function readVenueRiskTier(row: RankingWithRisk): string | null {
  return row.sourceRisk?.venueRiskTier ?? row.venueRiskTier ?? null;
}

function summarizeDistribution(values: number[]) {
  return {
    p10: percentileNearestRank(values, 10) ?? 0,
    p50: percentileNearestRank(values, 50) ?? 0,
    p90: percentileNearestRank(values, 90) ?? 0,
    max: values.length ? Math.max(...values) : 0,
  };
}

function summarizeNullCoverage(
  rankings: RankingWithRisk[],
): Record<CalibrationField, { present: number; missing: number; nullRate: number }> {
  return Object.fromEntries(
    CALIBRATION_FIELDS.map((field) => {
      const present = rankings.filter((row) => {
        if (field === "venueRiskTier") return readVenueRiskTier(row) != null;
        if (
          field === "sourceRiskScore" ||
          field === "sourceRiskPenalty" ||
          field === "rewardShare" ||
          field === "sourceDepthRatio" ||
          field === "sourceAgeSeconds" ||
          field === "sourceSwitchCount30d" ||
          field === "observationCount30d"
        ) {
          return readRiskNumber(row, field) != null;
        }
        return row[field] != null;
      }).length;
      const missing = rankings.length - present;
      return [field, { present, missing, nullRate: rankings.length ? missing / rankings.length : 0 }];
    }),
  ) as Record<CalibrationField, { present: number; missing: number; nullRate: number }>;
}

function summarizeNonUsd(rows: ScoredRow[]) {
  const groups = new Map<string, ScoredRow[]>();
  rows
    .filter((row) => row.peg !== "USD")
    .forEach((row) => {
      groups.set(row.peg, [...(groups.get(row.peg) ?? []), row]);
    });
  if (groups.size === 0) groups.set("non-USD", []);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([peg, group]) => {
      const distribution = summarizeDistribution(group.map((row) => row.v8Score));
      return {
        peg,
        count: group.length,
        p50: distribution.p50,
        p90: distribution.p90,
        max: distribution.max,
        capped: group.filter((row) => row.cappedAfter).length,
      };
    });
}

function renderRankTable(rows: ScoredRow[], mode: "before" | "after"): string {
  const rankKey = mode === "before" ? "beforeRank" : "afterRank";
  const scoreKey = mode === "before" ? "v7Score" : "v8Score";
  return [
    "| rank | id | symbol | APY 30d | PYS | source | driver |",
    "| ---: | --- | --- | ---: | ---: | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row[rankKey]} | ${row.id} | ${row.symbol} | ${formatNumber(row.apy30d)} | ${row[scoreKey]} | ${escapeCell(row.yieldSource)} | ${row.driver} |`,
    ),
  ].join("\n");
}

function renderMoverTable(rows: ScoredRow[]): string {
  return [
    "| before | after | delta | id | symbol | before PYS | after PYS | driver | source penalty |",
    "| ---: | ---: | ---: | --- | --- | ---: | ---: | --- | ---: |",
    ...rows.map(
      (row) =>
        `| ${row.beforeRank} | ${row.afterRank} | ${row.rankDelta} | ${row.id} | ${row.symbol} | ${row.v7Score} | ${row.v8Score} | ${row.driver} | ${formatNumber(row.sourceRiskPenalty)} |`,
    ),
  ].join("\n");
}

function sortByBeforeRank(a: ScoredRow, b: ScoredRow): number {
  return a.beforeRank - b.beforeRank;
}

function sortByAfterRank(a: ScoredRow, b: ScoredRow): number {
  return a.afterRank - b.afterRank;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2).replace(/\.00$/, "") : "0";
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function printUsage(): void {
  console.log(
    "Usage: tsx scripts/maintenance/yield-pys-v8-calibration.ts --input rankings.json [--out agents/report.md]",
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rankings = loadRankings(args.inputPath);
  const report = buildCalibrationReport(rankings, args.generatedAt);
  const outputPath = resolve(process.cwd(), args.outputPath);
  if (!existsSync(dirname(outputPath))) {
    throw new Error(`Output directory does not exist: ${dirname(outputPath)}`);
  }
  writeFileSync(outputPath, report);
  console.log(`Wrote ${args.outputPath}`);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main();
}

export { CALIBRATION_FIELDS, GOLDEN_FIXTURES, MAX_SOURCE_RISK_PENALTY };
