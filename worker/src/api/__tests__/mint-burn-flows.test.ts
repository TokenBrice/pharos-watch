import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as activeSafetyScoreSource from "../../lib/safety-score-index";
import * as flightToQualityClassification from "../../lib/flight-to-quality-classification";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import { mintBurnScenario } from "../../test-helpers/__shared/mint-burn";
import { flowResponse, makeFlowHourlyRow, makeFlowFallbackScenario, makeValidCachedAggregateFixture } from "./mint-burn-flows.test-support";
import { handleMintBurnFlows, refreshAggregateMintBurnFlowCache } from "../mint-burn-flows";
import { MintBurnFlowsResponseSchema, type MintBurnValuationCompleteness } from "@shared/types/mint-burn";

function flowHour(now: number, overrides: Partial<ReturnType<typeof makeFlowHourlyRow>> & Record<string, unknown> = {}) {
  return { ...makeFlowHourlyRow(now), mint_count: 1, burn_count: 0,
    mint_volume_usd: 15_000_000, burn_volume_usd: 5_000_000, net_flow_usd: 10_000_000, ...overrides };
}

function safetyIdentity(now: number) {
  return {
    model: "v9" as const, schemaVersion: 1 as const, methodologyVersion: "9.0", policyId: "safety-score-v9",
    policyDigest: "c".repeat(64), evaluationBuildDigest: "d".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`, publicationGenerationId: `report-cards:v9:${now}`,
  };
}

function cachedCoinValuation(window24h: MintBurnValuationCompleteness) {
  return {
    window24h: {
      completeness: window24h,
      mintCompleteness: window24h,
      burnCompleteness: window24h,
      unpricedMintEventCount: window24h === "partial" ? 1 : 0,
      unpricedBurnEventCount: window24h === "partial" ? 1 : 0,
    },
    baseline: "complete" as const,
    netFlow7d: window24h,
    netFlow30d: window24h,
    netFlow90d: window24h,
  };
}

function mockFtqPublication(updatedAt: number) {
  const snapshot = makeWorkerReportCardsV9Response({
    updatedAt,
    cards: [
      makeWorkerV9Card({ id: "usdc-circle", score: 80, grade: "A" }),
      makeWorkerV9Card({ id: "usdai-usd-ai", score: 30, grade: "D" }),
    ],
  });
  vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue({ kind: "v9", snapshot });
  return snapshot;
}

describe("handleMintBurnFlows contract tests", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const nowSec = Math.floor(Date.now() / 1000);

  const hourlyRow = makeFlowHourlyRow(nowSec);

  const stablecoinsCache = JSON.stringify({
    peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100000000000 } }],
  });

  it("excludes historical rows for quarantined mint/burn configs from the public aggregate", async () => {
    const now = Math.floor(Date.now() / 1000);
    const inactiveDb = mintBurnScenario({
      nowSec: now,
      rows: {
        hourly: [flowHour(now, { stablecoin_id: "tbill-openeden", mint_volume_usd: 5_000_000, burn_volume_usd: 0, net_flow_usd: 5_000_000 })],
      },
      stablecoinsCache: {
        value: JSON.stringify({
          peggedAssets: [{
            id: "tbill-openeden",
            symbol: "TBILL",
            circulating: { peggedUSD: 100_000_000 },
          }],
        }),
        updatedAt: now,
      },
    });

    const res = await flowResponse(inactiveDb);
    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.coins.some((coin) => coin.stablecoinId === "tbill-openeden")).toBe(false);
    expect(body.hourly.some((row) => row.netFlowUsd === 5_000_000)).toBe(false);
  });

  it("publishes the per-chain 24h net breakdown sorted by absolute net flow", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        { id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 30_000_000_000 } },
      ],
    });
    const db = mintBurnScenario({
      nowSec: now,
      rows: {
        hourly: [
          flowHour(now, { stablecoin_id: "usdc-circle", mint_count: 2, burn_count: 1, mint_volume_usd: 40_000_000, burn_volume_usd: 10_000_000, net_flow_usd: 30_000_000, mint_unresolved_event_count: 0, burn_unresolved_event_count: 0 }),
          flowHour(now, { stablecoin_id: "usdai-usd-ai", chain_id: "arbitrum", mint_count: 0, burn_count: 3, mint_volume_usd: 0, burn_volume_usd: 50_000_000, net_flow_usd: -50_000_000 }),
          /* An unpriced mint withholds the largest known net. */ flowHour(now, { stablecoin_id: "bd-basedollar", chain_id: "base", burn_count: 1, mint_unpriced_event_count: 1, burn_unpriced_event_count: 0, mint_volume_usd: 0, burn_volume_usd: 90_000_000, net_flow_usd: -90_000_000 }),
        ],
        baseline: [
          {
            stablecoin_id: "usdc-circle",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 0,
            daily_abs: 100_000_000,
          },
        ],
        firstSeen: [{ stablecoin_id: "usdc-circle", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      },
      stablecoinsCache: { value: cacheValue, updatedAt: now },
    });

    const res = await flowResponse(db);

    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    // Single source for the digest's top-chains block: same tracked-pair
    // universe as `coins`, ordered by absolute 24h net flow. Legacy buckets
    // without recorded coverage read as unknown and keep their net.
    expect(body.chains?.map(({ scanCoverage: _scanCoverage, classification: _classification, ...chain }) => chain)).toEqual([
      { chainId: "arbitrum", netFlow24hUsd: -50_000_000, valuation: "unknown" },
      { chainId: "ethereum", netFlow24hUsd: 30_000_000, valuation: "unknown" },
      { chainId: "base", netFlow24hUsd: null, valuation: "partial" },
    ]);
  });

  it("excludes tracked coins without observed supply from the gauge mcap and counts them", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cacheValue = JSON.stringify({
      peggedAssets: [
        { id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 },
          chainCirculating: { Ethereum: { current: 100_000_000_000 } } },
        // Empty buckets are unavailable supply, not a measured zero weight.
        { id: "usdc-circle", symbol: "USDC", circulating: {} },
        // An explicit zero is a measured weight and is not counted as unavailable.
        { id: "usdai-usd-ai", symbol: "USDai", circulating: { peggedUSD: 0 } },
      ],
    });
    const db = mintBurnScenario({
      nowSec: now,
      rows: {},
      stablecoinsCache: { value: cacheValue, updatedAt: now },
    });

    const res = await flowResponse(db);

    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.gauge.trackedMcapUsd).toBe(100_000_000_000);
    // Every tracked coin except the two observed rows (USDT, explicit-zero USDai) lacks a weight.
    expect(body.gauge.mcapUnavailableCoins).toBe(body.gauge.trackedCoins - 2);
    expect(body.coins.some((coin) => coin.stablecoinId === "usdc-circle")).toBe(true);
  });

  it.each([[720, 48, 1], [168, 48, 1], [1, 3, 4]] as const)(
    "keeps fixed 24h coin fields and indexed reads at hours=%s", async (hours, olderHour, multiplier) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));
      const now = Math.floor(Date.now() / 1000);
      const oneHourStart = now - 3600;
      const tenDaysAgoHour = now - 10 * 86400;
      const hourly = (age: number, scale: number) => ({ ...makeFlowHourlyRow(now), hour_ts: now - age * 3600,
        mint_count: 1, burn_count: 0, mint_volume_usd: 15_000_000 * scale,
        burn_volume_usd: 5_000_000 * scale, net_flow_usd: 10_000_000 * scale });
      const net = [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 40_000_000 }];
      const db = mintBurnScenario({ nowSec: now, stablecoinsCache: { value: stablecoinsCache, updatedAt: now }, rows: {
        hourly: [hourly(1, 1), hourly(olderHour, 3)], net7d: net, net30d: net, net90d: net,
        baseline: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", day_ts: Math.floor(tenDaysAgoHour / 86400) * 86400,
          daily_net: 0, daily_abs: 20_000_000 }],
        firstSeen: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      } });
      const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(
        await flowResponse(db, `?hours=${hours}`), 200));
      const usdt = body.coins.find((coin) => coin.stablecoinId === "usdt-tether");
      expect(body.windowHours).toBe(hours);
      expect(body.hourly).toHaveLength(hours);
      if (hours === 1) expect(body.hourly).toMatchObject([{
        hourTs: oneHourStart, netFlowUsd: 10_000_000, mintVolumeUsd: 15_000_000, burnVolumeUsd: 5_000_000,
        valuation: "unknown", scanCoverage: { complete: true, unavailableReason: null },
      }]);
      expect(usdt?.netFlow24hUsd).toBe(10_000_000 * multiplier);
      expect(usdt?.mintVolume24hUsd).toBe(15_000_000 * multiplier);
      expect(usdt?.burnVolume24hUsd).toBe(5_000_000 * multiplier);
      const history = db.getHistory();
      const windowScans = history.filter((entry) => entry.sql.includes("pharos:mint-burn-flows:window-rows"));
      expect(windowScans).toHaveLength(1);
      expect(typeof windowScans[0]?.binds[0]).toBe("string");
      expect((windowScans[0]?.binds[0] as string).includes('["usdt-tether","ethereum"]')).toBe(true);
      expect(windowScans[0]?.binds).toHaveLength(3);
      expect(windowScans[0]?.binds.slice(1)).toEqual([now - Math.max(hours, 24) * 3600, now]);
      expect(history.some((entry) => entry.sql.includes("pharos:mint-burn-flows:window-24h-rows"))).toBe(false);
    },
  );

  it("disables FTQ in a legacy cached aggregate before running live aggregate queries", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cachedBody = {
      gauge: {
        score: 0,
        band: "NEUTRAL",
        intensitySemantics: "signed-v2",
        flightToQuality: false,
        flightIntensity: 0,
        trackedCoins: 1,
        trackedMcapUsd: 0,
      },
      coins: [],
      hourly: [],
      updatedAt: now - 60,
      sync: { lastSuccessfulSyncAt: now - 120 },
    };
    const cachedDb = mintBurnScenario({
      nowSec: now,
      flowCache: {
        key: "mint-burn-flows:v8:aggregate:24",
        value: JSON.stringify(cachedBody),
        updatedAt: now,
      },
      overrides: [{
        match: "FROM mint_burn_hourly",
        rows: [],
        throwError: new Error("live aggregate query should not run"),
      }],
    });

    const res = await flowResponse(cachedDb);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      gauge: {
        flightToQuality: null,
        flightIntensity: null,
        classificationSource: "unavailable",
        safetyScoreIdentity: null,
      },
      sync: {
        lastSuccessfulSyncAt: now - 120,
        classificationWarning: expect.stringContaining("v9-snapshot-unavailable"),
      },
    });
    expect(res.headers.get("Warning")).toContain("v9-snapshot-unavailable");
    expect(res.headers.get("X-Data-Freshness")).toBe("fresh");

    const history = cachedDb.getHistory();
    expect(history.some((entry) => entry.sql.includes("FROM mint_burn_hourly"))).toBe(false);
  });

  it.each([
    ["serves a fresh aggregate with FTQ unavailable when the report-card cache read fails", false],
    ["keeps cached aggregate flow data while disabling FTQ when report-card validation throws", true],
  ] as const)("%s", async (_name, cached) => {
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex")
      .mockRejectedValueOnce(new Error("canonical V9 read failed"));
    const db = cached ? mintBurnScenario({ nowSec: now, flowCache: {
      key: "mint-burn-flows:v8:aggregate:24", value: JSON.stringify(makeValidCachedAggregateFixture(now, safetyIdentity(now))), updatedAt: now,
    } }) : mintBurnScenario({ nowSec: now, rows: { hourly: [{ ...hourlyRow, hour_ts: now - 3600 }] },
      stablecoinsCache: { value: stablecoinsCache, updatedAt: now },
    });
    const res = await flowResponse(db);
    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.gauge).toMatchObject({ flightToQuality: null, flightIntensity: null,
      classificationSource: "unavailable", safetyScoreIdentity: null });
    expect(body.sync?.classificationWarning).toContain("cache-read-failed");
  });

  it.each([24, 168])("recovers an explicitly unavailable cached FTQ state at %sh without renewing flow evidence", async (hours) => {
    const now = Math.floor(Date.now() / 1000);
    const snapshot = mockFtqPublication(now);
    const cachedBody = makeValidCachedAggregateFixture(now, null);
    cachedBody.gauge.classificationSource = "unavailable";
    cachedBody.gauge.flightToQuality = false; // Legacy unavailable representation must be re-admitted.
    cachedBody.gauge.flightIntensity = 0;
    const value = JSON.stringify({
      ...cachedBody,
      sync: { ...cachedBody.sync, classificationWarning: "Old classification unavailable (source-stale)" },
    });
    const db = mintBurnScenario({
      nowSec: now,
      flowCache: { key: `mint-burn-flows:v8:aggregate:${hours}`, value, updatedAt: now },
    });

    const res = await flowResponse(db, `?hours=${hours}`);
    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.gauge).toMatchObject({
      // The cached fixture publishes no coin flows, and both classified coins are
      // unbounded cohort members: a recovered classification cannot prove inactivity.
      flightToQuality: null,
      flightIntensity: null,
      flightToQualityReason: "cohort-member-unpublished",
      flightToQualityExcludedIds: [],
      classificationSource: "safety-score-v9-publication",
      classificationReason: null,
      safetyScoreIdentity: snapshot.safetyScoreIdentity,
    });
    expect(body.sync?.classificationWarning).toBeNull();
    expect(res.headers.get("Warning")).toBeNull();
    expect(body.updatedAt).toBe(cachedBody.updatedAt);
    expect(body._meta?.updatedAt).toBe(cachedBody.sync.lastSuccessfulSyncAt);
    expect(body._meta?.dependencies?.flightToQuality).toMatchObject({
      status: "fresh", reason: null, updatedAt: now, freshBudgetSec: 7200,
      generationId: snapshot.safetyScoreIdentity.publicationGenerationId,
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM mint_burn_hourly"))).toBe(false);
    expect(db.getHistory().some((entry) => /INSERT|UPDATE|DELETE/.test(entry.sql))).toBe(false);
  });

  it.each([
    { safeNet: 200_000_000, invalid: false, gatedNet: false, legacy: false, sourceUnavailable: false, stale: false, hours: 24, expectedIntensity: 40 },
    { safeNet: -200_000_000, invalid: false, gatedNet: false, legacy: false, sourceUnavailable: false, stale: true, hours: 168, expectedIntensity: 0 },
    { safeNet: 200_000_000, invalid: true, gatedNet: false, legacy: false, sourceUnavailable: false, stale: false, hours: 24, expectedIntensity: null },
    { safeNet: 200_000_000, invalid: false, gatedNet: false, legacy: false, sourceUnavailable: true, stale: false, hours: 24, expectedIntensity: null },
    // A partial (null) safe net could still exceed the threshold: FTQ is null, never inactive.
    { safeNet: null, invalid: false, gatedNet: true, legacy: false, sourceUnavailable: false, stale: false, hours: 24, expectedIntensity: null },
    // A cached coin without `valuation` predates completeness: unknown, so no decision is re-derived.
    { safeNet: 200_000_000, invalid: false, gatedNet: false, legacy: true, sourceUnavailable: false, stale: false, hours: 24, expectedIntensity: null },
  ])("reconciles a newer FTQ publication using cached flows: %j", async ({ safeNet, invalid, gatedNet, legacy, sourceUnavailable, stale, hours, expectedIntensity }) => {
    const now = Math.floor(Date.now() / 1000);
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    const activeGenerationId = `report-cards:v9:${now}`;
    const cachedIdentity = safetyIdentity(now - 900);
    const activeSnapshot = makeWorkerReportCardsV9Response({
      updatedAt: now,
      safetyScoreIdentity: {
        ...cachedIdentity,
        baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
        publicationGenerationId: activeGenerationId,
      },
      cards: [makeWorkerV9Card({ id: "usdc-circle", score: 80, grade: "A" })],
    });
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex")
      .mockResolvedValueOnce({
        kind: "v9",
        snapshot: activeSnapshot,
      });
    vi.spyOn(
      flightToQualityClassification,
      "buildFlightToQualityClassificationFromV9Snapshot",
    ).mockReturnValueOnce(sourceUnavailable ? { kind: "unavailable", reason: "publication-held" } : {
      kind: "ok",
      classification: {
        safeIds: new Set(["usdc-circle"]),
        riskyIds: new Set(["usdai-usd-ai"]),
        safetyScoreIdentity: activeSnapshot.safetyScoreIdentity,
      },
    });
    const cachedBody = {
      ...makeValidCachedAggregateFixture(stale ? now - 86400 : now, cachedIdentity),
      windowHours: hours,
      coins: [
        ["usdc-circle", safeNet],
        ["usdai-usd-ai", -400_000_000],
        ["dai-makerdao", -1_000_000_000], // Neutral flows must not contribute to FTQ.
      ].map(([stablecoinId, netFlow24hUsd]) => ({
        stablecoinId,
        symbol: "TEST",
        // A malformed net (string) breaks the cached contract; `null` is a valuation-gated net.
        netFlow24hUsd: invalid ? "not-a-number" : netFlow24hUsd,
        ...(legacy ? {} : {
          valuation: cachedCoinValuation(gatedNet && stablecoinId === "usdc-circle" ? "partial" : "complete"),
        }),
        pressureShiftScore: null,
        pressureShiftState: "nr",
        netFlowDirection24h: "flat",
        has24hActivity: true,
        baselineDailyNetUsd: null,
        baselineDailyAbsUsd: null,
        baselineDataDays: null,
        mintVolume24hUsd: 0,
        burnVolume24hUsd: 0,
        mintCount24h: 0,
        burnCount24h: 0,
        netFlow7dUsd: 0,
        netFlow30dUsd: 0,
        netFlow90dUsd: 0,
        largestEvent24h: null,
      })),
    };
    const db = mintBurnScenario({
      nowSec: now,
      flowCache: {
        key: `mint-burn-flows:v8:aggregate:${hours}`,
        value: JSON.stringify(cachedBody),
        updatedAt: now,
      },
      overrides: [{
        match: "FROM mint_burn_hourly",
        rows: [],
        throwError: new Error("live aggregate query should not run"),
      }],
    });

    const res = await flowResponse(db, `?hours=${hours}`);
    const body = await readJsonResponse<typeof cachedBody>(res, 200);
    if (!invalid) MintBurnFlowsResponseSchema.parse(body);

    const unavailable = invalid || sourceUnavailable;
    expect(body.gauge).toMatchObject({
      score: cachedBody.gauge.score,
      flightToQuality: expectedIntensity === null ? null : expectedIntensity > 0,
      flightIntensity: expectedIntensity,
      classificationSource: unavailable ? "unavailable" : "safety-score-v9-publication",
      safetyScoreIdentity: unavailable ? null : activeSnapshot.safetyScoreIdentity,
    });
    if (unavailable) {
      const reason = sourceUnavailable ? "publication-held" : "cached-flow-contract-invalid";
      expect(body.sync?.classificationWarning).toContain(reason);
      expect(res.headers.get("Warning")).toContain(reason);
    } else {
      expect(body.sync).toEqual(cachedBody.sync);
      if (stale) {
        expect(res.headers.get("Warning")).toContain('110 - "Response is stale');
        expect(res.headers.get("Cache-Control")).toBe("no-store");
      } else {
        expect(res.headers.get("Warning")).toBeNull();
      }
    }
    expect(body.coins).toEqual(cachedBody.coins);
    expect(body.hourly).toEqual(cachedBody.hourly);
    expect(body.updatedAt).toBe(cachedBody.updatedAt);
    expect(res.headers.get("X-Data-Age")).toBe(String(now - cachedBody.sync.lastSuccessfulSyncAt));
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM mint_burn_hourly"))).toBe(false);
    expect(db.getHistory().some((entry) => /INSERT|UPDATE|DELETE/.test(entry.sql))).toBe(false);
  });

  it("serves cached aggregate fallback when live query fails after a cache miss", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cachedBody = makeValidCachedAggregateFixture(now, null);
    const { db: failingDb, state } = makeFlowFallbackScenario(now, JSON.stringify(cachedBody), 720);

    const res = await flowResponse(failingDb, "?hours=720");
    const body = await readJsonResponse(res, 200);
    expect(state.hourlyFailed).toBe(true);
    expect(state.cacheReads).toBe(2);
    expect(body).toMatchObject({
      gauge: {
        flightToQuality: null,
        flightIntensity: null,
        classificationSource: "unavailable",
        safetyScoreIdentity: null,
      },
    });
    expect(res.headers.get("Warning")).toContain("v9-snapshot-unavailable");
  });

  it("strips FTQ when a held publication becomes unavailable during fallback revalidation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const identity = safetyIdentity(now);
    const heldSnapshot = makeWorkerReportCardsV9Response({
      updatedAt: now,
      safetyScoreIdentity: identity,
      cards: [makeWorkerV9Card({ id: "usdc-circle", score: 80, grade: "A" })],
    });
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex")
      .mockResolvedValueOnce({
        kind: "held",
        reason: "v9-publication-held",
        detail: "held for test",
        snapshot: heldSnapshot,
      })
      .mockResolvedValueOnce({
        kind: "error",
        reason: "v9-snapshot-unavailable",
        detail: "unavailable during fallback revalidation",
        snapshot: null,
      });
    vi.spyOn(
      flightToQualityClassification,
      "buildFlightToQualityClassificationFromV9Snapshot",
    ).mockReturnValue({
      kind: "ok",
      classification: {
        safeIds: new Set(["usdc-circle"]),
        riskyIds: new Set(),
        safetyScoreIdentity: identity,
      },
    });
    const cachedBody = makeValidCachedAggregateFixture(now, identity);
    const { db, state } = makeFlowFallbackScenario(now, JSON.stringify(cachedBody));

    const res = await flowResponse(db);
    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));

    expect(state.cacheReads).toBe(2);
    expect(state.hourlyFailed).toBe(true);
    expect(body.gauge).toMatchObject({
      flightToQuality: null,
      flightIntensity: null,
      classificationSource: "unavailable",
      safetyScoreIdentity: null,
    });
    expect(body.sync?.classificationWarning).toContain("v9-snapshot-unavailable");
    expect(res.headers.get("Warning")).toContain("v9-snapshot-unavailable");
  });

  it("returns 503 when the aggregate fallback cache is malformed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { db: failingDb, state } = makeFlowFallbackScenario(now, "{bad json", 720);

    const res = await flowResponse(failingDb, "?hours=720");
    expect(state.hourlyFailed).toBe(true);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Cached mint-burn-flows payload is malformed",
    });
  });

  it.each([
    ["keeps freshness healthy through one missed critical-lane slot", 30],
    ["keeps flow-generation freshness independent of the tighter Safety Score consumer budget", 75],
  ])("%s", async (_name, minutes) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    mockFtqPublication(now);
    const db = mintBurnScenario({ nowSec: now,
      rows: { hourly: [flowHour(now)], latestSuccessfulSync: [{ started_at: now - minutes * 60 }] },
      stablecoinsCache: { value: stablecoinsCache, updatedAt: now },
    });
    const res = await flowResponse(db);
    expect(res.status).toBe(200);
    expect(res.headers.get("Warning")).toBeNull();
    expect(res.headers.get("X-Data-Age")).toBe(String(minutes * 60));
  });

  it("preserves unavailable freshness when producer lookup fails instead of borrowing an attempt clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    // A recent attempt cannot replace an unavailable confirmed-output lookup.
    const seventyFiveMinutesAgo = now - 75 * 60;
    const cache = stablecoinsCache;

    const db = mintBurnScenario({
      nowSec: now,
      rows: {
        hourly: [
          flowHour(now),
        ],
        cronSnapshot: [{ started_at: seventyFiveMinutesAgo, status: "ok", metadata: JSON.stringify({ chainHead: 22_345_999 }) }],
      },
      stablecoinsCache: { value: cache, updatedAt: now },
      overrides: [{
        match: "as started_at FROM cron_runs WHERE job = ?",
        rows: [],
        throwError: new Error("cron lookup failed"),
      }],
    });

    const res = await flowResponse(db);

    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.sync?.warning).toContain("freshness lookup failed");
    expect(res.headers.get("X-Data-Age")).toBe("unavailable");
    expect(res.headers.get("X-Data-Freshness")).toBe("unknown");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Data-Freshness-Reason")).toBe("freshness-lookup-failed");
    expect(body.sync?.lastSuccessfulSyncAt).toBeNull();
  });

  it.each(["aggregate", "per-coin"] as const)("does not use an errored attempt as %s producer freshness", async (scope) => {
    const now = Math.floor(Date.now() / 1000);
    const db = mintBurnScenario({
      nowSec: now,
      rows: {
        hourly: [makeFlowHourlyRow(now)],
        cronSnapshot: [{ started_at: now, status: "error", metadata: "{}" }],
        latestSuccessfulSync: [{ started_at: null }],
      },
    });
    const url = new URL("https://x/api/mint-burn-flows");
    if (scope === "per-coin") url.searchParams.set("stablecoin", "usdt-tether");
    const response = await handleMintBurnFlows(db, url);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Data-Age")).toBe("unavailable");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Data-Freshness-Reason")).toBe("producer-history-missing");
    expect(await response.json()).toMatchObject({ sync: { lastSuccessfulSyncAt: null }, _meta: { updatedAt: null } });
  });

  it.each(["source-stale", "publication-held", "safety-score-index-missing", "safety-score-index-read-failed"])(
    "publishes identical FTQ state and warnings for materialized and cached reads: %s",
    async (reason) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-19T23:00:00Z"));
      const now = Math.floor(Date.now() / 1000);
      const snapshot = mockFtqPublication(reason === "source-stale" ? now - 7201 : now);
      if (reason === "publication-held") {
        vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue({
          kind: "held", reason: "v9-publication-held", detail: "held for test", snapshot,
        });
      } else if (reason !== "source-stale") {
        vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue({
          kind: "error", reason, detail: "missing or unreadable canonical index", snapshot: null,
        });
      }
      const db = mintBurnScenario({
        nowSec: now,
        rows: { hourly: [makeFlowHourlyRow(now)], latestSuccessfulSync: [{ started_at: now - 120 }] },
      });
      const fresh = await refreshAggregateMintBurnFlowCache(db, 24);
      const materialized = MintBurnFlowsResponseSchema.parse(await readJsonResponse(fresh, 200));
      const cachedDb = mintBurnScenario({
        nowSec: now,
        flowCache: {
          key: "mint-burn-flows:v8:aggregate:24",
          value: JSON.stringify(materialized),
          updatedAt: now,
        },
      });
      const cached = await flowResponse(cachedDb);
      const reread = MintBurnFlowsResponseSchema.parse(await readJsonResponse(cached, 200));
      for (const body of [materialized, reread]) {
        expect(body.gauge).toMatchObject({
          classificationSource: "unavailable", classificationReason: reason,
          flightToQuality: null, flightIntensity: null, safetyScoreIdentity: null,
        });
        expect(body._meta).toMatchObject({
          status: "fresh", updatedAt: now - 120, freshBudgetSec: 28800,
          dependencies: { flightToQuality: {
            reason, freshBudgetSec: 7200,
            status: reason === "source-stale" ? "stale" : "unavailable",
            updatedAt: reason === "source-stale" || reason === "publication-held" ? snapshot.updatedAt : null,
            generationId: reason === "source-stale" || reason === "publication-held"
              ? snapshot.safetyScoreIdentity.publicationGenerationId : null,
          } },
        });
        expect(body.sync?.classificationWarning).toContain("Safety Score");
        expect(body.sync?.classificationWarning).toContain("2h");
      }
      expect(reread).toEqual(materialized);
      expect(cached.headers.get("Warning")).toBe(fresh.headers.get("Warning"));
      expect(cached.headers.get("Warning")).toContain(reason);
      const writes = db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO cache"));
      expect(writes.some((entry) => entry.binds.some((value) => typeof value === "string"
        && value.includes('"flightToQuality":null') && value.includes('"flightIntensity":null')))).toBe(true);
    },
  );

  it("revalidates the same accepted identity at the inclusive Safety Score budget boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T23:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const snapshot = mockFtqPublication(now - 7200);
    const cachedBody = makeValidCachedAggregateFixture(now, snapshot.safetyScoreIdentity);
    const db = mintBurnScenario({
      nowSec: now,
      flowCache: { key: "mint-burn-flows:v8:aggregate:24", value: JSON.stringify(cachedBody), updatedAt: now },
    });
    const url = new URL("https://x/api/mint-burn-flows");
    const admitted = MintBurnFlowsResponseSchema.parse(await readJsonResponse(await handleMintBurnFlows(db, url), 200));
    expect(admitted.gauge.classificationSource).toBe("safety-score-v9-publication");
    expect(admitted.gauge.classificationReason).toBeNull();
    vi.setSystemTime((now + 1) * 1000);
    const expired = await handleMintBurnFlows(db, url);
    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(expired, 200));
    expect(body.gauge).toMatchObject({
      classificationSource: "unavailable", classificationReason: "source-stale",
      flightToQuality: null, flightIntensity: null,
    });
    expect(body._meta?.dependencies?.flightToQuality).toMatchObject({
      updatedAt: snapshot.updatedAt, ageSeconds: 7201, freshBudgetSec: 7200,
      generationId: snapshot.safetyScoreIdentity.publicationGenerationId,
    });
    expect(body._meta?.updatedAt).toBe(cachedBody.sync.lastSuccessfulSyncAt);
    expect(expired.headers.get("Warning")).toContain("source-stale");
  });

  it("keeps fresh per-coin flow evidence independent of a stale Safety Score publication", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockFtqPublication(now - 4000);
    const db = mintBurnScenario({
      nowSec: now,
      rows: { hourly: [makeFlowHourlyRow(now)], latestSuccessfulSync: [{ started_at: now - 120 }] },
    });
    const response = await flowResponse(db, "?stablecoin=usdt-tether");
    const body = await readJsonResponse<{ _meta: { status: string; dependencies?: Record<string, unknown> } }>(response, 200);
    expect(body._meta.status).toBe("fresh");
    expect(body._meta.dependencies?.flightToQuality).toBeUndefined();
    expect(response.headers.get("Warning")).toBeNull();
    expect(activeSafetyScoreSource.loadActiveSafetyScoreIndex).not.toHaveBeenCalled();
  });

  it.each([
    { failedRead: false, reason: "v9-snapshot-unavailable" },
    { failedRead: true, reason: "safety-score-index-read-failed" },
  ])("distinguishes absent accepted publication from failed index reads: $reason", async ({ failedRead, reason }) => {
    const now = Math.floor(Date.now() / 1000);
    const cachedBody = makeValidCachedAggregateFixture(now, null);
    const db = mintBurnScenario({
      nowSec: now,
      flowCache: {
        key: "mint-burn-flows:v8:aggregate:24",
        value: JSON.stringify(cachedBody),
        updatedAt: now,
      },
      overrides: failedRead ? [{
        match: "i.value AS score_index", rows: [],
        throwError: new Error("canonical index D1 read failed"),
      }] : [],
    });
    const response = await flowResponse(db);
    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body.gauge).toMatchObject({
      flightToQuality: null, flightIntensity: null, classificationSource: "unavailable", classificationReason: reason,
    });
    expect(body._meta?.dependencies?.flightToQuality).toMatchObject({
      status: "unavailable", updatedAt: null, generationId: null, reason,
    });
    expect(body._meta?.updatedAt).toBe(cachedBody.sync.lastSuccessfulSyncAt);
    expect(response.headers.get("Warning")).toContain(reason);
  });

  it("rejects pre-cutover aggregate and per-coin cache generations rather than renewing exact-zero claims", async () => {
    for (const suffix of ["aggregate:24", "coin:usdt-tether:24"]) {
      const db = mintBurnScenario({ rows: { scanCoverage: [] }, flowCache: {
        key: `mint-burn-flows:v4:${suffix}`, value: JSON.stringify({ oldExactZero: true }),
      } });
      const url = new URL(`https://x/api/mint-burn-flows${suffix.startsWith("coin:") ? "?stablecoin=usdt-tether" : ""}`);
      const body = await readJsonResponse(await handleMintBurnFlows(db, url), 200) as Record<string, unknown>;
      expect(body).not.toHaveProperty("oldExactZero");
      if (suffix.startsWith("coin:")) expect(body.netFlowUsd).toBeNull();
      else expect(MintBurnFlowsResponseSchema.parse(body).coins.every((coin) => coin.netFlow24hUsd === null)).toBe(true);
    }
  });

  it("keeps per-coin observed gross flow while withholding unproved chain, hourly and total signed nets", async () => {
    const now = Math.floor(Date.now() / 1000);
    const row = { ...makeFlowHourlyRow(now), hour_ts: Math.floor(now / 3600) * 3600 - 3600,
      mint_unpriced_event_count: 0, burn_unpriced_event_count: 0 };
    const db = mintBurnScenario({ nowSec: now, rows: { hourly: [row], scanCoverage: [] } });
    const body = await readJsonResponse(await flowResponse(db, "?stablecoin=usdt-tether"), 200) as {
      netFlowUsd: number | null; mintVolumeUsd: number; mintCount: number;
      scanCoverage: { complete: boolean; unavailableReason: string };
      chains: Array<{ netFlowUsd: number | null }>; hourly: Array<{ netFlowUsd: number | null }>;
    };
    expect(body).toMatchObject({ netFlowUsd: null, mintVolumeUsd: 10_000, mintCount: 5,
      scanCoverage: { complete: false, unavailableReason: "scan-coverage-incomplete" },
      window: { watermark: { unavailableReason: "scan-watermark-unavailable" } } });
    expect(body.chains.every((chain) => chain.netFlowUsd === null)).toBe(true);
    expect(body.hourly.every((hour) => hour.netFlowUsd === null)).toBe(true);
    const aggregate = MintBurnFlowsResponseSchema.parse(await readJsonResponse(
      await flowResponse(mintBurnScenario({ rows: { hourly: [row], scanCoverage: [] } })), 200));
    expect(aggregate.gauge).toMatchObject({ score: null, band: null,
      scanCoverage: { complete: false, unavailableReason: "scan-coverage-incomplete" } });
    expect(aggregate.window?.watermark?.unavailableReason).toBe("scan-watermark-unavailable");
  });
});
