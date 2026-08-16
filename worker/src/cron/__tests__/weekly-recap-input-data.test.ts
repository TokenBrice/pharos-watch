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
});
