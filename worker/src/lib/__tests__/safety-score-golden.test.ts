import { describe, expect, it, vi } from "vitest";
import { makeAsset, makeReportCardsDb } from "../../api/__tests__/helpers/fixtures";
import { buildReportCardsSnapshot } from "../report-cards-snapshot";
import type { PegSummaryCoin } from "@shared/types/market";

/**
 * Golden-fixture score-contract test for the Safety Score pipeline.
 *
 * Locks the current end-to-end behavior of `buildReportCardsSnapshot` against a
 * handful of scenarios that exercise the main policy surfaces:
 *
 *   1. Active-depeg D cap (>=1000 bps)
 *   2. Active-depeg F cap (>=2500 bps)
 *   3. NAV-wrapper peg inheritance (v6.94)
 *   4. No-liquidity penalty (v5.4, NO_LIQUIDITY_PENALTY = 0.9)
 *
 * Mock strategy mirrors `report-cards-snapshot.test.ts`: the `@shared/lib/stablecoins`
 * module stays real, and scenario-specific inputs are injected via mocked
 * `derivePegAnalyticsSnapshot`, `loadDexLiquiditySnapshot`,
 * `loadRedemptionBackstopSnapshot`, and `loadFreshIndependentLiveReserveMap`.
 *
 * Assertions lock `overallGrade`, `overallScore`, and the relevant dimension scores.
 * Values were captured from the first run against methodology v7.07. When updating
 * them after an intentional methodology bump, add a `// Locked against vX.XX ...`
 * comment alongside the changed block so the diff stays auditable.
 */

const loadRedemptionBackstopSnapshotMock = vi.hoisted(() => vi.fn());
const loadDexLiquiditySnapshotMock = vi.hoisted(() => vi.fn());
const loadFreshIndependentLiveReserveMapMock = vi.hoisted(() => vi.fn());
const derivePegAnalyticsSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../redemption-backstops-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("../redemption-backstops-store")>();
  return {
    ...original,
    loadRedemptionBackstopSnapshot: loadRedemptionBackstopSnapshotMock,
  };
});

vi.mock("../dex-liquidity", async (importOriginal) => {
  const original = await importOriginal<typeof import("../dex-liquidity")>();
  return {
    ...original,
    loadDexLiquiditySnapshot: loadDexLiquiditySnapshotMock,
  };
});

vi.mock("../live-reserves-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("../live-reserves-store")>();
  return {
    ...original,
    loadFreshIndependentLiveReserveMap: loadFreshIndependentLiveReserveMapMock,
  };
});

vi.mock("../peg-analytics", async (importOriginal) => {
  const original = await importOriginal<typeof import("../peg-analytics")>();
  return {
    ...original,
    derivePegAnalyticsSnapshot: derivePegAnalyticsSnapshotMock,
  };
});

const NOW_SEC = 1_776_527_157;

function makePeg(overrides: Partial<PegSummaryCoin>): PegSummaryCoin {
  return {
    id: "usdt-tether",
    symbol: "USDT",
    name: "Tether",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 0,
    pegScore: 95,
    pegPct: 100,
    severityScore: 100,
    spreadPenalty: 0,
    eventCount: 0,
    worstDeviationBps: null,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 1825,
    methodologyVersion: "test",
    ...overrides,
  };
}

describe("Safety Score golden fixture", () => {
  function setupMocks(params: {
    pegDataById: Map<string, PegSummaryCoin>;
    dexLiqMap?: Record<string, { liquidityScore: number; concentrationHhi: number; poolCount: number; chainCount: number }>;
    eventsByCoin?: Map<string, Array<{ peakDeviationBps: number; endedAt: number | null }>>;
  }) {
    loadRedemptionBackstopSnapshotMock.mockResolvedValue({ map: {}, latestUpdatedAt: NOW_SEC });
    loadFreshIndependentLiveReserveMapMock.mockResolvedValue(new Map());
    loadDexLiquiditySnapshotMock.mockResolvedValue({
      map: params.dexLiqMap ?? {},
      latestUpdatedAt: NOW_SEC,
    });
    derivePegAnalyticsSnapshotMock.mockResolvedValue({
      pegDataById: params.pegDataById,
      eventsByCoin: params.eventsByCoin ?? new Map(),
      methodology: {
        version: "test",
        activeDepegThresholdBps: 1000,
        activeDepegMinDurationMinutes: 60,
        trackingWindowYears: 4,
      },
      updatedAt: NOW_SEC,
    });
  }

  it("active-depeg D cap clamps overall score to 49 (1200 bps open-event peak)", async () => {
    setupMocks({
      pegDataById: new Map([
        [
          "usdt-tether",
          makePeg({
            id: "usdt-tether",
            symbol: "USDT",
            name: "Tether",
            pegScore: 70,
            pegPct: 95,
            currentDeviationBps: 1200,
            worstDeviationBps: 1200,
            eventCount: 1,
            activeDepeg: true,
            lastEventAt: NOW_SEC,
          }),
        ],
      ]),
      eventsByCoin: new Map([
        ["usdt-tether", [{ peakDeviationBps: 1200, endedAt: null }]],
      ]),
      dexLiqMap: {
        "usdt-tether": { liquidityScore: 85, concentrationHhi: 0.25, poolCount: 20, chainCount: 6 },
      },
    });

    const snapshot = await buildReportCardsSnapshot(
      makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })], NOW_SEC),
    );
    const card = snapshot.cards.find((c) => c.id === "usdt-tether");
    expect(card).toBeDefined();
    expect(card!.overallGrade).toBe("D");
    expect(card!.overallScore).toBe(49);
    expect(card!.rawInputs.activeDepegBps).toBe(1200);
  });

  it("active-depeg F cap clamps overall score to 39 (2700 bps open-event peak) and excludes redemption uplift", async () => {
    setupMocks({
      pegDataById: new Map([
        [
          "usdc-circle",
          makePeg({
            id: "usdc-circle",
            symbol: "USDC",
            name: "USD Coin",
            governance: "centralized",
            pegScore: 40,
            pegPct: 80,
            currentDeviationBps: 2700,
            worstDeviationBps: 2700,
            eventCount: 1,
            activeDepeg: true,
            lastEventAt: NOW_SEC,
          }),
        ],
      ]),
      eventsByCoin: new Map([
        ["usdc-circle", [{ peakDeviationBps: 2700, endedAt: null }]],
      ]),
      dexLiqMap: {
        "usdc-circle": { liquidityScore: 90, concentrationHhi: 0.2, poolCount: 30, chainCount: 8 },
      },
    });

    const snapshot = await buildReportCardsSnapshot(
      makeReportCardsDb([makeAsset({ id: "usdc-circle", symbol: "USDC" })], NOW_SEC),
    );
    const card = snapshot.cards.find((c) => c.id === "usdc-circle");
    expect(card).toBeDefined();
    expect(card!.overallGrade).toBe("F");
    expect(card!.overallScore).toBe(39);
    expect(card!.rawInputs.activeDepegBps).toBe(2700);
  });

  it("NAV-wrapper inherits peg from referenced base stablecoin (v6.94)", async () => {
    setupMocks({
      pegDataById: new Map([
        [
          "usdai-usd-ai",
          makePeg({
            id: "usdai-usd-ai",
            symbol: "USDAI",
            name: "USD AI",
            pegScore: 55,
            pegPct: 92,
            currentDeviationBps: 80,
            worstDeviationBps: 120,
            eventCount: 3,
            activeDepeg: false,
          }),
        ],
      ]),
    });

    const snapshot = await buildReportCardsSnapshot(
      makeReportCardsDb(
        [
          makeAsset({ id: "usdai-usd-ai", symbol: "USDAI" }),
          makeAsset({ id: "susdai-usd-ai", symbol: "sUSDAI" }),
        ],
        NOW_SEC,
      ),
    );

    const navWrapper = snapshot.cards.find((c) => c.id === "susdai-usd-ai");
    expect(navWrapper).toBeDefined();
    expect(navWrapper!.rawInputs.navToken).toBe(true);
    expect(navWrapper!.dimensions.pegStability.score).toBe(55);
    expect(navWrapper!.dimensions.pegStability.detail).toContain("Peg reference (USDai)");
  });

  it("no-liquidity penalty multiplies final score by 0.9 when both DEX and redemption are absent", async () => {
    setupMocks({
      pegDataById: new Map([
        [
          "usds-sky",
          makePeg({
            id: "usds-sky",
            symbol: "USDS",
            name: "USDS",
            governance: "decentralized",
            pegScore: 95,
            pegPct: 100,
            currentDeviationBps: 0,
            worstDeviationBps: null,
            eventCount: 0,
            activeDepeg: false,
          }),
        ],
      ]),
    });

    const snapshot = await buildReportCardsSnapshot(
      makeReportCardsDb([makeAsset({ id: "usds-sky", symbol: "USDS" })], NOW_SEC),
    );
    const card = snapshot.cards.find((c) => c.id === "usds-sky");
    expect(card).toBeDefined();
    expect(card!.dimensions.liquidity.score).toBeNull();
    const base = card!.baseScore;
    const overall = card!.overallScore;
    expect(base).not.toBeNull();
    expect(overall).not.toBeNull();
    // Peg multiplier (95/100)^0.4 = ~0.9796; then *0.9 no-liquidity penalty.
    const expectedApprox = base! * Math.pow(95 / 100, 0.4) * 0.9;
    expect(Math.abs(overall! - Math.round(expectedApprox))).toBeLessThanOrEqual(1);
  });
});
