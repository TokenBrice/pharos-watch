import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { mockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";

import { mockCircuitBreaker, mockRegistry } from "../../test-helpers/cron";
import type { CronProgressUpdate } from "../../lib/cron-logger";


vi.mock("@shared/lib/stablecoins/registry", () => {
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
      tradedContracts: [{ chain: "optimism", address: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071", decimals: 6 }],
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
      contracts: [{ chain: "ethereum", address: "0x45804880De22913dAFE09f4980848ECE6EcbAf78", decimals: 18 }],
    },
    {
      id: "xaut-tether",
      symbol: "XAUT",
      flags: { yieldBearing: false },
      contracts: [{ chain: "ethereum", address: "0x68749665FF8D2d112Fa859AA293F07A622782F38", decimals: 6 }],
    },
  ];
  // The digest's core aggregate universe is deliberately narrower than the
  // fixture registry: PAXG/XAUT stay tracked (mint-burn reads their contracts)
  // but are excluded from the id sets the aggregate iterates.
  const ids = new Set(["usdt-tether", "usdc-circle"]);
  return {
    ...mockRegistry({ stablecoins }),
    TRACKED_IDS: ids,
    ACTIVE_IDS: ids,
    FROZEN_IDS: new Set<string>(["usr-resolv"]),
  };
});

vi.mock("../../lib/stablecoins-cache", () => ({
  loadStablecoinsCache: vi.fn(),
}));

vi.mock("../../lib/safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: vi.fn(),
}));

vi.mock("../../lib/flight-to-quality-classification", () => ({
  buildFlightToQualityClassificationFromV9Snapshot: vi.fn(() => ({
    kind: "ok",
    classification: {
      safeIds: new Set(["usdt-tether", "usdc-circle"]),
      riskyIds: new Set(["paxg-paxos", "xaut-tether"]),
      safetyScoreIdentity: null,
    },
  })),
}));

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../../lib/twitter", () => ({
  postDigestTweet: vi.fn(),
}));

vi.mock("../../lib/digest-safety-map", async (importOriginal) => {
  const { mockDigestSafetyMapModule } = await import("./daily-digest.test-support");
  return mockDigestSafetyMapModule(await importOriginal<typeof import("../../lib/digest-safety-map")>());
});

vi.mock("../../lib/telegram-digest-appendices", () => ({
  prepareTelegramDigestAppendices: vi.fn(),
}));

vi.mock("../../lib/telegram-digest-outbox", () => ({
  enqueueTelegramDigestEdition: vi.fn(),
  deliverTelegramDigestEdition: vi.fn(),
}));

vi.mock("../telegram-digest-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telegram-digest-transport")>();
  return {
    ...actual,
    runTelegramDigestDeliveryWithPermit: vi.fn(async (params: {
    creds: unknown;
    deliver: (creds: unknown) => Promise<{ status: string }>;
  }) => {
    if (!params.creds) return "no-creds";
    try {
      return (await params.deliver(params.creds)).status;
    } catch (error) {
      return `failed: ${String(error).slice(0, 100)}`;
    }
    }),
  };
});

vi.mock("../../lib/circuit-breaker", () => mockCircuitBreaker());

import { generateDailyDigest } from "../daily-digest";

import { ANTHROPIC_TIMEOUT_MS, CIRCUIT_SOURCE, DIGEST_MODEL } from "../../lib/constants";



import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import {
  loadActiveSafetyScoreSource,
} from "../../lib/safety-score-active-source";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { postDigestTweet } from "../../lib/twitter";
import { resolveDigestSafetyMap } from "../../lib/digest-safety-map";
import { prepareTelegramDigestAppendices } from "../../lib/telegram-digest-appendices";
import { deliverTelegramDigestEdition, enqueueTelegramDigestEdition } from "../../lib/telegram-digest-outbox";
import { runTelegramDigestDeliveryWithPermit } from "../telegram-digest-transport";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import {
  canonicalSafetySource,
  makePublishedDewsTables,
  PUBLISHED_GAUGE_SCORE,
  publishedGaugeTable,
  type TestDewsRow,
} from "./daily-digest.test-support";



const VALID_DAILY_EXTENDED = [
  "PSI held at 91.2 BEDROCK with severity 2 and breadth 1, so the headline market still looks calm. USDT sat 150 bps off peg on a $100M float in the fixture, which gives the model a real candidate but not a systemic alarm. The point is selection, not volume.",
  "USDT added $5M over the week while USDC lost $2M, a mixed flow pattern rather than a single-direction stampede. The candidate list marks the depeg by impact first, then leaves supply as supporting context, which is the behavior this test expects. A smaller signal can still appear without becoming the lead.",
  "Safety scores stayed A for USDT and USDC, leaving the daily note with a dry but restrained read. Nothing in the fixture should force panic, but the digest still has enough numbers to produce a publishable editorial paragraph set today. Next session will decide whether the USDT deviation widens; if it crosses 200 bps, the impact score moves the depeg from supporting context to lead.",
].join("\n\n");

const ANTHROPIC_OK_TEXT = JSON.stringify({
  title: "Calm Drift",
  extended: VALID_DAILY_EXTENDED,
  text: "USDT's fixture depeg outranked supply noise while PSI stayed at 91.2 BEDROCK.",
  meta: {
    leadSignalId: "depeg:usdt-tether:active",
    lead: "depeg",
    tone: "dry",
    coins: ["USDT", "USDC"],
    usedCandidateIds: ["depeg:usdt-tether:active"],
  },
});

const VALID_MAP_SUMMARY = {
  date: "2026-03-06",
  asOfSec: 1_772_796_000,
  methodologyVersion: "v9.1",
  gradedCount: 318,
  notRatedCount: 7,
  totalMcapUsd: 100_000_000_000,
  floorMcapByTier: { a: 4_700_000_000, other: 2_400_000_000 },
  tiers: [
    { tier: "A" as const, range: "80-100", count: 13, mcapUsd: 81_800_000_000, sharePct: 81.8, leaders: [] },
    { tier: "B" as const, range: "60-79", count: 41, mcapUsd: 7_000_000_000, sharePct: 7, leaders: [] },
    { tier: "C" as const, range: "40-59", count: 133, mcapUsd: 3_000_000_000, sharePct: 3, leaders: [] },
    { tier: "D" as const, range: "20-39", count: 75, mcapUsd: 5_000_000_000, sharePct: 5, leaders: [] },
    { tier: "F" as const, range: "0-19", count: 56, mcapUsd: 3_200_000_000, sharePct: 3.2, leaders: [] },
  ],
};

const VALID_MAP_TWEET_HOOK = "Of 100B USD in mapped supply, A tier’s 13 coins hold 81.8%; C/D/F’s 264 hold 11.2%. Find yours on today’s map.";
const VALID_MAP_TELEGRAM_APPENDIX = [
  "<b>Today’s map</b>",
  "Mapped supply: $100B across 318 coins",
  "A tier: 13 coins · 81.8%",
  "C/D/F tiers: 264 coins · 11.2%",
].join("\n");

const SAFETY_FREE_ANTHROPIC_TEXT = ANTHROPIC_OK_TEXT.replace(
  "Safety scores stayed A for USDT and USDC, leaving the daily note with a dry but restrained read.",
  "Capital stayed concentrated in USDT and USDC, leaving the daily note with a dry but restrained read.",
);

const ANTHROPIC_SOFT_WARNING_TEXT = JSON.stringify({
  title: "Drift",
  extended: VALID_DAILY_EXTENDED,
  text: "USDT's fixture depeg led the queue while PSI stayed at 91.2 BEDROCK.",
  meta: {
    leadSignalId: "depeg:usdt-tether:active",
    lead: "depeg",
    tone: "dry",
    coins: ["USDT", "USDC"],
    usedCandidateIds: ["depeg:usdt-tether:active"],
  },
});

/**
 * Build a canonical Anthropic SSE streaming Response body for `text` as a
 * single text-delta. Matches what Anthropic actually emits when we set
 * `stream: true` on the /v1/messages call. Used to mock fetchWithRetry
 * responses in tests, since the production path now calls
 * `accumulateAnthropicStream` on the response body rather than `response.json()`.
 */
function mockAnthropicStreamResponse(text: string): Response {
  const events: Array<{ event: string; data: unknown }> = [
    {
      event: "message_start",
      data: { type: "message_start", message: { id: "msg_test", role: "assistant", content: [] } },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  const encoded = events.map((ev) => `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`).join("");
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(encoded));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const commitTelegramAppendices = vi.fn(async () => undefined);

function makeBaseTables(
  options: {
    dewsRows?: TestDewsRow[];
    stabilityIndexCount?: number;
  } = {},
): MockTableConfig[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % 86_400);
  const weekAgoTs = todayTs - 7 * 86_400;
  const dewsRows = options.dewsRows ?? [
    {
      stablecoin_id: "usdt-tether",
      score: 8,
      band: "CALM",
      signals_json: '{"supply":{"value":5,"available":true}}',
      computed_at: nowSec - 600,
    },
    {
      stablecoin_id: "usdc-circle",
      score: 12,
      band: "CALM",
      signals_json: '{"pool":{"value":10,"available":true}}',
      computed_at: nowSec - 600,
    },
  ];
  return [
    ...makePublishedDewsTables(dewsRows),
    {
      match: "SELECT generated_at, digest_text FROM daily_digest ORDER BY generated_at DESC LIMIT 1",
      rows: [],
      first: null,
    },
    {
      match:
        "SELECT digest_title, digest_text, digest_extended, digest_meta FROM daily_digest ORDER BY generated_at DESC LIMIT 5",
      rows: [],
    },
    {
      match: "SELECT digest_title, digest_text, digest_extended, digest_meta, input_data\n       FROM daily_digest",
      rows: [],
    },
    {
      match: "SELECT digest_meta FROM daily_digest",
      rows: [],
    },
    {
      match: "SELECT digest_title FROM daily_digest",
      rows: [],
    },
    { match: "SELECT generated_at, input_data FROM daily_digest\n         WHERE generated_at", rows: [] },
    { match: "SELECT MIN(generated_at) as oldest FROM daily_digest", rows: [], first: null },
    {
      match: "as ath_date\n         FROM daily_digest\n         WHERE (",
      rows: [],
      first: null,
    },
    {
      match: "SELECT COUNT(*) as cnt FROM stability_index",
      rows: [],
      first: { cnt: options.stabilityIndexCount ?? 1 },
    },
    {
      match: "SELECT score, band, components, computed_at as stored_at FROM stability_index",
      rows: [],
      first: {
        score: 89.5,
        band: "STEADY",
        components: JSON.stringify({ severity: 2, breadth: 1, trend: 0, stressBreadth: 0 }),
        stored_at: todayTs,
      },
    },
    {
      match: "SELECT stablecoin_id, symbol, current_apy, apy_7d, apy_30d, warning_signals",
      rows: [],
    },
    {
      match: "SELECT h.stablecoin_id, h.liquidity_score, h.total_tvl_usd, h.snapshot_date",
      rows: [],
    },
    { match: "SELECT circulating_usd AS ath_mcap, snapshot_date FROM supply_history", rows: [], first: null },
    { match: "SELECT stablecoin_id, score, band FROM stress_signal_history", rows: [] },
    { match: "GROUP BY recorded_at HAVING COUNT(*) > 15", rows: [] },
    { match: "SELECT history_id, stablecoin_id, recorded_at, model, identity_schema_version", rows: [] },
    { match: "INSERT INTO daily_digest", rows: [] },
    { match: "INSERT OR IGNORE INTO cache", rows: [] },
    { match: "UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?", rows: [] },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "DELETE FROM cache", rows: [] },
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [],
      first: null,
    },
    {
      match: "SELECT COUNT(*) as cnt FROM daily_digest WHERE",
      rows: [{ cnt: 1 }],
      first: { cnt: 1 },
    },
    {
      match: "FROM depeg_events WHERE ended_at IS NULL",
      rows: [
        {
          stablecoin_id: "usdt-tether",
          symbol: "USDT",
          direction: "below",
          peak_deviation_bps: 150,
          started_at: nowSec - 3600,
        },
      ],
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
      match: "SELECT score, band, components, computed_at as stored_at FROM stability_index",
      rows: [],
      first: {
        score: 89.5,
        band: "STEADY",
        components: JSON.stringify({ severity: 2, breadth: 1, trend: 0, stressBreadth: 0 }),
        stored_at: todayTs,
      },
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
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["report_card_cache"],
      rows: [],
      first: {
        value: JSON.stringify({
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          scores: {
            "usdt-tether": { score: 80, grade: "A" },
            "usdc-circle": { score: 78, grade: "A" },
            "paxg-paxos": { score: 45, grade: "D" },
            "xaut-tether": { score: 48, grade: "D" },
          },
          updatedAt: nowSec,
        }),
        updated_at: nowSec,
      },
    },
  ];
}

function getInsertDigestBinds(db: MockD1Database): unknown[] | undefined {
  return db.getHistory().find((entry) => entry.sql.includes("INSERT INTO daily_digest"))?.binds;
}

describe("generateDailyDigest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));

    vi.mocked(loadStablecoinsCache)
      .mockReset()
      .mockResolvedValue({
        kind: "ok",
        payload: {
          peggedAssets: [
            makeAsset({
              id: "usdt-tether",
              symbol: "USDT",
              price: 0.985,
              circulating: { peggedUSD: 100_000_000 },
              circulatingPrevWeek: { peggedUSD: 95_000_000 },
            }),
            makeAsset({
              id: "usdc-circle",
              symbol: "USDC",
              circulating: { peggedUSD: 60_000_000 },
              circulatingPrevWeek: { peggedUSD: 62_000_000 },
            }),
            makeAsset({
              id: "susds-sky",
              symbol: "sUSDS",
              circulating: { peggedUSD: 1_000_000_000 },
              circulatingPrevWeek: { peggedUSD: 900_000_000 },
            }),
            makeAsset({
              id: "acred-apollo-securitize",
              symbol: "ACRED",
              circulating: { peggedUSD: 500_000_000 },
              circulatingPrevWeek: { peggedUSD: 450_000_000 },
            }),
          ],
        },
        updatedAt: Math.floor(Date.now() / 1000),
      });

    vi.mocked(loadActiveSafetyScoreSource)
      .mockReset()
      .mockResolvedValue(
        canonicalSafetySource([
          {
            id: "usdt-tether",
            symbol: "USDT",
            isDefunct: false,
            overallGrade: "A",
            overallScore: 88,
            rawInputs: { navToken: false, pegScore: 95 },
            dimensions: { liquidity: { score: 90 } },
          },
          {
            id: "usdc-circle",
            symbol: "USDC",
            isDefunct: false,
            overallGrade: "A",
            overallScore: 85,
            rawInputs: { navToken: false, pegScore: 93 },
            dimensions: { liquidity: { score: 87 } },
          },
        ]),
      );

    vi.mocked(fetchWithRetry)
      .mockReset()
      .mockImplementation(async () => mockAnthropicStreamResponse(ANTHROPIC_OK_TEXT));

    vi.mocked(postDigestTweet).mockReset().mockResolvedValue({ tweetId: "1", mediaAttached: true, mediaError: null });
    vi.mocked(enqueueTelegramDigestEdition)
      .mockReset()
      .mockResolvedValue({
        created: true,
        payloadMatched: true,
        editionKey: "daily:2026-03-06",
        state: "pending",
        chunks: ["stored daily payload"],
      });
    vi.mocked(deliverTelegramDigestEdition).mockReset().mockResolvedValue({
      editionKey: "daily:2026-03-06",
      state: "sent",
      outcome: "sent",
      chunksSent: 1,
      nextChunkIndex: 1,
      chunkCount: 1,
      errorClass: null,
      retryAfterSec: null,
    });
    commitTelegramAppendices.mockReset().mockResolvedValue(undefined);
    vi.mocked(prepareTelegramDigestAppendices)
      .mockReset()
      .mockResolvedValue({
        appendixHtml: null,
        metadata: {
          hasAppendix: false,
          cemeteryDetected: 0,
          trackedDetected: 0,
          preLaunchDetected: 0,
          cemeterySymbols: [],
          trackedSymbols: [],
          preLaunchSymbols: [],
          frozenDetected: 0,
          frozenSymbols: [],
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
    vi.mocked(resolveDigestSafetyMap).mockResolvedValueOnce({
      kind: "available",
      imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-03-06",
      manifest: {
        date: "2026-03-06",
        asOfSec: 1_772_796_000,
        renderedAtSec: 1_772_798_400,
        edition: "daily",
        bytes: { png: 1_000_000 },
        mapSummary: VALID_MAP_SUMMARY,
      },
    });
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
    expect(insertBinds?.[1]).toBe("USDT's fixture depeg outranked supply noise while PSI stayed at 91.2 BEDROCK.");
    expect(insertBinds?.[2]).toBe("Calm Drift");

    const storedInput = JSON.parse(String(insertBinds?.[3])) as {
      aggregateUniverse?: string;
      totalMcapUsd: number;
      activeDepegCount: number;
      topDepegs: Array<{ symbol: string; bps: number }>;
      editorialCandidates?: unknown[];
      riskTape?: unknown[];
      nextTriggers?: unknown[];
      calmNarrativeFrame?: { label: string };
      editorialAudit?: { leadCandidateId?: string | null; usedCandidateIds?: string[] };
    };
    expect(storedInput.totalMcapUsd).toBe(160_000_000);
    expect(storedInput.aggregateUniverse).toBe("core-stablecoins-v1");
    expect(storedInput.activeDepegCount).toBe(1);
    expect(storedInput.topDepegs[0]).toMatchObject({ symbol: "USDT", bps: -150, mcapUsd: 100_000_000 });
    expect(storedInput.editorialCandidates?.length).toBeGreaterThan(0);
    expect(storedInput.riskTape?.length).toBeGreaterThan(0);
    expect(storedInput.nextTriggers?.length).toBeGreaterThan(0);
    expect(storedInput.calmNarrativeFrame?.label).toBeTruthy();
    expect(storedInput.editorialAudit?.leadCandidateId).toBe("depeg:usdt-tether:active");
    expect(storedInput.editorialAudit?.usedCandidateIds).toEqual(["depeg:usdt-tether:active"]);

    expect(postDigestTweet).toHaveBeenCalledTimes(1);
    expect(postDigestTweet).toHaveBeenCalledWith(
      "Calm Drift",
      "USDT's fixture depeg outranked supply noise while PSI stayed at 91.2 BEDROCK.",
      expect.any(Object),
      expect.any(Number),
      "https://pharos.watch/safety-scores/map.png?date=2026-03-06",
      VALID_MAP_TWEET_HOOK,
    );
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1);
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-03-06",
        mapAppendixHtml: VALID_MAP_TELEGRAM_APPENDIX,
      }),
      undefined,
    );
    expect(runTelegramDigestDeliveryWithPermit).toHaveBeenCalledWith(expect.objectContaining({
      db,
      owner: "daily-digest",
      editionKey: "daily:2026-03-06",
    }));
    expect(deliverTelegramDigestEdition).toHaveBeenCalledTimes(1);
    expect(commitTelegramAppendices).toHaveBeenCalledTimes(0);
    expect(fetchWithRetry).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-api-key": "anthropic-key" }),
      }),
      // Digest-specific retry cap + per-attempt timeout. The outer
      // AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS) caps total wall time; these
      // inner values bound individual attempts so a stalled retry cannot
      // consume the whole budget.
      2,
      { timeoutMs: 11 * 60_000 },
    );
    const anthropicBody = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      model: string;
      max_tokens: number;
      thinking?: { type: string };
      output_config?: { effort: string };
      system: string;
      messages: { content: string }[];
      stream?: boolean;
    };
    expect(anthropicBody.model).toBe(DIGEST_MODEL);
    expect(anthropicBody.thinking).toEqual({ type: "adaptive" });
    expect(anthropicBody.output_config).toEqual({ effort: "xhigh" });
    expect(anthropicBody.max_tokens).toBe(64000);
    // Streaming keeps the CF subrequest alive while Opus 4.7 thinks for minutes.
    expect(anthropicBody.stream).toBe(true);
    expect(anthropicBody.messages[0].content).toContain("Data quality notes:");
    expect(anthropicBody.messages[0].content).toContain("Editorial Candidates");
    expect(anthropicBody.messages[0].content).toContain("Risk Tape");
    expect(anthropicBody.messages[0].content).toContain("Deterministic Next Triggers");
    expect(anthropicBody.messages[0].content).toContain("Calm Narrative Frame");

    const systemPrompt = anthropicBody.system;
    expect(systemPrompt).toContain("Do NOT reuse any of the following house-style tics");
    expect(systemPrompt).toContain("plumbing");
    expect(systemPrompt).toContain("forward-look");
    expect(systemPrompt).toContain("Earn one sharp sentence");
    expect(systemPrompt).toContain("EXEMPLAR");
    expect(systemPrompt).toContain("Momentum Candidate");
    expect(systemPrompt).toContain("total-mcap ATH");
    expect(systemPrompt).toContain("CALM-DAY STORYTELLING");

    const userPrompt = anthropicBody.messages[0].content;
    expect(userPrompt).not.toContain("Distribution: median");
    expect(userPrompt).not.toMatch(/\d+ above B/);
  });

  it("keeps soft-only digest quality issues out of cron degraded status", async () => {
    vi.mocked(fetchWithRetry).mockImplementation(async () => mockAnthropicStreamResponse(ANTHROPIC_SOFT_WARNING_TEXT));
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
    expect(result.status).toBeUndefined();
    expect(result.metadata).toContain("quality: title-word-count:soft");
    // Soft-only issues no longer trigger the corrective retry (hard-only policy).
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(postDigestTweet).toHaveBeenCalledTimes(1);
    expect(deliverTelegramDigestEdition).toHaveBeenCalledTimes(1);
  });

  it("reports digest preflight and skipped progress when Anthropic is not configured", async () => {
    const db = mockD1(makeBaseTables());
    const progressUpdates: CronProgressUpdate[] = [];
    const reportProgress = vi.fn(async (update: CronProgressUpdate) => {
      progressUpdates.push(update);
    });

    const result = await generateDailyDigest(db, null, null, false, null, undefined, reportProgress);

    expect(result.metadata).toBe("skipped: no API key");
    expect(progressUpdates.find((update) => update.stage === "preflight")).toMatchObject({
      metadata: {
        providerFamily: "digest",
        phase: "preflight",
        countTotals: {
          forceRun: 0,
          configuredDeliveryChannels: 0,
        },
      },
    });
    expect(progressUpdates.find((update) => update.stage === "skipped")).toMatchObject({
      metadata: {
        providerFamily: "anthropic",
        phase: "skipped",
        skipped: "missing-api-key",
      },
    });
  });

  it("repairs malformed code-block JSON with one corrective retry", async () => {
    const malformed = '```json\n{"title":"Broken", "text":\n```';
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(mockAnthropicStreamResponse(malformed));

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key");

    expect(result.itemCount).toBe(1);
    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    expect(insertBinds?.[1]).toBe("USDT's fixture depeg outranked supply noise while PSI stayed at 91.2 BEDROCK.");
    expect(insertBinds?.[2]).toBe("Calm Drift");
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[daily-digest] Failed to parse digest model response"),
    );
  });

  it("skips the corrective retry when first-pass elapsed exceeds 50% of the Anthropic budget", async () => {
    const malformed = '```json\n{"title":"Broken", "text":\n```';
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const CORRECTIVE_RETRY_THRESHOLD_MS = ANTHROPIC_TIMEOUT_MS * 0.5;

    // Mock the first-pass fetch to advance fake time past 50% of the outer
    // Anthropic budget before returning a response that would otherwise
    // trigger a corrective retry via the raw-text-fallback quality issue.
    vi.mocked(fetchWithRetry).mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(Date.now() + CORRECTIVE_RETRY_THRESHOLD_MS + 30_000));
      return mockAnthropicStreamResponse(malformed);
    });

    const db = mockD1(makeBaseTables());
    await generateDailyDigest(db, "anthropic-key");

    // Only one Anthropic call — the corrective retry is skipped because
    // elapsed >= 50% of the budget, leaving no safe headroom for a second call.
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("skipping corrective retry"));
    warnSpy.mockRestore();
  });

  it("includes bounded Anthropic error body text when generation fails before streaming", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response("anthropic overloaded", { status: 529 }));
    const db = mockD1(makeBaseTables());

    await expect(generateDailyDigest(db, "anthropic-key")).rejects.toThrow(
      "Claude API error 529: anthropic overloaded",
    );

    expect(recordOutcomeSafe).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.ANTHROPIC, false);
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

  it("skips generation cleanly when the Anthropic circuit is open", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key");

    expect(result).toEqual({ status: "degraded", itemCount: 0, metadata: "skipped: anthropic circuit open" });
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();
    expect(getInsertDigestBinds(db as MockD1Database)).toBeUndefined();
  });

  it("omits safety inputs and blocks unbound safety claims when the canonical identity is unavailable", async () => {
    vi.mocked(loadActiveSafetyScoreSource).mockResolvedValueOnce({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      detail: "identity mismatch",
      snapshot: null,
    });

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key");

    expect(result.status).toBe("degraded");
    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    const storedInput = JSON.parse(String(insertBinds?.[3])) as {
      safetyScores?: unknown;
      safetyContext?: { status: string; expectedModel: string; reason: string };
      editorialAudit?: { qualityIssueCodes?: string[] };
    };
    expect(storedInput.safetyScores).toBeUndefined();
    expect(storedInput.safetyContext).toMatchObject({
      status: "unavailable",
      expectedModel: "v9",
      reason: "v9-snapshot-unavailable",
    });
    expect(JSON.parse(String(insertBinds?.[5]))).toMatchObject({ qualityGate: "blocked" });
    expect(storedInput.editorialAudit).toMatchObject({
      qualityIssueCodes: expect.arrayContaining(["unbound-safety-copy"]),
    });
    expect(result.metadata).toContain("unbound-safety-copy");
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
    expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();
  });

  it("blocks the edition and both channels when the model leads with a suppressed candidate", async () => {
    // Edition #179's regression test at the outermost seam: a suppressed
    // liquidity signal reached X and Telegram because suppression was advisory.
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);
    const yesterdayTs = todayTs - 86_400;
    const suppressedLeadText = JSON.stringify({
      title: "Pool Drains, Score Shrugs",
      extended: VALID_DAILY_EXTENDED,
      text: "USDC's measured DEX depth thinned while the composite score barely moved.",
      meta: {
        leadSignalId: "liquidity:usdc",
        lead: "liquidity",
        tone: "dry",
        coins: ["USDC"],
        usedCandidateIds: ["liquidity:usdc"],
      },
    });
    vi.mocked(fetchWithRetry)
      .mockResolvedValueOnce(mockAnthropicStreamResponse(suppressedLeadText))
      .mockResolvedValueOnce(mockAnthropicStreamResponse(suppressedLeadText));

    const db = mockD1([
      {
        match: "FROM dex_liquidity_history",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            liquidity_score: 60,
            total_tvl_usd: 80_000,
            snapshot_date: yesterdayTs,
            coverage_class: "primary",
            coverage_confidence: 0.9,
            methodology_version: "6.1",
          },
          {
            stablecoin_id: "usdc-circle",
            liquidity_score: 70,
            total_tvl_usd: 90_000,
            snapshot_date: yesterdayTs - 86_400,
            coverage_class: "primary",
            coverage_confidence: 0.9,
            methodology_version: "6.1",
          },
        ],
      },
      ...makeBaseTables(),
    ]);
    const result = await generateDailyDigest(db, "anthropic-key");

    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    expect(JSON.parse(String(insertBinds?.[5]))).toMatchObject({ qualityGate: "blocked" });
    expect(result.metadata).toContain("suppressed-lead");
    expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
    expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();
  });

  it("repairs unbound daily copy during the standard corrective retry", async () => {
    vi.mocked(loadActiveSafetyScoreSource).mockResolvedValueOnce({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      detail: "identity mismatch",
      snapshot: null,
    });
    const cleanResponse = JSON.parse(ANTHROPIC_OK_TEXT) as {
      title: string;
      text: string;
      extended: string;
      meta: Record<string, unknown>;
    };
    cleanResponse.extended = VALID_DAILY_EXTENDED.replace(
      "Safety scores stayed A for USDT and USDC, ",
      "The fixture's primary risk inputs were unchanged, ",
    );
    vi.mocked(fetchWithRetry)
      .mockResolvedValueOnce(mockAnthropicStreamResponse(ANTHROPIC_OK_TEXT))
      .mockResolvedValueOnce(mockAnthropicStreamResponse(JSON.stringify(cleanResponse)));

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key");

    expect(result.itemCount).toBe(1);
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(result.metadata).not.toContain("unbound-safety-copy");
    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    expect(JSON.parse(String(insertBinds?.[5]))).not.toMatchObject({ qualityGate: "blocked" });
    const firstRequest = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(firstRequest.messages[0]?.content).toContain("Editorial omission:");
    expect(firstRequest.messages[0]?.content).not.toContain("Safety source unavailable");
  });

  it("publishes only canonical V9 grades, pillars, reasons, caps, and full identity", async () => {
    const cap = {
      kind: "redemption-access",
      limit: 82,
      source: "structural" as const,
      reason: "Primary redemption remains eligibility-gated",
      binding: true,
    };
    const backing = {
      score: 91,
      evidenceLevel: "strong" as const,
      freshness: "current" as const,
      components: ["reserves"],
      reasons: [{
        code: "bounded-mechanism-review" as const,
        message: "Reviewed reserve reporting is current",
        path: "pillars.backing",
      }],
    };
    const card = makeWorkerV9Card({
      id: "usdt-tether",
      grade: "A+",
      score: 88,
      pillars: {
        backing,
        exit: { ...backing, score: 86, components: ["liquidity"] },
        control: { ...backing, score: 84, components: ["governance"] },
      },
      caps: [cap],
      bindingCap: cap,
      reasonCodes: ["bounded-mechanism-review"],
    });
    const snapshot = makeWorkerReportCardsV9Response({ cards: [card] });
    vi.mocked(loadActiveSafetyScoreSource).mockResolvedValueOnce({
      kind: "v9",
      snapshot,
    });

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key");

    expect(result.itemCount).toBe(1);
    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    const storedInput = JSON.parse(String(insertBinds?.[3]));
    expect(storedInput.safetyContext).toMatchObject({
      status: "available",
      expectedModel: "v9",
      identity: snapshot.safetyScoreIdentity,
    });
    expect(storedInput.safetyScores).toMatchObject({
      model: "v9",
      provenance: {
        ...snapshot.safetyScoreIdentity,
        publishedAt: snapshot.updatedAt,
      },
      mentionedCoins: [{
        symbol: "USDT",
        grade: "A+",
        score: 88,
        pillars: {
          backing: { score: 91 },
          exit: { score: 86 },
          control: { score: 84 },
        },
        reasonCodes: ["bounded-mechanism-review"],
        bindingCap: {
          kind: "redemption-access",
          limit: 82,
        },
      }],
    });
    expect(storedInput.safetyScores.medianGrade).toBeUndefined();
    const body = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[0].content).toContain("Safety Scores (V9");
    expect(body.messages[0].content).toContain("backing=91, exit=86, control=84");
    expect(body.messages[0].content).not.toContain("peg=95");
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

  it("re-bins the published Bank Run Gauge into the stored input", async () => {
    const db = mockD1([
      ...makeBaseTables(),
      publishedGaugeTable(),
    ]);

    const result = await generateDailyDigest(db, "anthropic-key");
    expect(result.itemCount).toBe(1);

    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    const storedInput = JSON.parse(String(insertBinds?.[3]));
    // Verbatim re-bin of the published composite: the digest must not recompute
    // a gauge of its own (WS0.1 — one gauge, one universe, one mcap basis).
    expect(storedInput.mintBurnFlows.gaugeScore).toBe(PUBLISHED_GAUGE_SCORE);
    expect(storedInput.mintBurnFlows.gaugeBand).toBe("HEALTHY");
    expect(storedInput.mintBurnFlows.flightToQuality).toEqual({
      active: false,
      // PAXG is outside the digest's core aggregate universe but inside the
      // published gauge universe, so its net flow now reaches the FTQ split.
      safeNetUsd: 150_000_000,
      riskyNetUsd: -3_000_000,
    });
    expect(storedInput.mintBurnFlows.topPressure.map((row: { symbol: string }) => row.symbol)).toEqual([
      "USDT",
      "USDC",
    ]);
    // One canonical loader serves both the digest collectors and the FTQ
    // classifier, so the suite's healthy source classifies here. The
    // fail-closed FTQ arms are covered by
    // daily-digest/__tests__/mint-burn-ftq.test.ts.
    expect(storedInput.mintBurnFlows.classificationSource).toBe("safety-score-v9-publication");
    expect(storedInput.mintBurnFlows.classificationReason).toBeNull();
    expect(storedInput.mintBurnFlows.topChains).toEqual([
      { chainId: "ethereum", netUsd: 150_000_000 },
      { chainId: "arbitrum", netUsd: -3_000_000 },
    ]);

    // The digest no longer touches mint_burn_hourly at all.
    expect(
      (db as MockD1Database).getHistory().some((entry) => entry.sql.includes("mint_burn_hourly")),
    ).toBe(false);

    const body = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[0].content).toContain("Top chains by net flow");
  });

  it("includes DEWS stress data with band changes in stored input", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const dewsRows = [
      {
        stablecoin_id: "usdt-tether",
        score: 8,
        band: "CALM",
        signals_json: '{"supply":{"value":5,"available":true}}',
        computed_at: nowSec - 600,
      },
      {
        stablecoin_id: "usdc-circle",
        score: 62,
        band: "ALERT",
        signals_json: '{"pool":{"value":70,"available":true},"liq":{"value":50,"available":true}}',
        computed_at: nowSec - 600,
      },
    ];
    const baseTables = makeBaseTables({ dewsRows });
    const db = mockD1([
      // Yesterday's snapshot
      {
        match: "FROM stress_signal_history WHERE snapshot_date = ?",
        rows: [
          { stablecoin_id: "usdt-tether", score: 10, band: "CALM" },
          { stablecoin_id: "usdc-circle", score: 30, band: "WATCH" },
        ],
      },
      ...baseTables,
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

  it("marks the digest degraded when persisted DEWS signals JSON is malformed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowSec = Math.floor(Date.now() / 1000);

    const dewsRows = [
      {
        stablecoin_id: "usdt-tether",
        score: 8,
        band: "CALM",
        signals_json: '{"supply":{"value":5,"available":true}}',
        computed_at: nowSec - 600,
      },
      {
        stablecoin_id: "usdc-circle",
        score: 62,
        band: "ALERT",
        signals_json: '{"pool":',
        computed_at: nowSec - 600,
      },
    ];
    const baseTables = makeBaseTables({ dewsRows });
    const db = mockD1([
      {
        match: "FROM stress_signal_history WHERE snapshot_date = ?",
        rows: [
          { stablecoin_id: "usdt-tether", score: 10, band: "CALM" },
          { stablecoin_id: "usdc-circle", score: 30, band: "WATCH" },
        ],
      },
      ...baseTables,
    ]);

    try {
      const result = await generateDailyDigest(db, "anthropic-key");

      expect(result.itemCount).toBe(1);
      expect(result.status).toBe("degraded");
      expect(result.metadata).toContain("dews-stress-signals-json");

      const insertBinds = getInsertDigestBinds(db as MockD1Database);
      const storedInput = JSON.parse(String(insertBinds?.[3])) as { degradedSources?: string[] };
      expect(storedInput.degradedSources).toContain("dews-stress-signals-json");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("includes historical context with PSI precedent and band streak", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);

    const baseTables = makeBaseTables({ stabilityIndexCount: 90 });
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

  it("includes V2 organic grade transitions and canonical safety provenance", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);

    const db = mockD1([
      // Organic V2 methodology bump check (no bumps)
      {
        match: "GROUP BY recorded_at HAVING COUNT(*) > 15",
        rows: [],
      },
      // Organic V2 grade transitions in last 48h
      {
        match: "ORDER BY ABS(COALESCE(score, 0) - COALESCE(prev_score, 0)) DESC",
        rows: [
          {
            history_id: "safety-score-history:v2:test",
            stablecoin_id: "usdt-tether",
            recorded_at: todayTs,
            model: "v9",
            identity_schema_version: 1,
            methodology_version: "9.0",
            policy_id: "safety-score-v9",
            policy_digest: "a".repeat(64),
            evaluation_build_digest: "b".repeat(64),
            base_input_generation_id: `report-cards-input:v1:${"b".repeat(64)}`,
            model_publication_generation_id: "report-cards:v9:1",
            transition_kind: "organic-grade-change",
            grade: "A-",
            score: 80,
            prev_grade: "A",
            prev_score: 85,
          },
        ],
      },
      ...makeBaseTables(),
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
    expect(storedInput.safetyScores.provenance).toMatchObject({
      model: "v9",
      methodologyVersion: "9.0",
      publicationGenerationId: "report-cards:v9:1",
    });
    expect((db as MockD1Database).getHistory().some((entry) => entry.sql.includes("safety_grade_history"))).toBe(false);
  });

  it("parses meta field from Claude response and stores in digest_meta", async () => {
    const responseWithMeta = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "Alert Watch",
            extended: VALID_DAILY_EXTENDED,
            text: "FRAX hit ALERT while PSI slid to 88, the first STEADY reading in 47 days.",
            meta: { lead: "dews-band-change", tone: "foreboding", coins: ["FRAX"] },
          }),
        },
      ],
    };

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(mockAnthropicStreamResponse(responseWithMeta.content[0].text));

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

  it("marks the digest degraded and stores collector degradation when active depeg loading fails", async () => {
    const db = mockD1([
      ...makeBaseTables().map((table) =>
        table.match === "FROM depeg_events WHERE ended_at IS NULL"
          ? { ...table, throwError: new Error("d1 unavailable") }
          : table,
      ),
    ]);

    const result = await generateDailyDigest(db, "anthropic-key");

    expect(result.itemCount).toBe(1);
    expect(result.status).toBe("degraded");
    expect(result.metadata).toContain("active-depegs-query");

    const insertBinds = getInsertDigestBinds(db as MockD1Database);
    const storedInput = JSON.parse(String(insertBinds?.[3])) as {
      degradedSources?: string[];
      activeDepegCount: number;
    };
    expect(storedInput.activeDepegCount).toBe(0);
    expect(storedInput.degradedSources).toContain("active-depegs-query");
  });

  it("keeps digest persistence even when social posting fails", async () => {
    vi.mocked(postDigestTweet).mockRejectedValueOnce(new Error("twitter down"));
    vi.mocked(deliverTelegramDigestEdition).mockRejectedValueOnce(new Error("telegram down"));

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
    expect(commitTelegramAppendices).toHaveBeenCalledTimes(0);
    expect(getInsertDigestBinds(db as MockD1Database)).toBeDefined();
  });

  it("posts text-only and records degraded telemetry when the daily map is unavailable", async () => {
    vi.mocked(resolveDigestSafetyMap).mockResolvedValueOnce({
      kind: "unavailable",
      reason: "manifest-not-today",
    });
    const db = mockD1(makeBaseTables());

    const result = await generateDailyDigest(
      db,
      "anthropic-key",
      { apiKey: "x", apiSecret: "y", accessToken: "z", accessTokenSecret: "w" },
      false,
      { botToken: "tg-token", chatId: "tg-chat" },
    );

    expect(result.status).toBe("degraded");
    expect(result.metadata).toContain("safety-map-manifest-not-today");
    expect(postDigestTweet).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      expect.any(Number),
      null,
      undefined,
    );
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ imageUrl: null }),
      undefined,
    );
  });

  it("omits map prose but keeps the valid attachment when Safety Score context is unavailable", async () => {
    vi.mocked(loadActiveSafetyScoreSource).mockResolvedValueOnce({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      detail: "identity mismatch",
      snapshot: null,
    });
    vi.mocked(fetchWithRetry).mockImplementation(async () => mockAnthropicStreamResponse(SAFETY_FREE_ANTHROPIC_TEXT));
    vi.mocked(resolveDigestSafetyMap).mockResolvedValueOnce({
      kind: "available",
      imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-03-06",
      manifest: {
        date: "2026-03-06",
        asOfSec: 1_772_796_000,
        renderedAtSec: 1_772_798_400,
        edition: "daily",
        bytes: { png: 1_000_000 },
        mapSummary: VALID_MAP_SUMMARY,
      },
    });
    const db = mockD1(makeBaseTables());

    const result = await generateDailyDigest(
      db,
      "anthropic-key",
      { apiKey: "x", apiSecret: "y", accessToken: "z", accessTokenSecret: "w" },
      false,
      { botToken: "tg-token", chatId: "tg-chat" },
    );

    expect(result.status).toBe("degraded");
    expect(result.metadata).not.toContain("unbound-safety-copy");
    expect(postDigestTweet).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      expect.any(Number),
      "https://pharos.watch/safety-scores/map.png?date=2026-03-06",
      undefined,
    );
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-03-06",
        mapAppendixHtml: undefined,
        safetyContext: expect.objectContaining({ status: "unavailable" }),
      }),
      undefined,
    );
  });

  it("persists the Twitter sent marker before sending on the happy path", async () => {
    const db = mockD1(makeBaseTables());
    await generateDailyDigest(db, "anthropic-key", {
      apiKey: "x",
      apiSecret: "y",
      accessToken: "z",
      accessTokenSecret: "w",
    });

    const markerKey = "daily-digest:twitter-sent:2026-03-06";
    const history = (db as MockD1Database).getHistory();
    const markerWrites = history.filter(
      (entry) => entry.sql.includes("INSERT OR IGNORE INTO cache") && entry.binds[0] === markerKey,
    );
    const markerDeletes = history.filter(
      (entry) => entry.sql.includes("DELETE FROM cache") && entry.binds[0] === markerKey,
    );
    expect(postDigestTweet).toHaveBeenCalledTimes(1);
    expect(markerWrites).toHaveLength(1);
    expect(markerDeletes).toHaveLength(0);
  });

  it("retains an execution-unknown Twitter ledger marker when delivery may have crossed the send boundary", async () => {
    vi.mocked(postDigestTweet).mockRejectedValueOnce(new Error("twitter down"));

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key", {
      apiKey: "x",
      apiSecret: "y",
      accessToken: "z",
      accessTokenSecret: "w",
    });

    expect(result.metadata).toContain("tweet: failed:");

    const markerKey = "daily-digest:twitter-sent:2026-03-06";
    const history = (db as MockD1Database).getHistory();
    const markerWrites = history.filter(
      (entry) => entry.sql.includes("INSERT OR IGNORE INTO cache") && entry.binds[0] === markerKey,
    );
    const executionUnknownWrites = history.filter(
      (entry) => entry.sql.includes("UPDATE cache SET value")
        && entry.binds[2] === markerKey
        && String(entry.binds[0]).includes('\"state\":\"execution_unknown\"'),
    );
    expect(markerWrites).toHaveLength(1);
    expect(executionUnknownWrites).toHaveLength(1);
  });

  it("skips Twitter delivery when the same-day marker claim is already taken", async () => {
    const markerKey = "daily-digest:twitter-sent:2026-03-06";
    const db = mockD1([
      {
        match: "INSERT OR IGNORE INTO cache",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT value FROM cache WHERE key = ?",
        matchBinds: [markerKey],
        rows: [],
        first: { value: JSON.stringify({ sentAt: Math.floor(Date.now() / 1000), editionNumber: 1 }) },
      },
      ...makeBaseTables(),
    ]);

    const result = await generateDailyDigest(db, "anthropic-key", {
      apiKey: "x",
      apiSecret: "y",
      accessToken: "z",
      accessTokenSecret: "w",
    });

    expect(result.metadata).toContain("tweet: skipped: already-sent");
    expect(postDigestTweet).not.toHaveBeenCalled();
    expect((db as MockD1Database).getHistory()).toContainEqual(
      expect.objectContaining({
        sql: expect.stringContaining("INSERT OR IGNORE INTO cache"),
        binds: expect.arrayContaining([markerKey]),
      }),
    );
  });

  it("still attempts Telegram before failing hard when the Twitter marker write fails", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const twitterMarkerKey = "daily-digest:twitter-sent:2026-03-06";
    const db = mockD1([
      {
        match: "INSERT OR IGNORE INTO cache",
        matchBinds: [twitterMarkerKey, JSON.stringify({
          schemaVersion: 1,
          state: "queued",
          editionNumber: 1,
          attempts: 0,
          createdAt: nowSec,
          updatedAt: nowSec,
        }), nowSec],
        rows: [],
        throwError: new Error("twitter marker down"),
      },
      ...makeBaseTables(),
    ]);

    await expect(
      generateDailyDigest(
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
      ),
    ).rejects.toThrow("Twitter daily digest marker write failed");

    expect(postDigestTweet).not.toHaveBeenCalled();
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1);
    expect(deliverTelegramDigestEdition).toHaveBeenCalledTimes(1);
    const history = (db as MockD1Database).getHistory();
    expect(history).toContainEqual(
      expect.objectContaining({
        sql: expect.stringContaining("INSERT OR IGNORE INTO cache"),
        binds: expect.arrayContaining([twitterMarkerKey]),
      }),
    );
    expect(getInsertDigestBinds(db as MockD1Database)).toBeDefined();
  });

  it("persists the exact Telegram edition before crossing the send boundary", async () => {
    const db = mockD1(makeBaseTables());
    await generateDailyDigest(db, "anthropic-key", null, false, { botToken: "tg-token", chatId: "tg-chat" });

    expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        editionKey: "daily:2026-03-06",
        digestKind: "daily",
        digestGeneratedAt: Math.floor(Date.now() / 1000),
        targetChatId: "tg-chat",
        title: "Calm Drift",
        extended: VALID_DAILY_EXTENDED,
        date: "2026-03-06",
        editionNumber: 1,
      }),
      undefined,
    );
    expect(vi.mocked(enqueueTelegramDigestEdition).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deliverTelegramDigestEdition).mock.invocationCallOrder[0]!,
    );
  });

  it("keeps a retryable Telegram failure in the durable outbox", async () => {
    vi.mocked(deliverTelegramDigestEdition).mockResolvedValueOnce({
      editionKey: "daily:2026-03-06",
      state: "pending",
      outcome: "pending",
      chunksSent: 0,
      nextChunkIndex: 0,
      chunkCount: 1,
      errorClass: "rate_limit",
      retryAfterSec: 45,
    });

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key", null, false, {
      botToken: "tg-token",
      chatId: "tg-chat",
    });

    expect(result.metadata).toContain("telegram: failed:");
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1);
    expect(deliverTelegramDigestEdition).toHaveBeenCalledTimes(1);
  });

  it("fails hard without sending when the Telegram outbox write fails", async () => {
    vi.mocked(enqueueTelegramDigestEdition).mockRejectedValueOnce(new Error("outbox down"));
    const db = mockD1(makeBaseTables());

    await expect(
      generateDailyDigest(db, "anthropic-key", null, false, { botToken: "tg-token", chatId: "tg-chat" }),
    ).rejects.toThrow("Telegram daily digest outbox write failed");

    expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();
    expect(getInsertDigestBinds(db as MockD1Database)).toBeDefined();
  });

  it("surfaces an immutable same-edition payload mismatch as degraded", async () => {
    vi.mocked(enqueueTelegramDigestEdition).mockResolvedValueOnce({
      created: false,
      payloadMatched: false,
      editionKey: "daily:2026-03-06",
      state: "pending",
      chunks: ["previous exact edition"],
    });
    const failureSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = mockD1(makeBaseTables());

    const result = await generateDailyDigest(db, "anthropic-key", null, false, {
      botToken: "tg-token",
      chatId: "tg-chat",
    });

    expect(result.status).toBe("degraded");
    expect(result.metadata).toContain("telegram-outbox-payload-mismatch");
    expect(deliverTelegramDigestEdition).toHaveBeenCalledTimes(1);
    failureSpy.mockRestore();
  });

  it("does not degrade a forced rerun when the immutable Telegram edition is already sent", async () => {
    vi.mocked(enqueueTelegramDigestEdition).mockResolvedValueOnce({
      created: false,
      payloadMatched: false,
      editionKey: "daily:2026-03-06",
      state: "sent",
      chunks: ["previous exact edition"],
    });
    vi.mocked(deliverTelegramDigestEdition).mockResolvedValueOnce({
      editionKey: "daily:2026-03-06",
      state: "sent",
      outcome: "skipped",
      chunksSent: 0,
      nextChunkIndex: 1,
      chunkCount: 1,
      errorClass: null,
      retryAfterSec: null,
    });
    const db = mockD1(makeBaseTables());

    const result = await generateDailyDigest(db, "anthropic-key", null, true, {
      botToken: "tg-token",
      chatId: "tg-chat",
    });

    expect(result.status).toBeUndefined();
    expect(result.metadata).toContain("telegram: skipped: already-sent");
    expect(result.metadata).not.toContain("telegram-outbox-payload-mismatch");
    expect(deliverTelegramDigestEdition).toHaveBeenCalledTimes(1);
  });

  it("stores appendix copy and success actions in the immutable Telegram edition", async () => {
    const successActions = [{ key: "telegram:tracked-stablecoins-snapshot", value: '["example"]' }];
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
        frozenDetected: 0,
        frozenSymbols: [],
        seededSnapshots: [],
      },
      successActions,
      commitSuccess: commitTelegramAppendices,
    });

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key", null, false, {
      botToken: "tg-token",
      chatId: "tg-chat",
    });

    expect(result.metadata).toContain("telegram: ok+appendix(");
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        appendixHtml: "<b>Tracking Changes</b>\n\n<code>USDX</code> Example USD",
        successActions,
      }),
      undefined,
    );
    expect(commitTelegramAppendices).not.toHaveBeenCalled();
  });

  it("preserves an already-sent immutable edition without crossing the send boundary", async () => {
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
        frozenDetected: 0,
        frozenSymbols: [],
        seededSnapshots: [],
      },
      commitSuccess: commitTelegramAppendices,
    });

    vi.mocked(deliverTelegramDigestEdition).mockResolvedValueOnce({
      editionKey: "daily:2026-03-06",
      state: "sent",
      outcome: "skipped",
      chunksSent: 0,
      nextChunkIndex: 1,
      chunkCount: 1,
      errorClass: null,
      retryAfterSec: null,
    });
    const db = mockD1(makeBaseTables());

    const result = await generateDailyDigest(db, "anthropic-key", null, false, {
      botToken: "tg-token",
      chatId: "tg-chat",
    });

    expect(result.metadata).toContain("telegram: skipped: already-sent");
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1);
    expect(commitTelegramAppendices).not.toHaveBeenCalled();
  });

  it("leaves appendix success actions uncommitted when Telegram delivery remains pending", async () => {
    const successActions = [{ key: "telegram:cemetery-snapshot", value: '["terrausd"]' }];
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
        frozenDetected: 0,
        frozenSymbols: [],
        seededSnapshots: [],
      },
      successActions,
      commitSuccess: commitTelegramAppendices,
    });
    vi.mocked(deliverTelegramDigestEdition).mockResolvedValueOnce({
      editionKey: "daily:2026-03-06",
      state: "pending",
      outcome: "pending",
      chunksSent: 0,
      nextChunkIndex: 0,
      chunkCount: 1,
      errorClass: "server_error",
      retryAfterSec: null,
    });

    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key", null, false, {
      botToken: "tg-token",
      chatId: "tg-chat",
    });

    expect(result.metadata).toContain("telegram: failed:");
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ successActions }),
      undefined,
    );
    expect(commitTelegramAppendices).not.toHaveBeenCalled();
  });
});

describe("totalMcapAth enrichment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(loadStablecoinsCache).mockReset();
    vi.mocked(loadActiveSafetyScoreSource).mockReset();
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records ATH context when supplied", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);

    vi.mocked(loadStablecoinsCache).mockResolvedValue({
      kind: "ok",
      payload: {
        peggedAssets: [
          makeAsset({
            id: "usdt-tether",
            symbol: "USDT",
            circulating: { peggedUSD: 100_000_000 },
            circulatingPrevWeek: { peggedUSD: 95_000_000 },
          }),
        ],
      },
      updatedAt: nowSec,
    });
    vi.mocked(loadActiveSafetyScoreSource).mockResolvedValue(
      canonicalSafetySource([
        {
          id: "usdt-tether",
          symbol: "USDT",
          isDefunct: false,
          overallGrade: "A",
          overallScore: 88,
          rawInputs: { navToken: false, pegScore: 95 },
          dimensions: { liquidity: { score: 90 } },
        },
      ]),
    );
    vi.mocked(fetchWithRetry).mockImplementation(async () => mockAnthropicStreamResponse(ANTHROPIC_OK_TEXT));
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);

    const baseTables = makeBaseTables();
    const db = mockD1([
      {
        match: "ORDER BY CAST(json_extract(input_data, '$.totalMcapUsd') AS REAL) DESC",
        first: { ath_value: 330_000_000_000, ath_date: nowSec - 7 * 86_400 },
        rows: [],
      },
      ...baseTables,
    ]);

    const result = await generateDailyDigest(db, "anthropic-key");
    expect(result.itemCount).toBe(1);

    const storedInput = JSON.parse(String(getInsertDigestBinds(db as MockD1Database)?.[3]));
    expect(storedInput.totalMcapAth).toBeDefined();
    expect(storedInput.totalMcapAth.value).toBe(330_000_000_000);
    expect(storedInput.totalMcapAth.daysAgo).toBe(7);
    expect(storedInput.totalMcapAth.date).toBe(todayTs - 7 * 86_400);

    const body = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[0].content).toContain("its Digest-window ATH");
  });
});

describe("momentum candidates surface", () => {
  it("renders Momentum Candidates block when momentum-novelty candidates exist", async () => {
    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key");
    expect(result.itemCount).toBe(1);
    const body = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[0].content).toContain("Momentum Candidates");
  });
});
