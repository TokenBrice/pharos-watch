import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { makeAsset, makeReportCardsDb } from "../../api/__tests__/helpers/fixtures";
import { handleReportCards } from "../../api/report-cards";
import { buildReportCardsSnapshot, ReportCardsSnapshotUnavailableError } from "../report-cards-snapshot";
import { RedemptionBackstopSnapshotUnavailableError } from "../redemption-backstops-store";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import type { PegSummaryCoin } from "@shared/types/market";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";

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

const nowSec = Math.floor(Date.now() / 1000);
const redemptionFreshnessMaxAgeSec = CRON_INTERVALS["sync-redemption-backstops"] * 2;

function makePegSummary(overrides: Partial<PegSummaryCoin>): PegSummaryCoin {
  return {
    id: "usdt-tether",
    symbol: "USDT",
    name: "Tether",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 0,
    pegScore: 100,
    pegPct: 100,
    severityScore: 100,
    spreadPenalty: 0,
    eventCount: 0,
    worstDeviationBps: null,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 365,
    methodologyVersion: "test",
    ...overrides,
  };
}

function makeRedemptionEntry(overrides: Partial<RedemptionBackstopEntry>): RedemptionBackstopEntry {
  return {
    stablecoinId: "cusd-cap",
    score: 88,
    effectiveExitScore: 91,
    dexLiquidityScore: 29,
    accessScore: 100,
    settlementScore: 100,
    executionCertaintyScore: 80,
    capacityScore: 100,
    outputAssetQualityScore: 80,
    costScore: 40,
    routeFamily: "basket-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    provider: "supply-ratio-model",
    sourceMode: "estimated",
    resolutionState: "resolved",
    routeStatus: "open",
    routeStatusSource: "static-config",
    holderEligibility: "unknown",
    capacityConfidence: "documented-bound",
    capacitySemantics: "immediate-bounded",
    feeConfidence: "undisclosed-reviewed",
    feeModelKind: "documented-variable",
    modelConfidence: "medium",
    immediateCapacityUsd: 10_000_000,
    immediateCapacityRatio: 0.5,
    feeBps: null,
    queueEnabled: false,
    methodologyVersion: "1.0",
    updatedAt: nowSec,
    capsApplied: [],
    notes: [],
    ...overrides,
  };
}

function makeReportCardsDbWithBluechipValue(assets: ReturnType<typeof makeAsset>[], bluechipValue: string) {
  const stablecoinsValue = JSON.stringify({ peggedAssets: assets });
  return mockD1([
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["stablecoins"],
      rows: [],
      first: { value: stablecoinsValue, updated_at: nowSec },
    },
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["bluechip-ratings"],
      rows: [],
      first: { value: bluechipValue, updated_at: nowSec },
    },
    { match: "dex_liquidity", rows: [] },
    { match: "depeg_events", rows: [] },
    { match: "supply_history", rows: [] },
  ]);
}

describe("buildReportCardsSnapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: nowSec * 1000 });
    loadRedemptionBackstopSnapshotMock.mockReset();
    loadRedemptionBackstopSnapshotMock.mockResolvedValue({ map: {}, latestUpdatedAt: nowSec });
    loadDexLiquiditySnapshotMock.mockReset();
    loadDexLiquiditySnapshotMock.mockImplementation(async (db: D1Database) => {
      const rows = await db
        .prepare(
          "SELECT stablecoin_id, liquidity_score, concentration_hhi, pool_count, chain_count, updated_at FROM dex_liquidity",
        )
        .all<{
          stablecoin_id: string;
          liquidity_score: number | null;
          concentration_hhi: number | null;
          pool_count: number;
          chain_count: number;
          updated_at: number | null;
        }>();

      const map: Record<
        string,
        {
          liquidityScore: number | null;
          concentrationHhi: number | null;
          poolCount: number;
          chainCount: number;
        }
      > = {};
      let latestUpdatedAt: number | null = null;

      for (const row of rows.results ?? []) {
        map[row.stablecoin_id] = {
          liquidityScore: row.liquidity_score,
          concentrationHhi: row.concentration_hhi,
          poolCount: row.pool_count,
          chainCount: row.chain_count,
        };
        if (row.updated_at != null && (latestUpdatedAt == null || row.updated_at > latestUpdatedAt)) {
          latestUpdatedAt = row.updated_at;
        }
      }

      return { map, latestUpdatedAt };
    });
    loadFreshIndependentLiveReserveMapMock.mockReset();
    loadFreshIndependentLiveReserveMapMock.mockResolvedValue(new Map());
    derivePegAnalyticsSnapshotMock.mockReset();
    derivePegAnalyticsSnapshotMock.mockResolvedValue({
      pegDataById: new Map(),
      eventsByCoin: new Map(),
      methodology: {
        version: "test",
        activeDepegThresholdBps: 1000,
        activeDepegMinDurationMinutes: 60,
        trackingWindowYears: 4,
      },
      updatedAt: nowSec,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws when stablecoins cache is missing", async () => {
    await expect(buildReportCardsSnapshot(mockD1())).rejects.toBeInstanceOf(ReportCardsSnapshotUnavailableError);
  });

  it("returns cards + methodology + dependencyGraph + updatedAt", async () => {
    const db = makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
    const snapshot = await buildReportCardsSnapshot(db);

    expect(Array.isArray(snapshot.cards)).toBe(true);
    expect(snapshot.cards.length).toBeGreaterThan(0);
    expect(snapshot.methodology).toHaveProperty("version");
    expect(snapshot.methodology).toHaveProperty("weights");
    expect(snapshot.methodology).toHaveProperty("thresholds");
    expect(Array.isArray(snapshot.dependencyGraph.edges)).toBe(true);
    expect(typeof snapshot.updatedAt).toBe("number");
  });

  it("matches /api/report-cards response payload", async () => {
    const db = makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
    const snapshot = await buildReportCardsSnapshot(db);

    const response = await handleReportCards(db);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual(snapshot);
  });

  it("orders rated live cards before defunct cards and defunct cards before unrated live cards", async () => {
    const db = makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
    derivePegAnalyticsSnapshotMock.mockResolvedValueOnce({
      pegDataById: new Map([["usdt-tether", makePegSummary({ id: "usdt-tether", symbol: "USDT", name: "Tether" })]]),
      methodology: {
        version: "test",
        activeDepegThresholdBps: 1000,
        activeDepegMinDurationMinutes: 60,
        trackingWindowYears: 4,
      },
      updatedAt: nowSec,
    });

    const snapshot = await buildReportCardsSnapshot(db);
    const ratedLiveIndex = snapshot.cards.findIndex((entry) => entry.id === "usdt-tether");
    const firstDefunctIndex = snapshot.cards.findIndex((entry) => entry.isDefunct);
    const unratedLiveIndex = snapshot.cards.findIndex((entry) => !entry.isDefunct && entry.overallScore === null);

    expect(ratedLiveIndex).toBeGreaterThanOrEqual(0);
    expect(firstDefunctIndex).toBeGreaterThanOrEqual(0);
    expect(unratedLiveIndex).toBeGreaterThanOrEqual(0);
    expect(ratedLiveIndex).toBeLessThan(firstDefunctIndex);
    expect(firstDefunctIndex).toBeLessThan(unratedLiveIndex);
  });

  it("uses effective exit scoring when a redemption backstop row exists", async () => {
    const cacheValue = JSON.stringify({
      peggedAssets: [makeAsset({ id: "cusd-cap", symbol: "CUSD" })],
    });
    const db = mockD1([
      {
        match: "cache",
        rows: [
          { key: "stablecoins", value: cacheValue, updated_at: nowSec },
          { key: "bluechip-ratings", value: "{}", updated_at: nowSec },
        ],
        first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
      },
      {
        match: "dex_liquidity",
        rows: [
          {
            stablecoin_id: "cusd-cap",
            liquidity_score: 29,
            concentration_hhi: 1,
            pool_count: 1,
            chain_count: 1,
          },
        ],
      },
      { match: "depeg_events", rows: [] },
      { match: "supply_history", rows: [] },
    ]);
    loadRedemptionBackstopSnapshotMock.mockResolvedValueOnce({
      map: { "cusd-cap": makeRedemptionEntry({}) },
      latestUpdatedAt: nowSec,
    });

    const snapshot = await buildReportCardsSnapshot(db);
    const card = snapshot.cards.find((entry) => entry.id === "cusd-cap");
    expect(card?.rawInputs.liquidityScore).toBe(29);
    expect(card?.rawInputs.redemptionBackstopScore).toBe(88);
    expect(card?.rawInputs.redemptionUsedForLiquidity).toBe(true);
    expect(card?.rawInputs.effectiveExitScore).toBe(91);
    expect(card?.dimensions.liquidity.score).toBe(91);
  });

  it("suppresses stale redemption backstop rows from report-card liquidity", async () => {
    const cacheValue = JSON.stringify({
      peggedAssets: [makeAsset({ id: "cusd-cap", symbol: "CUSD" })],
    });
    const db = mockD1([
      {
        match: "cache",
        rows: [
          { key: "stablecoins", value: cacheValue, updated_at: nowSec },
          { key: "bluechip-ratings", value: "{}", updated_at: nowSec },
        ],
        first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
      },
      {
        match: "dex_liquidity",
        rows: [
          {
            stablecoin_id: "cusd-cap",
            liquidity_score: 29,
            concentration_hhi: 1,
            pool_count: 1,
            chain_count: 1,
            updated_at: nowSec,
          },
        ],
      },
      { match: "depeg_events", rows: [] },
      { match: "supply_history", rows: [] },
    ]);
    loadRedemptionBackstopSnapshotMock.mockResolvedValueOnce({
      map: { "cusd-cap": makeRedemptionEntry({}) },
      latestUpdatedAt: nowSec - redemptionFreshnessMaxAgeSec - 1,
    });

    const snapshot = await buildReportCardsSnapshot(db);
    const card = snapshot.cards.find((entry) => entry.id === "cusd-cap");
    expect(snapshot.redemptionStale).toBe(true);
    expect(snapshot.inputFreshness.redemptionBackstops.stale).toBe(true);
    expect(card?.rawInputs.redemptionBackstopScore).toBeNull();
    expect(card?.rawInputs.redemptionUsedForLiquidity).toBe(false);
    expect(card?.dimensions.liquidity.score).toBe(29);
  });

  it("keeps redemption backstop rows through normal hourly cron lag", async () => {
    const cacheValue = JSON.stringify({
      peggedAssets: [makeAsset({ id: "cusd-cap", symbol: "CUSD" })],
    });
    const db = mockD1([
      {
        match: "cache",
        rows: [
          { key: "stablecoins", value: cacheValue, updated_at: nowSec },
          { key: "bluechip-ratings", value: "{}", updated_at: nowSec },
        ],
        first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
      },
      {
        match: "dex_liquidity",
        rows: [
          {
            stablecoin_id: "cusd-cap",
            liquidity_score: 29,
            concentration_hhi: 1,
            pool_count: 1,
            chain_count: 1,
            updated_at: nowSec,
          },
        ],
      },
      { match: "depeg_events", rows: [] },
      { match: "supply_history", rows: [] },
    ]);
    loadRedemptionBackstopSnapshotMock.mockResolvedValueOnce({
      map: { "cusd-cap": makeRedemptionEntry({ modelConfidence: "medium" }) },
      latestUpdatedAt: nowSec - CRON_INTERVALS["sync-redemption-backstops"] - 1800,
    });

    const snapshot = await buildReportCardsSnapshot(db);
    const card = snapshot.cards.find((entry) => entry.id === "cusd-cap");
    expect(snapshot.redemptionStale).toBe(false);
    expect(snapshot.inputFreshness.redemptionBackstops.stale).toBe(false);
    expect(card?.rawInputs.redemptionBackstopScore).toBe(88);
    expect(card?.rawInputs.redemptionUsedForLiquidity).toBe(true);
    expect(card?.dimensions.liquidity.score).toBe(91);
  });

  it("uses documented offchain issuer eventual redemption only as a DEX-gated bonus", async () => {
    const cacheValue = JSON.stringify({
      peggedAssets: [makeAsset({ id: "cusd-cap", symbol: "CUSD" })],
    });
    const db = mockD1([
      {
        match: "cache",
        rows: [
          { key: "stablecoins", value: cacheValue, updated_at: nowSec },
          { key: "bluechip-ratings", value: "{}", updated_at: nowSec },
        ],
        first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
      },
      {
        match: "dex_liquidity",
        rows: [
          {
            stablecoin_id: "cusd-cap",
            liquidity_score: 29,
            concentration_hhi: 1,
            pool_count: 1,
            chain_count: 1,
            updated_at: nowSec,
          },
        ],
      },
      { match: "depeg_events", rows: [] },
      { match: "supply_history", rows: [] },
    ]);
    loadRedemptionBackstopSnapshotMock.mockResolvedValueOnce({
      map: {
        "cusd-cap": makeRedemptionEntry({
          score: 65,
          routeFamily: "offchain-issuer",
          accessModel: "issuer-api",
          settlementModel: "same-day",
          executionModel: "rules-based-nav",
          outputAssetType: "stable-single",
          capacitySemantics: "eventual-only",
          capacityConfidence: "documented-bound",
          immediateCapacityUsd: null,
          immediateCapacityRatio: null,
        }),
      },
      latestUpdatedAt: nowSec,
    });

    const snapshot = await buildReportCardsSnapshot(db);
    const card = snapshot.cards.find((entry) => entry.id === "cusd-cap");
    expect(card?.rawInputs.redemptionUsedForLiquidity).toBe(true);
    expect(card?.rawInputs.effectiveExitScore).toBe(32);
    expect(card?.dimensions.liquidity.score).toBe(32);
    expect(card?.dimensions.liquidity.detail).toContain("primary-market exit bonus only");
  });

  it("does not use documented offchain issuer eventual redemption when DEX liquidity is unavailable", async () => {
    const cacheValue = JSON.stringify({
      peggedAssets: [makeAsset({ id: "cusd-cap", symbol: "CUSD" })],
    });
    const db = mockD1([
      {
        match: "cache",
        rows: [
          { key: "stablecoins", value: cacheValue, updated_at: nowSec },
          { key: "bluechip-ratings", value: "{}", updated_at: nowSec },
        ],
        first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
      },
      { match: "dex_liquidity", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "supply_history", rows: [] },
    ]);
    loadRedemptionBackstopSnapshotMock.mockResolvedValueOnce({
      map: {
        "cusd-cap": makeRedemptionEntry({
          score: 65,
          routeFamily: "offchain-issuer",
          accessModel: "issuer-api",
          settlementModel: "same-day",
          executionModel: "rules-based-nav",
          outputAssetType: "stable-single",
          capacitySemantics: "eventual-only",
          capacityConfidence: "documented-bound",
          immediateCapacityUsd: null,
          immediateCapacityRatio: null,
        }),
      },
      latestUpdatedAt: nowSec,
    });

    const snapshot = await buildReportCardsSnapshot(db);
    const card = snapshot.cards.find((entry) => entry.id === "cusd-cap");
    expect(card?.rawInputs.liquidityScore).toBeNull();
    expect(card?.rawInputs.redemptionUsedForLiquidity).toBe(false);
    expect(card?.rawInputs.effectiveExitScore).toBeNull();
    expect(card?.dimensions.liquidity.detail).toContain("primary-market route requires DEX liquidity floor");
  });

  it("keeps severe-depeg redemption eligibility aligned with scoreLiquidity rules", async () => {
    const cacheValue = JSON.stringify({
      peggedAssets: [makeAsset({ id: "cusd-cap", symbol: "CUSD" })],
    });
    const db = mockD1([
      {
        match: "cache",
        rows: [
          { key: "stablecoins", value: cacheValue, updated_at: nowSec },
          { key: "bluechip-ratings", value: "{}", updated_at: nowSec },
        ],
        first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
      },
      {
        match: "dex_liquidity",
        rows: [
          {
            stablecoin_id: "cusd-cap",
            liquidity_score: 29,
            concentration_hhi: 1,
            pool_count: 1,
            chain_count: 1,
            updated_at: nowSec,
          },
        ],
      },
      { match: "depeg_events", rows: [] },
      { match: "supply_history", rows: [] },
    ]);
    derivePegAnalyticsSnapshotMock.mockResolvedValueOnce({
      pegDataById: new Map([
        [
          "cusd-cap",
          makePegSummary({
            id: "cusd-cap",
            symbol: "CUSD",
            name: "Cap CUSD",
            activeDepeg: true,
            currentDeviationBps: -3000,
            pegScore: 20,
            worstDeviationBps: -3000,
            eventCount: 1,
          }),
        ],
      ]),
      eventsByCoin: new Map([["cusd-cap", [{ endedAt: null, peakDeviationBps: -3000 }]]]),
      methodology: {
        version: "test",
        activeDepegThresholdBps: 1000,
        activeDepegMinDurationMinutes: 60,
        trackingWindowYears: 4,
      },
      updatedAt: nowSec,
    });
    loadRedemptionBackstopSnapshotMock.mockResolvedValueOnce({
      map: {
        "cusd-cap": makeRedemptionEntry({
          capacityConfidence: "documented-bound",
          sourceMode: "estimated",
        }),
      },
      latestUpdatedAt: nowSec,
    });

    const staticSnapshot = await buildReportCardsSnapshot(db);
    const staticCard = staticSnapshot.cards.find((entry) => entry.id === "cusd-cap");
    expect(staticCard?.rawInputs.activeDepegBps).toBe(3000);
    expect(staticCard?.rawInputs.redemptionUsedForLiquidity).toBe(false);
    expect(staticCard?.dimensions.liquidity.detail).toContain(
      "active severe depeg requires live-open redemption evidence",
    );

    derivePegAnalyticsSnapshotMock.mockResolvedValueOnce({
      pegDataById: new Map([
        [
          "cusd-cap",
          makePegSummary({
            id: "cusd-cap",
            symbol: "CUSD",
            name: "Cap CUSD",
            activeDepeg: true,
            currentDeviationBps: -3000,
            pegScore: 20,
            worstDeviationBps: -3000,
            eventCount: 1,
          }),
        ],
      ]),
      eventsByCoin: new Map([["cusd-cap", [{ endedAt: null, peakDeviationBps: -3000 }]]]),
      methodology: {
        version: "test",
        activeDepegThresholdBps: 1000,
        activeDepegMinDurationMinutes: 60,
        trackingWindowYears: 4,
      },
      updatedAt: nowSec,
    });
    loadRedemptionBackstopSnapshotMock.mockResolvedValueOnce({
      map: {
        "cusd-cap": makeRedemptionEntry({
          capacityConfidence: "live-direct",
          sourceMode: "dynamic",
          accessModel: "permissionless-onchain",
          settlementModel: "atomic",
        }),
      },
      latestUpdatedAt: nowSec,
    });

    const liveSnapshot = await buildReportCardsSnapshot(db);
    const liveCard = liveSnapshot.cards.find((entry) => entry.id === "cusd-cap");
    expect(liveCard?.rawInputs.redemptionUsedForLiquidity).toBe(true);
    expect(liveCard?.dimensions.liquidity.score).toBe(91);
  });

  it("inherits peg risk for configured NAV wrappers from the referenced base stablecoin", async () => {
    const db = makeReportCardsDb([
      makeAsset({ id: "usdai-usd-ai", symbol: "USDai", name: "USDai" }),
      makeAsset({ id: "susdai-usd-ai", symbol: "sUSDai", name: "sUSDai" }),
    ]);
    derivePegAnalyticsSnapshotMock.mockResolvedValueOnce({
      pegDataById: new Map([
        [
          "usdai-usd-ai",
          {
            id: "usdai-usd-ai",
            symbol: "USDai",
            name: "USDai",
            pegType: "peggedUSD",
            pegCurrency: "USD",
            governance: "centralized",
            currentDeviationBps: 18,
            pegScore: 82,
            pegPct: 99,
            severityScore: 84,
            spreadPenalty: 0,
            eventCount: 2,
            worstDeviationBps: -230,
            activeDepeg: false,
            lastEventAt: nowSec - 86400,
            trackingSpanDays: 365,
            methodologyVersion: "test",
          },
        ],
        [
          "susdai-usd-ai",
          {
            id: "susdai-usd-ai",
            symbol: "sUSDai",
            name: "sUSDai",
            pegType: "peggedUSD",
            pegCurrency: "USD",
            governance: "centralized",
            currentDeviationBps: null,
            pegScore: null,
            pegPct: 0,
            severityScore: 0,
            spreadPenalty: 0,
            eventCount: 0,
            worstDeviationBps: null,
            activeDepeg: false,
            lastEventAt: null,
            trackingSpanDays: 365,
            methodologyVersion: "test",
          },
        ],
      ]),
      methodology: {
        version: "test",
        activeDepegThresholdBps: 1000,
        activeDepegMinDurationMinutes: 60,
        trackingWindowYears: 4,
      },
      updatedAt: nowSec,
    });

    const snapshot = await buildReportCardsSnapshot(db);
    const card = snapshot.cards.find((entry) => entry.id === "susdai-usd-ai");

    expect(card).toBeDefined();
    expect(card?.rawInputs.navToken).toBe(true);
    expect(card?.rawInputs.pegScore).toBe(82);
    expect(card?.dimensions.pegStability.grade).toBe("A-");
    expect(card?.dimensions.pegStability.detail).toContain("Peg reference (USDai)");
  });

  it("throws when the redemption backstop snapshot is unavailable", async () => {
    const db = makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
    loadRedemptionBackstopSnapshotMock.mockRejectedValueOnce(
      new RedemptionBackstopSnapshotUnavailableError("redemption snapshot unavailable"),
    );

    await expect(buildReportCardsSnapshot(db)).rejects.toBeInstanceOf(ReportCardsSnapshotUnavailableError);
  });

  it("degrades gracefully when dex liquidity is unavailable", async () => {
    const db = makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
    loadDexLiquiditySnapshotMock
      .mockRejectedValueOnce(new Error("dex liquidity unavailable"))
      .mockRejectedValueOnce(new Error("dex liquidity unavailable"));

    const snapshot = await buildReportCardsSnapshot(db);
    expect(snapshot.liquidityStale).toBe(true);

    const response = await handleReportCards(db);
    expect(response.status).toBe(200);
  });

  it("degrades gracefully when live reserves are unavailable", async () => {
    const db = makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
    loadFreshIndependentLiveReserveMapMock
      .mockRejectedValueOnce(new Error("live reserves unavailable"))
      .mockRejectedValueOnce(new Error("live reserves unavailable"));

    const snapshot = await buildReportCardsSnapshot(db);
    expect(Array.isArray(snapshot.cards)).toBe(true);

    const response = await handleReportCards(db);
    expect(response.status).toBe(200);
  });

  it("ignores malformed bluechip cache payloads instead of failing the snapshot", async () => {
    const db = makeReportCardsDbWithBluechipValue(
      [makeAsset({ id: "usdt-tether", symbol: "USDT" })],
      JSON.stringify({ "usdt-tether": { grade: "A" } }),
    );

    const snapshot = await buildReportCardsSnapshot(db);
    const card = snapshot.cards.find((entry) => entry.id === "usdt-tether");

    expect(card).toBeDefined();
    expect(card?.rawInputs.bluechipGrade ?? null).toBeNull();
  });
});
