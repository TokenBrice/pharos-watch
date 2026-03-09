import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAsset } from "../../api/__tests__/helpers/fixtures";
import { mockD1, type MockD1Database, type MockTableConfig } from "../../api/__tests__/helpers/mock-d1";

vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_IDS: new Set(["usdt-tether", "usdc-circle"]),
}));

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

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
  recordOutcomeSafe: vi.fn(async () => {}),
}));

import { generateDailyDigest, classifyRegime } from "../daily-digest";
import type { DigestInputData } from "@shared/types";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { computeSafetyScoresSnapshot } from "../../lib/safety-scores";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { postDigestTweet } from "../../lib/twitter";
import { postDigestToTelegram } from "../../lib/telegram";
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
      // PSI precedent: last time score was at/below current
      {
        match: "FROM stability_index WHERE score <= ?",
        rows: [],
        first: { computed_at: todayTs - 30 * 86_400, score: 89.0, band: "STEADY" },
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
    expect(getInsertDigestBinds(db as MockD1Database)).toBeDefined();
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
