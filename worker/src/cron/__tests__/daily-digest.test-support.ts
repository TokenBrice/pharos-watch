import { vi } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import { mockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { mockCircuitBreaker, mockRegistry } from "../../test-helpers/cron";
import type { ActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import type { StablecoinsCacheLoadResult } from "../../lib/stablecoins-cache";
import type { PreparedTelegramDigestAppendices } from "../../lib/telegram-digest-appendices";
import type {
  EnqueueTelegramDigestEditionResult,
  TelegramDigestDeliveryResult,
} from "../../lib/telegram-digest-outbox";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";

export const VALID_DAILY_EXTENDED = [
  "PSI held at 91.2 BEDROCK with severity 2 and breadth 1, so the headline market still looks calm. USDT sat 150 bps off peg on a $100M float in the fixture, which gives the model a real candidate but not a systemic alarm. The point is selection, not volume.",
  "USDT added $5M over the week while USDC lost $2M, a mixed flow pattern rather than a single-direction stampede. The candidate list marks the depeg by impact first, then leaves supply as supporting context, which is the behavior this test expects. A smaller signal can still appear without becoming the lead.",
  "Safety scores stayed A for USDT and USDC, leaving the daily note with a dry but restrained read. Nothing in the fixture should force panic, but the digest still has enough numbers to produce a publishable editorial paragraph set today. Next session will decide whether the USDT deviation widens; if it crosses 200 bps, the impact score moves the depeg from supporting context to lead.",
].join("\n\n");

export const ANTHROPIC_OK_TEXT = JSON.stringify({
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

export function mockDailyDigestRegistryModule() {
  type Contract = readonly [string, string, number];
  const toContract = ([chain, address, decimals]: Contract) => ({ chain, address, decimals });
  const asset = (id: string, symbol: string, contracts: Contract[], tradedContracts?: Contract[]) => ({
    id, symbol, flags: { yieldBearing: false }, contracts: contracts.map(toContract),
    ...(tradedContracts ? { tradedContracts: tradedContracts.map(toContract) } : {}),
  });
  const stablecoins = [
    asset("usdt-tether", "USDT", [
      ["ethereum", "0xdac17f958d2ee523a2206206994597c13d831ec7", 6], ["tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 6],
      ["arbitrum", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", 6], ["optimism", "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", 6],
      ["polygon", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", 6], ["avalanche", "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", 6],
      ["bsc", "0x55d398326f99059ff775485246999027b3197955", 18],
    ], [["optimism", "0x01bFF41798a0BcF287b996046Ca68b395DbC1071", 6]]),
    asset("usdc-circle", "USDC", [
      ["ethereum", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6], ["arbitrum", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", 6],
      ["base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 6], ["optimism", "0x0b2c639c533813f4aa9d7837caf62653d097ff85", 6],
      ["polygon", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", 6], ["avalanche", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", 6],
    ]),
    asset("paxg-paxos", "PAXG", [["ethereum", "0x45804880De22913dAFE09f4980848ECE6EcbAf78", 18]]),
    asset("xaut-tether", "XAUT", [["ethereum", "0x68749665FF8D2d112Fa859AA293F07A622782F38", 6]]),
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
}

export function mockDailyDigestStablecoinsCacheModule() {
  return { loadStablecoinsCache: vi.fn() };
}

export function mockDailyDigestSafetySourceModule() {
  return { loadActiveSafetyScoreSource: vi.fn() };
}

export function mockDailyDigestFlightToQualityModule() {
  return {
    buildFlightToQualityClassificationFromV9Snapshot: vi.fn(() => ({
      kind: "ok" as const,
      classification: {
        safeIds: new Set(["usdt-tether", "usdc-circle"]),
        riskyIds: new Set(["paxg-paxos", "xaut-tether"]),
        safetyScoreIdentity: null,
      },
    })),
  };
}

export function mockDailyDigestFetchRetryModule() {
  return { fetchWithRetry: vi.fn() };
}

export function mockDailyDigestTwitterModule() {
  return { postDigestTweet: vi.fn() };
}

export function mockDailyDigestAppendicesModule() {
  return { prepareTelegramDigestAppendices: vi.fn() };
}

export function mockDailyDigestOutboxModule() {
  return {
    enqueueTelegramDigestEdition: vi.fn(),
    deliverTelegramDigestEdition: vi.fn(),
  };
}

export function mockDailyDigestCircuitBreakerModule() {
  return mockCircuitBreaker();
}

export function mockTelegramDigestTransportModule(
  actual: typeof import("../telegram-digest-transport"),
) {
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
}

export function mockDigestSafetyMapModule(
  actual: typeof import("../../lib/digest-safety-map"),
) {
  return {
    ...actual,
    resolveDigestSafetyMap: vi.fn(async (date: string) => ({
      kind: "available" as const,
      imageUrl: `https://pharos.watch/safety-scores/map.png?date=${date}`,
      manifest: {
        date,
        asOfSec: 1_772_796_000,
        renderedAtSec: 1_772_798_400,
        edition: "daily" as const,
        bytes: { png: 1_000_000 },
      },
    })),
  };
}

export function canonicalSafetySource(
  cards: unknown[],
): Extract<ActiveSafetyScoreSource, { kind: "v9" }> {
  const snapshot = makeWorkerReportCardsV9Response({
    cards: cards
      .map((value) => value as {
        id: string;
        overallGrade: ReturnType<typeof makeWorkerV9Card>["grade"];
        overallScore: number | null;
      })
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((card) =>
        makeWorkerV9Card({
          id: card.id,
          grade: card.overallGrade,
          score: card.overallScore,
        }),
      ),
  });
  return { kind: "v9", snapshot };
}

export interface TestDewsRow {
  stablecoin_id: string;
  score: number;
  band: string;
  signals_json: string;
  computed_at: number;
}

export function makePublishedDewsTables(dewsRows: TestDewsRow[]): MockTableConfig[] {
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

export const PUBLISHED_GAUGE_SCORE = 37.5;

export function publishedGaugeTable(
  options: { value?: string; ageSec?: number } = {},
): MockTableConfig {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: ["mint-burn-flows:v3:aggregate:24"],
    rows: [],
    first: {
      value: options.value ?? JSON.stringify({
        gauge: { score: PUBLISHED_GAUGE_SCORE, band: "HEALTHY", flightToQuality: false, flightIntensity: 0, classificationSource: "safety-score-v9-publication" },
        coins: [
          { stablecoinId: "usdt-tether", symbol: "USDT", flowIntensity: 100, pressureShiftScore: 100, netFlow24hUsd: 200_000_000 },
          { stablecoinId: "usdc-circle", symbol: "USDC", flowIntensity: -83.33, pressureShiftScore: -83.33, netFlow24hUsd: -50_000_000 },
          { stablecoinId: "paxg-paxos", symbol: "PAXG", flowIntensity: null, pressureShiftScore: null, netFlow24hUsd: -3_000_000 },
        ],
        chains: [{ chainId: "ethereum", netFlow24hUsd: 150_000_000 }, { chainId: "arbitrum", netFlow24hUsd: -3_000_000 }],
      }),
      updated_at: nowSec - (options.ageSec ?? 300),
    },
  };
}

export function makeDailyDigestTables(): MockTableConfig[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % 86_400);
  const weekAgoTs = todayTs - 7 * 86_400;
  const dewsRows: TestDewsRow[] = [
    { stablecoin_id: "usdt-tether", score: 8, band: "CALM", signals_json: '{"supply":{"value":5,"available":true}}', computed_at: nowSec - 600 },
    { stablecoin_id: "usdc-circle", score: 12, band: "CALM", signals_json: '{"pool":{"value":10,"available":true}}', computed_at: nowSec - 600 },
  ];
  const empty = (match: string): MockTableConfig => ({ match, rows: [] });
  const first = (match: string, value: Record<string, unknown> | null): MockTableConfig => ({ match, rows: [], first: value });
  const cacheFirst = (key: string, value: Record<string, unknown> | null): MockTableConfig => ({
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: [key], rows: [], first: value,
  });
  return [
    ...makePublishedDewsTables(dewsRows),
    first("SELECT generated_at, digest_text FROM daily_digest ORDER BY generated_at DESC LIMIT 1", null),
    ...[
      "SELECT digest_title, digest_text, digest_extended, digest_meta FROM daily_digest ORDER BY generated_at DESC LIMIT 5",
      "SELECT digest_title, digest_text, digest_extended, digest_meta, input_data\n       FROM daily_digest",
      "SELECT digest_meta FROM daily_digest",
      "SELECT digest_title FROM daily_digest",
      "SELECT generated_at, input_data FROM daily_digest\n         WHERE generated_at",
    ].map(empty),
    first("SELECT MIN(generated_at) as oldest FROM daily_digest", null),
    first("as ath_date\n         FROM daily_digest\n         WHERE (", null),
    first("SELECT COUNT(*) as cnt FROM stability_index", { cnt: 1 }),
    first("SELECT score, band, components, computed_at as stored_at FROM stability_index", {
      score: 89.5, band: "STEADY", components: JSON.stringify({ severity: 2, breadth: 1, trend: 0, stressBreadth: 0 }), stored_at: todayTs,
    }),
    ...[
      "SELECT stablecoin_id, symbol, current_apy, apy_7d, apy_30d, warning_signals",
      "SELECT h.stablecoin_id, h.liquidity_score, h.total_tvl_usd, h.snapshot_date",
    ].map(empty),
    first("SELECT circulating_usd AS ath_mcap, snapshot_date FROM supply_history", null),
    ...[
      "SELECT stablecoin_id, score, band FROM stress_signal_history",
      "GROUP BY recorded_at HAVING COUNT(*) > 15",
      "SELECT history_id, stablecoin_id, recorded_at, model, identity_schema_version",
      "INSERT INTO daily_digest",
      "INSERT OR IGNORE INTO cache",
      "UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
      "INSERT OR REPLACE INTO cache",
      "DELETE FROM cache",
    ].map(empty),
    first("SELECT value, updated_at FROM cache WHERE key = ?", null),
    { ...empty("SELECT COUNT(*) as cnt FROM daily_digest WHERE"), rows: [{ cnt: 1 }], first: { cnt: 1 } },
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
    first("FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1", {
      score: 91.2, band: "BEDROCK", components: JSON.stringify({ severity: 2, breadth: 1, trend: 0, stressBreadth: 0 }),
    }),
    first("SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?", { avg: 90.6 }),
    first("FROM stability_index WHERE computed_at = ?", { score: 89.5, band: "STEADY" }),
    first("SELECT score, band, components, computed_at as stored_at FROM stability_index", {
      score: 89.5, band: "STEADY", components: JSON.stringify({ severity: 2, breadth: 1, trend: 0, stressBreadth: 0 }), stored_at: todayTs,
    }),
    empty("FROM blacklist_events"),
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
    empty("WHERE ended_at IS NOT NULL AND ended_at >= ?"),
    cacheFirst("report_card_cache", {
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
      }),
  ];
}

export interface DailyDigestDeliveryMocks {
  twitter: { tweetId: string; mediaAttached: boolean };
  telegramEnqueue: EnqueueTelegramDigestEditionResult;
  telegramDelivery: TelegramDigestDeliveryResult;
  appendices: PreparedTelegramDigestAppendices;
}

export interface DailyDigestScenario {
  db: MockD1Database;
  sourcePayload: StablecoinsCacheLoadResult;
  safetySource: ActiveSafetyScoreSource;
  modelResponse: string;
  deliveryMocks: DailyDigestDeliveryMocks;
}

export interface DailyDigestScenarioOptions {
  db?: {
    prependTables?: MockTableConfig[];
    transformTables?: (tables: MockTableConfig[]) => MockTableConfig[];
  };
  appendicesCommitSuccess?: () => Promise<void>;
}

export function makeDailyDigestScenario(
  options: DailyDigestScenarioOptions = {},
): DailyDigestScenario {
  const nowSec = Math.floor(Date.now() / 1000);
  const dbOptions = options.db ?? {};
  const baseTables = [
    ...(dbOptions.prependTables ?? []),
    ...makeDailyDigestTables(),
  ];
  const tables = dbOptions.transformTables?.(baseTables) ?? baseTables;
  const commitSuccess = options.appendicesCommitSuccess ?? (async () => undefined);
  const deliveryMocks: DailyDigestDeliveryMocks = {
    twitter: { tweetId: "1", mediaAttached: true },
    telegramEnqueue: { created: true, payloadMatched: true, editionKey: "daily:2026-03-06", state: "pending", chunks: ["stored daily payload"] },
    telegramDelivery: { editionKey: "daily:2026-03-06", state: "sent", outcome: "sent", chunksSent: 1, nextChunkIndex: 1, chunkCount: 1, errorClass: null, retryAfterSec: null },
    appendices: {
      appendixHtml: null,
      metadata: { hasAppendix: false, cemeteryDetected: 0, trackedDetected: 0, preLaunchDetected: 0, cemeterySymbols: [], trackedSymbols: [], preLaunchSymbols: [], frozenDetected: 0, frozenSymbols: [], seededSnapshots: [] },
      commitSuccess,
    },
  };
  return {
    db: mockD1(tables),
    sourcePayload: {
      kind: "ok",
      payload: {
        peggedAssets: [
          makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.985, circulating: { peggedUSD: 100_000_000 }, circulatingPrevWeek: { peggedUSD: 95_000_000 } }),
          makeAsset({ id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 60_000_000 }, circulatingPrevWeek: { peggedUSD: 62_000_000 } }),
          makeAsset({ id: "susds-sky", symbol: "sUSDS", circulating: { peggedUSD: 1_000_000_000 }, circulatingPrevWeek: { peggedUSD: 900_000_000 } }),
          makeAsset({ id: "acred-apollo-securitize", symbol: "ACRED", circulating: { peggedUSD: 500_000_000 }, circulatingPrevWeek: { peggedUSD: 450_000_000 } }),
        ],
      },
      updatedAt: nowSec,
    },
    safetySource: canonicalSafetySource([
      { id: "usdt-tether", overallGrade: "A", overallScore: 88 },
      { id: "usdc-circle", overallGrade: "A", overallScore: 85 },
    ]),
    modelResponse: ANTHROPIC_OK_TEXT,
    deliveryMocks,
  };
}
