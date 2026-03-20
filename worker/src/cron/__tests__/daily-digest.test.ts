import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAsset } from "../../api/__tests__/helpers/fixtures";
import { mockD1, type MockD1Database, type MockTableConfig } from "../../api/__tests__/helpers/mock-d1";

vi.mock("@shared/lib/stablecoins", () => {
  const stablecoins = [
    {
      id: "usdt-tether",
      symbol: "USDT",
      flags: { yieldBearing: false },
      contracts: [
        { chain: "ethereum", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
        { chain: "tron", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 },
        { chain: "arbitrum", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 },
        { chain: "optimism", address: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", decimals: 6 },
        { chain: "polygon", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
        { chain: "avalanche", address: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", decimals: 6 },
        { chain: "bsc", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 },
      ],
      tradedContracts: [
        { chain: "optimism", address: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071", decimals: 6 },
      ],
    },
    {
      id: "usdc-circle",
      symbol: "USDC",
      flags: { yieldBearing: false },
      contracts: [
        { chain: "ethereum", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
        { chain: "arbitrum", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
        { chain: "base", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
        { chain: "optimism", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 },
        { chain: "polygon", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 },
        { chain: "avalanche", address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6 },
      ],
    },
    {
      id: "paxg-paxos",
      symbol: "PAXG",
      flags: { yieldBearing: false },
      contracts: [
        { chain: "ethereum", address: "0x45804880De22913dAFE09f4980848ECE6EcbAf78", decimals: 18 },
      ],
    },
    {
      id: "xaut-tether",
      symbol: "XAUT",
      flags: { yieldBearing: false },
      contracts: [
        { chain: "ethereum", address: "0x68749665FF8D2d112Fa859AA293F07A622782F38", decimals: 6 },
      ],
    },
  ];
  const ids = new Set(["usdt-tether", "usdc-circle"]);
  return {
  TRACKED_STABLECOINS: stablecoins,
  ACTIVE_STABLECOINS: stablecoins,
  TRACKED_META_BY_ID: new Map([
    ["usdt-tether", {
      id: "usdt-tether",
      symbol: "USDT",
      flags: { yieldBearing: false },
      contracts: [
        { chain: "ethereum", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
        { chain: "tron", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 },
        { chain: "arbitrum", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 },
        { chain: "optimism", address: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", decimals: 6 },
        { chain: "polygon", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
        { chain: "avalanche", address: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", decimals: 6 },
        { chain: "bsc", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 },
      ],
      tradedContracts: [
        { chain: "optimism", address: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071", decimals: 6 },
      ],
    }],
    ["usdc-circle", {
      id: "usdc-circle",
      symbol: "USDC",
      flags: { yieldBearing: false },
      contracts: [
        { chain: "ethereum", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
        { chain: "arbitrum", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
        { chain: "base", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
        { chain: "optimism", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 },
        { chain: "polygon", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 },
        { chain: "avalanche", address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6 },
      ],
    }],
    ["paxg-paxos", {
      id: "paxg-paxos",
      symbol: "PAXG",
      flags: { yieldBearing: false },
      contracts: [{ chain: "ethereum", address: "0x45804880De22913dAFE09f4980848ECE6EcbAf78", decimals: 18 }],
    }],
    ["xaut-tether", {
      id: "xaut-tether",
      symbol: "XAUT",
      flags: { yieldBearing: false },
      contracts: [{ chain: "ethereum", address: "0x68749665FF8D2d112Fa859AA293F07A622782F38", decimals: 6 }],
    }],
  ]),
  TRACKED_IDS: ids,
  ACTIVE_IDS: ids,
  };
});

vi.mock("../../lib/stablecoins-cache", () => ({
  loadStablecoinsCache: vi.fn(),
}));

vi.mock("../../lib/safety-scores", () => ({
  computeSafetyScoresSnapshot: vi.fn(),
}));

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../../lib/twitter", () => ({
  postDigestTweet: vi.fn(),
}));

vi.mock("../../lib/telegram", () => ({
  postDigestToTelegram: vi.fn(),
}));

vi.mock("../../lib/telegram-digest-appendices", () => ({
  prepareTelegramDigestAppendices: vi.fn(),
}));

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
  recordOutcomeSafe: vi.fn(async () => {}),
}));

vi.mock("../../lib/mint-burn-contracts", () => ({
  SAFE_HAVEN_IDS: new Set(["usdt-tether", "usdc-circle"]),
}));

import { generateDailyDigest, classifyRegime } from "../daily-digest";
import {
  collectPsiContributors,
  collectYieldAnomalies,
  collectLiquidityShifts,
  collectCrossDayTrends,
  collectDewsStress,
  type CollectorContext,
} from "../daily-digest/collectors";
import type { DigestInputData } from "@shared/types";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { computeSafetyScoresSnapshot } from "../../lib/safety-scores";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { postDigestTweet } from "../../lib/twitter";
import { postDigestToTelegram } from "../../lib/telegram";
import { prepareTelegramDigestAppendices } from "../../lib/telegram-digest-appendices";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";

const ANTHROPIC_OK_RESPONSE = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        title: "Calm Drift",
        extended: "PSI held firm.\n\nUSDT and USDC stayed in range.",
        text: "USDT and USDC absorbed another quiet day near peg.",
      }),
    },
  ],
};

const commitTelegramAppendices = vi.fn(async () => undefined);

function makeBaseTables(): MockTableConfig[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % 86_400);
  const weekAgoTs = todayTs - 7 * 86_400;

  return [
    {
      match: "SELECT generated_at, digest_text FROM daily_digest ORDER BY generated_at DESC LIMIT 1",
      rows: [],
      first: null,
    },
    {
      match: "SELECT digest_title, digest_text, digest_extended, digest_meta FROM daily_digest ORDER BY generated_at DESC LIMIT 5",
      rows: [],
    },
    {
      match: "SELECT COUNT(*) as cnt FROM daily_digest WHERE",
      rows: [{ cnt: 1 }],
      first: { cnt: 1 },
    },
    {
      match: "FROM depeg_events WHERE ended_at IS NULL",
      rows: [{ stablecoin_id: "usdt-tether", symbol: "USDT", peak_deviation_bps: 150 }],
    },
    {
      match: "FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1",
      rows: [],
      first: {
        score: 91.2,
        band: "BEDROCK",
        components: JSON.stringify({ severity: 2, breadth: 1, trend: 0, stressBreadth: 0 }),
      },
    },
    {
      match: "SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?",
      rows: [],
      first: { avg: 90.6 },
    },
    {
      match: "FROM stability_index WHERE computed_at = ?",
      rows: [],
      first: { score: 89.5, band: "STEADY" },
    },
    {
      match: "FROM blacklist_events",
      rows: [],
    },
    {
      match: "FROM supply_history WHERE stablecoin_id IN",
      rows: [
        { stablecoin_id: "usdt-tether", snapshot_date: todayTs, circulating_usd: 100_000_000 },
        { stablecoin_id: "usdt-tether", snapshot_date: todayTs - 86_400, circulating_usd: 99_000_000 },
        { stablecoin_id: "usdt-tether", snapshot_date: weekAgoTs, circulating_usd: 95_000_000 },
        { stablecoin_id: "usdc-circle", snapshot_date: todayTs, circulating_usd: 60_000_000 },
        { stablecoin_id: "usdc-circle", snapshot_date: todayTs - 86_400, circulating_usd: 61_000_000 },
        { stablecoin_id: "usdc-circle", snapshot_date: weekAgoTs, circulating_usd: 62_000_000 },
      ],
    },
    {
      match: "WHERE ended_at IS NOT NULL AND ended_at >= ?",
      rows: [],
    },
  ];
}

function getInsertDigestBinds(db: MockD1Database): unknown[] | undefined {
  return db
    .getHistory()
    .find((entry) => entry.sql.includes("INSERT INTO daily_digest"))
    ?.binds;
}

describe("generateDailyDigest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));

    vi.mocked(loadStablecoinsCache).mockReset().mockResolvedValue({
      kind: "ok",
      payload: {
        peggedAssets: [
          makeAsset({
            id: "usdt-tether",
            symbol: "USDT",
            circulating: { peggedUSD: 100_000_000 },
            circulatingPrevWeek: { peggedUSD: 95_000_000 },
          }),
          makeAsset({
            id: "usdc-circle",
            symbol: "USDC",
            circulating: { peggedUSD: 60_000_000 },
            circulatingPrevWeek: { peggedUSD: 62_000_000 },
          }),
        ],
      },
      updatedAt: Math.floor(Date.now() / 1000),
    });

    vi.mocked(computeSafetyScoresSnapshot).mockReset().mockResolvedValue({
      kind: "ok",
      mode: "full-grades",
      coveredCount: 2,
      trackedCount: 2,
      coverageRatio: 1,
      scores: new Map(),
      grades: [
        { id: "usdt-tether", symbol: "USDT", grade: "A", score: 88, pegScore: 95, liqScore: 90 },
        { id: "usdc-circle", symbol: "USDC", grade: "A", score: 85, pegScore: 93, liqScore: 87 },
      ],
    });

    vi.mocked(fetchWithRetry).mockReset().mockResolvedValue(
      new Response(JSON.stringify(ANTHROPIC_OK_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    vi.mocked(postDigestTweet).mockReset().mockResolvedValue(undefined);
    vi.mocked(postDigestToTelegram).mockReset().mockResolvedValue(undefined);
    commitTelegramAppendices.mockReset().mockResolvedValue(undefined);
    vi.mocked(prepareTelegramDigestAppendices).mockReset().mockResolvedValue({
      appendixHtml: null,
      metadata: {
        hasAppendix: false,
        cemeteryDetected: 0,
        trackedDetected: 0,
        preLaunchDetected: 0,
        cemeterySymbols: [],
        trackedSymbols: [],
        preLaunchSymbols: [],
        seededSnapshots: [],
      },
      commitSuccess: commitTelegramAppendices,
    });
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stores digest on happy path and posts to social channels", async () => {
    const db = mockD1(makeBaseTables());

    const result = await generateDailyDigest(
      db,
      "anthropic-key",
      {
        apiKey: "x",
        apiSecret: "y",
        accessToken: "z",
        accessTokenSecret: "w",
      },
      false,
      {
        botToken: "tg-token",
        chatId: "tg-chat",
      },
    );

    expect(result.itemCount).toBe(1);
    expect(result.metadata).toContain("tweet: ok");
    expect(result.metadata).toContain("telegram: ok");

    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    expect(insertBinds).toBeDefined();
    expect(insertBinds?.[1]).toBe("USDT and USDC absorbed another quiet day near peg.");
    expect(insertBinds?.[2]).toBe("Calm Drift");

    const storedInput = JSON.parse(String(insertBinds?.[3])) as {
      totalMcapUsd: number;
      activeDepegCount: number;
      topDepegs: Array<{ symbol: string; bps: number }>;
    };
    expect(storedInput.totalMcapUsd).toBe(160_000_000);
    expect(storedInput.activeDepegCount).toBe(1);
    expect(storedInput.topDepegs).toEqual([{ symbol: "USDT", bps: 150, mcapUsd: 100_000_000 }]);

    expect(postDigestTweet).toHaveBeenCalledTimes(1);
    expect(postDigestToTelegram).toHaveBeenCalledTimes(1);
    expect(commitTelegramAppendices).toHaveBeenCalledTimes(1);
    expect(fetchWithRetry).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-api-key": "anthropic-key" }),
      }),
      2,
      { timeoutMs: 120_000 },
    );
  });

  it("falls back gracefully when LLM returns malformed code-block JSON", async () => {
    const malformed = "```json\n{\"title\":\"Broken\", \"text\":\n```";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: malformed }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key");

    expect(result.itemCount).toBe(1);
    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    expect(insertBinds?.[1]).toBe(malformed);
    expect(insertBinds?.[2]).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "[daily-digest] Failed to parse JSON response, using raw text",
    );
  });

  it("skips generation when a recent valid digest already exists", async () => {
    const recentDigestDb = mockD1([
      {
        match: "SELECT generated_at, digest_text FROM daily_digest ORDER BY generated_at DESC LIMIT 1",
        rows: [],
        first: {
          generated_at: Math.floor(Date.now() / 1000) - 20 * 60,
          digest_text: "Already generated",
        },
      },
    ]);

    const result = await generateDailyDigest(recentDigestDb, "anthropic-key");

    expect(result.metadata).toBe("skipped: recent digest exists");
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(getInsertDigestBinds(recentDigestDb as MockD1Database)).toBeUndefined();
  });

  it("skips regeneration when stablecoins cache is unavailable", async () => {
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "error",
      reason: "missing-cache",
      updatedAt: null,
    });

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key");

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(getInsertDigestBinds(db as MockD1Database)).toBeUndefined();
  });

  it("skips safety summary output when safety snapshot is degraded", async () => {
    vi.mocked(computeSafetyScoresSnapshot).mockResolvedValueOnce({
      kind: "degraded",
      mode: "full-grades",
      coveredCount: 0,
      trackedCount: 2,
      coverageRatio: 0,
      reason: "stablecoins-cache:missing-cache",
      scores: new Map(),
      grades: [],
    });

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key");

    expect(result.status).toBe("degraded");
    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    const storedInput = JSON.parse(String(insertBinds?.[3])) as { safetyScores?: unknown };
    expect(storedInput.safetyScores).toBeUndefined();
  });

  it("fails early on DB data-collection error and does not call Claude", async () => {
    const baseTables = makeBaseTables().filter(
      (table) => table.match !== "SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?",
    );
    const db = mockD1([
      ...baseTables,
      {
        match: "SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?",
        rows: [],
        throwError: new Error("D1 read failed"),
      },
    ]);

    await expect(generateDailyDigest(db, "anthropic-key")).rejects.toThrow("D1 read failed");
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it("includes mint-burn flow data in stored input when hourly data exists", async () => {
    const baseTables = makeBaseTables();
    const db = mockD1([
      ...baseTables,
      // 24h aggregate — match on SUM(mint_volume_usd) which is unique to this query
      {
        match: "SUM(mint_volume_usd)",
        rows: [
          { stablecoin_id: "usdt-tether", mint_24h: 500_000_000, burn_24h: 300_000_000, net_24h: 200_000_000 },
          { stablecoin_id: "usdc-circle", mint_24h: 100_000_000, burn_24h: 150_000_000, net_24h: -50_000_000 },
        ],
      },
      // 30d baseline — match on "/ 30.0" which is unique to this query
      {
        match: "/ 30.0",
        rows: [
          { stablecoin_id: "usdt-tether", avg_daily_net: 50_000_000, avg_daily_abs: 200_000_000, data_days: 30 },
          { stablecoin_id: "usdc-circle", avg_daily_net: -10_000_000, avg_daily_abs: 80_000_000, data_days: 25 },
        ],
      },
    ]);

    const result = await generateDailyDigest(db, "anthropic-key");
    expect(result.itemCount).toBe(1);

    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    const storedInput = JSON.parse(String(insertBinds?.[3]));
    expect(storedInput.mintBurnFlows).toBeDefined();
    expect(storedInput.mintBurnFlows.gaugeBand).toBeDefined();
    expect(typeof storedInput.mintBurnFlows.gaugeScore).toBe("number");
    expect(storedInput.mintBurnFlows.flightToQuality).toBeDefined();
  });

  it("includes DEWS stress data with band changes in stored input", async () => {
    const nowSec = Math.floor(Date.now() / 1000);

    const baseTables = makeBaseTables();
    const db = mockD1([
      ...baseTables,
      // Latest DEWS per coin
      {
        match: "FROM stress_signals",
        rows: [
          { stablecoin_id: "usdt-tether", score: 8, band: "CALM", signals_json: '{"supply":{"value":5,"available":true}}', computed_at: nowSec - 600 },
          { stablecoin_id: "usdc-circle", score: 62, band: "ALERT", signals_json: '{"pool":{"value":70,"available":true},"liq":{"value":50,"available":true}}', computed_at: nowSec - 600 },
        ],
      },
      // Yesterday's snapshot
      {
        match: "FROM stress_signal_history WHERE snapshot_date = ?",
        rows: [
          { stablecoin_id: "usdt-tether", score: 10, band: "CALM" },
          { stablecoin_id: "usdc-circle", score: 30, band: "WATCH" },
        ],
      },
    ]);

    const result = await generateDailyDigest(db, "anthropic-key");
    expect(result.itemCount).toBe(1);

    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    const storedInput = JSON.parse(String(insertBinds?.[3]));
    expect(storedInput.dewsStress).toBeDefined();
    expect(storedInput.dewsStress.bandCounts.calm).toBeGreaterThanOrEqual(1);
    // USDC went WATCH -> ALERT (crosses threshold)
    expect(storedInput.dewsStress.bandChanges.length).toBeGreaterThanOrEqual(1);
    expect(storedInput.dewsStress.bandChanges[0].symbol).toBe("USDC");
    expect(storedInput.dewsStress.bandChanges[0].from).toBe("WATCH");
    expect(storedInput.dewsStress.bandChanges[0].to).toBe("ALERT");
  });

  it("includes historical context with PSI precedent and band streak", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);

    const baseTables = makeBaseTables();
    const db = mockD1([
      ...baseTables,
      // PSI precedent: query previous digests for displayed PSI scores
      {
        match: "FROM daily_digest\n           WHERE json_extract(input_data",
        rows: [],
        first: { generated_at: todayTs - 30 * 86_400 + 8 * 3600, psi_score: 89.0, psi_band: "STEADY" },
      },
      // PSI band streak
      {
        match: "ORDER BY computed_at DESC LIMIT 90",
        rows: [
          { computed_at: todayTs, band: "BEDROCK" },
          { computed_at: todayTs - 86_400, band: "BEDROCK" },
          { computed_at: todayTs - 2 * 86_400, band: "BEDROCK" },
          { computed_at: todayTs - 3 * 86_400, band: "STEADY" },
        ],
      },
      // Supply mover ATH
      {
        match: "MAX(circulating_usd)",
        rows: [],
        first: { ath_mcap: 120_000_000 },
      },
      // Supply mover ATH date
      {
        match: "WHERE stablecoin_id = ? AND circulating_usd = ?",
        rows: [],
        first: { snapshot_date: todayTs - 60 * 86_400 },
      },
      // Supply mover largest weekly change
      {
        match: "ABS(s1.circulating_usd - s2.circulating_usd)",
        rows: [],
        first: { snapshot_date: todayTs - 45 * 86_400, abs_change: 8_000_000 },
      },
      // History depth check (>30 rows means >30 days)
      {
        match: "COUNT(*) as cnt FROM stability_index",
        rows: [],
        first: { cnt: 90 },
      },
    ]);

    const result = await generateDailyDigest(db, "anthropic-key");
    expect(result.itemCount).toBe(1);

    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    const storedInput = JSON.parse(String(insertBinds?.[3]));
    expect(storedInput.historicalContext).toBeDefined();
    expect(storedInput.historicalContext.psiBandStreak).toBe(3);
    expect(storedInput.historicalContext.psiPrecedent).toBeDefined();
    expect(storedInput.historicalContext.psiPrecedent.lastSeenDaysAgo).toBe(30);
  });

  it("includes grade transitions and excludes methodology bumps", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);

    const baseTables = makeBaseTables();
    const db = mockD1([
      ...baseTables,
      // Methodology bump check (no bumps)
      {
        match: "HAVING COUNT(*) > 10",
        rows: [],
      },
      // Grade transitions in last 48h
      {
        match: "FROM safety_grade_history WHERE recorded_at >= ?",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            recorded_at: todayTs,
            grade: "A-",
            score: 80,
            prev_grade: "A",
            prev_score: 85,
          },
        ],
      },
    ]);

    const result = await generateDailyDigest(db, "anthropic-key");
    expect(result.itemCount).toBe(1);

    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    const storedInput = JSON.parse(String(insertBinds?.[3]));
    expect(storedInput.gradeTransitions).toBeDefined();
    expect(storedInput.gradeTransitions.length).toBe(1);
    expect(storedInput.gradeTransitions[0].symbol).toBe("USDT");
    expect(storedInput.gradeTransitions[0].fromGrade).toBe("A");
    expect(storedInput.gradeTransitions[0].toGrade).toBe("A-");
  });

  it("parses meta field from Claude response and stores in digest_meta", async () => {
    const responseWithMeta = {
      content: [{
        type: "text",
        text: JSON.stringify({
          title: "Alert Watch",
          extended: "PSI dipped below 90.\n\nFRAX entered ALERT on pool drift.",
          text: "FRAX hit ALERT while PSI slid to 88, the first STEADY reading in 47 days.",
          meta: { lead: "dews-band-change", tone: "foreboding", coins: ["FRAX"] },
        }),
      }],
    };

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify(responseWithMeta), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key");
    expect(result.itemCount).toBe(1);

    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    // digest_meta should be the 6th bind (index 5)
    const metaJson = insertBinds?.[5];
    expect(metaJson).toBeDefined();
    const meta = JSON.parse(String(metaJson));
    expect(meta.lead).toBe("dews-band-change");
    expect(meta.tone).toBe("foreboding");
    expect(meta.coins).toEqual(["FRAX"]);
  });

  it("keeps digest persistence even when social posting fails", async () => {
    vi.mocked(postDigestTweet).mockRejectedValueOnce(new Error("twitter down"));
    vi.mocked(postDigestToTelegram).mockRejectedValueOnce(new Error("telegram down"));

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(
      db,
      "anthropic-key",
      {
        apiKey: "x",
        apiSecret: "y",
        accessToken: "z",
        accessTokenSecret: "w",
      },
      false,
      {
        botToken: "tg-token",
        chatId: "tg-chat",
      },
    );

    expect(result.itemCount).toBe(1);
    expect(result.metadata).toContain("tweet: failed:");
    expect(result.metadata).toContain("telegram: failed:");
    expect(commitTelegramAppendices).not.toHaveBeenCalled();
    expect(getInsertDigestBinds(db as MockD1Database)).toBeDefined();
  });

  it("passes digest appendices to Telegram and commits appendix state after a successful send", async () => {
    vi.mocked(prepareTelegramDigestAppendices).mockResolvedValueOnce({
      appendixHtml: "<b>Tracking Changes</b>\n\n<code>USDX</code> Example USD",
      metadata: {
        hasAppendix: true,
        cemeteryDetected: 0,
        trackedDetected: 1,
        preLaunchDetected: 0,
        cemeterySymbols: [],
        trackedSymbols: ["USDX"],
        preLaunchSymbols: [],
        seededSnapshots: [],
      },
      commitSuccess: commitTelegramAppendices,
    });

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(
      db,
      "anthropic-key",
      null,
      false,
      {
        botToken: "tg-token",
        chatId: "tg-chat",
      },
    );

    expect(result.metadata).toContain("telegram: ok+appendix(");
    expect(postDigestToTelegram).toHaveBeenCalledWith(
      "Calm Drift",
      "PSI held firm.\n\nUSDT and USDC stayed in range.",
      "2026-03-06",
      { botToken: "tg-token", chatId: "tg-chat" },
      1,
      "<b>Tracking Changes</b>\n\n<code>USDX</code> Example USD",
    );
    expect(commitTelegramAppendices).toHaveBeenCalledTimes(1);
  });

  it("does not commit appendix state when Telegram delivery fails", async () => {
    vi.mocked(prepareTelegramDigestAppendices).mockResolvedValueOnce({
      appendixHtml: "<b>New Cemetery Entries</b>\n\n<code>UST</code> TerraUSD",
      metadata: {
        hasAppendix: true,
        cemeteryDetected: 1,
        trackedDetected: 0,
        preLaunchDetected: 0,
        cemeterySymbols: ["UST"],
        trackedSymbols: [],
        preLaunchSymbols: [],
        seededSnapshots: [],
      },
      commitSuccess: commitTelegramAppendices,
    });
    vi.mocked(postDigestToTelegram).mockRejectedValueOnce(new Error("telegram down"));

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(
      db,
      "anthropic-key",
      null,
      false,
      {
        botToken: "tg-token",
        chatId: "tg-chat",
      },
    );

    expect(result.metadata).toContain("telegram: failed:");
    expect(commitTelegramAppendices).not.toHaveBeenCalled();
  });
});

describe("classifyRegime", () => {
  const baseData: DigestInputData = {
    totalMcapUsd: 200_000_000_000,
    mcap7dDelta: 1_000_000_000,
    activeDepegCount: 0,
    topDepegs: [],
    biggestSupplyChange: null,
    stabilityIndex: { score: 95, band: "BEDROCK", components: { severity: 0, breadth: 0, trend: 0 } },
    yesterdayIndex: null,
  };

  it("returns CALM when nothing is elevated", () => {
    expect(classifyRegime(baseData)).toBe("CALM");
  });

  it("returns CRISIS when FTQ is active", () => {
    expect(classifyRegime({
      ...baseData,
      mintBurnFlows: { gaugeScore: -20, gaugeBand: "CAUTIOUS", flightToQuality: { active: true, safeNetUsd: 200_000_000, riskyNetUsd: -200_000_000 }, topPressure: [] },
    })).toBe("CRISIS");
  });

  it("returns CRISIS when PSI band is TREMOR", () => {
    expect(classifyRegime({
      ...baseData,
      stabilityIndex: { score: 65, band: "TREMOR", components: { severity: 30, breadth: 5, trend: -3 } },
    })).toBe("CRISIS");
  });

  it("returns TENSION when 3+ coins ALERT+", () => {
    expect(classifyRegime({
      ...baseData,
      dewsStress: {
        bandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 },
        yesterdayBandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 },
        bandChanges: [], elevatedCoins: [],
      },
    })).toBe("TENSION");
  });

  it("returns WATCHFUL when 1 active depeg", () => {
    expect(classifyRegime({ ...baseData, activeDepegCount: 1 })).toBe("WATCHFUL");
  });
});

// ---------------------------------------------------------------------------
// Collector unit tests
// ---------------------------------------------------------------------------

function makeCollectorCtx(db: ReturnType<typeof mockD1>): CollectorContext {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % 86_400);
  const yesterdayTs = todayTs - 86_400;

  const trackedStablecoinAssets = [
    makeAsset({
      id: "usdt-tether",
      symbol: "USDT",
      circulating: { peggedUSD: 100_000_000_000 },
      circulatingPrevWeek: { peggedUSD: 95_000_000_000 },
    }),
    makeAsset({
      id: "usdc-circle",
      symbol: "USDC",
      circulating: { peggedUSD: 50_000_000_000 },
      circulatingPrevWeek: { peggedUSD: 52_000_000_000 },
    }),
    makeAsset({
      id: "dai-makerdao",
      symbol: "DAI",
      circulating: { peggedUSD: 5_000_000 },
      circulatingPrevWeek: { peggedUSD: 5_000_000 },
    }),
  ];

  const mcapById = new Map<string, number>([
    ["usdt-tether", 100_000_000_000],
    ["usdc-circle", 50_000_000_000],
    ["dai-makerdao", 5_000_000],
  ]);

  return { db: db as unknown as D1Database, trackedStablecoinAssets, mcapById, nowSec, todayTs, yesterdayTs };
}

describe("collectPsiContributors", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns top 3 contributors sorted by marketImpact", async () => {
    const db = mockD1([
      {
        match: "SELECT input_snapshot FROM stability_index_samples",
        first: {
          input_snapshot: JSON.stringify({
            contributors: [
              { id: "usdt-tether", symbol: "USDT", bps: 10, mcapUsd: 100_000_000_000, ageDays: 1, factor: 1.5 },
              { id: "usdc-circle", symbol: "USDC", bps: 20, mcapUsd: 50_000_000_000, ageDays: 2, factor: 1.2 },
              { id: "dai-makerdao", symbol: "DAI", bps: 50, mcapUsd: 5_000_000, ageDays: 1, factor: 1.0 },
              { id: "frax-finance", symbol: "FRAX", bps: 30, mcapUsd: 1_000_000_000, ageDays: 3, factor: 2.0 },
            ],
          }),
        },
        rows: [],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectPsiContributors(ctx);

    expect(result).toBeDefined();
    expect(result!.length).toBe(3);
    // Should be sorted by marketImpact descending
    expect(result![0].marketImpact).toBeGreaterThanOrEqual(result![1].marketImpact);
    expect(result![1].marketImpact).toBeGreaterThanOrEqual(result![2].marketImpact);
    // USDT should be first: |10| * 100B / 1e9 * 1.5 = 1500
    expect(result![0].symbol).toBe("USDT");
  });

  it("returns undefined when no input_snapshot exists", async () => {
    const db = mockD1([
      {
        match: "SELECT input_snapshot FROM stability_index_samples",
        first: null,
        rows: [],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectPsiContributors(ctx);
    expect(result).toBeUndefined();
  });

  it("returns undefined when contributors array is empty", async () => {
    const db = mockD1([
      {
        match: "SELECT input_snapshot FROM stability_index_samples",
        first: { input_snapshot: JSON.stringify({ contributors: [] }) },
        rows: [],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectPsiContributors(ctx);
    expect(result).toBeUndefined();
  });
});

describe("collectYieldAnomalies", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns yield anomalies filtered by is_best and mcap", async () => {
    const db = mockD1([
      {
        match: "FROM yield_data",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            current_apy: 8.5,
            apy_7d: 4.2,
            apy_30d: 3.8,
            warning_signals: JSON.stringify(["spike", "divergence"]),
          },
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            current_apy: 5.1,
            apy_7d: 4.9,
            apy_30d: 4.5,
            warning_signals: JSON.stringify(["tvl-outflow"]),
          },
          {
            stablecoin_id: "dai-makerdao",
            symbol: "DAI",
            current_apy: 12.0,
            apy_7d: 3.0,
            apy_30d: 2.5,
            warning_signals: JSON.stringify(["spike"]),
          },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectYieldAnomalies(ctx);

    expect(result).toBeDefined();
    // DAI should be filtered out (mcap $5M < $10M threshold)
    expect(result!.length).toBe(2);
    expect(result!.every((r) => r.mcapUsd >= 10_000_000)).toBe(true);
    // Should be sorted by mcap * warnings.length descending
    expect(result![0].symbol).toBe("USDT");
    expect(result![0].warnings).toEqual(["spike", "divergence"]);
  });

  it("returns undefined when no rows have warnings", async () => {
    const db = mockD1([
      {
        match: "FROM yield_data",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            current_apy: 4.0,
            apy_7d: 3.9,
            apy_30d: 3.8,
            warning_signals: "[]",
          },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectYieldAnomalies(ctx);
    expect(result).toBeUndefined();
  });

  it("returns at most 5 results", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      stablecoin_id: `coin-${i}`,
      symbol: `C${i}`,
      current_apy: 10 + i,
      apy_7d: 5,
      apy_30d: 4,
      warning_signals: JSON.stringify(["spike"]),
    }));

    const mcapById = new Map<string, number>();
    for (let i = 0; i < 8; i++) mcapById.set(`coin-${i}`, 20_000_000_000);

    const db = mockD1([{ match: "FROM yield_data", rows }]);
    const ctx = makeCollectorCtx(db);
    // Override mcapById to include all coins
    for (let i = 0; i < 8; i++) ctx.mcapById.set(`coin-${i}`, 20_000_000_000);

    const result = await collectYieldAnomalies(ctx);
    expect(result).toBeDefined();
    expect(result!.length).toBe(5);
  });
});

describe("collectLiquidityShifts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns shifts with delta >= 8 sorted by |delta| * mcap", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);
    const yesterdayTs = todayTs - 86_400;
    const dayBeforeTs = yesterdayTs - 86_400;

    const db = mockD1([
      {
        match: "FROM dex_liquidity_history",
        rows: [
          { stablecoin_id: "usdt-tether", liquidity_score: 85, total_tvl_usd: 500_000_000, snapshot_date: yesterdayTs },
          { stablecoin_id: "usdt-tether", liquidity_score: 75, total_tvl_usd: 480_000_000, snapshot_date: dayBeforeTs },
          { stablecoin_id: "usdc-circle", liquidity_score: 70, total_tvl_usd: 300_000_000, snapshot_date: yesterdayTs },
          { stablecoin_id: "usdc-circle", liquidity_score: 68, total_tvl_usd: 290_000_000, snapshot_date: dayBeforeTs },
          { stablecoin_id: "dai-makerdao", liquidity_score: 50, total_tvl_usd: 1_000_000, snapshot_date: yesterdayTs },
          { stablecoin_id: "dai-makerdao", liquidity_score: 30, total_tvl_usd: 800_000, snapshot_date: dayBeforeTs },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectLiquidityShifts(ctx);

    expect(result).toBeDefined();
    // USDT: delta=10 (>=8, mcap $100B) -> included
    // USDC: delta=2 (<8) -> excluded
    // DAI: delta=20 (>=8, but mcap $5M < $10M) -> excluded
    expect(result!.length).toBe(1);
    expect(result![0].symbol).toBe("USDT");
    expect(result![0].scoreDelta).toBe(10);
    expect(result![0].currentScore).toBe(85);
    expect(result![0].previousScore).toBe(75);
  });

  it("returns undefined when no shifts exceed threshold", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);
    const yesterdayTs = todayTs - 86_400;
    const dayBeforeTs = yesterdayTs - 86_400;

    const db = mockD1([
      {
        match: "FROM dex_liquidity_history",
        rows: [
          { stablecoin_id: "usdt-tether", liquidity_score: 80, total_tvl_usd: 500_000_000, snapshot_date: yesterdayTs },
          { stablecoin_id: "usdt-tether", liquidity_score: 78, total_tvl_usd: 480_000_000, snapshot_date: dayBeforeTs },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectLiquidityShifts(ctx);
    expect(result).toBeUndefined();
  });
});

describe("collectCrossDayTrends", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns PSI, mcap, and gauge trajectories from archived digests", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const makeDigestRow = (daysAgo: number, psiScore: number, band: string, mcap: number, gaugeScore?: number) => ({
      generated_at: nowSec - daysAgo * 86_400,
      input_data: JSON.stringify({
        totalMcapUsd: mcap,
        mcap7dDelta: 0,
        activeDepegCount: 0,
        topDepegs: [],
        biggestSupplyChange: null,
        stabilityIndex: { score: psiScore, band, components: { severity: 0, breadth: 0, trend: 0 } },
        yesterdayIndex: null,
        ...(gaugeScore != null
          ? { mintBurnFlows: { gaugeScore, gaugeBand: "STABLE", flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 }, topPressure: [] } }
          : {}),
      }),
    });

    const db = mockD1([
      {
        match: "FROM daily_digest",
        rows: [
          makeDigestRow(0, 92, "BEDROCK", 200e9, -5),
          makeDigestRow(1, 91, "BEDROCK", 199e9, -3),
          makeDigestRow(2, 90, "STEADY", 198e9, -1),
          makeDigestRow(3, 89, "STEADY", 197e9),
          makeDigestRow(4, 88, "STEADY", 196e9),
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectCrossDayTrends(ctx);

    expect(result).toBeDefined();
    // PSI trajectory should be reversed to chronological
    expect(result!.psiTrajectory.length).toBe(5);
    expect(result!.psiTrajectory[0].score).toBe(88); // oldest first
    expect(result!.psiTrajectory[4].score).toBe(92); // newest last
    // mcap trajectory
    expect(result!.mcapTrajectory.length).toBe(5);
    expect(result!.mcapTrajectory[0].mcapUsd).toBe(196e9);
    // gauge trajectory: only 3 entries have gauge data, exactly 3 points
    expect(result!.gaugeTrajectory).toBeDefined();
    expect(result!.gaugeTrajectory!.length).toBe(3);
  });

  it("returns null gauge trajectory when fewer than 3 gauge points", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const makeRow = (daysAgo: number) => ({
      generated_at: nowSec - daysAgo * 86_400,
      input_data: JSON.stringify({
        totalMcapUsd: 200e9,
        mcap7dDelta: 0,
        activeDepegCount: 0,
        topDepegs: [],
        biggestSupplyChange: null,
        stabilityIndex: { score: 90, band: "BEDROCK", components: { severity: 0, breadth: 0, trend: 0 } },
        yesterdayIndex: null,
        mintBurnFlows: daysAgo === 0
          ? { gaugeScore: -5, gaugeBand: "STABLE", flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 }, topPressure: [] }
          : undefined,
      }),
    });

    const db = mockD1([
      {
        match: "FROM daily_digest",
        rows: [makeRow(0), makeRow(1), makeRow(2), makeRow(3)],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectCrossDayTrends(ctx);

    expect(result).toBeDefined();
    expect(result!.psiTrajectory.length).toBe(4);
    // Only 1 gauge point -> should be null
    expect(result!.gaugeTrajectory).toBeNull();
  });

  it("returns undefined when fewer than 3 digest entries", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM daily_digest",
        rows: [
          {
            generated_at: nowSec - 86_400,
            input_data: JSON.stringify({
              totalMcapUsd: 200e9, mcap7dDelta: 0, activeDepegCount: 0, topDepegs: [],
              biggestSupplyChange: null, stabilityIndex: null, yesterdayIndex: null,
            }),
          },
          {
            generated_at: nowSec - 2 * 86_400,
            input_data: JSON.stringify({
              totalMcapUsd: 199e9, mcap7dDelta: 0, activeDepegCount: 0, topDepegs: [],
              biggestSupplyChange: null, stabilityIndex: null, yesterdayIndex: null,
            }),
          },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectCrossDayTrends(ctx);
    expect(result).toBeUndefined();
  });
});

describe("collectDewsStress — topSignals enrichment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns topSignals on elevated coins when signals_json is provided", async () => {
    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            score: 65,
            band: "ALERT",
            signals_json: JSON.stringify({
              supply: { value: 30, available: true },
              pool: { value: 80, available: true },
              liq: { value: 45, available: true },
              price: { value: 10, available: true },
            }),
          },
        ],
      },
      {
        match: "FROM stress_signal_history WHERE snapshot_date = ?",
        rows: [
          { stablecoin_id: "usdt-tether", score: 25, band: "WATCH" },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectDewsStress(ctx);

    expect(result).toBeDefined();
    expect(result!.elevatedCoins.length).toBe(1);
    const elevated = result!.elevatedCoins[0];
    expect(elevated.symbol).toBe("USDT");
    expect(elevated.topSignals).toBeDefined();
    expect(elevated.topSignals!.length).toBe(3); // top 3
    // Sorted descending by value
    expect(elevated.topSignals![0].value).toBeGreaterThanOrEqual(elevated.topSignals![1].value);
    expect(elevated.topSignals![1].value).toBeGreaterThanOrEqual(elevated.topSignals![2].value);
    // Pool (80) should be first
    expect(elevated.topSignals![0].name).toBe("pool balance drift");
  });

  it("returns empty topSignals when signals_json is missing", async () => {
    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            score: 65,
            band: "ALERT",
            signals_json: "{}",
          },
        ],
      },
      {
        match: "FROM stress_signal_history WHERE snapshot_date = ?",
        rows: [],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectDewsStress(ctx);

    expect(result).toBeDefined();
    expect(result!.elevatedCoins.length).toBe(1);
    expect(result!.elevatedCoins[0].topSignals).toEqual([]);
  });
});
