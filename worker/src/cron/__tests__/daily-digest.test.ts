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
}));

import { generateDailyDigest } from "../daily-digest";
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
  const yesterdayTs = todayTs - 86_400;
  const weekAgoTs = todayTs - 7 * 86_400;

  return [
    {
      match: "SELECT generated_at, digest_text FROM daily_digest ORDER BY generated_at DESC LIMIT 1",
      rows: [],
      first: null,
    },
    {
      match: "SELECT digest_title, digest_text, digest_extended FROM daily_digest ORDER BY generated_at DESC LIMIT 5",
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
      ok: true,
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
      mode: "full-grades",
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
      { timeoutMs: 60_000 },
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
