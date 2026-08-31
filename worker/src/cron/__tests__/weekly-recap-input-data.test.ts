import { describe, expect, it } from "vitest";
import type { DigestEditorialCandidate, DigestInputData } from "@shared/types/digest";
import { buildWeeklyInputData } from "../weekly-recap/input-data";
import type { DailyDigestSourceRow } from "../weekly-recap/types";

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
