import { describe, expect, it } from "vitest";
import type { DigestEditorialCandidate, DigestInputData } from "@shared/types/digest";
import { buildWeeklyInputData } from "../weekly-recap/input-data";
import type { DailyDigestSourceRow } from "../weekly-recap/types";
import { buildWeeklyPrompt } from "../weekly-recap/prompt";

const START_SEC = 1_786_665_600;

function candidate(
  id: string,
  kind: DigestEditorialCandidate["kind"],
  impactScore: number,
  symbol: string,
): DigestEditorialCandidate {
  return {
    id,
    kind,
    title: `${symbol} ${kind} signal`,
    symbols: [symbol],
    impactScore,
    novelty: "worsening",
    confidence: "high",
    artifactRisk: "low",
    headlineFacts: [`canonical impact ${impactScore}`],
    whyItMatters: "Fixture canonical candidate.",
  };
}

function row(index: number, overrides: Partial<DigestInputData> = {}): DailyDigestSourceRow {
  const input: DigestInputData = {
    totalMcapUsd: 1_000_000_000,
    mcap7dDelta: 0,
    activeDepegCount: 0,
    topDepegs: [],
    biggestSupplyChange: null,
    stabilityIndex: {
      score: 90,
      band: "BEDROCK",
      components: { severity: 0, breadth: 0, trend: 0 },
    },
    yesterdayIndex: null,
    ...overrides,
  };
  return {
    generated_at: START_SEC + index * 86_400,
    digest_title: `Day ${index + 1}`,
    digest_text: "Daily fixture.",
    input_data: JSON.stringify(input),
  };
}

describe("weekly recap canonical candidate aggregation", () => {
  it("keeps a zero market-cap base undefined rather than inventing infinite growth", () => {
    const weekly = buildWeeklyInputData(Array.from({ length: 5 }, (_, index) => row(index, {
      totalMcapUsd: index * 1_000_000,
    })));
    expect(weekly?.mcapRange).toEqual({ start: 0, end: 4_000_000, netChange: 4_000_000, pctChange: null });
    expect(buildWeeklyPrompt(weekly!)).toContain("(N/A)");
    expect(buildWeeklyPrompt(weekly!)).not.toContain("Infinity");
  });

  it("computes prior-week deltas from independent daily values", () => {
    const current = Array.from({ length: 5 }, (_, index) => row(index, { totalMcapUsd: 200_000_000 }));
    const prior = Array.from({ length: 5 }, (_, index) => row(index - 7, {
      totalMcapUsd: 100_000_000,
      stabilityIndex: { score: 80, band: "BEDROCK", components: { severity: 0, breadth: 0, trend: 0 } },
    }));
    expect(buildWeeklyInputData(current, prior)?.weekOverWeekDeltas).toMatchObject({
      mcap: { current: 200_000_000, prior: 100_000_000, deltaPct: 100 },
      psi: { current: 90, prior: 80, delta: 10 },
      dataCoverage: { currentDays: 5, priorDays: 5 },
    });
  });

  it("rejects malformed grade transitions while preserving comparable valid transitions", () => {
    const identity = {
      model: "v8" as const, schemaVersion: 1 as const, methodologyVersion: "8.17",
      evaluationBuildDigest: "a".repeat(64), baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
      publicationGenerationId: "report-cards:v8:test",
    };
    const rows = Array.from({ length: 5 }, (_, index) => row(index));
    const input = JSON.parse(rows[2]!.input_data);
    input.gradeTransitions = [
      { mcapUsd: 1_000_000 },
      {
        historyId: "history:usdt:1", recordedAt: rows[2]!.generated_at, model: "v8", safetyScoreIdentity: identity,
        symbol: "USDT", fromGrade: "A", toGrade: "B", fromScore: 90, toScore: 80,
        currentDimensions: { peg: 95, liq: 80, resilience: null, decentralization: null }, mcapUsd: 2_000_000,
      },
    ];
    rows[2] = { ...rows[2]!, input_data: JSON.stringify(input) };
    const weekly = buildWeeklyInputData(rows, [], {
      status: "available", expectedModel: "v8", identity, publishedAt: START_SEC, reason: null,
    });
    expect(weekly?.weeklySignals.topGradeTransitions.map((entry) => entry.historyId)).toEqual(["history:usdt:1"]);
    expect(weekly?.gradeTransitionCount).toBe(1);
  });

  it("ranks fresh criticals first but makes carried criticals compete on severity ahead of suppressed signals", () => {
    const chronicStartedAt = START_SEC - 30 * 86_400;
    const freshStartedAt = START_SEC + 86_400;
    const rows = Array.from({ length: 5 }, (_, index) => row(index));
    rows[2] = row(2, {
      editorialCandidates: [
        { ...candidate("liquidity:suppressed", "liquidity", 1_000_000_000, "SUP"), suppressReason: "known bad upstream quote" },
        candidate("liquidity:large", "liquidity", 100_000_000, "BIG"),
      ],
      activeDepegCount: 2,
      topDepegs: [
        { stablecoinId: "chronic", symbol: "CHR", bps: -2500, mcapUsd: 75_000_000, startedAt: chronicStartedAt },
        { stablecoinId: "fresh", symbol: "NEW", bps: -2500, mcapUsd: 75_000_000, startedAt: freshStartedAt },
      ],
    });
    const weekly = buildWeeklyInputData(rows);
    expect(weekly?.weeklySignals.riskLeaderboard.map((entry) => entry.id)).toEqual([
      `weekly:depeg:fresh:${freshStartedAt}`,
      "weekly:liquidity:large",
      `weekly:depeg:chronic:${chronicStartedAt}`,
      "weekly:liquidity:suppressed",
    ]);
    expect(weekly?.weeklySignals.riskLeaderboard[2]).toMatchObject({ critical: true, carriedOver: true });
  });

  it("orders depeg competitors by suppression, fresh criticality, severity, and impact", () => {
    const startedAt = START_SEC + 86_400;
    const rows = Array.from({ length: 5 }, (_, index) => row(index));
    rows[2] = row(2, {
      activeDepegCount: 3,
      topDepegs: [
        { stablecoinId: "suppressed-critical", symbol: "SUP", bps: -2500, mcapUsd: 3_000_000_000, startedAt, suppressReason: "known bad upstream quote" },
        { stablecoinId: "noncritical-large", symbol: "BIG", bps: -900, mcapUsd: 5_000_000_000, startedAt },
        { stablecoinId: "critical-small", symbol: "CRIT", bps: -2500, mcapUsd: 75_000_000, startedAt },
      ],
    });
    expect(buildWeeklyInputData(rows)?.weeklySignals.riskLeaderboard.map((entry) => entry.id)).toEqual([
      `weekly:depeg:critical-small:${startedAt}`,
      `weekly:depeg:noncritical-large:${startedAt}`,
      `weekly:depeg:suppressed-critical:${startedAt}`,
    ]);
  });

  it("deduplicates repeated observations by stable depeg event identity", () => {
    const chronicStartedAt = START_SEC - 86_400;
    const rows = Array.from({ length: 7 }, (_, index) => row(index, {
      activeDepegCount: 1,
      topDepegs: [{
        stablecoinId: "chronic-usd",
        symbol: "CHR",
        bps: -(200 + index * 50),
        mcapUsd: 100_000_000,
        startedAt: chronicStartedAt,
      }],
    }));
    const last = JSON.parse(rows[6]!.input_data) as DigestInputData;
    last.activeDepegCount = 2;
    last.topDepegs.push({
      stablecoinId: "fresh-usd",
      symbol: "NEW",
      bps: -300,
      mcapUsd: 50_000_000,
      startedAt: START_SEC + 6 * 86_400 - 3_600,
    });
    rows[6] = { ...rows[6]!, input_data: JSON.stringify(last) };

    const weekly = buildWeeklyInputData(rows);

    expect(weekly?.activeDepegObservationsThisWeek).toBe(8);
    expect(weekly?.weeklySignals.topDepegSignals).toHaveLength(2);
    expect(weekly?.weeklySignals.topDepegSignals.filter((signal) => signal.symbol === "CHR")).toHaveLength(1);
    expect(weekly?.weeklySignals.topDepegSignals.find((signal) => signal.symbol === "CHR")).toMatchObject({
      bps: 500,
      eventIdentity: `chronic-usd:${chronicStartedAt}`,
      carriedOver: true,
    });
  });

  it("uses persisted daily candidate impact units for weekly yield and liquidity ranking", () => {
    const rows = Array.from({ length: 5 }, (_, index) => row(index, {
      editorialCandidates: [
        candidate("yield:coin", "yield", 321, "YLD"),
        candidate("liquidity:coin", "liquidity", 654, "LIQ"),
      ],
    }));

    const weekly = buildWeeklyInputData(rows);
    const leaderboard = weekly?.weeklySignals.riskLeaderboard ?? [];

    expect(leaderboard.filter((signal) => signal.id === "weekly:yield:coin")).toHaveLength(1);
    expect(leaderboard.find((signal) => signal.id === "weekly:yield:coin")).toMatchObject({
      impactScore: 321,
      severityScore: 321,
    });
    expect(leaderboard.find((signal) => signal.id === "weekly:liquidity:coin")).toMatchObject({
      impactScore: 654,
      severityScore: 654,
    });
  });

  it("excludes the retracted USDS liquidity ingestion and records the withheld signal", () => {
    const incidentAt = 1_787_299_523;
    const rows = Array.from({ length: 5 }, (_, index) => row(index));
    rows[4] = row(4, {
      dataQuality: {
        generatedAt: incidentAt,
        stablecoinsCacheUpdatedAt: incidentAt - 60,
        stablecoinsCacheAgeSec: 60,
        windows: {
          blacklistActivity: { label: "rolling last 24h", start: incidentAt - 86_400, end: incidentAt },
          mintBurnFlows: { label: "rolling last 24h", start: incidentAt - 86_400, end: incidentAt },
          supplyVelocity: { label: "UTC snapshots", dates: [incidentAt] },
          psi: { label: "latest sample", sampleAt: incidentAt, dailySnapshotAt: incidentAt - 300 },
        },
      },
      liquidityShifts: [
        {
          symbol: "USDS",
          currentScore: 49,
          previousScore: 59,
          scoreDelta: -10,
          currentTvl: 13_715_691,
          previousTvl: 162_283_507,
          mcapUsd: 6_711_545_483,
          tvlChangePct: -0.915,
          expectedScoreDeltaFromTvl: -11,
          coverageClass: "primary",
          coverageConfidence: 1,
        },
        {
          symbol: "YLDS",
          currentScore: 51,
          previousScore: 60,
          scoreDelta: -9,
          currentTvl: 13_720_000,
          previousTvl: 20_000_000,
          mcapUsd: 500_000_000,
          tvlChangePct: -0.314,
          expectedScoreDeltaFromTvl: -5,
          coverageClass: "primary",
          coverageConfidence: 1,
        },
      ],
      editorialCandidates: [
        candidate("liquidity:usds", "liquidity", 67_115, "USDS"),
        candidate("liquidity:ylds", "liquidity", 4_500, "YLDS"),
      ],
    });
    rows[4] = {
      ...rows[4],
      generated_at: incidentAt,
      digest_title: "USDS Drained",
      digest_text: "USDS drained to $13.72M.",
    };

    const weekly = buildWeeklyInputData(rows);
    const incidentDay = weekly?.dailyDigests.find((digest) => digest.date === "2026-08-21");

    expect(weekly?.degradedSources).toContain("liquidity-shift-quarantined-signal:usds-sky:2026-08-21");
    expect(incidentDay).toMatchObject({ title: "", text: "" });
    expect(incidentDay?.inputData.liquidityShifts?.map((shift) => shift.symbol)).toEqual(["YLDS"]);
    expect(incidentDay?.inputData.editorialCandidates?.map((entry) => entry.id)).toEqual(["liquidity:ylds"]);
    expect(weekly?.weeklySignals.topLiquidityShifts.map((shift) => shift.symbol)).toEqual(["YLDS"]);
    expect(weekly?.weeklySignals.riskLeaderboard.some((signal) => signal.symbols.includes("USDS"))).toBe(false);
    expect(weekly?.weeklySignals.riskLeaderboard.some((signal) => signal.symbols.includes("YLDS"))).toBe(true);
  });
});
