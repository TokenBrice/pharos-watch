// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildYieldDetailModel } from "@/components/yield-detail-section-model";
import { deriveYieldRowDisplay } from "@/components/yield-leaderboard-row-parts";
import { resolveYieldDisplayRebaseReferenceRate } from "@/lib/yield-benchmark";
import { makeYieldDetailRanking, makeYieldDetailResponse } from "./yield-detail.test-support";
import { makeYieldViewModelRow, REGISTRY_WITH_EUR } from "./yield-test-support";

beforeEach(() => vi.useFakeTimers({ now: Date.parse("2026-09-27T12:00:00Z") }));
afterEach(() => vi.useRealTimers());

describe("display breakdown reference evidence", () => {
  it.each([
    { version: "8.44", fallback: true, expected: 4.3864 },
    { version: "8.44", fallback: false, expected: 8.672 },
    { version: "8.42", fallback: false, expected: 4.3864 },
  ])("matches API effective yield for $version with fallback=$fallback", ({ version, fallback, expected }) => {
    const ranking = makeYieldDetailRanking({
      id: "zchf-frankencoin", apy30d: 3.5, benchmarkKey: "CHF",
      benchmarkCurrency: "CHF", benchmarkRate: -0.0456,
      safetyScore: 80, yieldStability: 1,
    });
    const response = makeYieldDetailResponse([ranking]);
    response.riskFreeRate = 4.24;
    response.methodology = {
      version, versionLabel: `v${version}`, currentVersion: "8.44", currentVersionLabel: "v8.44",
      changelogPath: "/methodology/yield", asOf: Date.now() / 1000, isCurrent: version === "8.44",
    };
    response.benchmarks = {
      USD: { ...REGISTRY_WITH_EUR.USD, rate: 4.24, fetchedAt: Date.now() / 1000,
        recordDate: "2026-09-27", maxRecordAgeSec: 5 * 86400, isFallback: fallback },
    };
    const model = buildYieldDetailModel(response, {
      stablecoinId: ranking.id, lifecycle: "active", mode: "embedded", shouldHaveYieldData: false,
      inactiveReason: "",
    }, []);
    expect(model.status).toBe("ready");
    if (model.status !== "ready") throw new Error("Expected detail breakdown");
    expect(model.pysBreakdown.effectiveYield).toBeCloseTo(expected, 4);
    const board = deriveYieldRowDisplay(makeYieldViewModelRow(ranking), response.scalingFactor,
      resolveYieldDisplayRebaseReferenceRate(version, response.riskFreeRate, response.benchmarks.USD));
    expect(board.breakdown.effectiveYield).toBeCloseTo(expected, 4);
  });
});
