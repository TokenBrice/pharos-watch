import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALERT_RESERVE_SOURCE_GENERATION } from "../../lib/alert-reserve-source-cache";
import {
  cleanupDispatchTelegramAlertsTest,
  createDispatchHarness,
  dispatchTelegramAlerts,
  makeSafetySnapshotCache,
  mockRecordOutcome,
  parseLogRecords,
  readCacheValue,
  resetDispatchTelegramAlertsTest,
  seedActiveSafetySource,
  scriptTelegramDeliveries,
  scriptTelegramDeliveriesForChat,
  STABLECOINS_CACHE_WITH_USDC,
  telegramDeliveryTranscript,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
} from "./dispatch-telegram-alerts.test-support";

function sources(
  harness: ReturnType<typeof createDispatchHarness>,
  options: {
    dews?: Record<string, string>;
    dewsAlertable?: Record<string, string>;
    depeg?: Record<string, unknown>;
    launch?: string[];
    reserve?: unknown;
    reserveDispatched?: string[];
    safety?: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000) - 60;
  harness.cache("alert:dews-snapshot", options.dews ?? {}, now);
  if (options.dewsAlertable !== undefined) harness.cache("alert:dews-alertable-snapshot", options.dewsAlertable, now);
  harness.cache("alert:depeg-snapshot", options.depeg ?? {}, now);
  harness.cache("alert:safety-snapshot", makeSafetySnapshotCache(options.safety ?? {}).value, now);
  if (options.safety) seedActiveSafetySource(harness, options.safety, now);
  if (options.launch !== undefined) harness.cache("alert:launch-snapshot", options.launch, now);
  if (options.reserve !== undefined) harness.cache("alert:reserve-snapshot", options.reserve, now);
  if (options.reserveDispatched !== undefined)
    harness.cache("alert:reserve-dispatched-snapshot", options.reserveDispatched, now);
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

    expect(callbackData).toContain("status:usdc-circle");
    expect(callbackData).toContain("snooze:4h");
    expect(callbackData).toContain("coinsnooze:usdc-circle:4h");
    expect(keyboard.inline_keyboard?.length).toBeLessThanOrEqual(2);
  });

  it("attaches link_preview_options to the first chunk of single-coin alerts", async () => {
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed(dewsDirect("42"));
    await dispatchTelegramAlerts(harness.db, "bot-token");

    expect(telegramDeliveryTranscript[0]?.options.linkPreviewOptions).toEqual({
      is_disabled: false,
      url: "https://pharos.watch/stablecoin/usdc-circle",
      prefer_small_media: true,
      show_above_text: false,
    });
  });

  it("skips a chat whose alert_snooze_until_ts is in the future and reports chatsWithActiveSnooze", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      subscribers: [
        { chatId: "A", snoozeUntil: now + 3_600, global: { dews: true } },
        { chatId: "B", global: { dews: true } },
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

  it("holds direct targets durably when the preset-subscribers query must resume", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = createDispatchHarness([
      { operation: "preset-subscribers", error: new Error("D1_ERROR: connection reset") },
    ]);
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.cache("stablecoins", STABLECOINS_CACHE_WITH_USDC);
    harness.seed(dewsDirect("12345"));
    try {
      const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);
      expect(metadata).toMatchObject({
        presetFailure: true,
        presetQueryFailures: 1,
        presetResolutionFailures: 0,
        snapshotSeeded: false,
        subscribersNotified: 0,
        messagesSent: 0,
      });
      expect(telegramDeliveryTranscript).toEqual([]);
      expect(
        harness.sqlite.prepare("SELECT status, target_plan_state FROM telegram_alert_source_events").get(),
      ).toMatchObject({ status: "resolving", target_plan_state: "unstarted" });
      expect(parseLogRecords(warnSpy).find((record) => record.action === "preset-query")).toMatchObject({
        failureKind: "query-failed",
        alertType: "dews",
        requestedStablecoinCount: 1,
      });
      expect(readCacheValue(harness.sqlite, "telegram:preset-query-failure-count")).toBe("1");
      expect(mockRecordOutcome).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
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
      });
      expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "direct-chat" })]);
      expect(parseLogRecords(warnSpy).some((record) => record.action === "preset-resolution")).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("holds direct targets durably when dynamic preset resolution must resume", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      ...dewsDirect("direct-chat"),
      subscribers: [{ chatId: "direct-chat" }, { chatId: "preset-chat" }],
      presets: [{ chatId: "preset-chat", presetId: "usd-top25", alerts: { dews: true } }],
    });
    try {
      const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);
      expect(metadata).toMatchObject({
        presetFailure: true,
        presetQueryFailures: 0,
        presetResolutionFailures: 1,
        subscribersNotified: 0,
        messagesSent: 0,
      });
      expect(telegramDeliveryTranscript).toEqual([]);
      expect(
        harness.sqlite.prepare("SELECT status, target_plan_state FROM telegram_alert_source_events").get(),
      ).toMatchObject({ status: "resolving", target_plan_state: "unstarted" });
      expect(parseLogRecords(warnSpy).find((record) => record.action === "preset-resolution")).toMatchObject({
        failureKind: "resolution-failed",
        reason: "stablecoins-cache-unavailable",
        alertType: "dews",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("clears the preset-failure counter on a successful run", async () => {
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.cache("telegram:preset-query-failure-count", "2");
    harness.seed(dewsDirect("12345"));
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ presetFailure: false, presetQueryFailures: 0 });
    expect(readCacheValue(harness.sqlite, "telegram:preset-query-failure-count")).toBe("0");
  });

  it("attributes authoritative target delivery by dominant category", async () => {
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      depegs: [{ stablecoinId: "usdc-circle" }],
      subscribers: [{ chatId: "A" }, { chatId: "C" }],
      subscriptions: [
        { chatId: "A", stablecoinId: "usdc-circle", alerts: { dews: true } },
        { chatId: "C", stablecoinId: "usdc-circle", alerts: { depeg: true } },
      ],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.messagesSent).toBe(2);
    expect(
      harness.sqlite
        .prepare("SELECT alert_type, status, final_delivery_state FROM telegram_alert_job_targets ORDER BY alert_type")
        .all(),
    ).toEqual([
      { alert_type: "depeg", status: "sent", final_delivery_state: "accepted" },
      { alert_type: "dews", status: "sent", final_delivery_state: "accepted" },
    ]);
  });

  it("buckets blocked/failed/enqueued by alert type", async () => {
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      depegs: [{ stablecoinId: "usdc-circle" }],
      subscribers: [{ chatId: "A" }, { chatId: "B" }],
      subscriptions: [
        { chatId: "A", stablecoinId: "usdc-circle", alerts: { dews: true } },
        { chatId: "B", stablecoinId: "usdc-circle", alerts: { depeg: true } },
      ],
    });
    scriptTelegramDeliveriesForChat("A", {
      ok: false,
      blocked: true,
      retryable: false,
      permanentFailure: true,
      statusCode: 403,
      errorClass: "blocked",
      delivery: "blocked",
      retryAfterSec: null,
    });
    scriptTelegramDeliveriesForChat("B", {
      ok: false,
      blocked: false,
      retryable: false,
      permanentFailure: true,
      statusCode: 400,
      errorClass: "permanent",
      delivery: "failed",
      retryAfterSec: null,
    });
    await dispatchTelegramAlerts(harness.db, "bot-token");

    expect(
      harness.sqlite
        .prepare("SELECT alert_type, status, error_class FROM telegram_alert_job_targets ORDER BY alert_type")
        .all(),
    ).toEqual([
      { alert_type: "depeg", status: "failed", error_class: "permanent" },
      { alert_type: "dews", status: "failed", error_class: "blocked" },
    ]);
  });

  it("chunks a 120-coin depeg fan-out for one chat and preserves overflow past the format budget", async () => {
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
        ...Array.from({ length: 1_200 }, (_, index) => ({
          chatId: `global-${index}`,
          lastActiveAt: now - 1_000 - index,
          global: { depeg: true },
        })),
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
    const megaMessages = harness.sqlite
      .prepare(
        "SELECT message_html AS html, chunk_index FROM telegram_alert_job_targets WHERE chat_id = ? ORDER BY chunk_index",
      )
      .all("mega-chat") as Array<{ html: string; chunk_index: number }>;
    const targetCount = harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_targets").get() as {
      count: number;
    };

    expect(metadata.eventsDetected).toMatchObject({ depeg: 120, depegTriggered: 120 });
    expect(metadata.cappedAtLimit).toBe(false);
    expect(megaMessages.length).toBeGreaterThan(1);
    expect(megaMessages.every((message) => message.html.length <= 4000)).toBe(true);
    expect(megaMessages.map((message) => message.chunk_index).sort((a, b) => a - b)).toEqual(
      Array.from({ length: megaMessages.length }, (_, index) => index),
    );
    expect(targetCount.count).toBeGreaterThan(TELEGRAM_MAX_MESSAGES_PER_RUN);
    expect(readCacheValue(harness.sqlite, "telegram:dispatch-overflow-plan")).toBeNull();
  }, 90_000);

  it("preserves the launch snapshot in the seed branch so the next healthy run still detects the transition (P1.7)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    harness.cache("alert:launch-snapshot", ["usdc-circle"], now - 60);
    const cycle1 = await dispatchTelegramAlerts(harness.db, "bot-token");
    expect(JSON.parse(cycle1.metadata).snapshotSeeded).toBe(true);
    expect(JSON.parse(readCacheValue(harness.sqlite, "alert:launch-snapshot") ?? "[]")).toContain("usdc-circle");
    sources(harness, { launch: ["usdc-circle"], dewsAlertable: {} });
    harness.seed({
      subscribers: [{ chatId: "555" }],
      subscriptions: [{ chatId: "555", stablecoinId: "usdc-circle", alerts: { launch: true } }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { launch: 1 }, subscribersNotified: 1, messagesSent: 1 });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "555" })]);
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
      { generation: ALERT_RESERVE_SOURCE_GENERATION, publishedAt: now, continuous: false, driftIds: ["usdc-circle"] },
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

  it("persists alert job manifests for reserve fanout", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness, {
      dewsAlertable: {},
      reserve: {
        generation: ALERT_RESERVE_SOURCE_GENERATION,
        publishedAt: now - 60,
        continuous: true,
        driftIds: ["usdc-circle"],
      },
      reserveDispatched: [],
      safety: {},
    });
    harness.seed({
      subscribers: [{ chatId: "555" }],
      subscriptions: [{ chatId: "555", stablecoinId: "usdc-circle", alerts: { reserve: true } }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { reserve: 1 }, subscribersNotified: 1, messagesSent: 1 });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "555" })]);
    expect(
      harness.sqlite.prepare("SELECT alert_type, status, final_delivery_state FROM telegram_alert_job_targets").get(),
    ).toMatchObject({ alert_type: "reserve", status: "sent", final_delivery_state: "accepted" });
  });

  it("deduplicates a close-and-reopen transition at stablecoin incident level", async () => {
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
        { stablecoinId: "usdc-circle", symbol: "USDC", direction: "below", peakDeviationBps: 90, startPrice: 0.991 },
      ],
      subscribers: [{ chatId: "12345" }],
      subscriptions: [{ chatId: "12345", stablecoinId: "usdc-circle", alerts: { depeg: true } }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected).toMatchObject({ depegTriggered: 0, depegResolved: 0, depegWorsening: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
  });
});
