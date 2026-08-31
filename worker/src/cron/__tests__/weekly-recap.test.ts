import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import type { CronProgressUpdate } from "../../lib/cron-logger";

vi.mock("../../lib/fetch-retry", async () => {
  const { mockDailyDigestFetchRetryModule } = await import("./daily-digest.test-support");
  return mockDailyDigestFetchRetryModule();
});

vi.mock("../../lib/telegram-digest-outbox", async () => {
  const { mockDailyDigestOutboxModule } = await import("./daily-digest.test-support");
  return mockDailyDigestOutboxModule();
});

vi.mock("../telegram-digest-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telegram-digest-transport")>();
  const { mockTelegramDigestTransportModule } = await import("./daily-digest.test-support");
  return mockTelegramDigestTransportModule(actual);
});

vi.mock("../../lib/digest-safety-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/digest-safety-context")>();
  return {
    ...actual,
    loadDigestSafetyContext: vi.fn(),
    digestSafetyContextFromPersistedInput: vi.fn(),
    checkDigestSafetyContextForDelivery: vi.fn(async () => ({ kind: "ok" as const })),
  };
});

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcomeSafe: vi.fn(async () => {}),
}));

vi.mock("../../lib/twitter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/twitter")>()),
  postDigestTweet: vi.fn(async () => ({ tweetId: "weekly-tweet", mediaAttached: true })),
}));

vi.mock("../../lib/twitter-digest-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/twitter-digest-ledger")>()),
  deliverTwitterDigestWithLedger: vi.fn(async (_db, _key, _edition, _now, post) => ({
    status: "sent" as const,
    post: await post(),
  })),
}));

vi.mock("../../lib/digest-safety-map", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/digest-safety-map")>()),
  resolveDigestSafetyMap: vi.fn(async () => ({ kind: "unavailable" as const, reason: "manifest-http-404" })),
}));

import { generateWeeklyRecap } from "../weekly-recap";
import { fetchWithRetry } from "../../lib/fetch-retry";
import {
  deliverTelegramDigestEdition,
  enqueueTelegramDigestEdition,
} from "../../lib/telegram-digest-outbox";
import { runTelegramDigestDeliveryWithPermit } from "../telegram-digest-transport";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import { DIGEST_MODEL } from "../../lib/constants";
import {
  digestSafetyContextFromPersistedInput,
  loadDigestSafetyContext,
} from "../../lib/digest-safety-context";
import { resolveDigestSafetyMap } from "../../lib/digest-safety-map";
import { postDigestTweet } from "../../lib/twitter";
import { deliverTwitterDigestWithLedger } from "../../lib/twitter-digest-ledger";

const safetyContext = {
  status: "available" as const,
  expectedModel: "v8" as const,
  identity: {
    model: "v8" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "8.17",
    evaluationBuildDigest: "a".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
    publicationGenerationId: "report-cards:v8:test",
  },
  publishedAt: 1_774_800_000,
  reason: null,
};

const VALID_WEEKLY_EXTENDED = [
  "PSI opened the trailing edition window at 90 and closed at 86, never leaving BEDROCK but losing four points across five daily notes. USDT stayed near 1.00 in every fixture row, which makes the week's story less about a broken peg and more about calm data refusing to become a headline. The recap should notice the drift without inventing a crisis.",
  "The active depeg observations rose from 0 to 4 as the week progressed, but the recap input separates those observations from unique signals. That distinction matters because one persistent condition should not masquerade as five independent events just because it survived five daily snapshots. It is burden, not necessarily breadth.",
  "Blacklist activity accumulated 10 fixture events while grade transitions appeared on alternating days, giving the model enough secondary texture without overwhelming the market-cap arc. The Bank Run Gauge climbed from 10 to 14, a mild range that supports watchfulness rather than panic. Weekly structure should tie those pieces together instead of stapling them into a list.",
  "The weekly note should therefore synthesize the slow drift: PSI softened, enforcement kept tapping the glass, and supply rose by $4M from the first daily edition to the last. That is a complete recap, but it is still restrained enough for a market that mostly held together. A reader should leave with a coherent week, not seven smaller mornings, and should understand which signals were excluded because they were too small or too stale for a serious lead in public without drama today. Next week will decide whether the 10 observations consolidate into a durable trend or fade; if the gauge crosses 20, the recap flips from restrained to sharper.",
].join("\n\n");

function weeklyClaudeResponse(overrides: Partial<{
  title: string;
  text: string;
  extended: string;
  meta: Record<string, unknown>;
}> = {}): Response {
  const text = JSON.stringify({
    title: overrides.title ?? "Weekly Calm",
    text: overrides.text ?? "PSI softened by 4 points while USDT stayed near peg and blacklist activity kept tapping the glass.",
    extended: overrides.extended ?? VALID_WEEKLY_EXTENDED,
    meta: overrides.meta ?? {
      leadSignalId: "weekly:psi",
      lead: "psi-regime",
      tone: "dry",
      coins: ["USDT", "USDC"],
      usedCandidateIds: ["weekly:psi"],
    },
  });
  return mockAnthropicStreamResponse(text);
}

/**
 * Build an Anthropic SSE streaming Response body for `text`, matching the
 * production `stream: true` path in `requestDigestCopy`.
 */
function mockAnthropicStreamResponse(text: string): Response {
  const events: Array<{ event: string; data: unknown }> = [
    { event: "message_start", data: { type: "message_start", message: { id: "msg_test", role: "assistant", content: [] } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  const encoded = events
    .map((ev) => `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`)
    .join("");
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(encoded));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function buildDailyRows() {
  // Start at Tuesday 2026-03-24 12:00 UTC so all 5 rows fall within the
  // "current week" window (weekBoundary = todayTs - 6d = Tue 00:00 UTC
  // given the cron runs Monday 03-30 08:05 UTC).
  const baseTs = Math.floor(Date.UTC(2026, 2, 24, 12, 0, 0) / 1000);
  return Array.from({ length: 5 }).map((_, index) => ({
    generated_at: baseTs + index * 86_400,
    digest_title: `Day ${index + 1}`,
    digest_text: `USDT held near 1.00 on day ${index + 1}.`,
    digest_extended: null,
    input_data: JSON.stringify({
      totalMcapUsd: 100_000_000 + index * 1_000_000,
      activeDepegCount: index,
      stabilityIndex: {
        score: 90 - index,
        band: "BEDROCK",
      },
      blacklistActivity: {
        eventCount: index,
      },
      gradeTransitions: index % 2 === 0 ? [{ stablecoinId: "usdt-tether" }] : [],
      mintBurnFlows: {
        gaugeScore: 10 + index,
      },
    }),
  }));
}

function makeTables(overrides: Partial<{
  existingWeekly: Record<string, unknown> | null;
  dailyRows: ReturnType<typeof buildDailyRows>;
  recentWeeklyRows: Record<string, unknown>[];
}> = {}): MockTableConfig[] {
  return [
    {
      match: "SELECT generated_at, digest_title, digest_text, digest_extended, digest_meta",
      rows: [],
      first: overrides.existingWeekly ?? null,
    },
    {
      match: "SELECT digest_title, digest_text, digest_meta",
      rows: overrides.recentWeeklyRows ?? [],
    },
    {
      match: "digest_meta, input_data",
      rows: [],
      first: null,
    },
    {
      match: "WHERE generated_at >= ? AND (digest_meta IS NULL OR json_extract(digest_meta, '$.type') IS NULL OR json_extract(digest_meta, '$.type') != 'weekly')",
      rows: overrides.dailyRows ?? buildDailyRows(),
    },
    {
      match: "INSERT INTO daily_digest",
      rows: [],
      runMeta: { changes: 1 },
    },
    {
      match: "SET digest_meta = ?",
      rows: [],
      runMeta: { changes: 1 },
    },
  ];
}

describe("generateWeeklyRecap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));
    vi.clearAllMocks();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    vi.mocked(loadDigestSafetyContext).mockResolvedValue(safetyContext);
    vi.mocked(digestSafetyContextFromPersistedInput).mockReturnValue(safetyContext);
    vi.mocked(enqueueTelegramDigestEdition).mockResolvedValue({
      created: true,
      payloadMatched: true,
      editionKey: "weekly:2026-03-30",
      state: "pending",
      chunks: ["stored weekly payload"],
    });
    vi.mocked(deliverTelegramDigestEdition).mockResolvedValue({
      editionKey: "weekly:2026-03-30",
      state: "sent",
      outcome: "sent",
      chunksSent: 1,
      nextChunkIndex: 1,
      chunkCount: 1,
      errorClass: null,
      retryAfterSec: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores a weekly digest and posts to Telegram when generation succeeds", async () => {
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());

    const result = await generateWeeklyRecap(
      db,
      "anthropic-key",
      null,
      { botToken: "bot", chatId: "chat" },
    );

    expect(result.itemCount).toBe(1);
    expect(result.status).toBeUndefined();
    expect(result.metadata).toContain("telegram: ok");
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        editionKey: "weekly:2026-03-30",
        digestKind: "weekly",
        targetChatId: "chat",
        title: "Weekly Recap: Weekly Calm",
        extended: VALID_WEEKLY_EXTENDED,
        date: "2026-03-30-weekly",
      }),
      undefined,
    );
    expect(runTelegramDigestDeliveryWithPermit).toHaveBeenCalledWith(expect.objectContaining({
      db,
      owner: "weekly-recap",
      editionKey: "weekly:2026-03-30",
    }));
    expect(deliverTelegramDigestEdition).toHaveBeenCalledWith(
      db,
      { botToken: "bot", chatId: "chat" },
      "weekly:2026-03-30",
      undefined,
    );

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO daily_digest"));
    expect(insert).toBeTruthy();
    const recentWeeklyQuery = db.getHistory().find((entry) =>
      entry.sql.includes("SELECT digest_title, digest_text, digest_meta"),
    );
    expect(recentWeeklyQuery?.sql).toContain("$.qualityGate");
    expect(insert?.binds[1]).toBe("PSI softened by 4 points while USDT stayed near peg and blacklist activity kept tapping the glass.");
    expect(insert?.binds[2]).toBe("Weekly Calm");
    expect(JSON.parse(String(insert?.binds[5]))).toMatchObject({
      leadSignalId: "weekly:psi",
      lead: "psi-regime",
      tone: "dry",
      coins: ["USDT", "USDC"],
      usedCandidateIds: ["weekly:psi"],
      type: "weekly",
      periodType: "trailing-daily-editions",
      weekStart: "2026-03-24",
      weekEnd: "2026-03-28",
      telegramDelivered: false,
      telegramDeliveryStatus: "pending",
    });
    const update = db.getHistory().find((entry) => entry.sql.includes("SET digest_meta = ?"));
    const finalMeta = JSON.parse(String(update?.binds[0])) as Record<string, unknown>;
    expect(finalMeta).toMatchObject({
      type: "weekly",
      telegramDelivered: true,
      telegramDeliveryStatus: "ok",
    });
    expect(update?.binds[1]).toBe(insert?.binds[0]);

    expect(fetchWithRetry).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.any(Object),
      2,
      { timeoutMs: 11 * 60_000 },
    );

    const weeklyBody = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      model: string;
      max_tokens: number;
      thinking?: { type: string };
      output_config?: { effort: string };
      system: string;
    };
    expect(weeklyBody.model).toBe(DIGEST_MODEL);
    expect(weeklyBody.thinking).toEqual({ type: "adaptive" });
    expect(weeklyBody.output_config).toEqual({ effort: "xhigh" });
    expect(weeklyBody.max_tokens).toBe(64000);

    const weeklySystem = weeklyBody.system as string;
    expect(weeklySystem).toContain("forward-look");
    expect(weeklySystem).toContain("plumbing");
    expect(weeklySystem).toContain("week-over-week");
    expect(weeklySystem).toContain("arc");
  });

  it("posts the weekly recap to X with a carried-forward dated map", async () => {
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());
    vi.mocked(resolveDigestSafetyMap).mockResolvedValueOnce({
      kind: "available",
      imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-03-29",
      manifest: {
        date: "2026-03-29",
        asOfSec: 1_774_800_000,
        renderedAtSec: 1_774_800_100,
        edition: "daily",
        bytes: { png: 1_000 },
      },
      freshness: "carried-forward",
      ageDays: 1,
    });
    const twitterCreds = {
      apiKey: "key",
      apiSecret: "secret",
      accessToken: "token",
      accessTokenSecret: "token-secret",
    };

    const result = await generateWeeklyRecap(
      db,
      "anthropic-key",
      twitterCreds,
      { botToken: "bot", chatId: "chat" },
    );

    expect(result.status).toBeUndefined();
    expect(deliverTwitterDigestWithLedger).toHaveBeenCalledWith(
      db,
      "weekly-recap:twitter-sent:2026-03-30",
      null,
      expect.any(Number),
      expect.any(Function),
      undefined,
    );
    expect(postDigestTweet).toHaveBeenCalledWith(
      "Weekly Calm",
      expect.any(String),
      twitterCreds,
      null,
      "https://pharos.watch/safety-scores/map.png?date=2026-03-29",
      null,
    );
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        mapImageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-03-29",
        mapDate: "2026-03-29",
      }),
      undefined,
    );
  });

  it("keeps residual soft quality warnings visible without degrading cron health", async () => {
    const recentWeeklyRows = [{
      digest_title: "Prior USDT Week",
      digest_text: "USDT led the prior weekly edition.",
      digest_meta: JSON.stringify({
        type: "weekly",
        lead: "supply",
        tone: "forensic",
        coins: ["USDT"],
      }),
    }];
    const db = mockD1(makeTables({ recentWeeklyRows }), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());

    const result = await generateWeeklyRecap(
      db,
      "anthropic-key",
      null,
      { botToken: "bot", chatId: "chat" },
    );

    // Soft-only issues no longer trigger the corrective retry (hard-only policy).
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(result.status).toBeUndefined();
    expect(result.metadata).toContain("quality: repeated-primary-coin:soft");
    expect(deliverTelegramDigestEdition).toHaveBeenCalledTimes(1);
  });

  it("reports weekly recap preflight and skipped progress when Anthropic is not configured", async () => {
    const db = mockD1([]);
    const progressUpdates: CronProgressUpdate[] = [];
    const reportProgress = vi.fn(async (update: CronProgressUpdate) => {
      progressUpdates.push(update);
    });

    const result = await generateWeeklyRecap(db, null, null, null, undefined, reportProgress);

    expect(result.metadata).toBe("skipped: no API key");
    expect(progressUpdates.find((update) => update.stage === "preflight")).toMatchObject({
      metadata: {
        providerFamily: "digest",
        phase: "preflight",
        countTotals: {
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

  it("returns a neutral skipped result outside Monday UTC", async () => {
    vi.setSystemTime(new Date("2026-03-31T12:00:00.000Z"));
    const db = mockD1([]);
    const progressUpdates: CronProgressUpdate[] = [];
    const reportProgress = vi.fn(async (update: CronProgressUpdate) => {
      progressUpdates.push(update);
    });

    const result = await generateWeeklyRecap(db, "anthropic-key", null, null, undefined, reportProgress);

    expect(result.status).toBe("skipped_neutral");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "not-monday",
      skipped: "not-monday",
      utcDay: 2,
    });
    expect(progressUpdates.find((update) => update.stage === "skipped")).toMatchObject({
      metadata: {
        providerFamily: "digest",
        phase: "skipped",
        skipped: "not-monday",
        utcDay: 2,
      },
    });
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();
  });

  it("uses the Monday scheduled slot when execution starts after midnight Tuesday", async () => {
    vi.setSystemTime(new Date("2026-03-31T00:01:00.000Z"));
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());
    const db = mockD1(makeTables(), { requireMatch: true });
    const mondaySlotSec = Math.floor(Date.parse("2026-03-30T08:10:00Z") / 1000);

    const result = await generateWeeklyRecap(
      db,
      "anthropic-key",
      null,
      null,
      undefined,
      undefined,
      mondaySlotSec,
    );

    expect(result.itemCount).toBe(1);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      digestDate: "2026-03-30",
      scheduledAtSec: mondaySlotSec,
    });
  });

  it("returns a neutral skipped result when this week's recap already exists", async () => {
    const existingGeneratedAt = Math.floor(Date.UTC(2026, 2, 30, 12, 0, 0) / 1000);
    const existing = {
      generated_at: existingGeneratedAt,
      digest_title: "Weekly Calm",
      digest_text: "A stored weekly digest.",
      digest_extended: VALID_WEEKLY_EXTENDED,
      digest_meta: JSON.stringify({
        type: "weekly",
        telegramDelivered: true,
        telegramDeliveryStatus: "ok",
      }),
    };
    const db = mockD1([
      {
        match: "SELECT generated_at, digest_title, digest_text, digest_extended, digest_meta",
        rows: [existing],
        first: existing,
      },
    ], { requireMatch: true });

    const result = await generateWeeklyRecap(db, "anthropic-key", null, null);

    expect(result.status).toBe("skipped_neutral");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "weekly-recap-exists",
      skipped: "weekly-recap-exists",
      existingGeneratedAt,
    });
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();
  });

  it.each([
    "failed: Error: Telegram digest failed_permanent: stale_safety_identity:identity-mismatch",
    "queued: execution_unknown",
  ])("does not auto-retry an operator-terminal weekly outbox row (%s)", async (telegramDeliveryStatus) => {
    const existingGeneratedAt = Math.floor(Date.UTC(2026, 2, 30, 12, 0, 0) / 1000);
    const existing = {
      generated_at: existingGeneratedAt,
      digest_title: "Weekly Terminal",
      digest_text: "A stored weekly digest.",
      digest_extended: VALID_WEEKLY_EXTENDED,
      digest_meta: JSON.stringify({
        type: "weekly",
        telegramDelivered: false,
        telegramDeliveryStatus,
      }),
    };
    const db = mockD1([
      {
        match: "SELECT generated_at, digest_title, digest_text, digest_extended, digest_meta",
        rows: [existing],
        first: existing,
      },
    ], { requireMatch: true });

    const result = await generateWeeklyRecap(
      db,
      "anthropic-key",
      null,
      { botToken: "bot", chatId: "chat" },
    );

    expect(result.status).toBe("skipped_neutral");
    expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
    expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();
    expect(db.getHistory().some((entry) => entry.sql.includes("SET digest_meta = ?"))).toBe(false);
  });

  it("preserves blocked quality-gate metadata when Telegram delivery is skipped", async () => {
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse({
      text: "PSI softened by 4 points while USDT stayed near peg and blacklist activity kept tapping the glass, but this hook deliberately runs long enough to trip the hard tweet length validator so the weekly recap remains stored only for operator inspection and must not be published publicly from archive reads.",
    }));

    const result = await generateWeeklyRecap(
      db,
      "anthropic-key",
      null,
      { botToken: "bot", chatId: "chat" },
    );

    expect(result.status).toBe("degraded");
    expect(result.metadata).toContain("telegram: skipped: quality-gate");
    expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
    expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO daily_digest"));
    const insertedMeta = JSON.parse(String(insert?.binds[5])) as Record<string, unknown>;
    expect(insertedMeta.qualityGate).toBe("blocked");

    const update = db.getHistory().find((entry) => entry.sql.includes("SET digest_meta = ?"));
    const finalMeta = JSON.parse(String(update?.binds[0])) as Record<string, unknown>;
    expect(finalMeta).toMatchObject({
      qualityGate: "blocked",
      telegramDelivered: false,
      telegramDeliveryStatus: "skipped: quality-gate",
    });
  });

  it("blocks weekly copy that makes grade claims while safety context is unavailable", async () => {
    vi.mocked(loadDigestSafetyContext).mockResolvedValueOnce({
      status: "unavailable",
      expectedModel: "v9",
      identity: null,
      publishedAt: null,
      reason: "v9-snapshot-unavailable",
    });
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());

    const result = await generateWeeklyRecap(
      db,
      "anthropic-key",
      null,
      { botToken: "bot", chatId: "chat" },
    );

    expect(result.status).toBe("degraded");
    expect(result.metadata).toContain("unbound-safety-copy:hard");
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
    expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO daily_digest"));
    expect(JSON.parse(String(insert?.binds[5]))).toMatchObject({
      qualityGate: "blocked",
      safetyContext: {
        status: "unavailable",
        reason: "v9-snapshot-unavailable",
      },
    });
  });

  it("repairs unbound weekly copy during the standard corrective retry", async () => {
    vi.mocked(loadDigestSafetyContext).mockResolvedValueOnce({
      status: "unavailable",
      expectedModel: "v9",
      identity: null,
      publishedAt: null,
      reason: "v9-snapshot-unavailable",
    });
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(fetchWithRetry)
      .mockResolvedValueOnce(weeklyClaudeResponse())
      .mockResolvedValueOnce(weeklyClaudeResponse({
        extended: VALID_WEEKLY_EXTENDED.replace("grade transitions", "risk transitions"),
      }));

    const result = await generateWeeklyRecap(db, "anthropic-key", null, null);

    expect(result.itemCount).toBe(1);
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(result.metadata).not.toContain("unbound-safety-copy");
    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO daily_digest"));
    expect(JSON.parse(String(insert?.binds[5]))).not.toMatchObject({ qualityGate: "blocked" });
    const firstRequest = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(firstRequest.messages[0]?.content).toContain("Editorial omission:");
    expect(firstRequest.messages[0]?.content).not.toContain("Safety source unavailable");
  });

  it("stores failed Telegram delivery state so the weekly row can be retried", async () => {
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());
    vi.mocked(deliverTelegramDigestEdition).mockResolvedValueOnce({
      editionKey: "weekly:2026-03-30",
      state: "pending",
      outcome: "pending",
      chunksSent: 0,
      nextChunkIndex: 0,
      chunkCount: 1,
      errorClass: "server_error",
      retryAfterSec: null,
    });

    const result = await generateWeeklyRecap(
      db,
      "anthropic-key",
      null,
      { botToken: "bot", chatId: "chat" },
    );

    expect(result.status).toBe("degraded");
    expect(result.metadata).toContain("telegram: failed:");
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1);
    expect(deliverTelegramDigestEdition).toHaveBeenCalledTimes(1);

    const update = db.getHistory().find((entry) => entry.sql.includes("SET digest_meta = ?"));
    const finalMeta = JSON.parse(String(update?.binds[0])) as Record<string, unknown>;
    expect(finalMeta.telegramDelivered).toBe(false);
    expect(finalMeta.telegramDeliveryStatus).toMatch(/^failed:/);
  });

  it("retries an existing generated weekly recap when Telegram was not delivered", async () => {
    const existingGeneratedAt = Math.floor(Date.UTC(2026, 2, 30, 12, 0, 0) / 1000);
    const existing = {
      generated_at: existingGeneratedAt,
      digest_title: "Weekly Calm",
      digest_text: "A stored weekly digest awaits delivery.",
      digest_extended: VALID_WEEKLY_EXTENDED,
      digest_meta: JSON.stringify({
        type: "weekly",
        periodType: "trailing-daily-editions",
        weekStart: "2026-03-24",
        weekEnd: "2026-03-28",
        telegramDelivered: false,
        telegramDeliveryStatus: "failed: telegram down",
      }),
    };
    const db = mockD1([
      {
        match: "SELECT generated_at, digest_title, digest_text, digest_extended, digest_meta",
        rows: [existing],
        first: existing,
      },
      {
        match: "SET digest_meta = ?",
        rows: [],
      },
    ], { requireMatch: true });

    const result = await generateWeeklyRecap(
      db,
      "anthropic-key",
      null,
      { botToken: "bot", chatId: "chat" },
    );

    expect(result.itemCount).toBe(0);
    expect(result.metadata).toContain("existing recap delivery retry");
    expect(result.metadata).toContain("telegram: ok");
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO daily_digest"))).toBe(false);
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        title: "Weekly Recap: Weekly Calm",
        extended: VALID_WEEKLY_EXTENDED,
        date: "2026-03-30-weekly",
      }),
      undefined,
    );
    const update = db.getHistory().find((entry) => entry.sql.includes("SET digest_meta = ?"));
    const finalMeta = JSON.parse(String(update?.binds[0])) as Record<string, unknown>;
    expect(finalMeta).toMatchObject({
      telegramDelivered: true,
      telegramDeliveryStatus: "ok",
      weekStart: "2026-03-24",
    });
  });

  it("repairs non-JSON weekly output with a corrective retry", async () => {
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      mockAnthropicStreamResponse(
        "USDT stayed at 1.00 all week, blacklist pressure faded, and weekly flows stayed calm.",
      ),
    );
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());

    const result = await generateWeeklyRecap(db, "anthropic-key", null, null);

    expect(result.itemCount).toBe(1);
    expect(result.status).toBeUndefined();
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO daily_digest"));
    expect(insert).toBeTruthy();
    expect(insert?.binds[1]).toBe("PSI softened by 4 points while USDT stayed near peg and blacklist activity kept tapping the glass.");
    expect(insert?.binds[2]).toBe("Weekly Calm");
  });

  it("prints N/A for weekly market-cap change when the week starts from zero", async () => {
    const zeroStartRows = buildDailyRows();
    zeroStartRows[0] = {
      ...zeroStartRows[0]!,
      input_data: JSON.stringify({
        ...JSON.parse(zeroStartRows[0]!.input_data),
        totalMcapUsd: 0,
      }),
    };

    const db = mockD1(makeTables({ dailyRows: zeroStartRows }), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse({ title: "Zero Base Week" }));

    await generateWeeklyRecap(db, "anthropic-key", null, null);

    const anthropicRequest = vi.mocked(fetchWithRetry).mock.calls[0];
    const body = anthropicRequest?.[1]?.body;
    expect(typeof body).toBe("string");
    expect(body).toContain("(N/A)");
    expect(body).not.toContain("Infinity");
  });

  it("includes week-over-week deltas in prompt when prior week data exists", async () => {
    const current = buildDailyRows();
    const prior = buildDailyRows().map((row, i) => ({
      ...row,
      generated_at: row.generated_at - 7 * 86_400,
      input_data: JSON.stringify({
        ...(JSON.parse(row.input_data) as Record<string, unknown>),
        totalMcapUsd: 99_000_000 + i * 1_000_000,
        stabilityIndex: { score: 92 - i, band: "BEDROCK" },
      }),
    }));

    const db = mockD1([
      {
        match: "SELECT id FROM daily_digest WHERE generated_at >= ? AND json_extract(digest_meta, '$.type') = 'weekly'",
        first: null,
        rows: [],
      },
      {
        match: "digest_meta, input_data",
        first: null,
        rows: [],
      },
      { match: "SELECT digest_title, digest_text, digest_meta", rows: [] },
      { match: "UPDATE daily_digest", rows: [] },
      {
        match: "WHERE generated_at >= ? AND (digest_meta IS NULL",
        rows: [...prior, ...current],
      },
      { match: "INSERT INTO daily_digest", rows: [] },
    ]);
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());

    await generateWeeklyRecap(db, "anthropic-key", null, null);

    const body = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[0].content).toContain("Week-over-week deltas");
    expect(body.messages[0].content).toMatch(/mcap: current .+ prior .+ delta/i);
    expect(body.messages[0].content).toMatch(/PSI midpoint: current .+ prior .+/i);
  });

  it("filters malformed grade transitions before building the weekly risk leaderboard", async () => {
    const rows = buildDailyRows();
    rows[1] = {
      ...rows[1]!,
      input_data: JSON.stringify({
        ...(JSON.parse(rows[1]!.input_data) as Record<string, unknown>),
        gradeTransitions: [{ mcapUsd: 1_000_000 }],
      }),
    };
    rows[2] = {
      ...rows[2]!,
      input_data: JSON.stringify({
        ...(JSON.parse(rows[2]!.input_data) as Record<string, unknown>),
        gradeTransitions: [{
          historyId: "history:usdt:1",
          recordedAt: rows[2]!.generated_at,
          model: "v8",
          safetyScoreIdentity: safetyContext.identity,
          symbol: "USDT",
          fromGrade: "A",
          toGrade: "B",
          fromScore: 90,
          toScore: 80,
          currentDimensions: { peg: 95, liq: 80, resilience: null, decentralization: null },
          mcapUsd: 2_000_000,
        }],
      }),
    };
    const db = mockD1(makeTables({ dailyRows: rows }), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());

    await expect(generateWeeklyRecap(db, "anthropic-key", null, null)).resolves.toMatchObject({ itemCount: 1 });

    const body = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      messages: { content: string }[];
    };
    const prompt = body.messages[0].content;
    expect(prompt).toContain("USDT grade fell to B");
    expect(prompt).not.toContain("undefined: grade undefined");
  });

  it("selects the latest daily row per UTC date before limiting the weekly input window", async () => {
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());

    await generateWeeklyRecap(db, "anthropic-key", null, null);

    const dailySelection = db.getHistory().find((entry) => entry.sql.includes("latest_daily"));
    expect(dailySelection?.sql).toContain("ROW_NUMBER() OVER");
    expect(dailySelection?.sql).toContain("PARTITION BY strftime('%Y-%m-%d', generated_at, 'unixepoch')");
    expect(dailySelection?.sql).toContain("WHERE row_rank = 1");
    expect(dailySelection?.sql).toContain("LIMIT 15");
  });

  it("surfaces critical weekly depegs in the risk leaderboard and spike metrics", async () => {
    const rows = buildDailyRows();
    const criticalRowIndex = 2;
    const criticalStartedAt = rows[criticalRowIndex]!.generated_at - 3600;
    rows[criticalRowIndex] = {
      ...rows[criticalRowIndex]!,
      input_data: JSON.stringify({
        ...(JSON.parse(rows[criticalRowIndex]!.input_data) as Record<string, unknown>),
        activeDepegCount: 1,
        topDepegs: [{
          stablecoinId: "pmusd-protocol",
          symbol: "PMUSD",
          bps: -5284,
          direction: "below",
          mcapUsd: 65_000_000,
          startedAt: criticalStartedAt,
          impactScore: 343.5,
        }],
      }),
    };
    const expectedLeadId = `weekly:depeg:pmusd-protocol:${criticalStartedAt}`;
    const criticalExtended = VALID_WEEKLY_EXTENDED.replace(
      "PSI opened",
      "PMUSD spent Thursday 5284 bps below peg on $65M while PSI opened",
    );
    const db = mockD1(makeTables({ dailyRows: rows }), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse({
      title: "Weekly Depeg Lead",
      text: "PMUSD's 5284 bps depeg took the weekly lead while PSI only framed the regime.",
      extended: criticalExtended,
      meta: {
        leadSignalId: expectedLeadId,
        lead: "depeg",
        tone: "forensic",
        coins: ["PMUSD"],
        usedCandidateIds: [expectedLeadId],
      },
    }));

    const result = await generateWeeklyRecap(db, "anthropic-key", null, null);

    expect(result.status).toBeUndefined();
    const body = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[0].content).toContain("Weekly Risk Leaderboard");
    expect(body.messages[0].content).toContain("Weekly spike metrics");
    expect(body.messages[0].content).toContain(expectedLeadId);
    expect(body.messages[0].content).toContain("PMUSD");
    expect(body.messages[0].content).toContain("Worst depeg by bps");
  });

  it("orders the weekly risk leaderboard by suppression, criticality, severity, then impact", async () => {
    const rows = buildDailyRows();
    const baseInput = JSON.parse(rows[2]!.input_data) as Record<string, unknown>;
    rows[2] = {
      ...rows[2]!,
      input_data: JSON.stringify({
        ...baseInput,
        activeDepegCount: 3,
        topDepegs: [
          {
            stablecoinId: "critical-small",
            symbol: "CRIT",
            bps: -2_500,
            direction: "below",
            mcapUsd: 75_000_000,
            startedAt: rows[2]!.generated_at - 3_600,
            impactScore: 120,
          },
          {
            stablecoinId: "noncritical-large",
            symbol: "BIG",
            bps: -900,
            direction: "below",
            mcapUsd: 5_000_000_000,
            startedAt: rows[2]!.generated_at - 1_800,
            impactScore: 4_500,
          },
          {
            stablecoinId: "suppressed-critical",
            symbol: "SUP",
            bps: -2_500,
            direction: "below",
            mcapUsd: 3_000_000_000,
            startedAt: rows[2]!.generated_at - 900,
            impactScore: 7_500,
            suppressReason: "known bad upstream quote",
          },
        ],
      }),
    };
    const db = mockD1(makeTables({ dailyRows: rows }), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());

    await generateWeeklyRecap(db, "anthropic-key", null, null);

    const body = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      messages: { content: string }[];
    };
    const prompt = body.messages[0].content;
    const criticalIndex = prompt.indexOf("weekly:depeg:critical-small");
    const noncriticalIndex = prompt.indexOf("weekly:depeg:noncritical-large");
    const suppressedIndex = prompt.indexOf("weekly:depeg:suppressed-critical");

    expect(criticalIndex).toBeGreaterThan(-1);
    expect(noncriticalIndex).toBeGreaterThan(-1);
    expect(suppressedIndex).toBeGreaterThan(-1);
    expect(criticalIndex).toBeLessThan(noncriticalIndex);
    expect(noncriticalIndex).toBeLessThan(suppressedIndex);
    expect(prompt).toContain("weekly:depeg:suppressed-critical");
    expect(prompt).toContain("suppress: known bad upstream quote");
  });

  it("normalizes weekly meta lead and tone through the allowlist", async () => {
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse({
      meta: {
        leadSignalId: "wk:arc",
        lead: "Week narrative about USDC flow rotation accelerating mid-week",
        tone: "structurally-concerned-sardonic",
        coins: ["USDC"],
      },
    }));

    await generateWeeklyRecap(db, "anthropic-key", null, null);

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO daily_digest"));
    expect(insert).toBeTruthy();
    const metaStored = JSON.parse(String(insert?.binds[5])) as Record<string, unknown>;
    expect(metaStored.lead).toBe("other");
    expect(metaStored.tone).toBe("other");
    expect(metaStored.type).toBe("weekly");
  });

  it("skips generation cleanly when the Anthropic circuit is open", async () => {
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);

    const result = await generateWeeklyRecap(db, "anthropic-key", null, null);

    expect(result).toEqual({ metadata: "skipped: anthropic circuit open" });
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();
  });
});
