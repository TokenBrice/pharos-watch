import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

const derivePegAnalyticsSnapshotMock = vi.hoisted(() =>
  vi.fn(async () => ({
    pegDataById: new Map([
      [
        "usdt-tether",
        {
          id: "usdt-tether",
          symbol: "AAA",
          name: "AAA Stable",
          pegType: "peggedUSD",
          pegCurrency: "USD",
          governance: "centralized",
          currentDeviationBps: 4,
          pegScore: 88,
          pegPct: 0.88,
          severityScore: 12,
          spreadPenalty: 0,
          eventCount: 0,
          worstDeviationBps: null,
          activeDepeg: false,
          lastEventAt: null,
          trackingSpanDays: 100,
          methodologyVersion: "test-methodology",
        },
      ],
      [
        "usdc-circle",
        {
          id: "usdc-circle",
          symbol: "BBB",
          name: "BBB Stable",
          pegType: "peggedUSD",
          pegCurrency: "USD",
          governance: "centralized-dependent",
          currentDeviationBps: 3,
          pegScore: 91,
          pegPct: 0.91,
          severityScore: 9,
          spreadPenalty: 0,
          eventCount: 0,
          worstDeviationBps: null,
          activeDepeg: false,
          lastEventAt: null,
          trackingSpanDays: 100,
          methodologyVersion: "test-methodology",
        },
      ],
      [
        "ust-terra",
        {
          id: "ust-terra",
          symbol: "NAV",
          name: "NAV Token",
          pegType: "peggedUSD",
          pegCurrency: "USD",
          governance: "centralized",
          currentDeviationBps: null,
          pegScore: null,
          pegPct: null,
          severityScore: null,
          spreadPenalty: null,
          eventCount: 0,
          worstDeviationBps: null,
          activeDepeg: false,
          lastEventAt: null,
          trackingSpanDays: 100,
          methodologyVersion: "test-methodology",
        },
      ],
    ]),
  })),
);

vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_STABLECOINS: [
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
  ],
}));

vi.mock("@shared/lib/report-cards", () => ({
  isBlacklistable: vi.fn(() => false),
  scorePegStability: vi.fn((peg: { currentDeviationBps: number | null } | undefined, meta: { flags: { navToken?: boolean } }) => {
    if (meta.flags.navToken) return { score: null, grade: "NR", detail: "nav" };
    if (!peg || peg.currentDeviationBps === null) {
      return { score: null, grade: "NR", detail: "no live peg signal" };
    }
    return { score: 80, grade: "B", detail: "ok" };
  }),
  scoreLiquidity: vi.fn(() => ({ score: 80, grade: "B", detail: "ok" })),
  scoreResilience: vi.fn(() => ({ score: 80, grade: "B", detail: "ok" })),
  scoreDecentralization: vi.fn(() => ({ score: 80, grade: "B", detail: "ok" })),
  scoreDependencyRisk: vi.fn(() => ({ score: 80, grade: "B", detail: "ok" })),
  computeOverallGrade: vi.fn((dims: Record<string, { score: number | null }>, opts: { navToken?: boolean }) => {
    if (!opts.navToken && dims.pegStability?.score === null) {
      return { score: null, grade: "NR", ratedDimensions: 4 };
    }
    return {
      score: opts.navToken ? 95 : 75,
      grade: opts.navToken ? "A" : "B",
      ratedDimensions: 5,
    };
  }),
}));

vi.mock("../stablecoins-cache", () => ({
  loadStablecoinsCache: vi.fn(async () => ({
    kind: "ok",
    payload: {
      peggedAssets: [
        { id: "usdt-tether", pegType: "peggedUSD" },
        { id: "usdc-circle", pegType: "peggedUSD" },
        { id: "ust-terra", pegType: "peggedUSD" },
      ],
    },
    updatedAt: 1_700_000_000,
  })),
}));

vi.mock("../peg-analytics", () => ({
  derivePegAnalyticsSnapshot: derivePegAnalyticsSnapshotMock,
}));

import { computeSafetyScoresSnapshot } from "../safety-scores";

describe("computeSafetyScoresSnapshot", () => {
  let db: D1Database;

  beforeEach(() => {
    db = mockD1([
      { match: "dex_liquidity", rows: [] },
    ]);
    derivePegAnalyticsSnapshotMock.mockClear();
  });

  it("returns map mode and excludes NAV tokens when requested", async () => {
    const result = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: false,
      outputMode: "map",
    });

    expect(result.kind).toBe("ok");
    expect(result.mode).toBe("map");
    expect(result.scores.has("usdt-tether")).toBe(true);
    expect(result.scores.has("usdc-circle")).toBe(true);
    expect(result.scores.has("ust-terra")).toBe(false);
    expect(derivePegAnalyticsSnapshotMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        includeNavTokens: false,
        methodologyAsOf: 1_700_000_000,
      }),
    );
  });

  it("returns full-grades mode including NAV tokens when enabled", async () => {
    const result = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: true,
      outputMode: "full-grades",
    });

    expect(result.kind).toBe("ok");
    expect(result.mode).toBe("full-grades");
    expect(result.scores.has("ust-terra")).toBe(true);
    expect(result.grades.some((grade) => grade.id === "ust-terra")).toBe(true);
  });

  it("returns degraded result when stablecoins cache is unavailable", async () => {
    const { loadStablecoinsCache } = await import("../stablecoins-cache");
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "error",
      reason: "missing-cache",
      updatedAt: null,
    });

    const result = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: false,
      outputMode: "map",
    });

    expect(result.kind).toBe("degraded");
    expect(result.coveredCount).toBe(0);
    expect(result.reason).toBe("stablecoins-cache:missing-cache");
  });
});
