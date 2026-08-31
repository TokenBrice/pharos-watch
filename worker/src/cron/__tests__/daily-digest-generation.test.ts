import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";

import type { CronProgressUpdate } from "../../lib/cron-logger";


vi.mock("@shared/lib/stablecoins/registry", async () => (await import("./daily-digest.test-support")).mockDailyDigestRegistryModule());
vi.mock("../../lib/stablecoins-cache", async () => (await import("./daily-digest.test-support")).mockDailyDigestStablecoinsCacheModule());
vi.mock("../../lib/safety-score-active-source", async () => (await import("./daily-digest.test-support")).mockDailyDigestSafetySourceModule());
vi.mock("../../lib/flight-to-quality-classification", async () => (await import("./daily-digest.test-support")).mockDailyDigestFlightToQualityModule());
vi.mock("../../lib/fetch-retry", async () => (await import("./daily-digest.test-support")).mockDailyDigestFetchRetryModule());
vi.mock("../../lib/twitter", async () => (await import("./daily-digest.test-support")).mockDailyDigestTwitterModule());

vi.mock("../../lib/digest-safety-map", async (importOriginal) => {
  const { mockDigestSafetyMapModule } = await import("./daily-digest.test-support");
  return mockDigestSafetyMapModule(await importOriginal<typeof import("../../lib/digest-safety-map")>());
});

vi.mock("../../lib/telegram-digest-appendices", async () => (await import("./daily-digest.test-support")).mockDailyDigestAppendicesModule());
vi.mock("../../lib/telegram-digest-outbox", async () => (await import("./daily-digest.test-support")).mockDailyDigestOutboxModule());

vi.mock("../telegram-digest-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telegram-digest-transport")>();
  const { mockTelegramDigestTransportModule } = await import("./daily-digest.test-support");
  return mockTelegramDigestTransportModule(actual);
});

vi.mock("../../lib/circuit-breaker", async () => (await import("./daily-digest.test-support")).mockDailyDigestCircuitBreakerModule());

import { generateDailyDigest, resumeDailyDigestDelivery } from "../daily-digest";
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
  ANTHROPIC_OK_TEXT,
  VALID_DAILY_EXTENDED,
  canonicalSafetySource,
  makeDailyDigestScenario,
  type DailyDigestScenario,
} from "./daily-digest.test-support";



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
let baselineScenario: DailyDigestScenario;

function getInsertDigestBinds(db: MockD1Database): unknown[] | undefined {
  return db.getHistory().find((entry) => entry.sql.includes("INSERT INTO daily_digest"))?.binds;
}

describe("generateDailyDigest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));

    baselineScenario = makeDailyDigestScenario({ appendicesCommitSuccess: commitTelegramAppendices });
    vi.mocked(loadStablecoinsCache)
      .mockReset()
      .mockResolvedValue(baselineScenario.sourcePayload);

    vi.mocked(loadActiveSafetyScoreSource)
      .mockReset()
      .mockResolvedValue(baselineScenario.safetySource);

    vi.mocked(fetchWithRetry)
      .mockReset()
      .mockImplementation(async () => mockAnthropicStreamResponse(baselineScenario.modelResponse));

    vi.mocked(postDigestTweet).mockReset().mockResolvedValue(baselineScenario.deliveryMocks.twitter);
    vi.mocked(enqueueTelegramDigestEdition)
      .mockReset()
      .mockResolvedValue(baselineScenario.deliveryMocks.telegramEnqueue);
    vi.mocked(deliverTelegramDigestEdition)
      .mockReset()
      .mockResolvedValue(baselineScenario.deliveryMocks.telegramDelivery);
    commitTelegramAppendices.mockReset().mockResolvedValue(undefined);
    vi.mocked(prepareTelegramDigestAppendices)
      .mockReset()
      .mockResolvedValue(baselineScenario.deliveryMocks.appendices);
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stores digest on happy path and posts to social channels", async () => {
    vi.mocked(resolveDigestSafetyMap).mockResolvedValueOnce({
      kind: "available",
        freshness: "current",
        ageDays: 0,
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
    const db = baselineScenario.db;

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
        mapImageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-03-06",
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
  });

  it("sends the daily prompt contract to the configured model with streaming enabled", async () => {
    await generateDailyDigest(baselineScenario.db, "anthropic-key");

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
    const db = baselineScenario.db;

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
    const db = baselineScenario.db;
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

    const db = baselineScenario.db;
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

    const db = baselineScenario.db;
    await generateDailyDigest(db, "anthropic-key");

    // Only one Anthropic call — the corrective retry is skipped because
    // elapsed >= 50% of the budget, leaving no safe headroom for a second call.
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("skipping corrective retry"));
    warnSpy.mockRestore();
  });

  it("includes bounded Anthropic error body text when generation fails before streaming", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response("anthropic overloaded", { status: 529 }));
    const db = baselineScenario.db;

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

  it("regenerates a malformed recent digest instead of treating it as today's edition", async () => {
    // A code-block response is stored but unpublishable. Without this branch a
    // broken row inside the one-hour window would suppress regeneration for the
    // rest of the hour and the day could ship nothing.
    const scenario = makeDailyDigestScenario({
      db: {
        transformTables: (tables) => [
          {
            match: "SELECT generated_at, digest_text FROM daily_digest ORDER BY generated_at DESC LIMIT 1",
            rows: [],
            first: {
              generated_at: Math.floor(Date.now() / 1000) - 5 * 60,
              digest_text: "```json\n{\"title\":\"Broken\"",
            },
          },
          ...tables,
        ],
      },
    });

    const result = await generateDailyDigest(scenario.db, "anthropic-key");

    expect(result.metadata).not.toBe("skipped: recent digest exists");
    expect(result.itemCount).toBe(1);
    expect(fetchWithRetry).toHaveBeenCalled();
  });

  it("degrades but still publishes when the Telegram appendix state cannot be read", async () => {
    vi.mocked(prepareTelegramDigestAppendices).mockRejectedValueOnce(new Error("appendix store down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await generateDailyDigest(
      baselineScenario.db,
      "anthropic-key",
      null,
      false,
      { botToken: "tg-token", chatId: "tg-chat" },
    );

    expect(result.status).toBe("degraded");
    expect(String(result.metadata)).toContain("telegram-appendix-state");
    // The edition still ships: a missing appendix is cosmetic, not a reason to
    // withhold the day's digest.
    expect(result.itemCount).toBe(1);
    expect(deliverTelegramDigestEdition).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("skips regeneration when stablecoins cache is unavailable", async () => {
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "error",
      reason: "missing-cache",
      updatedAt: null,
    });

    const db = baselineScenario.db;
    const result = await generateDailyDigest(db, "anthropic-key");

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(getInsertDigestBinds(db as MockD1Database)).toBeUndefined();
  });

  it("skips generation cleanly when the Anthropic circuit is open", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);

    const db = baselineScenario.db;
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

    const db = baselineScenario.db;
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

    const db = makeDailyDigestScenario({
      db: {
        prependTables: [
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
        ],
      },
    }).db;
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

    const db = baselineScenario.db;
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

  it("fails early on DB data-collection error and does not call Claude", async () => {
    const db = makeDailyDigestScenario({
      db: {
        transformTables: (tables) => [
          ...tables.filter(
            (table) => table.match !== "SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?",
          ),
          {
            match: "SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?",
            rows: [],
            throwError: new Error("D1 read failed"),
          },
        ],
      },
    }).db;

    await expect(generateDailyDigest(db, "anthropic-key")).rejects.toThrow("D1 read failed");
    expect(fetchWithRetry).not.toHaveBeenCalled();
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

    const db = baselineScenario.db;
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
    const db = makeDailyDigestScenario({
      db: {
        transformTables: (tables) => tables.map((table) =>
          table.match === "FROM depeg_events WHERE ended_at IS NULL"
            ? { ...table, throwError: new Error("d1 unavailable") }
            : table,
        ),
      },
    }).db;

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

    const db = baselineScenario.db;
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
    expect(result.status).toBe("degraded");
    expect(result.metadata).toContain("tweet: failed:");
    expect(result.metadata).toContain("telegram: failed:");
    expect(commitTelegramAppendices).toHaveBeenCalledTimes(0);
    expect(getInsertDigestBinds(db as MockD1Database)).toBeDefined();
  });

  it("degrades when required channel credentials are absent", async () => {
    const result = await generateDailyDigest(
      baselineScenario.db,
      "anthropic-key",
      null,
      false,
      null,
      undefined,
      undefined,
      {
        twitterMissing: ["TWITTER_API_KEY", "TWITTER_API_SECRET"],
        telegramMissing: ["TELEGRAM_BOT_TOKEN"],
      },
    );

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      channels: {
        twitter: {
          status: "skipped: no-creds",
          disposition: "terminal-unsent",
          missingCredentialNames: ["TWITTER_API_KEY", "TWITTER_API_SECRET"],
        },
        telegram: {
          status: "no-creds",
          disposition: "terminal-unsent",
          missingCredentialNames: ["TELEGRAM_BOT_TOKEN"],
        },
      },
    });
  });

  it("publishes text-only when the daily map is unavailable", async () => {
    vi.mocked(resolveDigestSafetyMap).mockResolvedValueOnce({
      kind: "unavailable",
      reason: "manifest-too-old",
    });
    const db = baselineScenario.db;

    const result = await generateDailyDigest(
      db,
      "anthropic-key",
      { apiKey: "x", apiSecret: "y", accessToken: "z", accessTokenSecret: "w" },
      false,
      { botToken: "tg-token", chatId: "tg-chat" },
    );

    expect(result.itemCount).toBe(1);
    expect(fetchWithRetry).toHaveBeenCalled();
    expect(getInsertDigestBinds(db as MockD1Database)).toBeDefined();
    expect(postDigestTweet).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      expect.any(Number),
      null,
      null,
    );
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ mapImageUrl: null, mapDate: null, mapAppendixHtml: null }),
      undefined,
    );
  });

  it("publishes a forced run without map attachment when the map is unavailable", async () => {
    vi.mocked(resolveDigestSafetyMap).mockResolvedValueOnce({
      kind: "unavailable",
      reason: "image-http-404",
    });
    const db = baselineScenario.db;

    const result = await generateDailyDigest(
      db,
      "anthropic-key",
      { apiKey: "x", apiSecret: "y", accessToken: "z", accessTokenSecret: "w" },
      true,
      { botToken: "tg-token", chatId: "tg-chat" },
    );

    expect(result.itemCount).toBe(1);
    expect(postDigestTweet).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      expect.any(Number),
      null,
      null,
    );
    expect(enqueueTelegramDigestEdition).toHaveBeenCalled();
  });

  it("resumes stored-edition delivery with the map attached", async () => {
    const db = mockD1([
      {
        match: "SELECT generated_at, digest_text, digest_title, digest_extended, input_data FROM daily_digest",
        rows: [],
        first: {
          generated_at: 1_772_798_400,
          digest_text: "Stored digest body.",
          digest_title: "Stored Title",
          digest_extended: "Stored extended body.",
          input_data: JSON.stringify({ totalMcapUsd: 100e9 }),
        },
      },
      { match: "SELECT COUNT(*) as cnt FROM daily_digest", rows: [{ cnt: 187 }], first: { cnt: 187 } },
      {
        match: "SELECT state FROM telegram_digest_outbox",
        rows: [],
        first: { state: "sent" },
      },
      { match: "INSERT OR IGNORE INTO cache", rows: [] },
      { match: "UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?", rows: [] },
    ]);

    const result = await resumeDailyDigestDelivery(
      db,
      { apiKey: "x", apiSecret: "y", accessToken: "z", accessTokenSecret: "w" },
      { botToken: "tg-token", chatId: "tg-chat" },
      {
        kind: "available",
        freshness: "current",
        ageDays: 0,
        imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-03-06",
        manifest: { date: "2026-03-06", asOfSec: 1_772_796_000, renderedAtSec: 1_772_798_400, edition: "daily", bytes: { png: 1_000_000 } },
      },
    );

    expect(result).toEqual({
      kind: "resumed",
      tweetStatus: "ok",
      // The already-enqueued Telegram edition stays owned by the outbox drain.
      telegramStatus: "outbox-sent",
      deliveryComplete: true,
    });
    expect(postDigestTweet).toHaveBeenCalledWith(
      "Stored Title",
      "Stored digest body.",
      expect.any(Object),
      187,
      "https://pharos.watch/safety-scores/map.png?date=2026-03-06",
      null,
    );
    expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
  });

  it("reports an unresolved resume when no publishable digest row exists today", async () => {
    const db = mockD1([
      { match: "SELECT generated_at, digest_text, digest_title, digest_extended, input_data FROM daily_digest", rows: [], first: null },
    ]);

    const result = await resumeDailyDigestDelivery(
      db,
      { apiKey: "x", apiSecret: "y", accessToken: "z", accessTokenSecret: "w" },
      null,
      {
        kind: "available",
        freshness: "current",
        ageDays: 0,
        imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-03-06",
        manifest: { date: "2026-03-06", asOfSec: 1_772_796_000, renderedAtSec: 1_772_798_400, edition: "daily", bytes: { png: 1_000_000 } },
      },
    );

    expect(result).toEqual({ kind: "no-publishable-digest" });
    expect(postDigestTweet).not.toHaveBeenCalled();
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
        freshness: "current",
        ageDays: 0,
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
    const db = baselineScenario.db;

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
      null,
    );
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        mapImageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-03-06",
        mapAppendixHtml: null,
        safetyContext: expect.objectContaining({ status: "unavailable" }),
      }),
      undefined,
    );
  });

  it("persists the Twitter sent marker before sending on the happy path", async () => {
    const db = baselineScenario.db;
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

    const db = baselineScenario.db;
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
    const db = makeDailyDigestScenario({
      db: {
        prependTables: [
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
        ],
      },
    }).db;

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
    const db = makeDailyDigestScenario({
      db: {
        prependTables: [
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
        ],
      },
    }).db;

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
    const db = baselineScenario.db;
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

    const db = baselineScenario.db;
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
    const db = baselineScenario.db;

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
    const db = baselineScenario.db;

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
    const db = baselineScenario.db;

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

    const db = baselineScenario.db;
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
    const db = baselineScenario.db;

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

    const db = baselineScenario.db;
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

    const db = makeDailyDigestScenario({
      db: {
        prependTables: [
          {
            match: "ORDER BY CAST(json_extract(input_data, '$.totalMcapUsd') AS REAL) DESC",
            first: { ath_value: 330_000_000_000, ath_date: nowSec - 7 * 86_400 },
            rows: [],
          },
        ],
      },
    }).db;

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
    const scenario = makeDailyDigestScenario();
    vi.mocked(loadStablecoinsCache).mockReset().mockResolvedValue(scenario.sourcePayload);
    vi.mocked(loadActiveSafetyScoreSource).mockReset().mockResolvedValue(scenario.safetySource);
    vi.mocked(fetchWithRetry)
      .mockReset()
      .mockImplementation(async () => mockAnthropicStreamResponse(scenario.modelResponse));
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    const db = scenario.db;
    const result = await generateDailyDigest(db, "anthropic-key");
    expect(result.itemCount).toBe(1);
    const body = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[0].content).toContain("Momentum Candidates");
  });
});
