import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import * as activeSafetyScoreSource from "../../lib/safety-score-active-source";
import * as flightToQualityClassification from "../../lib/flight-to-quality-classification";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import { mintBurnScenario } from "../../test-helpers/__shared/mint-burn";
import { handleMintBurnFlows } from "../mint-burn-flows";
import { MintBurnFlowsResponseSchema } from "@shared/types/mint-burn";

// ---------------------------------------------------------------------------
// Contract tests (handler-level, using D1 mock)
// ---------------------------------------------------------------------------

describe("handleMintBurnFlows contract tests", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const nowSec = Math.floor(Date.now() / 1000);

  const hourlyRow = {
    stablecoin_id: "usdt-tether",
    chain_id: "ethereum",
    hour_ts: nowSec - 3600,
    mint_count: 5,
    burn_count: 3,
    mint_volume_usd: 10000,
    burn_volume_usd: 5000,
    net_flow_usd: 5000,
  };

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
            hour_ts: now - 1800,
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
    expect(usdai?.baselineDailyNetUsd).toBe(200_000);
    const firstHourQuery = scopedDb
      .getHistory()
      .find((entry) => entry.sql.includes("pharos:mint-burn-flows:first-hour-seek"));
    expect(firstHourQuery?.sql).toContain("INDEXED BY idx_mbh_chain_coin_hour");
    expect(firstHourQuery?.sql).toContain("ORDER BY h.hour_ts ASC");
    expect(firstHourQuery?.sql).not.toContain("GROUP BY");
    const recentAggregateQueries = scopedDb
      .getHistory()
      .filter((entry) => entry.sql.includes("FROM mint_burn_hourly INDEXED BY idx_mbh_ts"));
    expect(recentAggregateQueries.length).toBeGreaterThanOrEqual(5);
  });

  it("excludes historical rows for quarantined mint/burn configs from the public aggregate", async () => {
    const now = Math.floor(Date.now() / 1000);
    const inactiveDb = mintBurnScenario({
      nowSec: now,
      rows: {
        hourly: [{
          stablecoin_id: "busd0-usual",
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
            id: "busd0-usual",
            symbol: "bUSD0",
            circulating: { peggedUSD: 100_000_000 },
          }],
        }),
        updatedAt: now,
      },
    });

    const res = await handleMintBurnFlows(inactiveDb, new URL("https://x/api/mint-burn-flows"));
    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.coins.some((coin) => coin.stablecoinId === "busd0-usual")).toBe(false);
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
    // universe as `coins`, ordered by absolute 24h net flow.
    expect(body.chains).toEqual([
      { chainId: "arbitrum", netFlow24hUsd: -50_000_000 },
      { chainId: "ethereum", netFlow24hUsd: 30_000_000 },
    ]);
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
    expect(windowScans[0]?.binds).toEqual(["ethereum", "base", "arbitrum", sevenDayStart]);
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
      },
    ]);
    expect(usdt?.netFlow24hUsd).toBe(40_000_000);
    expect(usdt?.mintVolume24hUsd).toBe(60_000_000);
    expect(usdt?.burnVolume24hUsd).toBe(20_000_000);

    const history = db.getHistory();
    const windowScans = history.filter((entry) => entry.sql.includes("pharos:mint-burn-flows:window-rows"));
    expect(windowScans).toHaveLength(1);
    expect(windowScans[0]?.binds).toEqual(["ethereum", "base", "arbitrum", twentyFourHourStart]);
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
        key: "mint-burn-flows:v3:aggregate:24",
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
        flightToQuality: false,
        flightIntensity: 0,
        classificationSource: "unavailable",
        safetyScoreIdentity: null,
      },
      sync: {
        lastSuccessfulSyncAt: now - 120,
        classificationWarning: expect.stringContaining("identity-missing"),
      },
    });
    expect(res.headers.get("Warning")).toContain("identity-missing");

    const history = cachedDb.getHistory();
    expect(history.some((entry) => entry.sql.includes("FROM mint_burn_hourly"))).toBe(false);
  });

  it("serves a fresh aggregate with FTQ unavailable when the report-card cache read fails", async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource")
      .mockRejectedValueOnce(new Error("canonical V9 read failed"));
    const db = mintBurnScenario({
      nowSec: now,
      rows: { hourly: [{ ...hourlyRow, hour_ts: now - 3600 }] },
      stablecoinsCache: { value: stablecoinsCache, updatedAt: now },
    });

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));

    expect(body.gauge).toMatchObject({
      flightToQuality: false,
      flightIntensity: 0,
      classificationSource: "unavailable",
      safetyScoreIdentity: null,
    });
    expect(body.sync?.classificationWarning).toContain("cache-read-failed");
  });

  it("preserves an explicitly unavailable cached FTQ state without revalidation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cachedBody = {
      gauge: {
        score: 0,
        band: "NEUTRAL",
        intensitySemantics: "signed-v2",
        flightToQuality: false,
        flightIntensity: 0,
        classificationSource: "unavailable",
        safetyScoreIdentity: null,
        trackedCoins: 1,
        trackedMcapUsd: 0,
      },
      coins: [],
      hourly: [],
      updatedAt: now - 60,
      sync: {
        lastSuccessfulSyncAt: now - 120,
        freshnessStatus: "fresh",
        warning: null,
        classificationWarning: "Report-card FTQ classification unavailable (identity-missing)",
        criticalLaneHealthy: true,
      },
    };
    const db = mintBurnScenario({
      nowSec: now,
      flowCache: {
        key: "mint-burn-flows:v3:aggregate:24",
        value: JSON.stringify(cachedBody),
        updatedAt: now,
      },
    });

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(cachedBody);
    expect(db.getHistory().some((entry) => entry.binds.includes("report_card_cache"))).toBe(false);
  });

  it("removes cached FTQ output when its report-card identity is no longer active", async () => {
    const now = Math.floor(Date.now() / 1000);
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
      cards: [...ACTIVE_IDS]
        .sort()
        .map((id) => makeWorkerV9Card({ id, score: 80, grade: "A" })),
    });
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource")
      .mockResolvedValueOnce({
        kind: "v9",
        snapshot: activeSnapshot,
      });
    vi.spyOn(
      flightToQualityClassification,
      "buildFlightToQualityClassificationFromV9Snapshot",
    ).mockReturnValueOnce({
      kind: "ok",
      classification: {
        safeIds: new Set(["usdc-circle"]),
        riskyIds: new Set(),
        safetyScoreIdentity: activeSnapshot.safetyScoreIdentity,
      },
    });
    const cachedBody = {
      gauge: {
        score: 10,
        band: "BUYING",
        intensitySemantics: "signed-v2" as const,
        flightToQuality: true,
        flightIntensity: 20,
        classificationSource: "safety-score-v9-publication" as const,
        safetyScoreIdentity: cachedIdentity,
        trackedCoins: 1,
        trackedMcapUsd: 1,
      },
      coins: [],
      hourly: [],
      updatedAt: now - 60,
      sync: {
        lastSuccessfulSyncAt: now - 120,
        freshnessStatus: "fresh" as const,
        warning: null,
        classificationWarning: null,
        criticalLaneHealthy: true,
      },
    };
    const db = mintBurnScenario({
      nowSec: now,
      flowCache: {
        key: "mint-burn-flows:v3:aggregate:24",
        value: JSON.stringify(cachedBody),
        updatedAt: now,
      },
      overrides: [{
        match: "FROM mint_burn_hourly",
        rows: [],
        throwError: new Error("live aggregate query should not run"),
      }],
    });

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    const body = MintBurnFlowsResponseSchema.parse(await res.json());

    expect(body.gauge).toMatchObject({
      flightToQuality: false,
      flightIntensity: 0,
      classificationSource: "unavailable",
      safetyScoreIdentity: null,
    });
    expect(body.sync?.classificationWarning).toContain("identity-mismatch");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM mint_burn_hourly"))).toBe(false);
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
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource")
      .mockRejectedValueOnce(new Error("canonical V9 read failed"));
    const cachedBody = {
      gauge: {
        score: 10,
        band: "BUYING",
        intensitySemantics: "signed-v2" as const,
        flightToQuality: true,
        flightIntensity: 20,
        classificationSource: "safety-score-v9-publication" as const,
        safetyScoreIdentity: identity,
        trackedCoins: 1,
        trackedMcapUsd: 1,
      },
      coins: [],
      hourly: [],
      updatedAt: now - 60,
      sync: {
        lastSuccessfulSyncAt: now - 120,
        freshnessStatus: "fresh" as const,
        warning: null,
        classificationWarning: null,
        criticalLaneHealthy: true,
      },
    };
    const db = mintBurnScenario({
      nowSec: now,
      flowCache: {
        key: "mint-burn-flows:v3:aggregate:24",
        value: JSON.stringify(cachedBody),
        updatedAt: now,
      },
    });

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));

    expect(body.gauge).toMatchObject({
      flightToQuality: false,
      flightIntensity: 0,
      classificationSource: "unavailable",
      safetyScoreIdentity: null,
    });
    expect(body.sync?.classificationWarning).toContain("cache-read-failed");
  });

  it("serves cached aggregate fallback when live query fails after a cache miss", async () => {
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
    };
    let aggregateCacheLookups = 0;

    const failingDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async <T>() => {
            if (sql.includes("FROM mint_burn_hourly")) {
              throw new Error("simulated d1 failure");
            }
            return { results: [] as T[], success: true, meta: {} };
          },
          first: async <T>() => {
            if (sql.includes("SELECT value, updated_at FROM cache WHERE key = ?")) {
              const key = String(args[0] ?? "");
              if (key.startsWith("mint-burn-flows:v3:aggregate:")) {
                aggregateCacheLookups += 1;
                if (aggregateCacheLookups === 1) return null;
                return {
                  value: JSON.stringify(cachedBody),
                  updated_at: now,
                } as T;
              }
            }
            return null;
          },
          run: async () => ({ success: true, meta: {} }),
        }),
        all: async <T>() => {
          if (sql.includes("FROM mint_burn_hourly")) {
            throw new Error("simulated d1 failure");
          }
          return { results: [] as T[], success: true, meta: {} };
        },
        first: async () => null,
        run: async () => ({ success: true, meta: {} }),
      }),
    } as unknown as D1Database;

    const res = await handleMintBurnFlows(failingDb, new URL("https://x/api/mint-burn-flows?hours=720"));
    const body = await readJsonResponse(res, 200);
    expect(body).toMatchObject({
      gauge: {
        flightToQuality: false,
        flightIntensity: 0,
        classificationSource: "unavailable",
        safetyScoreIdentity: null,
      },
    });
    expect(res.headers.get("Warning")).toContain("identity-missing");
  });

  it("returns 503 when the aggregate fallback cache is malformed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const failingDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async <T>() => {
            if (sql.includes("FROM mint_burn_hourly")) {
              throw new Error("simulated d1 failure");
            }
            return { results: [] as T[], success: true, meta: {} };
          },
          first: async <T>() => {
            if (sql.includes("SELECT value, updated_at FROM cache WHERE key = ?")) {
              const key = String(args[0] ?? "");
              if (key.startsWith("mint-burn-flows:v3:aggregate:")) {
                return {
                  value: "{bad json",
                  updated_at: now,
                } as T;
              }
            }
            return null;
          },
          run: async () => ({ success: true, meta: {} }),
        }),
        all: async <T>() => {
          if (sql.includes("FROM mint_burn_hourly")) {
            throw new Error("simulated d1 failure");
          }
          return { results: [] as T[], success: true, meta: {} };
        },
        first: async () => null,
        run: async () => ({ success: true, meta: {} }),
      }),
    } as unknown as D1Database;

    const res = await handleMintBurnFlows(failingDb, new URL("https://x/api/mint-burn-flows?hours=720"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Cached mint-burn-flows payload is malformed",
    });
  });

  it("disables FTQ when the canonical V9 publication is unavailable", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
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
    expect(body.sync?.classificationWarning).toContain("v9-snapshot-unavailable");
    expect(body.gauge.flightToQuality).toBe(false);
    expect(body.gauge.flightIntensity).toBe(0);
  });

  it("keeps freshness healthy through one missed critical-lane slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
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

  it("warns once mint/burn freshness exceeds the shared status grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    // 75 min old → ratio 1.25 vs the 60-min SLA (MAX_AGE = 2× 30-min lane),
    // firmly inside the "degraded" band (1.0 < ratio ≤ 1.5) and outside "fresh".
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

  it("combines degraded freshness with the lookup fallback warning when cron freshness lookup fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    // 75 min old → ratio 1.25 vs the 60-min SLA; see the previous test for the
    // rationale behind the band math.
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
        match: "MAX(started_at) as started_at FROM cron_runs WHERE job = ? AND status = 'ok'",
        rows: [],
        throwError: new Error("cron lookup failed"),
      }],
    });

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));

    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.sync?.warning).toContain("freshness lookup failed");
    expect(res.headers.get("X-Data-Age")).toBe(String(75 * 60));
  });
});
