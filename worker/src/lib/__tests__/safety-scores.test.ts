import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

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
  scorePegStability: vi.fn(() => ({ score: 80, grade: "B", detail: "ok" })),
  scoreLiquidity: vi.fn(() => ({ score: 80, grade: "B", detail: "ok" })),
  scoreResilience: vi.fn(() => ({ score: 80, grade: "B", detail: "ok" })),
  scoreDecentralization: vi.fn(() => ({ score: 80, grade: "B", detail: "ok" })),
  scoreDependencyRisk: vi.fn(() => ({ score: 80, grade: "B", detail: "ok" })),
  computeOverallGrade: vi.fn((_dims: unknown, opts: { navToken?: boolean }) => ({
    score: opts.navToken ? 95 : 75,
    grade: opts.navToken ? "A" : "B",
    ratedDimensions: 5,
  })),
}));

vi.mock("@shared/lib/peg-score", () => ({
  computePegScore: vi.fn(() => ({
    pegScore: 88,
    pegPct: 0.88,
    severityScore: 12,
    spreadPenalty: 0,
    eventCount: 1,
    worstDeviationBps: 42,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 100,
  })),
  coinTrackingStart: vi.fn(() => 0),
}));

vi.mock("@shared/lib/depeg-dews-version", () => ({
  getDepegDewsMethodologyVersionAt: vi.fn(() => "test-methodology"),
}));

vi.mock("../stablecoins-cache", () => ({
  loadStablecoinsCache: vi.fn(async () => ({
    ok: true,
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

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return {
    ...actual,
    getFirstSeenDates: vi.fn(async () => new Map<string, number>()),
  };
});

import { computeSafetyScoresSnapshot } from "../safety-scores";

describe("computeSafetyScoresSnapshot", () => {
  let db: D1Database;

  beforeEach(() => {
    db = mockD1([
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);
  });

  it("returns map mode and excludes NAV tokens when requested", async () => {
    const result = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: false,
      outputMode: "map",
    });

    expect(result.mode).toBe("map");
    expect(result.scores.has("usdt-tether")).toBe(true);
    expect(result.scores.has("usdc-circle")).toBe(true);
    expect(result.scores.has("ust-terra")).toBe(false);
  });

  it("returns full-grades mode including NAV tokens when enabled", async () => {
    const result = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: true,
      outputMode: "full-grades",
    });

    expect(result.mode).toBe("full-grades");
    expect(result.scores.has("ust-terra")).toBe(true);
    expect(result.grades.some((grade) => grade.id === "ust-terra")).toBe(true);
  });
});
