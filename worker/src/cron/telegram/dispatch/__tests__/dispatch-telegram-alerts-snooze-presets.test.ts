import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDispatchSnapshots } from "./dispatch-telegram-snapshots.test-support";
import { ALERT_RESERVE_SOURCE_GENERATION } from "../../../../lib/alert-reserve-source-cache";
import {
  cleanupDispatchTelegramAlertsTest,
  createDispatchHarness as createBaseDispatchHarness,
  dispatchTelegramAlerts,
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
