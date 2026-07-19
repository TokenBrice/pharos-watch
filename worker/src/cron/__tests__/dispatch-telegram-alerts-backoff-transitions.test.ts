import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupDispatchTelegramAlertsTest,
  createDispatchHarness,
  dispatchTelegramAlerts,
  formatConsolidatedMessageSpy,
  makeSafetySnapshotCache,
  makeSafetySourceCache,
  mockSendToChat,
  parseLogRecords,
  readCacheValue,
  resetDispatchTelegramAlertsTest,
  scriptTelegramDeliveries,
  scriptTelegramDeliveriesForChat,
  telegramDeliveryTranscript,
  TELEGRAM_FORMAT_BUDGET_ALLOWANCE,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
  type CronProgressUpdate,
} from "./dispatch-telegram-alerts.test-support";

function sources(
  harness: ReturnType<typeof createDispatchHarness>,
  options: {
    dews?: Record<string, string>;
    depeg?: Record<string, unknown>;
    safety?: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }> | string;
    safetySource?: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000) - 60;
  harness.cache("alert:dews-snapshot", options.dews ?? {}, now);
  harness.cache("alert:depeg-snapshot", options.depeg ?? {}, now);
  harness.cache(
    "alert:safety-snapshot",
    typeof options.safety === "string" ? options.safety : makeSafetySnapshotCache(options.safety ?? {}).value,
    now,
  );
  if (options.safetySource)
    harness.cache("alert:safety-source-cache", makeSafetySourceCache(options.safetySource, now).value, now);
}

function dewsSubscribers(count: number, prefix = "chat") {
  const now = Math.floor(Date.now() / 1000);
  return {
    subscribers: Array.from({ length: count }, (_, index) => ({
      chatId: `${prefix}-${index}`,
      lastActiveAt: now - index,
    })),
    subscriptions: Array.from({ length: count }, (_, index) => ({
      chatId: `${prefix}-${index}`,
      stablecoinId: "usdc-circle",
      alerts: { dews: true },
    })),
  };
}

function retryResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: false,
    blocked: false,
    retryable: true,
    permanentFailure: false,
    statusCode: 500,
    errorClass: "server_error",
    delivery: "retryable_failure",
    retryAfterSec: null,
    ...overrides,
  };
}

describe("dispatchTelegramAlerts", () => {
  beforeEach(resetDispatchTelegramAlertsTest);
  afterEach(cleanupDispatchTelegramAlertsTest);

  it("records a fresh-send chat_not_found first strike without deactivating the subscriber", async () => {
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
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
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      subscribers: [{ chatId: "99999", consecutiveBlockCount: 1, consecutiveBlockFirstAt: now - 60 }],
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

    expect(metadata.blockedUsersCleanedUp).toBe(1);
    expect(
      harness.sqlite
        .prepare(
          "SELECT alert_dews, alert_launch, global_alert_launch FROM telegram_subscribers WHERE chat_id = '99999'",
        )
        .get(),
    ).toEqual({ alert_dews: 0, alert_launch: 0, global_alert_launch: 0 });
    expect(
      harness.sqlite.prepare("SELECT alert_dews FROM telegram_subscriptions WHERE chat_id = '99999'").get(),
    ).toEqual({ alert_dews: 0 });

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
      harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts WHERE chat_id = '99999'").get(),
    ).toEqual({ count: 0 });
  });

  it("drains pending queue on an eventless dispatch", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness);
    harness.seed({
      pending: [
        { id: 1, chatId: "100", html: "<b>Old alert</b>", createdAt: now - 120 },
        { id: 2, chatId: "200", html: "<b>Old alert 2</b>", createdAt: now - 60 },
      ],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.pendingDrained).toBe(2);
    expect(telegramDeliveryTranscript.map((entry) => entry.chatId)).toEqual(["100", "200"]);
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
  });

  it("drains existing pending alerts before authoritative target planning", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", score: 55, band: "WARNING" }],
      pending: [{ id: 1, chatId: "pending-chat", html: "<b>Old alert</b>", createdAt: now - 120 }],
      subscribers: [{ chatId: "fresh-chat" }],
      subscriptions: [{ chatId: "fresh-chat", stablecoinId: "usdc-circle", alerts: { dews: true } }],
    });
    const reportProgress = vi.fn(async (_update: CronProgressUpdate) => undefined);

    const metadata = JSON.parse(
      (await dispatchTelegramAlerts(harness.db, "bot-token", undefined, undefined, reportProgress)).metadata,
    );

    const targetPlanProgressCallIndex = reportProgress.mock.calls.findIndex(
      ([update]) => update.stage === "target-plan-progress",
    );
    const fanoutBuiltCallIndex = reportProgress.mock.calls.findIndex(([update]) => update.stage === "fanout-built");
    expect(targetPlanProgressCallIndex).toBeGreaterThanOrEqual(0);
    expect(fanoutBuiltCallIndex).toBeGreaterThanOrEqual(0);
    expect(targetPlanProgressCallIndex).toBeLessThan(fanoutBuiltCallIndex);
    expect(mockSendToChat.mock.invocationCallOrder[0]).toBeLessThan(
      reportProgress.mock.invocationCallOrder[fanoutBuiltCallIndex]!,
    );
    expect(metadata).toMatchObject({
      pendingAttempted: 1,
      pendingSent: 1,
      pendingEnqueued: 1,
      pendingTotal: 1,
    });
    expect(telegramDeliveryTranscript.map((entry) => entry.chatId)).toEqual(["pending-chat"]);
    expect(
      harness.sqlite.prepare("SELECT chat_id, delivery_state FROM telegram_pending_alerts").all(),
    ).toEqual([{ chat_id: "fresh-chat", delivery_state: "pending" }]);
  });

  it("captures overflow subscribers durably before bounded materialization", async () => {
    const subscriberCount = TELEGRAM_MAX_MESSAGES_PER_RUN + 50;
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", score: 55, band: "WARNING" }],
      ...dewsSubscribers(subscriberCount),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);
    const captured = harness.sqlite
      .prepare("SELECT COUNT(*) AS count FROM telegram_alert_planning_subscribers")
      .get() as { count: number };

    expect(metadata).toMatchObject({
      cappedAtLimit: true,
      pendingEnqueued: 0,
      freshCandidateChats: 0,
      freshCandidateCount: 0,
    });
    expect(captured.count).toBeGreaterThan(0);
    expect(captured.count).toBeLessThan(subscriberCount);
    expect(metadata.fanoutQueryMs).toBeGreaterThanOrEqual(0);
    expect(metadata.fanoutBuildMs).toBeGreaterThanOrEqual(0);
    expect(metadata.subscribersNotified).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGES_PER_RUN);
    expect(formatConsolidatedMessageSpy).not.toHaveBeenCalled();
  });

  it("C102: caps hot-path formatting at the fresh budget under a market-wide burst", async () => {
    const subscriberCount = TELEGRAM_MAX_MESSAGES_PER_RUN + TELEGRAM_FORMAT_BUDGET_ALLOWANCE + 400;
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", score: 55, band: "WARNING" }],
      ...dewsSubscribers(subscriberCount),
    });
    let metadata: Record<string, number | boolean> | undefined;
    for (let cycle = 0; cycle < 10; cycle++) {
      if (cycle > 0) vi.advanceTimersByTime(121_000);
      const runMetadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata) as Record<
        string,
        number | boolean
      >;
      metadata = runMetadata;
      if (!runMetadata.cappedAtLimit) break;
    }
    const completed = metadata as Record<string, number | boolean>;
    expect(completed).toMatchObject({
      cappedAtLimit: false,
      freshCandidateChats: subscriberCount,
      freshCandidateCount: subscriberCount,
      freshOverflow: 0,
    });
    expect(formatConsolidatedMessageSpy).toHaveBeenCalledTimes(subscriberCount);
    expect(readCacheValue(harness.sqlite, "telegram:dispatch-overflow-plan")).toBeNull();
  }, 45_000);

  it("writes snapshots even when subscriber queue is capped", async () => {
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({ dews: [{ stablecoinId: "usdc-circle", score: 55, band: "WARNING" }], ...dewsSubscribers(250) });
    await dispatchTelegramAlerts(harness.db, "bot-token");

    expect(readCacheValue(harness.sqlite, "alert:dews-snapshot")).toContain("WARNING");
  }, 30_000);

  it("cleans up expired pending alerts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness);
    harness.seed({
      pending: Array.from({ length: 5 }, (_, index) => ({
        id: index + 1,
        chatId: `expired-${index}`,
        html: "<b>Expired</b>",
        createdAt: now - 2 * 60 * 60 - 100,
        dedupeKey: `expired-${index}`,
        alertType: "depeg",
      })),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.pendingExpired).toBe(5);
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_dead_letters").get()).toEqual({
      count: 5,
    });
  });

  it("keeps retryable authoritative targets queued instead of dropping them", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", score: 55, band: "WARNING" }],
      ...dewsSubscribers(1, "12345"),
    });
    scriptTelegramDeliveries(retryResult());
    try {
      const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);
      expect(metadata).toMatchObject({
        pendingAttempted: 1,
        pendingRetryQueued: 1,
        pendingDropped: 0,
        pendingEnqueued: 1,
        pendingTotal: 1,
        messagesSent: 0,
      });
      expect(
        harness.sqlite.prepare("SELECT delivery_state, attempts, last_error_class FROM telegram_pending_alerts").get(),
      ).toMatchObject({ delivery_state: "pending", attempts: 1, last_error_class: "server_error" });
      expect(parseLogRecords(errorSpy).some((record) => record.action === "dispatch-systemic-fresh-failure")).toBe(
        false,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("isolates rate-limit deferral to the affected chat and still sends fresh alerts for other chats", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", score: 55, band: "WARNING" }],
      pending: [{ id: 1, chatId: "old-chat", html: "<b>Old</b>", createdAt: now - 60 }],
      subscribers: [{ chatId: "old-chat" }, { chatId: "fresh-chat" }],
      subscriptions: [{ chatId: "fresh-chat", stablecoinId: "usdc-circle", alerts: { dews: true } }],
    });
    scriptTelegramDeliveriesForChat(
      "old-chat",
      retryResult({ statusCode: 429, errorClass: "rate_limit", retryAfterSec: 45 }),
    );
    const firstMetadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(firstMetadata).toMatchObject({
      pendingAttempted: 1,
      pendingRetryQueued: 1,
      pendingEnqueued: 1,
      freshAttempted: 0,
      freshSent: 0,
      freshDeferredPerChat: 0,
    });
    expect(telegramDeliveryTranscript.map((entry) => entry.chatId)).toEqual(["old-chat"]);

    vi.advanceTimersByTime(5 * 60_000);
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({
      pendingAttempted: 2,
      pendingRetryQueued: 0,
      freshAttempted: 0,
      freshSent: 0,
      freshDeferredPerChat: 0,
    });
    expect(telegramDeliveryTranscript.map((entry) => entry.chatId).sort()).toEqual([
      "fresh-chat",
      "old-chat",
      "old-chat",
    ]);
    expect(
      harness.sqlite
        .prepare("SELECT chat_id, not_before_at, attempts, delivery_state FROM telegram_pending_alerts")
        .all(),
    ).toEqual([]);
  });

  it("defers fresh alerts for chats already in per-chat backoff without sending", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", score: 55, band: "WARNING" }],
      pending: [{ chatId: "chat-A", html: "<b>Backoff</b>", createdAt: now - 60, notBeforeAt: now + 300 }],
      subscribers: [{ chatId: "chat-A" }, { chatId: "chat-B", lastActiveAt: now - 1 }],
      subscriptions: [
        { chatId: "chat-A", stablecoinId: "usdc-circle", alerts: { dews: true } },
        { chatId: "chat-B", stablecoinId: "usdc-circle", alerts: { dews: true } },
      ],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ pendingAttempted: 1, pendingSent: 1, pendingEnqueued: 2, pendingTotal: 2 });
    expect(telegramDeliveryTranscript.map((entry) => entry.chatId)).toEqual(["chat-B"]);
    expect(
      harness.sqlite
        .prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts WHERE chat_id = 'chat-A' AND not_before_at > ?")
        .get(now),
    ).toEqual({ count: 2 });
  });

  it("hands global rate limits to the pending transport controller", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({ dews: [{ stablecoinId: "usdc-circle", score: 55, band: "WARNING" }], ...dewsSubscribers(8) });
    scriptTelegramDeliveries(
      retryResult({ statusCode: 429, errorClass: "rate_limit", retryAfterSec: 45, rateLimitScope: "global" }),
    );
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.pendingAttempted).toBeGreaterThanOrEqual(1);
    expect(metadata.pendingRetryQueued).toBeGreaterThanOrEqual(1);
    expect(metadata.pendingRateLimited).toBe(true);
    expect(metadata.pendingEnqueued).toBe(8);
    expect(metadata.messagesSent).toBe(metadata.pendingSent);
    expect(readCacheValue(harness.sqlite, "telegram:global-send-backoff-until")).toBe(String(now + 45));
    expect(
      harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts WHERE not_before_at IS NULL").get(),
    ).toEqual({ count: metadata.pendingEnqueued - metadata.pendingSent });
  });

  it("emits worsening depeg alerts when the configured bps step is crossed", async () => {
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
    expect(telegramDeliveryTranscript[0]?.html).toContain("worsening");
  });

  it("suppresses fresh global depeg alerts below the configured bps step", async () => {
    const harness = createDispatchHarness();
    sources(harness);
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
    const harness = createDispatchHarness();
    sources(harness);
    harness.seed({
      depegs: [{ stablecoinId: "usdc-circle", peakDeviationBps: 260, startPrice: 0.974 }],
      subscribers: [{ chatId: "global-123", global: { depeg: true }, globalDepegWorseningBpsStep: 250 }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { depegTriggered: 1 }, messagesSent: 1, subscribersNotified: 1 });
    expect(telegramDeliveryTranscript).toEqual([
      expect.objectContaining({ chatId: "global-123", html: expect.stringContaining("below peg by 2.6%") }),
    ]);
  });

  it("emits global worsening depeg alerts when the configured global bps step is crossed", async () => {
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
      expect.objectContaining({ chatId: "global-123", html: expect.stringContaining("worsening") }),
    ]);
  });

  it("suppresses safety alerts when only the methodology version changed", async () => {
    const harness = createDispatchHarness();
    sources(harness, {
      safety: { "usdc-circle": { grade: "B", score: 78, methodologyVersion: "v1" } },
      safetySource: { "usdc-circle": { grade: "C", score: 61, methodologyVersion: "v2" } },
    });
    harness.seed({
      safety: [
        { stablecoinId: "usdc-circle", grade: "C", score: 61, prevGrade: "B", prevScore: 78, methodologyVersion: "v2" },
      ],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { safety: 0, suppressedMethodologyChanges: 1 }, messagesSent: 0 });
  });

  it("reports suppressedSafetyChangesAtSeed when reseeding hides real safety changes", async () => {
    const harness = createDispatchHarness();
    const safety = {
      "usdc-circle": { grade: "C", score: 61, methodologyVersion: "7.10" },
      "dai-makerdao": { grade: "C+", score: 65, methodologyVersion: "7.10" },
    };
    sources(harness, {
      safety: makeSafetySnapshotCache(
        {
          "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.10" },
          "dai-makerdao": { grade: "B+", score: 80, methodologyVersion: "7.10" },
        },
        "legacy-generation",
      ).value,
      safetySource: safety,
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({
      eventsDetected: { safety: 0 },
      messagesSent: 0,
      safetyAlertsSuppressed: true,
      suppressedSafetyChangesAtSeed: 2,
    });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("clears launch alert flags when deactivating a blocked subscriber", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    sources(harness, { dews: { "usdc-circle": "CALM" } });
    harness.cache("alert:launch-snapshot", [], now - 60);
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      subscribers: [{ chatId: "99999", consecutiveBlockCount: 1, consecutiveBlockFirstAt: now - 60 }],
      subscriptions: [{ chatId: "99999", stablecoinId: "usdc-circle", alerts: { dews: true } }],
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
    await dispatchTelegramAlerts(harness.db, "bot-token");

    expect(
      harness.sqlite
        .prepare("SELECT alert_launch, global_alert_launch FROM telegram_subscribers WHERE chat_id = '99999'")
        .get(),
    ).toEqual({ alert_launch: 0, global_alert_launch: 0 });
  });

  it("does not emit a worsening alert when an active depeg flips direction (same stablecoin_id)", async () => {
    const harness = createDispatchHarness();
    sources(harness, {
      depeg: { "usdc-circle": { symbol: "USDC", direction: "below", deviationBps: 50, price: 0.995, pegReference: 1 } },
    });
    harness.seed({
      depegs: [{ stablecoinId: "usdc-circle", direction: "above", peakDeviationBps: 100, startPrice: 1.01 }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected).toMatchObject({ depegTriggered: 0, depegResolved: 0, depegWorsening: 0 });
  });
});
