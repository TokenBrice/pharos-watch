import { describe, expect, it } from "vitest";
import { makeYieldRanking, makeYieldProvenance, makeAltYieldSource } from "@shared/test-utils/yield-ranking-fixtures";
import { YieldHistoryResponseSchema, YieldRankingsResponseSchema, type YieldHistoryResponse } from "@shared/types/yield";
import { YieldRankingsSummaryResponseSchema } from "@shared/types/yield-summary";
import { projectYieldRankingsSummary } from "../yield-rankings-summary";
import { projectYieldWireCompat } from "../yield-wire-compat";

function payload() {
  return {
    rankings: [makeYieldRanking({ benchmarkSelectionMode: "native", benchmarkIsFallback: true,
      provenance: makeYieldProvenance({ sourceObservedAt: null, sourceAgeSeconds: null, sourceMaxAgeSeconds: 3600 }),
      sourceRisk: { rewardShare: 1.5 }, altSources: [makeAltYieldSource({ sourceRisk: { rewardShare: 2 } })],
      rankChangeAttribution: null })],
    riskFreeRate: 4, scalingFactor: 8, medianApy: null, updatedAt: 100,
    _meta: { updatedAt: 100, ageSeconds: 10, status: "fresh" as const, assessedAt: 110,
      freshBudgetSec: 7200, degradedBudgetSec: 14400, reason: null },
  };
}

describe("Phase A yield wire compatibility", () => {
  it("withholds strict-summary additions and retains the legacy currency-substitution flag", () => {
    const input = payload();
    const summary = projectYieldRankingsSummary(input);
    const wire = projectYieldWireCompat(summary);
    expect(wire.rankings[0]).not.toHaveProperty("benchmarkSelectionMode");
    expect(wire.rankings[0].provenance).not.toHaveProperty("sourceMaxAgeSeconds");
    expect(wire.rankings[0].benchmarkIsFallback).toBe(false);
    input.rankings[0].benchmarkSelectionMode = "fallback-usd";
    expect(projectYieldWireCompat(projectYieldRankingsSummary(input)).rankings[0].benchmarkIsFallback).toBe(true);
    expect(summary.rankings[0].benchmarkSelectionMode).toBe("native");
    expect(YieldRankingsSummaryResponseSchema.safeParse(summary).success).toBe(true);
    expect(YieldRankingsSummaryResponseSchema.safeParse(wire).success).toBe(true);
  });

  it("keeps unavailable observation and out-of-range reward evidence unavailable without altering stored values", () => {
    const input = payload();
    const wire = projectYieldWireCompat(input);
    expect(wire.rankings[0].provenance).toBeNull();
    expect(wire.rankings[0].sourceRisk?.rewardShare).toBeNull();
    expect(wire.rankings[0].altSources[0].sourceRisk?.rewardShare).toBeNull();
    expect(wire.rankings[0].rankChangeAttribution).toBeNull();
    expect(wire.medianApy).toBe(0);
    expect(wire._meta).toEqual({ updatedAt: 100, ageSeconds: 10, status: "fresh" });
    expect(input.rankings[0].sourceRisk?.rewardShare).toBe(1.5);
    expect(input.rankings[0].provenance?.sourceMaxAgeSeconds).toBe(3600);
    expect(YieldRankingsResponseSchema.safeParse(input).success).toBe(true);
    expect(YieldRankingsResponseSchema.safeParse(wire).success).toBe(true);
  });

  it("retains unreadable warning status while withholding unrepresentable history reward share", () => {
    const point = {
      date: 100, apy: 4, apyBase: -2, apyReward: 6, exchangeRate: null, sourceTvlUsd: null,
      warningSignals: [], warningSignalsStatus: "unreadable" as const, sourceRisk: { rewardShare: 1.5 },
    };
    const input: YieldHistoryResponse = {
      current: point, history: [point],
      methodology: { version: "8.45", versionLabel: "v8.45", currentVersion: "8.45",
        currentVersionLabel: "v8.45", changelogPath: "/methodology/yield-changelog/", asOf: 100, isCurrent: true },
    };
    const wire = projectYieldWireCompat(input);
    expect(wire.current?.sourceRisk?.rewardShare).toBeNull();
    expect(wire.history[0].sourceRisk?.rewardShare).toBeNull();
    expect(wire.history[0].warningSignalsStatus).toBe("unreadable");
    expect(input.current?.sourceRisk?.rewardShare).toBe(1.5);
    expect(YieldHistoryResponseSchema.safeParse(wire).success).toBe(true);
  });
});
