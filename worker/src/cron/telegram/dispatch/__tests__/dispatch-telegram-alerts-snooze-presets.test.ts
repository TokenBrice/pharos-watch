import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDispatchSnapshots } from "./dispatch-telegram-snapshots.test-support";
import { ALERT_RESERVE_SOURCE_GENERATION } from "../../../../lib/alert-reserve-source-cache";
import {
  cleanupDispatchTelegramAlertsTest,
  createDispatchHarness as createBaseDispatchHarness,
  dispatchTelegramAlerts,
  mockSendToChat,
  parseLogRecords,
  readCacheValue,
  resetDispatchTelegramAlertsTest,
  scriptTelegramDeliveries,
  STABLECOINS_CACHE_WITH_USDC,
  telegramDeliveryTranscript,
} from "./dispatch-telegram-alerts.test-support";

// Snooze/preset scenarios require published DEWS, not pointerless diagnostic rows.
// Keep admission local so the base harness can still exercise unavailable publications.
function createDispatchHarness(...args: Parameters<typeof createBaseDispatchHarness>) {
  const harness = createBaseDispatchHarness(...args);
  const seed = harness.seed;
  harness.seed = (input) => {
    seed(input);
    if (input.dews?.length) {
      const computedAt = Math.max(...input.dews.map((row) => row.computedAt ?? Math.floor(Date.now() / 1000)));
      harness.cache("dews:published-generation", {
        updatedAt: computedAt,
        source: "compute-dews",
        publishStatus: "published",
      }, computedAt);
    }
  };
  return harness;
}

// Durable counter read by `telegramBot.presetQueryFailures`
// (worker/src/lib/status/telegram-bot-stats.ts).
const PRESET_QUERY_FAILURE_CACHE_KEY = "telegram:preset-query-failure-count";

function readPersistedPresetFailureCount(harness: ReturnType<typeof createDispatchHarness>): number {
  return Number(readCacheValue(harness.sqlite, PRESET_QUERY_FAILURE_CACHE_KEY) ?? "0");
}

function sources(
  harness: ReturnType<typeof createDispatchHarness>,
  options: {
    dews?: Record<string, string>;
    dewsAlertable?: Record<string, string>;
    depeg?: Record<string, unknown>;
    reserve?: unknown;
    reserveDispatched?: string[];
    reserveObserved?: Record<string, number>;
    safety?: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>;
  } = {},
) {
  seedDispatchSnapshots(harness, { ...options, safetySource: options.safety });
}

/** A fresh depeg baseline plus a preset follower whose membership needs the cache. */
function seedPresetFollowerWithDepeg(harness: ReturnType<typeof createDispatchHarness>): void {
  const now = Math.floor(Date.now() / 1000);
  sources(harness, { depeg: {} });
  harness.seed({
    depegs: [
      {
        stablecoinId: "usdc-circle",
        symbol: "USDC",
        direction: "below",
        peakDeviationBps: 125,
        startedAt: now - 300,
      },
    ],
    subscribers: [{ chatId: "preset-chat" }],
    presets: [{ chatId: "preset-chat", presetId: "usd-top25", alerts: { depeg: true } }],
  });
}

function dewsDirect(chatId: string, options: Record<string, unknown> = {}) {
  return {
    dews: [{ stablecoinId: "usdc-circle", signals: { supply: { value: 45, available: true } } }],
    subscribers: [{ chatId, ...((options.subscriber as object) ?? {}) }],
    subscriptions: [
      { chatId, stablecoinId: "usdc-circle", alerts: { dews: true }, ...((options.subscription as object) ?? {}) },
    ],
  };
}

describe("dispatchTelegramAlerts", () => {
  beforeEach(resetDispatchTelegramAlertsTest);
  afterEach(cleanupDispatchTelegramAlertsTest);

  it("attaches snooze inline keyboard to every fresh subscriber alert", async () => {
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed(dewsDirect("42"));
    await dispatchTelegramAlerts(harness.db, "bot-token");
    const keyboard = telegramDeliveryTranscript[0]?.options.replyMarkup as {
      inline_keyboard?: Array<Array<{ callback_data?: string }>>;
    };
    const callbackData = keyboard.inline_keyboard?.flat().map((button) => button.callback_data);

    expect(callbackData).toContain("coinsnooze:usdc-circle:24h");
    expect(callbackData).toContain("snooze:4h");
    expect(callbackData).toContain("fewer:usdc-circle:db:W");
    expect(callbackData).not.toContain("status:usdc-circle");
    expect(keyboard.inline_keyboard?.length).toBeLessThanOrEqual(2);
    expect(telegramDeliveryTranscript[0]?.html).toContain("<i>Via your watchlist · stress alerts</i>");
  });

  it("skips a chat whose alert_snooze_until_ts is in the future and reports chatsWithActiveSnooze", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      subscribers: [
        { chatId: "A", snoozeUntil: now + 3_600 },
        { chatId: "B" },
      ],
      subscriptions: [
        { chatId: "A", stablecoinId: "usdc-circle", alerts: { dews: true } },
        { chatId: "B", stablecoinId: "usdc-circle", alerts: { dews: true } },
      ],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ messagesSent: 1, chatsWithActiveSnooze: 1 });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "B" })]);
  });

  it("skips a global subscriber for a coin with an active per-coin snooze (P1-U10)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      subscribers: [{ chatId: "C", global: { dews: true } }],
      subscriptions: [{ chatId: "C", stablecoinId: "usdc-circle", snoozeUntil: now + 3_600 }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.messagesSent).toBe(0);
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("deduplicates 403 cleanup for a chat hit across multiple alert types", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      depegs: [{ stablecoinId: "usdc-circle" }],
      subscribers: [
        {
          chatId: "42",
          global: { dews: true, depeg: true },
          consecutiveBlockCount: 1,
          consecutiveBlockFirstAt: now - 60,
        },
      ],
    });
    scriptTelegramDeliveries({
      ok: false,
      blocked: true,
      retryable: false,
      permanentFailure: true,
      statusCode: 403,
      errorClass: "blocked",
      delivery: "blocked",
      retryAfterSec: null,
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.blockedUsersCleanedUp).toBe(1);
    expect(
      harness.sqlite.prepare("SELECT alert_dews, alert_depeg FROM telegram_subscribers WHERE chat_id = '42'").get(),
    ).toEqual({ alert_dews: 0, alert_depeg: 0 });
  });

  it("does not resolve dynamic presets when no preset subscriber rows exist", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.cache("stablecoins", STABLECOINS_CACHE_WITH_USDC);
    harness.seed(dewsDirect("direct-chat"));
    try {
      const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);
      expect(metadata).toMatchObject({
        presetFailure: false,
        presetQueryFailures: 0,
        presetResolutionFailures: 0,
        subscribersNotified: 1,
        messagesSent: 1,
        noWorkRun: false,
      });
      expect(metadata).not.toHaveProperty("planningRowsWritten");
      expect(metadata).not.toHaveProperty("d1RowsWritten");
      expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "direct-chat" })]);
      expect(parseLogRecords(warnSpy).some((record) => record.action === "preset-resolution")).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("records and persists per-mode preset failure counters when preset resolution fails closed", async () => {
    const harness = createDispatchHarness();
    seedPresetFollowerWithDepeg(harness);
    // No `stablecoins` cache: resolveTelegramPresetTargets cannot resolve the
    // follower's preset, so the alert fan-out page fails closed.
    expect(readCacheValue(harness.sqlite, "stablecoins")).toBeNull();

    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.deliveryV2.jobsFailedClosed).toBe(1);
    expect(metadata.presetFailure).toBe(true);
    expect(metadata.presetQueryFailures + metadata.presetResolutionFailures).toBeGreaterThanOrEqual(1);
    // /api/status.telegramBot.presetQueryFailures reads this durable counter.
    expect(readPersistedPresetFailureCount(harness)).toBeGreaterThanOrEqual(1);
    expect(harness.sqlite.prepare("SELECT state FROM telegram_jobs WHERE kind = 'alert'").get())
      .toEqual({ state: "planning" });
  });

  it("clears the preset failure counters on the next clean run", async () => {
    const harness = createDispatchHarness();
    seedPresetFollowerWithDepeg(harness);
    await dispatchTelegramAlerts(harness.db, "bot-token");
    expect(readPersistedPresetFailureCount(harness)).toBeGreaterThanOrEqual(1);

    // The cache becomes readable again; the retried planning job loads presets cleanly.
    harness.cache("stablecoins", STABLECOINS_CACHE_WITH_USDC);
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.deliveryV2.jobsFailedClosed).toBe(0);
    expect(metadata.presetFailure).toBe(false);
    expect(metadata.presetQueryFailures).toBe(0);
    expect(metadata.presetResolutionFailures).toBe(0);
    expect(readPersistedPresetFailureCount(harness)).toBe(0);
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "preset-chat" })]);
  });

  it("chunks a 120-coin depeg fan-out for one chat without losing coin identities", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinIds = Array.from({ length: 120 }, (_, index) => `scale-depeg-${index.toString().padStart(3, "0")}`);
    const harness = createDispatchHarness();
    sources(harness);
    harness.seed({
      depegs: stablecoinIds.map((stablecoinId, index) => ({
        stablecoinId,
        symbol: `SD${index}`,
        peakDeviationBps: 150 + (index % 50),
      })),
      subscribers: [
        { chatId: "mega-chat", lastActiveAt: now },
      ],
      subscriptions: stablecoinIds.map((stablecoinId) => ({
        chatId: "mega-chat",
        stablecoinId,
        alerts: { depeg: true },
      })),
    });
    let metadata: Record<string, unknown> = {};
    for (let cycle = 0; cycle < 10; cycle++) {
      if (cycle > 0) vi.advanceTimersByTime(121_000);
      metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);
      if (metadata.cappedAtLimit !== true) break;
    }
    // Sent rows drop their body, so read the delivered chunks from the transport transcript.
    const megaMessages = harness.sqlite
      .prepare("SELECT seq AS chunk_index FROM telegram_deliveries WHERE chat_id = ? ORDER BY seq")
      .all("mega-chat")
      .map((row, index) => ({
        chunk_index: (row as { chunk_index: number }).chunk_index,
        html: telegramDeliveryTranscript[index]?.html ?? "",
      }));
    const targetCount = harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_deliveries").get() as {
      count: number;
    };

    expect(metadata.eventsDetected).toMatchObject({ depeg: 120, depegTriggered: 120 });
    expect(metadata.cappedAtLimit).toBe(false);
    expect(megaMessages.length).toBeGreaterThan(1);
    expect(megaMessages.every((message) => message.html.length <= 4000)).toBe(true);
    expect(megaMessages.map((message) => message.chunk_index).sort((a, b) => a - b)).toEqual(
      Array.from({ length: megaMessages.length }, (_, index) => index),
    );
    expect(targetCount.count).toBe(megaMessages.length);
    for (let index = 0; index < stablecoinIds.length; index++) {
      expect(megaMessages.map((message) => message.html).join("\n")).toContain(`SD${index}`);
    }
    expect(readCacheValue(harness.sqlite, "telegram:dispatch-overflow-plan")).toBeNull();
  }, 90_000);

  it("never detects or sends retired launch alerts, even for legacy launch opt-ins", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness, { dewsAlertable: {} });
    // A legacy baseline that still lists a now-active coin as pre-launch.
    harness.cache("alert:launch-snapshot", ["usdc-circle"], now - 60);
    harness.seed({
      subscribers: [{ chatId: "555", global: { launch: true } }],
      subscriptions: [{ chatId: "555", stablecoinId: "usdc-circle", alerts: { launch: true } }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ subscribersNotified: 0, messagesSent: 0 });
    expect(metadata.eventsDetected.launch ?? 0).toBe(0);
    expect(telegramDeliveryTranscript).toEqual([]);
    // The retired baseline key is left as-is (no longer read or written).
    expect(JSON.parse(readCacheValue(harness.sqlite, "alert:launch-snapshot") ?? "[]")).toEqual(["usdc-circle"]);
  });

  it("does not reset the reserve baseline when the producer snapshot is corrupt", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness, { dewsAlertable: {}, reserve: "{", reserveDispatched: ["usdc-circle"], safety: {} });
    const cycle1 = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);
    expect(cycle1).toMatchObject({
      eventlessFastPath: true,
      reserveSourceUnavailable: true,
      eventsDetected: { reserve: 0 },
    });
    expect(JSON.parse(readCacheValue(harness.sqlite, "alert:reserve-dispatched-snapshot") ?? "[]")).toEqual([
      "usdc-circle",
    ]);
    harness.cache(
      "alert:reserve-snapshot",
      { generation: ALERT_RESERVE_SOURCE_GENERATION, publishedAt: now, continuous: false, driftIds: ["usdc-circle"], observedSince: { "usdc-circle": now }, unavailableIds: [] },
      now,
    );
    const cycle2 = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(cycle2).toMatchObject({
      eventlessFastPath: true,
      reserveSourceUnavailable: true,
      reserveAlertSourceState: "recovering",
      eventsDetected: { reserve: 0 },
    });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("delivers a new detected event when a depeg closes and reopens between snapshots", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness, {
      depeg: {
        "usdc-circle": {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          direction: "below",
          deviationBps: 120,
          price: 0.988,
          pegReference: 1,
          eventId: 1,
        },
      },
    });
    harness.seed({
      depegs: [
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          direction: "below",
          peakDeviationBps: 120,
          startedAt: now - 1_800,
          endedAt: now - 60,
          recoveryPrice: 1,
        },
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          direction: "below",
          peakDeviationBps: 90,
          startPrice: 0.991,
          startedAt: now - 30,
        },
      ],
      subscribers: [{ chatId: "12345" }],
      subscriptions: [{ chatId: "12345", stablecoinId: "usdc-circle", alerts: { depeg: true } }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({
      eventsDetected: { depegTriggered: 1, depegResolved: 0, depegWorsening: 0 },
      subscribersNotified: 1,
      messagesSent: 1,
    });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "12345" })]);
    expect(
      harness.sqlite.prepare("SELECT kind, families, state FROM telegram_deliveries").get(),
    ).toMatchObject({ kind: "alert", families: "depeg", state: "sent" });
  });
});

// These transport scenarios need accepted DEWS, not pointerless diagnostic rows.
// Keep acceptance local to this suite so unavailable-source fixtures stay explicit.
function createBackoffDispatchHarness() {
  const harness = createBaseDispatchHarness();
  const seed = harness.seed;
  harness.seed = (input) => {
    seed(input);
    if (input.dews?.length) {
      const computedAt = Math.max(...input.dews.map((row) => row.computedAt ?? Math.floor(Date.now() / 1000)));
      harness.cache("dews:published-generation", {
        updatedAt: computedAt,
        source: "compute-dews",
        publishStatus: "published",
      }, computedAt);
    }
  };
  return harness;
}


describe("dispatchTelegramAlerts", () => {
  beforeEach(resetDispatchTelegramAlertsTest);
  afterEach(cleanupDispatchTelegramAlertsTest);

  it("records a fresh-send chat_not_found first strike without deactivating the subscriber", async () => {
    const harness = createBackoffDispatchHarness();
    seedDispatchSnapshots(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      subscribers: [{ chatId: "99999" }],
      subscriptions: [{ chatId: "99999", stablecoinId: "usdc-circle", alerts: { dews: true } }],
    });
    scriptTelegramDeliveries({
      ok: false,
      blocked: true,
      retryable: false,
      permanentFailure: true,
      statusCode: 400,
      errorClass: "chat_not_found",
      delivery: "blocked",
      retryAfterSec: null,
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.blockedUsersCleanedUp).toBe(0);
    expect(
      harness.sqlite
        .prepare("SELECT consecutive_block_count, alert_dews FROM telegram_subscribers WHERE chat_id = '99999'")
        .get(),
    ).toEqual({ consecutive_block_count: 1, alert_dews: 0 });
    expect(
      harness.sqlite.prepare("SELECT alert_dews FROM telegram_subscriptions WHERE chat_id = '99999'").get(),
    ).toEqual({ alert_dews: 1 });
  });

  it("deactivates a fresh-send chat_not_found subscriber only on the second strike", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createBackoffDispatchHarness();
    seedDispatchSnapshots(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      subscribers: [{ chatId: "99999", direct: { launch: true }, global: { launch: true }, consecutiveBlockCount: 1, consecutiveBlockFirstAt: now - 60 }],
      subscriptions: [{ chatId: "99999", stablecoinId: "usdc-circle", alerts: { dews: true, launch: true } }],
    });
    expect(harness.sqlite.prepare("SELECT alert_launch, global_alert_launch FROM telegram_subscribers WHERE chat_id = '99999'").get())
      .toEqual({ alert_launch: 1, global_alert_launch: 1 });
    expect(harness.sqlite.prepare("SELECT alert_launch FROM telegram_subscriptions WHERE chat_id = '99999'").get())
      .toEqual({ alert_launch: 1 });
    scriptTelegramDeliveries({
      ok: false,
      blocked: true,
      retryable: false,
      permanentFailure: true,
      statusCode: 400,
      errorClass: "chat_not_found",
      delivery: "blocked",
      retryAfterSec: null,
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.blockedUsersCleanedUp).toBe(1);
    expect(
      harness.sqlite
        .prepare(
          "SELECT alert_dews, alert_launch, global_alert_launch FROM telegram_subscribers WHERE chat_id = '99999'",
        )
        .get(),
    ).toEqual({ alert_dews: 0, alert_launch: 0, global_alert_launch: 0 });
    expect(
      harness.sqlite.prepare("SELECT alert_dews, alert_launch FROM telegram_subscriptions WHERE chat_id = '99999'").get(),
    ).toEqual({ alert_dews: 0, alert_launch: 0 });

    const attemptedAtDisable = mockSendToChat.mock.calls.length;
    vi.advanceTimersByTime(121_000);
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", score: 92, band: "DANGER", computedAt: now + 121 }],
    });

    const nextMetadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);
    expect(nextMetadata).toMatchObject({
      eventsDetected: { dews: 1 },
      subscribersNotified: 0,
      messagesSent: 0,
    });
    expect(mockSendToChat).toHaveBeenCalledTimes(attemptedAtDisable);
    expect(
      harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_deliveries WHERE chat_id = '99999' AND state IN ('pending', 'retry')").get(),
    ).toEqual({ count: 0 });
  });

  // This case is the file's whole runtime (6.45s of 7.95s, measured 2026-09-09),
  // and the 3,665-subscriber burst is load-bearing: it is the smallest burst
  // above the production format budget, so a smaller one would make the
  // per-cycle bound below trivially true. The cost is production-side and
  // superlinear in the burst — per-flush target-plan verification (2.43s over
  // 204 correlated-count reads of the generation's target rows) plus per-send
  // job-counter reconciliation that re-aggregates every target of the job
  // (2.35s over 916 transition batches). The same file at 400 subscribers costs
  // 194ms, and the only phase seeding could skip (subscriber capture) is 110ms,
  // so pre-seeding target-plan state does not pay here.
  it("emits worsening depeg alerts when the configured bps step is crossed", async () => {
    const harness = createBackoffDispatchHarness();
    seedDispatchSnapshots(harness, {
      depeg: {
        "usdc-circle": {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          direction: "below",
          deviationBps: 120,
          price: 0.988,
          pegReference: 1,
        },
      },
    });
    harness.seed({
      depegs: [{ stablecoinId: "usdc-circle", peakDeviationBps: 260, startPrice: 0.974 }],
      subscribers: [{ chatId: "12345" }],
      subscriptions: [
        { chatId: "12345", stablecoinId: "usdc-circle", alerts: { depeg: true }, depegWorseningBpsStep: 100 },
      ],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected.depegWorsening).toBe(1);
    expect(telegramDeliveryTranscript[0]?.html).toContain("depeg deepened");
  });

  it("renders the active depeg peak price when a worsening event moved far past its opening price", async () => {
    const harness = createBackoffDispatchHarness();
    seedDispatchSnapshots(harness, {
      depeg: {
        "usdc-circle": {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          direction: "below",
          deviationBps: 3800,
          price: 0.62,
          pegReference: 1,
        },
      },
    });
    harness.seed({
      depegs: [{
        stablecoinId: "usdc-circle",
        peakDeviationBps: -5940,
        startPrice: 0.9884,
        peakPrice: 0.406,
      }],
      subscribers: [{ chatId: "12345" }],
      subscriptions: [
        { chatId: "12345", stablecoinId: "usdc-circle", alerts: { depeg: true }, depegWorseningBpsStep: 100 },
      ],
    });

    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected.depegWorsening).toBe(1);
    expect(telegramDeliveryTranscript[0]?.html).toContain("depeg deepened to 59.4% below $1.00 ($0.4060)");
    expect(telegramDeliveryTranscript[0]?.html).toContain("Was 38.0% at the previous check");
    expect(telegramDeliveryTranscript[0]?.html).not.toContain("$0.9884");
  });

  it("does not call an unalerted intermediate peak the chat's last alert", async () => {
    const harness = createBackoffDispatchHarness();
    seedDispatchSnapshots(harness);
    harness.seed({
      depegs: [{
        stablecoinId: "usdc-circle", symbol: "USDC", direction: "below",
        peakDeviationBps: 510, startPrice: 0.949, peakPrice: 0.949,
      }],
      subscribers: [{ chatId: "12345" }],
      subscriptions: [{
        chatId: "12345", stablecoinId: "usdc-circle", alerts: { depeg: true }, depegWorseningBpsStep: 500,
      }],
    });

    // 5.1% opens the 500 bps bucket: the chat is alerted at 5.1%.
    await dispatchTelegramAlerts(harness.db, "bot-token");
    expect(telegramDeliveryTranscript).toHaveLength(1);
    expect(telegramDeliveryTranscript[0]?.html).toContain("5.1% below $1.00");

    // 9.9% stays inside the same bucket: not alerted, but the snapshot baseline advances.
    vi.advanceTimersByTime(300_000);
    harness.sqlite
      .prepare("UPDATE depeg_events SET peak_deviation_bps = ?, peak_price = ? WHERE stablecoin_id = ?")
      .run(990, 0.901, "usdc-circle");
    await dispatchTelegramAlerts(harness.db, "bot-token");
    expect(telegramDeliveryTranscript).toHaveLength(1);

    // 10.1% crosses the next bucket. 9.9% was observed but never sent to this
    // chat, so the message must not present it as the last alerted deviation.
    vi.advanceTimersByTime(300_000);
    harness.sqlite
      .prepare("UPDATE depeg_events SET peak_deviation_bps = ?, peak_price = ? WHERE stablecoin_id = ?")
      .run(1010, 0.899, "usdc-circle");
    await dispatchTelegramAlerts(harness.db, "bot-token");
    expect(telegramDeliveryTranscript).toHaveLength(2);
    expect(telegramDeliveryTranscript[1]?.html).toContain("depeg deepened to 10.1% below $1.00");
    expect(telegramDeliveryTranscript[1]?.html).not.toContain("last alert");
  });

  it("suppresses fresh global depeg alerts below the configured bps step", async () => {
    const harness = createBackoffDispatchHarness();
    seedDispatchSnapshots(harness);
    harness.seed({
      depegs: [{ stablecoinId: "usdc-circle", peakDeviationBps: 125 }],
      subscribers: [{ chatId: "global-123", global: { depeg: true }, globalDepegWorseningBpsStep: 250 }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({
      eventsDetected: { depeg: 1, depegTriggered: 1 },
      messagesSent: 0,
      subscribersNotified: 0,
    });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("sends fresh global depeg alerts when the configured bps step is met", async () => {
    const harness = createBackoffDispatchHarness();
    seedDispatchSnapshots(harness);
    harness.seed({
      depegs: [{ stablecoinId: "usdc-circle", peakDeviationBps: 260, startPrice: 0.974 }],
      subscribers: [{ chatId: "global-123", global: { depeg: true }, globalDepegWorseningBpsStep: 250 }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { depegTriggered: 1 }, messagesSent: 1, subscribersNotified: 1 });
    expect(telegramDeliveryTranscript).toEqual([
      expect.objectContaining({ chatId: "global-123", html: expect.stringContaining("2.6% below $1.00") }),
    ]);
  });

  it("emits global worsening depeg alerts when the configured global bps step is crossed", async () => {
    const harness = createBackoffDispatchHarness();
    seedDispatchSnapshots(harness, {
      depeg: {
        "usdc-circle": {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          direction: "below",
          deviationBps: 120,
          price: 0.988,
          pegReference: 1,
        },
      },
    });
    harness.seed({
      depegs: [{ stablecoinId: "usdc-circle", peakDeviationBps: 260, startPrice: 0.974 }],
      subscribers: [{ chatId: "global-123", global: { depeg: true }, globalDepegWorseningBpsStep: 100 }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected.depegWorsening).toBe(1);
    expect(telegramDeliveryTranscript).toEqual([
      expect.objectContaining({ chatId: "global-123", html: expect.stringContaining("depeg deepened") }),
    ]);
  });

  it("clears retired launch alert flags when deactivating a blocked subscriber", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createBackoffDispatchHarness();
    seedDispatchSnapshots(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      subscribers: [{ chatId: "99999", direct: { launch: true }, global: { launch: true }, consecutiveBlockCount: 1, consecutiveBlockFirstAt: now - 60 }],
      subscriptions: [{ chatId: "99999", stablecoinId: "usdc-circle", alerts: { dews: true, launch: true } }],
    });
    expect(harness.sqlite.prepare("SELECT alert_launch, global_alert_launch FROM telegram_subscribers WHERE chat_id = '99999'").get())
      .toEqual({ alert_launch: 1, global_alert_launch: 1 });
    expect(harness.sqlite.prepare("SELECT alert_launch FROM telegram_subscriptions WHERE chat_id = '99999'").get())
      .toEqual({ alert_launch: 1 });
    scriptTelegramDeliveries({
      ok: false,
      blocked: true,
      retryable: false,
      permanentFailure: true,
      statusCode: 403,
      errorClass: "blocked",
      delivery: "blocked",
      retryAfterSec: null,
    });
    await dispatchTelegramAlerts(harness.db, "bot-token");

    expect(
      harness.sqlite
        .prepare("SELECT alert_launch, global_alert_launch FROM telegram_subscribers WHERE chat_id = '99999'")
        .get(),
    ).toEqual({ alert_launch: 0, global_alert_launch: 0 });
    expect(harness.sqlite.prepare("SELECT alert_launch FROM telegram_subscriptions WHERE chat_id = '99999'").get())
      .toEqual({ alert_launch: 0 });
  });

  it("does not emit a worsening alert when an active depeg flips direction (same stablecoin_id)", async () => {
    const harness = createBackoffDispatchHarness();
    seedDispatchSnapshots(harness, {
      depeg: { "usdc-circle": { symbol: "USDC", direction: "below", deviationBps: 50, price: 0.995, pegReference: 1 } },
    });
    harness.seed({
      depegs: [{ stablecoinId: "usdc-circle", direction: "above", peakDeviationBps: 100, startPrice: 1.01 }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected).toMatchObject({ depegTriggered: 0, depegResolved: 0, depegWorsening: 0 });
  });
});
