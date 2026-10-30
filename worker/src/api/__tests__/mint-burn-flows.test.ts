import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as activeSafetyScoreSource from "../../lib/safety-score-index";
import * as flightToQualityClassification from "../../lib/flight-to-quality-classification";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import { makeMintBurnScanSegments, mintBurnScenario } from "../../test-helpers/__shared/mint-burn";
import { makeFlowHourlyRow, makeFlowFallbackScenario, makeValidCachedAggregateFixture } from "./mint-burn-flows.test-support";
import { handleMintBurnFlows, refreshAggregateMintBurnFlowCache } from "../mint-burn-flows";
import { MintBurnFlowsResponseSchema, type MintBurnValuationCompleteness } from "@shared/types/mint-burn";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import { isGrandfatheredMintBurnConfig } from "../../lib/mint-burn-publication";

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

// ---------------------------------------------------------------------------
// Contract tests (handler-level, using D1 mock)
// ---------------------------------------------------------------------------

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

  it("filters aggregate flow metrics to configured stablecoin-chain pairs", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdai-usd-ai", symbol: "USDai", circulating: { peggedUSD: 250_000_000 } }],
    });

    const scopedDb = mintBurnScenario({
      nowSec: now,
      rows: {
        hourly: [
          {
            stablecoin_id: "usdai-usd-ai",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 5_000_000,
            burn_volume_usd: 0,
            net_flow_usd: 5_000_000,
          },
          // usdai-usd-ai/arbitrum is a tracked pair; a usdc-circle/arbitrum row
          // would be filtered out by the same universe guard that shapes `coins`.
          {
            stablecoin_id: "usdai-usd-ai",
            chain_id: "arbitrum",
            hour_ts: Math.floor(now / 3600) * 3600 - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 7_000_000,
            burn_volume_usd: 0,
            net_flow_usd: 7_000_000,
          },
        ],
        net7d: [
          { stablecoin_id: "usdai-usd-ai", chain_id: "ethereum", net_flow_usd: 5_000_000 },
          { stablecoin_id: "usdai-usd-ai", chain_id: "arbitrum", net_flow_usd: 7_000_000 },
        ],
        baseline: [
          {
            stablecoin_id: "usdai-usd-ai",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 100_000_000,
            daily_abs: 100_000_000,
          },
          {
            stablecoin_id: "usdai-usd-ai",
            chain_id: "arbitrum",
            day_ts: tenDaysAgoDay,
            daily_net: 2_000_000,
            daily_abs: 8_000_000,
          },
        ],
        firstSeen: [
          { stablecoin_id: "usdai-usd-ai", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour - 30 * 86400 },
          { stablecoin_id: "usdai-usd-ai", chain_id: "arbitrum", first_hour_ts: tenDaysAgoHour },
        ],
      },
      stablecoinsCache: { value: cache, updatedAt: now },
    });

    const res = await handleMintBurnFlows(scopedDb, new URL("https://x/api/mint-burn-flows"));

    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    const usdai = body.coins.find((coin) => coin.stablecoinId === "usdai-usd-ai");

    expect(body.scope).toEqual({
      chainIds: ["ethereum", "base", "arbitrum"],
      label: "Configured issuance chains",
    });
    expect(usdai?.netFlow24hUsd).toBe(7_000_000);
    expect(usdai?.mintVolume24hUsd).toBe(7_000_000);
    expect(usdai?.baselineDailyNetUsd).toBeCloseTo(2_000_000 / 30);
    expect(usdai?.coverage).toMatchObject({ has24hWindow: true, has7dWindow: true, has30dWindow: true, has90dWindow: true });
    const recentAggregateQueries = scopedDb
      .getHistory()
      .filter((entry) => entry.sql.includes("FROM mint_burn_hourly INDEXED BY idx_mbh_chain_coin_hour"));
    expect(recentAggregateQueries.length).toBeGreaterThanOrEqual(5);
    // The tracked-pair filter must stay index-driven: a row-value IN over
    // json_each lets each (chain, coin) prefix be seeked. A correlated
    // EXISTS (SELECT ... FROM json_each(?)) re-scans the whole pair array per
    // index row and turned these into ~1.6M-row reads per call.
    expect(recentAggregateQueries.every((entry) => entry.sql.includes("json_each(?)"))).toBe(true);
    expect(
      recentAggregateQueries.every((entry) => !entry.sql.includes("EXISTS (SELECT 1 FROM json_each")),
    ).toBe(true);
    expect(
      recentAggregateQueries.every((entry) => entry.sql.includes("(chain_id, stablecoin_id) IN")),
    ).toBe(true);
    const largestEventQuery = scopedDb
      .getHistory()
      .find((entry) => entry.sql.includes("WITH ranked_events AS"));
    expect(largestEventQuery?.sql).toContain("ROW_NUMBER() OVER");
    expect(largestEventQuery?.sql).toContain("PARTITION BY stablecoin_id");
    expect(largestEventQuery?.sql).toContain(
      "ORDER BY amount_usd DESC, timestamp DESC, block_number DESC, id DESC",
    );
    expect(largestEventQuery?.sql).toContain("WHERE row_num = 1");
  });

  it("excludes historical rows for quarantined mint/burn configs from the public aggregate", async () => {
    const now = Math.floor(Date.now() / 1000);
    const inactiveDb = mintBurnScenario({
      nowSec: now,
      rows: {
        hourly: [{
          stablecoin_id: "tbill-openeden",
          chain_id: "ethereum",
          hour_ts: now - 3600,
          mint_count: 1,
          burn_count: 0,
          mint_volume_usd: 5_000_000,
          burn_volume_usd: 0,
          net_flow_usd: 5_000_000,
        }],
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

    const res = await handleMintBurnFlows(inactiveDb, new URL("https://x/api/mint-burn-flows"));
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
          {
            stablecoin_id: "usdc-circle",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 2,
            burn_count: 1,
            mint_volume_usd: 40_000_000,
            burn_volume_usd: 10_000_000,
            net_flow_usd: 30_000_000,
          },
          {
            stablecoin_id: "usdai-usd-ai",
            chain_id: "arbitrum",
            hour_ts: now - 3600,
            mint_count: 0,
            burn_count: 3,
            mint_volume_usd: 0,
            burn_volume_usd: 50_000_000,
            net_flow_usd: -50_000_000,
          },
          {
            // Largest known net, but an unpriced mint makes it partial: no net, sorted last.
            stablecoin_id: "bd-basedollar",
            chain_id: "base",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 1,
            mint_unpriced_event_count: 1,
            burn_unpriced_event_count: 0,
            mint_volume_usd: 0,
            burn_volume_usd: 90_000_000,
            net_flow_usd: -90_000_000,
          },
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

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));

    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    // Single source for the digest's top-chains block: same tracked-pair
    // universe as `coins`, ordered by absolute 24h net flow. Legacy buckets
    // without recorded coverage read as unknown and keep their net.
    expect(body.chains?.map(({ scanCoverage: _scanCoverage, ...chain }) => chain)).toEqual([
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

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));

    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.gauge.trackedMcapUsd).toBe(100_000_000_000);
    // Every tracked coin except the two observed rows (USDT, explicit-zero USDai) lacks a weight.
    expect(body.gauge.mcapUnavailableCoins).toBe(body.gauge.trackedCoins - 2);
    expect(body.coins.some((coin) => coin.stablecoinId === "usdc-circle")).toBe(true);
  });

  it("keeps aggregate coin fields on a fixed 24h window even when hours changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    const sevenDayStart = now - 168 * 3600;
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mintBurnScenario({
      nowSec: now,
      rows: {
        hourly: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 15_000_000,
            burn_volume_usd: 5_000_000,
            net_flow_usd: 10_000_000,
          },
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 48 * 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 45_000_000,
            burn_volume_usd: 15_000_000,
            net_flow_usd: 30_000_000,
          },
        ],
        net7d: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 40_000_000 }],
        net30d: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 40_000_000 }],
        net90d: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 40_000_000 }],
        baseline: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 0,
            daily_abs: 20_000_000,
          },
        ],
        firstSeen: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      },
      stablecoinsCache: { value: cache, updatedAt: now },
    });

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows?hours=168"));

    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    const usdt = body.coins.find((coin) => coin.stablecoinId === "usdt-tether");

    expect(body.windowHours).toBe(168);
    expect(body.hourly).toHaveLength(2);
    expect(usdt?.netFlow24hUsd).toBe(10_000_000);
    expect(usdt?.mintVolume24hUsd).toBe(15_000_000);
    expect(usdt?.burnVolume24hUsd).toBe(5_000_000);

    const history = db.getHistory();
    const windowScans = history.filter((entry) => entry.sql.includes("pharos:mint-burn-flows:window-rows"));
    expect(windowScans).toHaveLength(1);
    expect(typeof windowScans[0]?.binds[0]).toBe("string");
    expect((windowScans[0]?.binds[0] as string).includes('["usdt-tether","ethereum"]')).toBe(true);
    // Pair JSON plus closed-hour start and exclusive end: no per-chain binds.
    expect(windowScans[0]?.binds).toHaveLength(3);
    expect(windowScans[0]?.binds.slice(1)).toEqual([sevenDayStart, now]);
    expect(history.some((entry) => entry.sql.includes("pharos:mint-burn-flows:window-24h-rows"))).toBe(false);
  });

  it("keeps fixed 24h coin fields when the requested hourly window is shorter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    const oneHourStart = now - 3600;
    const twentyFourHourStart = now - 24 * 3600;
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mintBurnScenario({
      nowSec: now,
      rows: {
        hourly: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: oneHourStart,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 15_000_000,
            burn_volume_usd: 5_000_000,
            net_flow_usd: 10_000_000,
          },
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3 * 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 45_000_000,
            burn_volume_usd: 15_000_000,
            net_flow_usd: 30_000_000,
          },
        ],
        net7d: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 40_000_000 }],
        net30d: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 40_000_000 }],
        net90d: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 40_000_000 }],
        baseline: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 0,
            daily_abs: 20_000_000,
          },
        ],
        firstSeen: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      },
      stablecoinsCache: { value: cache, updatedAt: now },
    });

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows?hours=1"));

    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    const usdt = body.coins.find((coin) => coin.stablecoinId === "usdt-tether");

    expect(body.windowHours).toBe(1);
    expect(body.hourly).toEqual([
      {
        hourTs: oneHourStart,
        netFlowUsd: 10_000_000,
        mintVolumeUsd: 15_000_000,
        burnVolumeUsd: 5_000_000,
        valuation: "unknown",
        scanCoverage: { complete: true, unavailableReason: null },
      },
    ]);
    expect(usdt?.netFlow24hUsd).toBe(40_000_000);
    expect(usdt?.mintVolume24hUsd).toBe(60_000_000);
    expect(usdt?.burnVolume24hUsd).toBe(20_000_000);

    const history = db.getHistory();
    const windowScans = history.filter((entry) => entry.sql.includes("pharos:mint-burn-flows:window-rows"));
    expect(windowScans).toHaveLength(1);
    expect(typeof windowScans[0]?.binds[0]).toBe("string");
    expect((windowScans[0]?.binds[0] as string).includes('["usdt-tether","ethereum"]')).toBe(true);
    // Pair JSON plus closed-hour start and exclusive end: no per-chain binds.
    expect(windowScans[0]?.binds).toHaveLength(3);
    expect(windowScans[0]?.binds.slice(1)).toEqual([twentyFourHourStart, now]);
    expect(history.some((entry) => entry.sql.includes("pharos:mint-burn-flows:window-24h-rows"))).toBe(false);
  });

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
        key: "mint-burn-flows:v6:aggregate:24",
        value: JSON.stringify(cachedBody),
        updatedAt: now,
      },
      overrides: [{
        match: "FROM mint_burn_hourly",
        rows: [],
        throwError: new Error("live aggregate query should not run"),
      }],
    });

    const res = await handleMintBurnFlows(cachedDb, new URL("https://x/api/mint-burn-flows"));
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

  it("serves a fresh aggregate with FTQ unavailable when the report-card cache read fails", async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex")
      .mockRejectedValueOnce(new Error("canonical V9 read failed"));
    const db = mintBurnScenario({
      nowSec: now,
      rows: { hourly: [{ ...hourlyRow, hour_ts: now - 3600 }] },
      stablecoinsCache: { value: stablecoinsCache, updatedAt: now },
    });

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));

    expect(body.gauge).toMatchObject({
      flightToQuality: null,
      flightIntensity: null,
      classificationSource: "unavailable",
      safetyScoreIdentity: null,
    });
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
      flowCache: { key: `mint-burn-flows:v6:aggregate:${hours}`, value, updatedAt: now },
    });

    const res = await handleMintBurnFlows(db, new URL(`https://x/api/mint-burn-flows?hours=${hours}`));
    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.gauge).toMatchObject({
      flightToQuality: false,
      flightIntensity: 0,
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
    const cachedGenerationId = `report-cards:v9:${now - 900}`;
    const activeGenerationId = `report-cards:v9:${now}`;
    const cachedIdentity = {
      model: "v9" as const,
      schemaVersion: 1 as const,
      methodologyVersion: "9.0",
      policyId: "safety-score-v9",
      policyDigest: "c".repeat(64),
      evaluationBuildDigest: "d".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
      publicationGenerationId: cachedGenerationId,
    };
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
        key: `mint-burn-flows:v6:aggregate:${hours}`,
        value: JSON.stringify(cachedBody),
        updatedAt: now,
      },
      overrides: [{
        match: "FROM mint_burn_hourly",
        rows: [],
        throwError: new Error("live aggregate query should not run"),
      }],
    });

    const res = await handleMintBurnFlows(db, new URL(`https://x/api/mint-burn-flows?hours=${hours}`));
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

  it("keeps cached aggregate flow data while disabling FTQ when report-card validation throws", async () => {
    const now = Math.floor(Date.now() / 1000);
    const identity = {
      model: "v9" as const,
      schemaVersion: 1 as const,
      methodologyVersion: "9.0",
      policyId: "safety-score-v9",
      policyDigest: "c".repeat(64),
      evaluationBuildDigest: "d".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
      publicationGenerationId: `report-cards:v9:${now}`,
    };
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex")
      .mockRejectedValueOnce(new Error("canonical V9 read failed"));
    const cachedBody = makeValidCachedAggregateFixture(now, identity);
    const db = mintBurnScenario({
      nowSec: now,
      flowCache: {
        key: "mint-burn-flows:v6:aggregate:24",
        value: JSON.stringify(cachedBody),
        updatedAt: now,
      },
    });

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));

    expect(body.gauge).toMatchObject({
      flightToQuality: null,
      flightIntensity: null,
      classificationSource: "unavailable",
      safetyScoreIdentity: null,
    });
    expect(body.sync?.classificationWarning).toContain("cache-read-failed");
  });

  it("serves cached aggregate fallback when live query fails after a cache miss", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cachedBody = makeValidCachedAggregateFixture(now, null);
    const { db: failingDb, state } = makeFlowFallbackScenario(now, JSON.stringify(cachedBody), 720);

    const res = await handleMintBurnFlows(failingDb, new URL("https://x/api/mint-burn-flows?hours=720"));
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
    const identity = {
      model: "v9" as const,
      schemaVersion: 1 as const,
      methodologyVersion: "9.0",
      policyId: "safety-score-v9",
      policyDigest: "c".repeat(64),
      evaluationBuildDigest: "d".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
      publicationGenerationId: `report-cards:v9:${now}`,
    };
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

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
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

    const res = await handleMintBurnFlows(failingDb, new URL("https://x/api/mint-burn-flows?hours=720"));
    expect(state.hourlyFailed).toBe(true);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Cached mint-burn-flows payload is malformed",
    });
  });

  it("disables FTQ when the canonical V9 publication is unavailable", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValueOnce({
      kind: "error", reason: "safety-score-index-missing", detail: "missing index", snapshot: null,
    });
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });
    const db = mintBurnScenario({
      nowSec: now,
      rows: {
        hourly: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 15_000_000,
            burn_volume_usd: 5_000_000,
            net_flow_usd: 10_000_000,
          },
        ],
        baseline: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 0,
            daily_abs: 20_000_000,
          },
        ],
        firstSeen: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      },
      stablecoinsCache: { value: stablecoinsCache, updatedAt: now },
    });

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));

    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.gauge.classificationSource).toBe("unavailable");
    expect(body.gauge.safetyScoreIdentity).toBeNull();
    expect(body.sync?.classificationWarning).toContain("safety-score-index-missing");
    expect(body.gauge.flightToQuality).toBeNull();
    expect(body.gauge.flightIntensity).toBeNull();
  });

  it("keeps freshness healthy through one missed critical-lane slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    mockFtqPublication(now);
    const thirtyMinutesAgo = now - 30 * 60;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mintBurnScenario({
      nowSec: now,
      rows: {
        hourly: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 15_000_000,
            burn_volume_usd: 5_000_000,
            net_flow_usd: 10_000_000,
          },
        ],
        latestSuccessfulSync: [{ started_at: thirtyMinutesAgo }],
      },
      stablecoinsCache: { value: cache, updatedAt: now },
    });

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Warning")).toBeNull();
    expect(res.headers.get("X-Data-Age")).toBe(String(30 * 60));
  });

  it("keeps flow-generation freshness independent of the tighter Safety Score consumer budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    mockFtqPublication(now);
    // The observed flow clock stays inside its served 8h availability budget;
    // Safety Score classification has its own independent 2h budget.
    const seventyFiveMinutesAgo = now - 75 * 60;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mintBurnScenario({
      nowSec: now,
      rows: {
        hourly: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 15_000_000,
            burn_volume_usd: 5_000_000,
            net_flow_usd: 10_000_000,
          },
        ],
        latestSuccessfulSync: [{ started_at: seventyFiveMinutesAgo }],
      },
      stablecoinsCache: { value: cache, updatedAt: now },
    });

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));

    expect(res.headers.get("Warning")).toBeNull();
    expect(res.headers.get("X-Data-Age")).toBe(String(75 * 60));
  });

  it("preserves unavailable freshness when producer lookup fails instead of borrowing an attempt clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    // A recent attempt cannot replace an unavailable confirmed-output lookup.
    const seventyFiveMinutesAgo = now - 75 * 60;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mintBurnScenario({
      nowSec: now,
      rows: {
        hourly: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 15_000_000,
            burn_volume_usd: 5_000_000,
            net_flow_usd: 10_000_000,
          },
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

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));

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
          key: "mint-burn-flows:v6:aggregate:24",
          value: JSON.stringify(materialized),
          updatedAt: now,
        },
      });
      const cached = await handleMintBurnFlows(cachedDb, new URL("https://x/api/mint-burn-flows"));
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
      flowCache: { key: "mint-burn-flows:v6:aggregate:24", value: JSON.stringify(cachedBody), updatedAt: now },
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
    const response = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows?stablecoin=usdt-tether"));
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
        key: "mint-burn-flows:v6:aggregate:24",
        value: JSON.stringify(cachedBody),
        updatedAt: now,
      },
      overrides: failedRead ? [{
        match: "i.value AS score_index", rows: [],
        throwError: new Error("canonical index D1 read failed"),
      }] : [],
    });
    const response = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
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

  it.each(["bootstrap", "legacy", "one-config-missing", "lagging", "quiet"] as const)(
    "publishes unknown versus genuine zero for %s scan evidence", async (state) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = 1_800_001_800;
      vi.setSystemTime(now * 1000);
      const end = Math.floor(now / 3600) * 3600;
      const configs = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "buidl-blackrock");
      let scanCoverage = makeMintBurnScanSegments(end, 91, configs);
      if (state === "bootstrap" || state === "legacy") scanCoverage = [];
      if (state === "one-config-missing") scanCoverage = scanCoverage.slice(0, 1);
      if (state === "lagging") scanCoverage = scanCoverage.map((segment) => ({ ...segment, to_timestamp: end - 1 }));
      scanCoverage.push(...makeMintBurnScanSegments(end, 91,
        MINT_BURN_CONFIGS.filter((config) => config.stablecoinId !== "buidl-blackrock" && isGrandfatheredMintBurnConfig(config))));
      const db = mintBurnScenario({ nowSec: now, rows: { scanCoverage,
        syncState: state === "legacy" ? configs.map((config) => ({ config_key: mintBurnConfigKey(config), last_block: 100_000_000 })) : [],
      } });
      const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(
        await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows")), 200));
      const coin = body.coins.find((entry) => entry.stablecoinId === "buidl-blackrock")!;
      const quiet = state === "quiet" || state === "lagging";
      expect(coin.has24hActivity).toBe(quiet ? false : null);
      expect(coin.netFlowDirection24h).toBe(quiet ? "inactive" : null);
      expect([coin.netFlow24hUsd, coin.netFlow7dUsd, coin.netFlow30dUsd, coin.netFlow90dUsd])
        .toEqual(Array(4).fill(quiet ? 0 : null));
      expect(coin.pressureShiftScore).toBeNull();
      expect(coin.coverage?.unavailableReason).toBe(quiet ? null : "scan-coverage-incomplete");
    },
  );

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
    const body = await readJsonResponse(await handleMintBurnFlows(db,
      new URL("https://x/api/mint-burn-flows?stablecoin=usdt-tether")), 200) as {
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
      await handleMintBurnFlows(mintBurnScenario({ rows: { hourly: [row], scanCoverage: [] } }),
        new URL("https://x/api/mint-burn-flows")), 200));
    expect(aggregate.gauge).toMatchObject({ score: null, band: null,
      scanCoverage: { complete: false, unavailableReason: "scan-coverage-incomplete" } });
    expect(aggregate.window?.watermark?.unavailableReason).toBe("scan-watermark-unavailable");
  });
});
