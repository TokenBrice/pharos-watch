import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const buildReportCardsSnapshotMock = vi.hoisted(() =>
  vi.fn(async () => ({
    cards: [
      {
        id: "usdt-tether",
        symbol: "AAA",
        overallGrade: "B",
        overallScore: 75,
        dimensions: { liquidity: { score: 80 } },
        rawInputs: { pegScore: 88, navToken: false },
        isDefunct: false,
      },
      {
        id: "usdc-circle",
        symbol: "BBB",
        overallGrade: "B+",
        overallScore: 82,
        dimensions: { liquidity: { score: 84 } },
        rawInputs: { pegScore: 91, navToken: false },
        isDefunct: false,
      },
      {
        id: "ust-terra",
        symbol: "NAV",
        overallGrade: "A",
        overallScore: 95,
        dimensions: { liquidity: { score: 90 } },
        rawInputs: { pegScore: null, navToken: true },
        isDefunct: false,
      },
      {
        id: "dead-coin",
        symbol: "DEAD",
        overallGrade: "F",
        overallScore: 0,
        dimensions: { liquidity: { score: 0 } },
        rawInputs: { pegScore: null, navToken: false },
        isDefunct: true,
      },
    ],
  })),
);
const reportCardsSnapshotUnavailableErrorCtor = vi.hoisted(
  () => class ReportCardsSnapshotUnavailableError extends Error {},
);

vi.mock("@shared/lib/stablecoins/registry", () => {
  const stablecoins = [
    {
      id: "usdt-tether",
      symbol: "AAA",
      name: "AAA Stable",
      flags: { pegCurrency: "USD", governance: "centralized", navToken: false },
    },
    {
      id: "usdc-circle",
      symbol: "BBB",
      name: "BBB Stable",
      flags: { pegCurrency: "USD", governance: "centralized-dependent", navToken: false },
    },
    {
      id: "ust-terra",
      symbol: "NAV",
      name: "NAV Token",
      flags: { pegCurrency: "USD", governance: "centralized", navToken: true },
    },
  ];
  return {
    TRACKED_STABLECOINS: stablecoins,
    ACTIVE_STABLECOINS: stablecoins,
  };
});

vi.mock("../report-cards-snapshot", () => ({
  buildReportCardsSnapshot: buildReportCardsSnapshotMock,
  ReportCardsSnapshotUnavailableError: reportCardsSnapshotUnavailableErrorCtor,
}));

import { computeSafetyScoresSnapshot } from "../safety-scores";
import type { StablecoinsCacheLoadOk } from "../stablecoins-cache";

describe("computeSafetyScoresSnapshot", () => {
  let db: D1Database;

  beforeEach(() => {
    db = mockD1();
    buildReportCardsSnapshotMock.mockClear();
  });

  it("returns map mode and excludes NAV tokens when requested", async () => {
    const result = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: false,
      outputMode: "map",
    });

    expect(result.kind).toBe("ok");
    expect(result.mode).toBe("map");
    expect(result.scores.get("usdt-tether")).toEqual({ score: 75, grade: "B" });
    expect(result.scores.get("usdc-circle")).toEqual({ score: 82, grade: "B+" });
    expect(result.scores.has("ust-terra")).toBe(false);
    expect(buildReportCardsSnapshotMock).toHaveBeenCalledWith(db);
  });

  it("returns full-grades mode including NAV tokens when enabled", async () => {
    const result = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: true,
      outputMode: "full-grades",
    });

    expect(result.kind).toBe("ok");
    expect(result.mode).toBe("full-grades");
    expect(result.scores.get("ust-terra")).toEqual({ score: 95, grade: "A" });
    expect(result.grades).toEqual([
      { id: "usdt-tether", symbol: "AAA", grade: "B", score: 75, pegScore: 88, liqScore: 80 },
      { id: "usdc-circle", symbol: "BBB", grade: "B+", score: 82, pegScore: 91, liqScore: 84 },
      { id: "ust-terra", symbol: "NAV", grade: "A", score: 95, pegScore: null, liqScore: 90 },
    ]);
  });

  it("passes a preloaded stablecoins cache through to the report-card builder", async () => {
    const preloadedStablecoinsCache: StablecoinsCacheLoadOk = {
      kind: "ok",
      payload: { peggedAssets: [] },
      updatedAt: 123,
    };

    await computeSafetyScoresSnapshot(db, {
      includeNavTokens: true,
      outputMode: "map",
      preloadedStablecoinsCache,
    });

    expect(buildReportCardsSnapshotMock).toHaveBeenCalledWith(db, { preloadedStablecoinsCache });
  });

  it("returns degraded result when report-card snapshot build fails", async () => {
    buildReportCardsSnapshotMock.mockRejectedValueOnce(new Error("Cached stablecoins data is corrupt"));

    const result = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: false,
      outputMode: "map",
    });

    expect(result.kind).toBe("degraded");
    expect(result.coveredCount).toBe(0);
    expect(result.reason).toBe("Cached stablecoins data is corrupt");
  });

  it("preserves typed snapshot-unavailable reasons in degraded mode", async () => {
    buildReportCardsSnapshotMock.mockRejectedValueOnce(
      new reportCardsSnapshotUnavailableErrorCtor("Redemption backstop snapshot unavailable"),
    );

    const result = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: false,
      outputMode: "map",
    });

    expect(result.kind).toBe("degraded");
    expect(result.reason).toBe("Redemption backstop snapshot unavailable");
  });
});
