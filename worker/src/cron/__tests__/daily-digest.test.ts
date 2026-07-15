import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { mockD1, type MockD1Database, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { mockCircuitBreaker } from "../../test-helpers/cron";
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
  const ids = new Set(["usdt-tether", "usdc-circle"]);
  return {
    TRACKED_STABLECOINS: stablecoins,
    ACTIVE_STABLECOINS: stablecoins,
    TRACKED_META_BY_ID: new Map([
      [
        "usdt-tether",
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
      ],
      [
        "usdc-circle",
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
      ],
      [
        "paxg-paxos",
        {
          id: "paxg-paxos",
          symbol: "PAXG",
          flags: { yieldBearing: false },
          contracts: [{ chain: "ethereum", address: "0x45804880De22913dAFE09f4980848ECE6EcbAf78", decimals: 18 }],
        },
      ],
      [
        "xaut-tether",
        {
          id: "xaut-tether",
          symbol: "XAUT",
          flags: { yieldBearing: false },
          contracts: [{ chain: "ethereum", address: "0x68749665FF8D2d112Fa859AA293F07A622782F38", decimals: 6 }],
        },
      ],
    ]),
    TRACKED_IDS: ids,
    ACTIVE_IDS: ids,
    FROZEN_IDS: new Set<string>(["usr-resolv"]),
    FROZEN_META_BY_ID: new Map<string, never>(),
  };
});

vi.mock("../../lib/stablecoins-cache", () => ({
  loadStablecoinsCache: vi.fn(),
}));

vi.mock("../../lib/safety-score-history-v2", () => ({
  loadActiveV8SafetyScoreHistorySource: vi.fn(),
}));

vi.mock("../../lib/flight-to-quality-classification", () => ({
  buildFlightToQualityClassification: vi.fn(() => ({
    safeIds: new Set(["usdt-tether", "usdc-circle"]),
    riskyIds: new Set(["paxg-paxos", "xaut-tether"]),
  })),
}));

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../../lib/twitter", () => ({
  postDigestTweet: vi.fn(),
}));

vi.mock("../../lib/telegram-digest-appendices", () => ({
  prepareTelegramDigestAppendices: vi.fn(),
}));

vi.mock("../../lib/telegram-digest-outbox", () => ({
  enqueueTelegramDigestEdition: vi.fn(),
  deliverTelegramDigestEdition: vi.fn(),
}));

vi.mock("../../lib/circuit-breaker", () => mockCircuitBreaker());

import { generateDailyDigest, classifyRegime } from "../daily-digest";
import { buildUserPrompt } from "../daily-digest/prompt";
import {
  parseDigestModelResponse,
  validateDigestModelOutput,
  type ParsedDigestResponse,
} from "../daily-digest/response";
import { ANTHROPIC_TIMEOUT_MS, CIRCUIT_SOURCE, DIGEST_MODEL } from "../../lib/constants";
import {
  collectPsiContributors,
  collectYieldAnomalies,
  collectLiquidityShifts,
  collectCrossDayTrends,
  collectDewsStress,
  collectActiveDepegs,
  collectSupplyVelocity,
  type CollectorContext,
} from "../daily-digest/collectors";
import { buildDigestIntelligence } from "../daily-digest/digest-intelligence";
import type { DigestInputData } from "@shared/types/digest";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import {
  loadActiveV8SafetyScoreHistorySource,
  type ActiveV8SafetyScoreHistorySource,
} from "../../lib/safety-score-history-v2";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { postDigestTweet } from "../../lib/twitter";
import { prepareTelegramDigestAppendices } from "../../lib/telegram-digest-appendices";
import { deliverTelegramDigestEdition, enqueueTelegramDigestEdition } from "../../lib/telegram-digest-outbox";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";

const DEFAULT_PARSED_EXTENDED = "T. T. T.\n\nT. T. T.\n\nT. T. T.";

function canonicalSafetySource(cards: unknown[]): ActiveV8SafetyScoreHistorySource {
  return {
    identity: {
      model: "v8" as const,
      schemaVersion: 1 as const,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      evaluationBuildDigest: "a".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
      publicationGenerationId: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:123`,
    },
    publishedAtSec: 123,
    snapshot: { cards },
  } as unknown as ActiveV8SafetyScoreHistorySource;
}

function makeParsedFixture(
  opts: {
    extended?: string;
    text?: string;
    lead?: string;
    leadSignalId?: string;
    tone?: string;
  } = {},
): ParsedDigestResponse {
  return {
    digestTitle: "T",
    digestText: opts.text ?? "T.",
    digestExtended: opts.extended ?? DEFAULT_PARSED_EXTENDED,
    digestMeta: JSON.stringify({
      ...(opts.leadSignalId ? { leadSignalId: opts.leadSignalId } : {}),
      lead: opts.lead ?? "depeg",
      tone: opts.tone ?? "dry",
      coins: ["USDT"],
    }),
    strippedDashCount: 0,
    strippedForbiddenCharCount: 0,
    usedRawTextFallback: false,
  };
}

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

interface TestDewsRow {
  stablecoin_id: string;
  score: number;
  band: string;
  signals_json: string;
  computed_at: number;
}

function makePublishedDewsTables(dewsRows: TestDewsRow[]): MockTableConfig[] {
  const computedAt = dewsRows[0]!.computed_at;
  return [
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["dews:published-generation"],
      rows: [],
      first: {
        value: JSON.stringify({
          updatedAt: computedAt,
          source: "compute-dews",
          publishStatus: "published",
          coverageVersion: 2,
          expectedRowCount: dewsRows.length,
          stablecoinIdsDigest: buildDewsStablecoinIdsDigest(dewsRows.map((row) => row.stablecoin_id)),
        }),
        updated_at: computedAt,
      },
    },
    {
      match: "pharos:stress-signals:published-exact",
      rows: dewsRows.map((row) => ({ ...row })),
    },
  ];
}

function makeBaseTables(
  options: {
    dewsRows?: TestDewsRow[];
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

    vi.mocked(loadActiveV8SafetyScoreHistorySource)
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

    vi.mocked(postDigestTweet).mockReset().mockResolvedValue(undefined);
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
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1);
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
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
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

  it("omits safety summary output when the canonical snapshot identity is unavailable", async () => {
    vi.mocked(loadActiveV8SafetyScoreHistorySource).mockRejectedValueOnce(new Error("identity mismatch"));

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
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            mint_24h: 500_000_000,
            burn_24h: 300_000_000,
            net_24h: 200_000_000,
          },
          {
            stablecoin_id: "usdc-circle",
            chain_id: "ethereum",
            mint_24h: 100_000_000,
            burn_24h: 150_000_000,
            net_24h: -50_000_000,
          },
        ],
      },
      // 30d baseline — match on "/ 30.0" which is unique to this query
      {
        match: "/ 30.0",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            avg_daily_net: 50_000_000,
            avg_daily_abs: 200_000_000,
            data_days: 30,
          },
          {
            stablecoin_id: "usdc-circle",
            chain_id: "ethereum",
            avg_daily_net: -10_000_000,
            avg_daily_abs: 80_000_000,
            data_days: 25,
          },
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
    expect(storedInput.mintBurnFlows.classificationSource).toBe("unavailable");
    expect(storedInput.mintBurnFlows.classificationReason).toBe("identity-missing");
    expect(storedInput.mintBurnFlows.safetyScoreIdentity).toBeNull();
    expect(storedInput.degradedSources).toContain("mint-burn-ftq:identity-missing");
    expect(storedInput.mintBurnFlows.topChains).toBeDefined();
    expect(Array.isArray(storedInput.mintBurnFlows.topChains)).toBe(true);
    expect(storedInput.mintBurnFlows.topChains.length).toBeLessThanOrEqual(3);
    expect(storedInput.mintBurnFlows.topChains.length).toBeGreaterThan(0);
    expect(storedInput.mintBurnFlows.topChains[0]).toMatchObject({
      chainId: expect.any(String),
      netUsd: expect.any(Number),
    });

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
      ...baseTables,
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
      ...baseTables,
      {
        match: "FROM stress_signal_history WHERE snapshot_date = ?",
        rows: [
          { stablecoin_id: "usdt-tether", score: 10, band: "CALM" },
          { stablecoin_id: "usdc-circle", score: 30, band: "WATCH" },
        ],
      },
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

  it("includes V2 organic grade transitions and canonical safety provenance", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);

    const baseTables = makeBaseTables();
    const db = mockD1([
      ...baseTables,
      // Organic V2 methodology bump check (no bumps)
      {
        match: "GROUP BY recorded_at HAVING COUNT(*) > 15",
        rows: [],
      },
      // Organic V2 grade transitions in last 48h
      {
        match: "ORDER BY ABS(score - prev_score) DESC",
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
    expect(storedInput.safetyScores.provenance).toMatchObject({
      model: "v8",
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      publicationGenerationId: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:123`,
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

  it("rolls back the Twitter sent marker when delivery fails so the next run can resend", async () => {
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
    const markerDeletes = history.filter(
      (entry) => entry.sql.includes("DELETE FROM cache") && entry.binds[0] === markerKey,
    );
    expect(markerWrites).toHaveLength(1);
    expect(markerDeletes).toHaveLength(1);
  });

  it("skips Twitter delivery when the same-day marker claim is already taken", async () => {
    const markerKey = "daily-digest:twitter-sent:2026-03-06";
    const db = mockD1([
      {
        match: "INSERT OR IGNORE INTO cache",
        rows: [],
        runMeta: { changes: 0 },
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
        matchBinds: [twitterMarkerKey, JSON.stringify({ sentAt: nowSec, editionNumber: 1 }), nowSec],
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

describe("parseDigestModelResponse meta normalization", () => {
  function parseLeadTone(leadValue: string, toneValue: string): { lead?: string; tone?: string } {
    const raw = JSON.stringify({
      title: "T",
      text: "T.",
      extended: "T. T. T.\n\nT. T. T.\n\nT. T. T.",
      meta: { lead: leadValue, tone: toneValue, coins: ["USDT"] },
    });
    const parsed = parseDigestModelResponse(raw);
    const meta = parsed.digestMeta ? (JSON.parse(parsed.digestMeta) as Record<string, string>) : {};
    return { lead: meta.lead, tone: meta.tone };
  }

  it("retains observed natural lead tokens", () => {
    expect(parseLeadTone("gauge-flip", "dry").lead).toBe("gauge-flip");
    expect(parseLeadTone("psi-band-change", "dry").lead).toBe("psi-band-change");
    expect(parseLeadTone("issuer-concentration", "dry").lead).toBe("issuer-concentration");
    expect(parseLeadTone("regime-divergence", "dry").lead).toBe("regime-divergence");
    expect(parseLeadTone("chain-migration", "dry").lead).toBe("chain-migration");
    expect(parseLeadTone("reserve-event", "dry").lead).toBe("reserve-event");
  });

  it("retains observed natural tones", () => {
    expect(parseLeadTone("depeg", "sardonic").tone).toBe("sardonic");
    expect(parseLeadTone("depeg", "observant").tone).toBe("observant");
    expect(parseLeadTone("depeg", "forensic").tone).toBe("forensic");
  });

  it("collapses garbage to 'other'", () => {
    expect(parseLeadTone("asdfghjkl", "dry").lead).toBe("other");
    expect(parseLeadTone("depeg", "asdfghjkl").tone).toBe("other");
  });
});

describe("lead family variety check", () => {
  function validateWith(currentLead: string, recentLeads: string[]) {
    const parsed: ParsedDigestResponse = {
      digestTitle: "T",
      digestText: "T.",
      digestExtended: "T. T. T.\n\nT. T. T.\n\nT. T. T.",
      digestMeta: JSON.stringify({ lead: currentLead, tone: "dry", coins: ["USDT"] }),
      strippedDashCount: 0,
      strippedForbiddenCharCount: 0,
      usedRawTextFallback: false,
    };
    const recentMeta = recentLeads.map((l) => ({
      meta: { lead: l, tone: "dry" } as Record<string, unknown>,
      title: "x",
    }));
    return validateDigestModelOutput(parsed, { kind: "daily", recentMeta });
  }

  it("fires repeated-lead-family when family repeats 2 of last 3", () => {
    const issues = validateWith("psi-streak", ["psi-regime", "psi-band-change", "supply-reversal"]);
    expect(issues.some((i) => i.code === "repeated-lead-family")).toBe(true);
  });

  it("does not fire when lead families differ", () => {
    const issues = validateWith("psi-streak", ["depeg", "grade-transition", "ftq"]);
    expect(issues.some((i) => i.code === "repeated-lead-family")).toBe(false);
  });
});

describe("forward-look voice guard", () => {
  it("flags missing forward-look when digest is purely retrospective", () => {
    const issues = validateDigestModelOutput(
      makeParsedFixture({
        extended: "USDT added $2B.\n\nUSDC pulled $500M.\n\nThe gap is now the story.",
        text: "USDT added $2B while USDC pulled $500M.",
      }),
      { kind: "daily", recentMeta: [] },
    );
    expect(issues.some((i) => i.code === "missing-forward-look")).toBe(true);
  });

  it("does not flag when forward-look is present in extended", () => {
    const issues = validateDigestModelOutput(
      makeParsedFixture({
        extended: "USDT added $2B.\n\nUSDC pulled $500M.\n\nIf the gap holds next week, it is a rotation.",
      }),
      { kind: "daily", recentMeta: [] },
    );
    expect(issues.some((i) => i.code === "missing-forward-look")).toBe(false);
  });

  it("does not flag when forward-look is only in the text hook", () => {
    const issues = validateDigestModelOutput(
      makeParsedFixture({ extended: "A.\n\nB.\n\nC.", text: "Watch if USDT crosses $185B." }),
      { kind: "daily", recentMeta: [] },
    );
    expect(issues.some((i) => i.code === "missing-forward-look")).toBe(false);
  });
});

describe("lead requirement validator", () => {
  it("hard-fails when a required critical candidate is not the declared lead", () => {
    const issues = validateDigestModelOutput(
      makeParsedFixture({
        leadSignalId: "market:usdc-circle:weekly-supply",
        extended:
          "PMUSD stayed 5284 bps below peg on $65M.\n\nUSDC added $2B.\n\nIf PMUSD holds there next session, the peg stress remains the lead.",
      }),
      {
        kind: "daily",
        recentMeta: [],
        leadRequirements: [
          {
            candidateIds: ["depeg:pmusd-active"],
            severity: "hard",
            mentionTokens: ["PMUSD"],
            reason: "PMUSD critical depeg must lead",
          },
        ],
      },
    );

    expect(issues.some((issue) => issue.code === "lead-candidate-mismatch" && issue.severity === "hard")).toBe(true);
  });

  it("hard-fails when a required critical candidate is omitted from the copy", () => {
    const issues = validateDigestModelOutput(
      makeParsedFixture({
        leadSignalId: "depeg:pmusd-active",
        extended:
          "USDC added $2B.\n\nUSDT held steady.\n\nIf the flow reverses next session, the supply story changes.",
      }),
      {
        kind: "daily",
        recentMeta: [],
        leadRequirements: [
          {
            candidateIds: ["depeg:pmusd-active"],
            severity: "hard",
            mentionTokens: ["PMUSD"],
            reason: "PMUSD critical depeg must lead",
          },
        ],
      },
    );

    expect(issues.some((issue) => issue.code === "required-lead-missing" && issue.severity === "hard")).toBe(true);
  });
});

describe("opening-fingerprint voice guard", () => {
  it("flags PSI-verb opening when any of last 3 also opened that way", () => {
    const recent = [
      { meta: null, title: "a", rawText: "PSI sits at 95. USDC hit ATH." },
      { meta: null, title: "b", rawText: "USDT minted $2B. PSI unchanged." },
      { meta: null, title: "c", rawText: "Flows rotated into gold. USDC weak." },
    ];
    const parsed = makeParsedFixture({ extended: "PSI ticked to 96 in BEDROCK.\n\nUSDC added $500M.\n\nReal closer." });
    const issues = validateDigestModelOutput(parsed, { kind: "daily", recentMeta: recent });
    expect(issues.some((i) => i.code === "opening-pattern-repetition")).toBe(true);
  });

  it("does not flag when opening is structurally different", () => {
    const recent = [
      { meta: null, title: "a", rawText: "PSI sits at 95." },
      { meta: null, title: "b", rawText: "PSI slipped to 93." },
    ];
    const parsed = makeParsedFixture({
      extended: "USDT just added $2B overnight.\n\nPSI drifted to 93.\n\nReal closer.",
    });
    const issues = validateDigestModelOutput(parsed, { kind: "daily", recentMeta: recent });
    expect(issues.some((i) => i.code === "opening-pattern-repetition")).toBe(false);
  });
});

describe("forbidden-tic voice guard", () => {
  it("flags plumbing metaphor anywhere in extended", () => {
    const issues = validateDigestModelOutput(
      makeParsedFixture({ extended: "PSI held.\n\nThe plumbing flinched again.\n\nDone." }),
      { kind: "daily", recentMeta: [] },
    );
    expect(issues.some((i) => i.code === "forbidden-tic")).toBe(true);
  });

  it("flags 'worth watching' in closer position", () => {
    const issues = validateDigestModelOutput(
      makeParsedFixture({ extended: "Line one.\n\nLine two.\n\nLine three, worth monitoring into next week." }),
      { kind: "daily", recentMeta: [] },
    );
    expect(issues.some((i) => i.code === "forbidden-tic")).toBe(true);
  });

  it("does NOT flag 'worth watching' mid-paragraph when last sentence is different", () => {
    const issues = validateDigestModelOutput(
      makeParsedFixture({
        extended:
          "A coin worth watching for mcap drift, plus five others. Real closer sentence here.\n\nLine two.\n\nLine three.",
      }),
      { kind: "daily", recentMeta: [] },
    );
    expect(issues.some((i) => i.code === "forbidden-tic")).toBe(false);
  });

  it("does not flag prose free of tics", () => {
    const issues = validateDigestModelOutput(
      makeParsedFixture({ extended: "USDT added $3B.\n\nUSDC pulled $200M.\n\nThe gap is now the story." }),
      { kind: "daily", recentMeta: [] },
    );
    expect(issues.some((i) => i.code === "forbidden-tic")).toBe(false);
  });
});

describe("tone cluster validator", () => {
  it("fires tone-cluster when same tone appears 3+ times in last 5", () => {
    const recent = Array.from({ length: 5 }, () => ({
      meta: { lead: "depeg", tone: "foreboding" } as Record<string, unknown>,
      title: "prior",
    }));
    const result = validateDigestModelOutput(makeParsedFixture({ tone: "foreboding" }), {
      kind: "daily",
      recentMeta: recent,
    });
    expect(result.some((i) => i.code === "tone-cluster")).toBe(true);
  });

  it("does not fire when spread across tones", () => {
    const recent = [
      { meta: { tone: "dry" } as Record<string, unknown>, title: "a" },
      { meta: { tone: "sardonic" } as Record<string, unknown>, title: "b" },
      { meta: { tone: "foreboding" } as Record<string, unknown>, title: "c" },
      { meta: { tone: "clinical" } as Record<string, unknown>, title: "d" },
      { meta: { tone: "wistful" } as Record<string, unknown>, title: "e" },
    ];
    const result = validateDigestModelOutput(makeParsedFixture({ tone: "foreboding" }), {
      kind: "daily",
      recentMeta: recent,
    });
    expect(result.some((i) => i.code === "tone-cluster")).toBe(false);
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

describe("digest intelligence enrichment", () => {
  const current: DigestInputData = {
    totalMcapUsd: 160_000_000,
    mcap7dDelta: 3_000_000,
    activeDepegCount: 1,
    topDepegs: [{ stablecoinId: "usdt-tether", symbol: "USDT", bps: -175, direction: "below", mcapUsd: 100_000_000 }],
    biggestSupplyChange: {
      id: "usdc-circle",
      symbol: "USDC",
      name: "USD Coin",
      changeUsd: 40_000_000,
      currentMcap: 60_000_000,
    },
    stabilityIndex: { score: 88, band: "STEADY", components: { severity: 4, breadth: 2, trend: -1 } },
    yesterdayIndex: { score: 90, band: "BEDROCK" },
    supplyVelocity: [{ coin: "USDC", change1d: 12_000_000, change7d: 40_000_000, signal: "accelerating" }],
    editorialCandidates: [
      {
        id: "depeg:usdt-tether:active",
        kind: "depeg",
        title: "USDT active 175 bps below peg",
        symbols: ["USDT"],
        impactScore: 17.5,
        novelty: "worsening",
        confidence: "high",
        artifactRisk: "low",
        headlineFacts: ["175 bps below peg", "$100M market cap"],
        whyItMatters: "Active peg stress is reader-relevant.",
      },
      {
        id: "supply:usdc:accelerating",
        kind: "supply",
        title: "USDC supply accelerating",
        symbols: ["USDC"],
        impactScore: 12,
        novelty: "accelerating",
        confidence: "high",
        artifactRisk: "low",
        headlineFacts: ["+$12M in 1d"],
        whyItMatters: "Supply velocity shows allocation.",
      },
    ],
  };

  it("builds risk tape, next triggers, changes, and prior-trigger outcomes", () => {
    const previous: DigestInputData = {
      ...current,
      dataQuality: {
        generatedAt: 1_772_668_800,
        stablecoinsCacheUpdatedAt: null,
        stablecoinsCacheAgeSec: null,
        windows: current.dataQuality?.windows ?? {
          blacklistActivity: { label: "x", start: 0, end: 0 },
          mintBurnFlows: { label: "x", start: 0, end: 0 },
          supplyVelocity: { label: "x", dates: [] },
          psi: { label: "x", sampleAt: null, dailySnapshotAt: null },
        },
      },
      topDepegs: [{ stablecoinId: "usdt-tether", symbol: "USDT", bps: -100, direction: "below", mcapUsd: 100_000_000 }],
      stabilityIndex: { score: 91, band: "BEDROCK", components: { severity: 2, breadth: 1, trend: 0 } },
      nextTriggers: [
        {
          id: "trigger:depeg:usdt",
          label: "USDT depeg widening",
          metric: "depeg-bps",
          comparator: "abs-gte",
          thresholdValue: 125,
          thresholdLabel: "125 bps off peg",
          symbol: "USDT",
          rationale: "A wider deviation raises severity.",
          detail: "If USDT reaches 125 bps off peg, severity rises.",
        },
      ],
    };

    const intelligence = buildDigestIntelligence(current, previous);

    expect(intelligence.riskTape?.some((item) => item.id === "risk-tape:depegs")).toBe(true);
    expect(intelligence.nextTriggers?.[0]).toMatchObject({ metric: "depeg-bps", symbol: "USDT" });
    expect(intelligence.changeSummary?.worsenedSignals[0]).toMatchObject({ label: "USDT depeg widened" });
    expect(intelligence.forwardLookOutcomes?.[0]).toMatchObject({ status: "hit", triggerId: "trigger:depeg:usdt" });
    expect(intelligence.calmNarrativeFrame?.label).toBe("Supply rotation");
  });

  it("keeps unavailable flight-to-quality classification explicit in prompt and risk tape", () => {
    const data: DigestInputData = {
      ...current,
      mintBurnFlows: {
        gaugeScore: 0,
        gaugeBand: "NEUTRAL",
        classificationSource: "unavailable",
        classificationReason: "identity-missing",
        safetyScoreIdentity: null,
        flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 },
        topPressure: [],
      },
    };

    const prompt = buildUserPrompt(data);
    const gauge = buildDigestIntelligence(data, null).riskTape?.find((item) => item.id === "risk-tape:gauge");

    expect(prompt).toContain("Flight-to-Quality: unavailable (identity-missing)");
    expect(prompt).not.toContain("Flight-to-Quality: inactive");
    expect(gauge).toMatchObject({
      detail: "Flight-to-quality classification unavailable (identity-missing).",
    });
  });

  it("evaluates a supply-7d trigger against the coin's weekly change when no velocity signal is emitted", () => {
    const previous: DigestInputData = {
      ...current,
      dataQuality: {
        generatedAt: 1_772_668_800,
        stablecoinsCacheUpdatedAt: null,
        stablecoinsCacheAgeSec: null,
        windows: current.dataQuality?.windows ?? {
          blacklistActivity: { label: "x", start: 0, end: 0 },
          mintBurnFlows: { label: "x", start: 0, end: 0 },
          supplyVelocity: { label: "x", dates: [] },
          psi: { label: "x", sampleAt: null, dailySnapshotAt: null },
        },
      },
      nextTriggers: [
        {
          id: "trigger:supply-7d:usdc",
          label: "USDC weekly supply move",
          metric: "supply-7d-usd",
          comparator: "abs-gte",
          thresholdValue: 30_000_000,
          thresholdLabel: "$30M 7d move",
          symbol: "USDC",
          rationale: "The largest weekly mover stays useful only if the move keeps scaling.",
          detail: "If USDC's 7d supply move clears $30M, the story has follow-through.",
        },
      ],
    };
    const today: DigestInputData = {
      ...current,
      supplyVelocity: [],
      supplyChanges7d: [{ coin: "USDC", change7d: 40_000_000 }],
    };

    const intelligence = buildDigestIntelligence(today, previous);

    expect(intelligence.forwardLookOutcomes?.[0]).toMatchObject({
      status: "hit",
      triggerId: "trigger:supply-7d:usdc",
    });
  });

  it("evaluates a supply-7d trigger against the coin's own velocity even when a different coin is the biggest weekly mover", () => {
    const previous: DigestInputData = {
      ...current,
      dataQuality: {
        generatedAt: 1_772_668_800,
        stablecoinsCacheUpdatedAt: null,
        stablecoinsCacheAgeSec: null,
        windows: current.dataQuality?.windows ?? {
          blacklistActivity: { label: "x", start: 0, end: 0 },
          mintBurnFlows: { label: "x", start: 0, end: 0 },
          supplyVelocity: { label: "x", dates: [] },
          psi: { label: "x", sampleAt: null, dailySnapshotAt: null },
        },
      },
      nextTriggers: [
        {
          id: "trigger:supply-7d:usdc",
          label: "USDC weekly supply move",
          metric: "supply-7d-usd",
          comparator: "abs-gte",
          thresholdValue: 30_000_000,
          thresholdLabel: "$30M 7d move",
          symbol: "USDC",
          rationale: "The largest weekly mover stays useful only if the move keeps scaling.",
          detail: "If USDC's 7d supply move clears $30M, the story has follow-through.",
        },
      ],
    };
    // Current day: USDT is now the biggest weekly mover, but USDC still moved $40M over 7d.
    const today: DigestInputData = {
      ...current,
      biggestSupplyChange: {
        id: "usdt-tether",
        symbol: "USDT",
        name: "Tether",
        changeUsd: 90_000_000,
        currentMcap: 100_000_000,
      },
    };

    const intelligence = buildDigestIntelligence(today, previous);

    expect(intelligence.forwardLookOutcomes?.[0]).toMatchObject({
      status: "hit",
      triggerId: "trigger:supply-7d:usdc",
    });
  });
});

describe("totalMcapAth enrichment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(loadStablecoinsCache).mockReset();
    vi.mocked(loadActiveV8SafetyScoreHistorySource).mockReset();
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
    vi.mocked(loadActiveV8SafetyScoreHistorySource).mockResolvedValue(
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
      ...baseTables,
      {
        match: "ORDER BY CAST(json_extract(input_data, '$.totalMcapUsd') AS REAL) DESC",
        first: { ath_value: 330_000_000_000, ath_date: nowSec - 7 * 86_400 },
        rows: [],
      },
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
    expect(
      classifyRegime({
        ...baseData,
        mintBurnFlows: {
          gaugeScore: -20,
          gaugeBand: "CAUTIOUS",
          flightToQuality: { active: true, safeNetUsd: 200_000_000, riskyNetUsd: -200_000_000 },
          topPressure: [],
        },
      }),
    ).toBe("CRISIS");
  });

  it("returns CRISIS when PSI band is TREMOR", () => {
    expect(
      classifyRegime({
        ...baseData,
        stabilityIndex: { score: 65, band: "TREMOR", components: { severity: 30, breadth: 5, trend: -3 } },
      }),
    ).toBe("CRISIS");
  });

  it("returns TENSION when ALERT+ coins have material mcap", () => {
    expect(
      classifyRegime({
        ...baseData,
        dewsStress: {
          bandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 },
          yesterdayBandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 },
          bandChanges: [],
          elevatedCoins: [{ symbol: "USDT", band: "ALERT", score: 50, mcapUsd: 2_000_000_000 }],
        },
      }),
    ).toBe("TENSION");
  });

  it("returns WATCHFUL when 1 unsuppressed active depeg is present", () => {
    expect(
      classifyRegime({
        ...baseData,
        activeDepegCount: 1,
        topDepegs: [{ symbol: "USDT", bps: 5, mcapUsd: 100_000_000_000 }],
      }),
    ).toBe("WATCHFUL");
  });
});

// ---------------------------------------------------------------------------
// Collector unit tests
// ---------------------------------------------------------------------------

function makeCollectorCtx(db: D1Database): CollectorContext {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % 86_400);
  const yesterdayTs = todayTs - 86_400;

  const trackedStablecoinAssets = [
    makeAsset({
      id: "usdt-tether",
      symbol: "USDT",
      price: 0.9975,
      circulating: { peggedUSD: 100_000_000_000 },
      circulatingPrevWeek: { peggedUSD: 95_000_000_000 },
    }),
    makeAsset({
      id: "usdc-circle",
      symbol: "USDC",
      price: 0.99,
      circulating: { peggedUSD: 50_000_000_000 },
      circulatingPrevWeek: { peggedUSD: 52_000_000_000 },
    }),
    makeAsset({
      id: "dai-makerdao",
      symbol: "DAI",
      price: 1.05,
      circulating: { peggedUSD: 5_000_000 },
      circulatingPrevWeek: { peggedUSD: 5_000_000 },
    }),
  ];
  const stablecoinAssetById = new Map(trackedStablecoinAssets.map((asset) => [asset.id, asset]));

  const mcapById = new Map<string, number>([
    ["usdt-tether", 100_000_000_000],
    ["usdc-circle", 50_000_000_000],
    ["dai-makerdao", 5_000_000],
  ]);

  return {
    db: db as unknown as D1Database,
    trackedStablecoinAssets,
    trackedStablecoinIds: new Set(trackedStablecoinAssets.map((asset) => asset.id)),
    coreAggregateStablecoinAssets: trackedStablecoinAssets,
    coreAggregateStablecoinIds: new Set(trackedStablecoinAssets.map((asset) => asset.id)),
    stablecoinAssetById,
    mcapById,
    nowSec,
    todayTs,
    yesterdayTs,
  };
}

describe("collectActiveDepegs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sorts active depegs by absolute market impact and marks small chronic noise", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "dai-makerdao",
            symbol: "DAI",
            direction: "above",
            peak_deviation_bps: 500,
            started_at: nowSec - 8 * 86_400,
          },
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: -100,
            started_at: nowSec - 3600,
          },
        ],
      },
    ]);

    const result = await collectActiveDepegs(makeCollectorCtx(db));

    expect(result.value.topDepegs[0]).toMatchObject({
      symbol: "USDC",
      bps: -100,
      direction: "below",
    });
    expect(result.value.topDepegs[1].suppressReason).toContain("sub-$20M");
  });

  it("keeps critical live depegs unsuppressed and returns more than three prompt candidates", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "dai-makerdao",
            symbol: "DAI",
            direction: "above",
            peak_deviation_bps: 500,
            started_at: nowSec - 8 * 86_400,
          },
          {
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            direction: "below",
            peak_deviation_bps: -25,
            started_at: nowSec - 3600,
          },
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: -5200,
            started_at: nowSec - 10 * 86_400,
          },
          {
            stablecoin_id: "dai-makerdao",
            symbol: "DAI2",
            direction: "above",
            peak_deviation_bps: 150,
            started_at: nowSec - 3600,
          },
        ],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    ctx.stablecoinAssetById.set("usdc-circle", { ...ctx.stablecoinAssetById.get("usdc-circle")!, price: 0.48 });
    ctx.stablecoinAssetById.set("usdt-tether", { ...ctx.stablecoinAssetById.get("usdt-tether")!, price: 0.97 });

    const result = await collectActiveDepegs(ctx);

    expect(result.value.topDepegs).toHaveLength(4);
    expect(result.value.topDepegs[0]).toMatchObject({
      symbol: "USDC",
      bps: -5200,
    });
    expect(result.value.topDepegs[0].suppressReason).toBeUndefined();
  });

  it("keeps the open event peak as authoritative while showing cache price as context", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -5568,
            peak_price: 0.443,
            peg_reference: 1,
            started_at: nowSec - 3600,
          },
        ],
      },
    ]);

    const result = await collectActiveDepegs(makeCollectorCtx(db));

    expect(result.value.activeDepegCount).toBe(1);
    expect(result.value.topDepegs[0]).toMatchObject({
      symbol: "USDC",
      bps: -5568,
      peakBps: -5568,
      currentPriceUsd: 0.99,
      peakPriceUsd: 0.443,
    });
  });

  it("reports monitored variant depegs without adding variants to monetary aggregates", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "susds-sky",
            symbol: "sUSDS",
            direction: "below",
            peak_deviation_bps: -125,
            started_at: nowSec - 3600,
          },
        ],
      },
    ]);
    const ctx = makeCollectorCtx(db);
    const variant = makeAsset({
      id: "susds-sky",
      symbol: "sUSDS",
      circulating: { peggedUSD: 1_000_000_000 },
    });
    ctx.trackedStablecoinAssets.push(variant);
    (ctx.trackedStablecoinIds as Set<string>).add(variant.id);
    ctx.stablecoinAssetById.set(variant.id, variant);
    ctx.mcapById.set(variant.id, 1_000_000_000);

    const result = await collectActiveDepegs(ctx);

    expect(ctx.coreAggregateStablecoinIds.has(variant.id)).toBe(false);
    expect(result.value.activeDepegCount).toBe(1);
    expect(result.value.topDepegs[0]).toMatchObject({ stablecoinId: "susds-sky", symbol: "sUSDS" });
  });

  it("filters frozen coins out of digest active depeg candidates", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usr-resolv",
            symbol: "USR",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -9025,
            peak_price: 0.0975,
            peg_reference: 1,
            started_at: nowSec - 3600,
          },
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -100,
            peak_price: 0.99,
            peg_reference: 1,
            started_at: nowSec - 3600,
          },
        ],
      },
    ]);

    const result = await collectActiveDepegs(makeCollectorCtx(db));

    expect(result.value.activeDepegCount).toBe(1);
    expect(result.value.topDepegs).toHaveLength(1);
    expect(result.value.topDepegs[0]).toMatchObject({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
    });
    expect(result.value.topDepegs.some((depeg) => depeg.stablecoinId === "usr-resolv")).toBe(false);
  });

  it("keeps an open depeg event even when the cache price appears recovered", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -500,
            peak_price: 0.95,
            peg_reference: 1,
            started_at: nowSec - 3600,
          },
        ],
      },
    ]);

    const result = await collectActiveDepegs(makeCollectorCtx(db));

    expect(result.value.activeDepegCount).toBe(1);
    expect(result.value.topDepegs[0]).toMatchObject({
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      bps: -500,
      direction: "below",
      peakBps: -500,
      peakPriceUsd: 0.95,
      currentPriceUsd: 0.9975,
    });
  });
});

describe("collectSupplyVelocity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits decelerating when a material weekly trend slows sharply", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayTs = nowSec - (nowSec % 86_400);
    const yesterdayTs = todayTs - 86_400;
    const weekAgoTs = todayTs - 7 * 86_400;
    const db = mockD1([
      {
        match: "FROM supply_history WHERE stablecoin_id IN",
        rows: [
          { stablecoin_id: "usdt-tether", snapshot_date: todayTs, circulating_usd: 101_400_000_000 },
          { stablecoin_id: "usdt-tether", snapshot_date: yesterdayTs, circulating_usd: 101_350_000_000 },
          { stablecoin_id: "usdt-tether", snapshot_date: weekAgoTs, circulating_usd: 100_000_000_000 },
        ],
      },
    ]);

    const result = await collectSupplyVelocity(makeCollectorCtx(db));

    expect(result.value).toEqual([expect.objectContaining({ coin: "USDT", signal: "decelerating" })]);
  });
});

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
    const yieldSql = db.getHistory().find((entry) => entry.sql.includes("FROM yield_data"))?.sql;
    expect(yieldSql).toContain("publication_generation_id IS NULL OR publication_state = 'published'");
  });

  it("excludes staged and failed yield anomalies behaviorally", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE yield_data (
          stablecoin_id TEXT NOT NULL,
          symbol TEXT NOT NULL,
          is_best INTEGER NOT NULL,
          current_apy REAL NOT NULL,
          apy_7d REAL NOT NULL,
          apy_30d REAL NOT NULL,
          warning_signals TEXT,
          publication_generation_id TEXT,
          publication_state TEXT
        );
      `);
      const insertYield = sqlite.prepare(
        `INSERT INTO yield_data (
          stablecoin_id, symbol, is_best, current_apy, apy_7d, apy_30d,
          warning_signals, publication_generation_id, publication_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertYield.run("usdt-tether", "USDT", 1, 12, 5, 4, JSON.stringify(["spike"]), "gen-failed", "failed");
      insertYield.run("dai-makerdao", "DAI", 1, 11, 4, 3, JSON.stringify(["spike"]), "gen-staged", "staged");
      insertYield.run(
        "usdc-circle",
        "USDC",
        1,
        5.1,
        4.9,
        4.5,
        JSON.stringify(["tvl-outflow"]),
        "gen-published",
        "published",
      );

      const result = await collectYieldAnomalies(makeCollectorCtx(createSqliteD1(sqlite)));

      expect(result?.map((row) => row.symbol)).toEqual(["USDC"]);
    } finally {
      sqlite.close();
    }
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
          ? {
              mintBurnFlows: {
                gaugeScore,
                gaugeBand: "STABLE",
                flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 },
                topPressure: [],
              },
            }
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
        mintBurnFlows:
          daysAgo === 0
            ? {
                gaugeScore: -5,
                gaugeBand: "STABLE",
                flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 },
                topPressure: [],
              }
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
              totalMcapUsd: 200e9,
              mcap7dDelta: 0,
              activeDepegCount: 0,
              topDepegs: [],
              biggestSupplyChange: null,
              stabilityIndex: null,
              yesterdayIndex: null,
            }),
          },
          {
            generated_at: nowSec - 2 * 86_400,
            input_data: JSON.stringify({
              totalMcapUsd: 199e9,
              mcap7dDelta: 0,
              activeDepegCount: 0,
              topDepegs: [],
              biggestSupplyChange: null,
              stabilityIndex: null,
              yesterdayIndex: null,
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

  it("marks the collector degraded instead of using a partial staged generation", async () => {
    const computedAt = Math.floor(Date.now() / 1000) - 600;
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [],
        first: {
          value: JSON.stringify({
            updatedAt: computedAt,
            source: "compute-dews",
            publishStatus: "published",
            coverageVersion: 2,
            expectedRowCount: 2,
            stablecoinIdsDigest: buildDewsStablecoinIdsDigest(["usdc-circle", "usdt-tether"]),
          }),
          updated_at: computedAt,
        },
      },
      {
        match: "pharos:stress-signals:published-exact",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            score: 65,
            band: "ALERT",
            signals_json: "{}",
            computed_at: computedAt,
          },
        ],
      },
    ]);
    const degradedReasons: string[] = [];

    const result = await collectDewsStress(makeCollectorCtx(db), degradedReasons);

    expect(result).toBeUndefined();
    expect(degradedReasons).toContain("dews-published-generation");
  });

  it("returns topSignals on elevated coins when signals_json is provided", async () => {
    const computedAt = Math.floor(Date.now() / 1000) - 600;
    const dewsRows: TestDewsRow[] = [
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
        computed_at: computedAt,
      },
    ];
    const db = mockD1([
      ...makePublishedDewsTables(dewsRows),
      {
        match: "FROM stress_signal_history WHERE snapshot_date = ?",
        rows: [{ stablecoin_id: "usdt-tether", score: 25, band: "WATCH" }],
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
    const computedAt = Math.floor(Date.now() / 1000) - 600;
    const dewsRows: TestDewsRow[] = [
      {
        stablecoin_id: "usdt-tether",
        score: 65,
        band: "ALERT",
        signals_json: "{}",
        computed_at: computedAt,
      },
    ];
    const db = mockD1([
      ...makePublishedDewsTables(dewsRows),
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

  it("unwraps the v5.95 wrapped { signals, amplifiers } shape for elevatedCoins and bandChanges", async () => {
    const wrappedJson = JSON.stringify({
      signals: {
        supply: { value: 30, available: true },
        pool: { value: 80, available: true },
        liq: { value: 45, available: true },
      },
      amplifiers: { psi: 1.08, contagion: 1.15 },
    });
    const dewsRows: TestDewsRow[] = [
      {
        stablecoin_id: "usdt-tether",
        score: 65,
        band: "ALERT",
        signals_json: wrappedJson,
        computed_at: Math.floor(Date.now() / 1000) - 600,
      },
    ];
    const db = mockD1([
      ...makePublishedDewsTables(dewsRows),
      {
        match: "FROM stress_signal_history WHERE snapshot_date = ?",
        rows: [{ stablecoin_id: "usdt-tether", score: 25, band: "WATCH" }],
      },
    ]);

    const ctx = makeCollectorCtx(db);
    const result = await collectDewsStress(ctx);

    expect(result).toBeDefined();
    // bandChanges must recover the top driver from the nested signals map.
    expect(result!.bandChanges.length).toBe(1);
    expect(result!.bandChanges[0].topDriver).toBe("pool balance drift");
    // elevatedCoins must surface non-empty topSignals — previously the Object.entries
    // iteration hit {signals,amplifiers} and filtered everything out.
    const elevated = result!.elevatedCoins[0];
    expect(elevated.topSignals!.length).toBe(3);
    expect(elevated.topSignals![0].name).toBe("pool balance drift");
  });

  it("produces identical elevatedCoins.topSignals for flat and wrapped shapes of the same signals", async () => {
    const signalsPayload = {
      supply: { value: 30, available: true },
      pool: { value: 80, available: true },
      liq: { value: 45, available: true },
    };
    const computedAt = Math.floor(Date.now() / 1000) - 600;
    const flatDb = mockD1([
      ...makePublishedDewsTables([
        {
          stablecoin_id: "usdt-tether",
          score: 65,
          band: "ALERT",
          signals_json: JSON.stringify(signalsPayload),
          computed_at: computedAt,
        },
      ]),
      { match: "FROM stress_signal_history WHERE snapshot_date = ?", rows: [] },
    ]);
    const wrappedDb = mockD1([
      ...makePublishedDewsTables([
        {
          stablecoin_id: "usdt-tether",
          score: 65,
          band: "ALERT",
          signals_json: JSON.stringify({
            signals: signalsPayload,
            amplifiers: { psi: 1, contagion: 1 },
          }),
          computed_at: computedAt,
        },
      ]),
      { match: "FROM stress_signal_history WHERE snapshot_date = ?", rows: [] },
    ]);

    const flat = await collectDewsStress(makeCollectorCtx(flatDb));
    const wrapped = await collectDewsStress(makeCollectorCtx(wrappedDb));
    expect(wrapped!.elevatedCoins[0].topSignals).toEqual(flat!.elevatedCoins[0].topSignals);
  });
});
