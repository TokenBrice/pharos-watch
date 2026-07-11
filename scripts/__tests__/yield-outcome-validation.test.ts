import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computePYS } from "../../shared/lib/yield-scoring";
import { afterEach, describe, expect, it } from "vitest";

import { buildYieldOutcomeValidationReport, spearmanCorrelation } from "../lib/yield-outcome-validation";
import {
  parseYieldOutcomeDataset,
  type YieldOutcomeCohort,
  type YieldOutcomeDataset,
} from "../lib/yield-outcome-validation-dataset";
import {
  generateYieldOutcomeValidation,
  parseYieldOutcomeCliArgs,
} from "../maintenance/generate-yield-outcome-validation";

const DAY_SECONDS = 86_400;
const START_SEC = 1_700_000_000;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function ranking(params: {
  stablecoinId: string;
  sourceKey: string;
  apy30d: number;
  safetyScore: number;
  variance: number;
  sourceRiskPenalty: number;
  cohorts: YieldOutcomeCohort[];
}) {
  const scoreInput = {
    apy30d: params.apy30d,
    safetyScore: params.safetyScore,
    apyVarianceScore: params.variance,
    benchmarkRate: 3,
    sourceRiskPenalty: params.sourceRiskPenalty,
    scalingFactor: 8,
  };
  return {
    generationId: "yield-g0",
    stablecoinId: params.stablecoinId,
    sourceKey: params.sourceKey,
    ...scoreInput,
    publishedPys: computePYS(scoreInput),
    cohorts: params.cohorts,
  };
}

function rawDataset() {
  const rankingObservations = [
    ranking({
      stablecoinId: "coin-a",
      sourceKey: "source:a",
      apy30d: 6,
      safetyScore: 75,
      variance: 0.05,
      sourceRiskPenalty: 1,
      cohorts: ["canonical-holder", "direct-evidence"],
    }),
    ranking({
      stablecoinId: "coin-b",
      sourceKey: "source:b",
      apy30d: 5,
      safetyScore: 65,
      variance: 0.1,
      sourceRiskPenalty: 1.4,
      cohorts: ["external-opportunity", "modeled-proxy"],
    }),
    ranking({
      stablecoinId: "coin-c",
      sourceKey: "source:c",
      apy30d: 4,
      safetyScore: 55,
      variance: 0.2,
      sourceRiskPenalty: 1.7,
      cohorts: ["direct-evidence", "external-opportunity"],
    }),
    ranking({
      stablecoinId: "coin-d",
      sourceKey: "source:d",
      apy30d: 3,
      safetyScore: 45,
      variance: 0.3,
      sourceRiskPenalty: 1,
      cohorts: ["canonical-holder", "modeled-proxy"],
    }),
  ];
  const future = (generationId: string, observedAt: number, rows: Array<[string, string, number, number | null]>) =>
    rows.map(([stablecoinId, sourceKey, apy30d, publishedPys]) => ({
      generationId,
      stablecoinId,
      sourceKey,
      observedAt,
      apy30d,
      publishedPys,
    }));

  return {
    schemaVersion: 1,
    generations: [
      { generationId: "yield-g30", publishedAt: START_SEC + 30 * DAY_SECONDS, methodologyVersion: "8.299" },
      { generationId: "yield-g0", publishedAt: START_SEC, methodologyVersion: "8.299" },
      { generationId: "yield-g7", publishedAt: START_SEC + 7 * DAY_SECONDS, methodologyVersion: "8.299" },
    ],
    rankingObservations: [...rankingObservations].reverse(),
    historyObservations: [
      ...future("yield-g30", START_SEC + 30 * DAY_SECONDS + 1_800, [
        ["coin-a", "source:a", 2, 10],
        ["coin-b", "source:b", 3, 15],
        ["coin-c", "source:c", 4, 20],
        ["coin-d", "source:d", 5, 25],
      ]),
      ...future("yield-g7", START_SEC + 7 * DAY_SECONDS + 1_800, [
        ["coin-a", "source:a", 7, 35],
        ["coin-b", "source:b", 5.5, 16],
        ["coin-c", "source:c", 4, 8],
        ["coin-d", "source:d", 2.5, null],
      ]),
    ],
  };
}

function dataset(): YieldOutcomeDataset {
  return parseYieldOutcomeDataset(rawDataset());
}

describe("yield outcome validation dataset", () => {
  it("rejects unknown fields, unsafe identifiers, duplicates, and dangling generation references", () => {
    expect(() => parseYieldOutcomeDataset({ ...rawDataset(), operatorEmail: "private@example.test" })).toThrow();

    const unsafe = rawDataset();
    unsafe.rankingObservations[0] = { ...unsafe.rankingObservations[0]!, sourceKey: "person@example.test" };
    expect(() => parseYieldOutcomeDataset(unsafe)).toThrow("privacy-safe identifier");

    const duplicate = rawDataset();
    duplicate.generations.push({ ...duplicate.generations[0]! });
    expect(() => parseYieldOutcomeDataset(duplicate)).toThrow("duplicate generationId");

    const dangling = rawDataset();
    dangling.historyObservations[0] = { ...dangling.historyObservations[0]!, generationId: "missing" };
    expect(() => parseYieldOutcomeDataset(dangling)).toThrow("unknown generationId");
  });

  it("normalizes semantically unordered input into the same digest and report", () => {
    const first = dataset();
    const shuffled = parseYieldOutcomeDataset({
      ...rawDataset(),
      generations: [...rawDataset().generations].reverse(),
      rankingObservations: [...rawDataset().rankingObservations].reverse(),
      historyObservations: [...rawDataset().historyObservations].reverse(),
    });

    expect(buildYieldOutcomeValidationReport(first)).toEqual(buildYieldOutcomeValidationReport(shuffled));
  });
});

describe("buildYieldOutcomeValidationReport", () => {
  it("reports deterministic forward APY/PYS outcomes, cohorts, and exact score recomputation", () => {
    const report = buildYieldOutcomeValidationReport(dataset(), {
      horizonDays: [30, 7],
      maxObservationGapSeconds: 3_600,
    });

    expect(report.dataset).toMatchObject({
      generationCount: 3,
      rankingObservationCount: 4,
      historyObservationCount: 8,
      methodologyVersions: ["8.299"],
      firstPublishedAt: START_SEC,
      asOf: START_SEC + 30 * DAY_SECONDS + 1_800,
    });
    expect(report.dataset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.settings).toMatchObject({
      horizonDays: [7, 30],
      maxObservationGapSeconds: 3_600,
      scoreImplementation: "shared/lib/yield-scoring.computePYS",
      formulaWeightsModified: false,
    });
    expect(report.recomputation).toEqual({
      eligiblePublishedScores: 4,
      exactMatches: 4,
      mismatchCount: 0,
      meanAbsoluteDelta: 0,
      maxAbsoluteDelta: 0,
    });

    const sevenDay = report.horizons[0]!;
    expect(sevenDay.coverage).toEqual({
      rankingObservations: 4,
      apyMatches: 4,
      apyCoverageRate: 1,
      pysEligibleRankings: 4,
      pysMatches: 3,
      pysCoverageRate: 0.75,
    });
    expect(sevenDay.outcomes).toMatchObject({
      meanForwardApy30d: 4.75,
      meanApyDelta: 0.25,
      meanAbsoluteApyDelta: 0.5,
      apyRetentionRate: 0.75,
    });
    expect(sevenDay.scorePerformance).toMatchObject({
      apySampleSize: 4,
      pysSampleSize: 3,
      pysVsForwardApySpearman: 1,
      pysVsForwardPysSpearman: 1,
    });
    expect(sevenDay.cohorts.map((cohort) => cohort.cohort)).toEqual([
      "canonical-holder",
      "direct-evidence",
      "external-opportunity",
      "modeled-proxy",
    ]);
    expect(report.horizons[1]?.scorePerformance.pysVsForwardApySpearman).toBe(-1);
  });

  it("runs one-component neutralizations through computePYS without exposing weight controls", () => {
    const source = dataset();
    const before = JSON.stringify(source);
    const report = buildYieldOutcomeValidationReport(source, {
      horizonDays: [7],
      maxObservationGapSeconds: 3_600,
    });

    expect(report.settings.ablations.map((ablation) => ablation.component)).toEqual([
      "benchmark",
      "stablecoin-safety",
      "sustainability",
      "source-risk",
    ]);
    expect(report.horizons[0]?.ablations).toHaveLength(4);
    expect(report.horizons[0]?.ablations.every((ablation) => ablation.sampleSize === 4)).toBe(true);
    expect(
      report.horizons[0]?.ablations.find((ablation) => ablation.component === "source-risk")
        ?.meanScoreDeltaFromBaseline,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(source)).toBe(before);
    expect(Object.keys(report.settings)).not.toContain("weights");
  });

  it("surfaces persisted-score drift and rejects invalid matching options", () => {
    const drifted = dataset();
    drifted.rankingObservations[0] = {
      ...drifted.rankingObservations[0]!,
      publishedPys: (drifted.rankingObservations[0]?.publishedPys ?? 0) + 1,
    };
    expect(buildYieldOutcomeValidationReport(drifted).recomputation).toMatchObject({
      exactMatches: 3,
      mismatchCount: 1,
      maxAbsoluteDelta: 1,
    });
    expect(() => buildYieldOutcomeValidationReport(dataset(), { horizonDays: [7, 7] })).toThrow("horizonDays");
    expect(() => buildYieldOutcomeValidationReport(dataset(), { maxObservationGapSeconds: 0 })).toThrow(
      "maxObservationGapSeconds",
    );
  });

  it("computes tie-aware Spearman correlations", () => {
    expect(spearmanCorrelation([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearmanCorrelation([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1);
    expect(spearmanCorrelation([1, 1, 2], [3, 3, 4])).toBe(1);
    expect(spearmanCorrelation([1], [2])).toBeNull();
  });
});

describe("generate-yield-outcome-validation CLI", () => {
  it("strictly parses deterministic report controls", () => {
    expect(
      parseYieldOutcomeCliArgs([
        "--input",
        "agents/yield-outcomes.json",
        "--horizons",
        "90,7,30",
        "--max-gap-hours",
        "48",
      ]),
    ).toEqual({
      help: false,
      inputPath: "agents/yield-outcomes.json",
      outputPath: null,
      horizonDays: [7, 30, 90],
      maxGapHours: 48,
    });
    expect(() => parseYieldOutcomeCliArgs([])).toThrow("--input is required");
    expect(() => parseYieldOutcomeCliArgs(["--input", "x", "--horizons", "7,7"])).toThrow("unique");
    expect(() => parseYieldOutcomeCliArgs(["--input", "x", "--weights", "1"])).toThrow("Unknown option");
  });

  it("serializes the same offline report for repeated input", () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-yield-outcomes-"));
    tempDirectories.push(directory);
    const inputPath = join(directory, "dataset.json");
    writeFileSync(inputPath, `${JSON.stringify(rawDataset())}\n`);
    const args = parseYieldOutcomeCliArgs(["--input", inputPath, "--horizons", "7,30", "--max-gap-hours", "1"]);

    const first = generateYieldOutcomeValidation(args);
    const second = generateYieldOutcomeValidation(args);
    expect(second).toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      schemaVersion: 1,
      settings: { formulaWeightsModified: false, horizonDays: [7, 30] },
    });
  });
});
