import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDedupeKey,
  cleanupDispatchTelegramAlertsTest,
  createDispatchHarness,
  defaultDispatchCaches,
  deliverTelegramSubscriberQueue,
  dispatchTelegramAlerts,
  emptyDrainResult,
  formatConsolidatedMessageSpy,
  makeDewsOverflowPlan,
  makeSafetySnapshotCache,
  mockRecordOutcome,
  mockSendBatch,
  mockShouldAttemptFetch,
  pruneOverflowPlanBacklogForChat,
  readCacheValue,
  recordPendingEnqueueAttempts,
  resetDispatchTelegramAlertsTest,
  seedActiveSafetySource,
  scriptTelegramDeliveries,
  telegramDeliveryTranscript,
  TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
  type CronProgressUpdate,
} from "./dispatch-telegram-alerts.test-support";

function freshQueue(
  chatId = "chat-1",
  chunks = ["chunk-0"],
  alertType: "dews" | "depeg" | "safety" | "launch" | "reserve" | "freeze" = "depeg",
) {
  return [
    {
      chatId,
      lastActiveAt: Math.floor(Date.now() / 1000),
      alerts: {
        dews: [],
        depegTriggered: [],
        depegResolved: [],
        depegWorsening: [],
        safety: [],
        launch: [],
        reserve: [],
      },
      canonicalHtml: "canonical-body",
      chunks,
      disableNotification: false,
      alertType,
    },
  ];
}

function healthySources(
  harness: ReturnType<typeof createDispatchHarness>,
  options: {
    dews?: Array<{ stablecoinId: string; score?: number; band?: "CALM" | "WATCH" | "ALERT" | "WARNING" | "DANGER" }>;
    safety?: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const safety = options.safety ?? { "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" } };
  harness.seed({ dews: options.dews ?? [], cache: defaultDispatchCaches() });
  harness.cache("alert:dews-snapshot", { "usdc-circle": "CALM" }, now - 60);
  harness.cache("alert:depeg-snapshot", {}, now - 60);
  harness.cache("alert:safety-snapshot", makeSafetySnapshotCache(safety).value, now - 60);
  seedActiveSafetySource(harness, safety, now - 60);
}

describe("dispatchTelegramAlerts", () => {
  beforeEach(resetDispatchTelegramAlertsTest);
  afterEach(cleanupDispatchTelegramAlertsTest);

  it("filters already-terminal chunks before fresh delivery", async () => {
    const now = Math.floor(Date.now() / 1000);
    const terminalChunkKey = buildDedupeKey({
      chatId: "chat-1",
      html: "chunk-0",
      canonicalHtml: "canonical-body",
      disableNotification: false,
      chunkIndex: 0,
      alertType: "depeg",
    });
    const { db } = createDispatchHarness();
    const result = await deliverTelegramSubscriberQueue({
      db,
      subscriberQueue: freshQueue("chat-1", ["chunk-0", "chunk-1"]),
      botToken: "bot-token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 10,
      nowSec: now,
      chatsInBackoff: new Map(),
      globalBackoffUntil: null,
      dispatchStartedAtMs: Date.now(),
      terminalTargetKeys: new Set([terminalChunkKey]),
    });

    expect(result.freshAttempted).toBe(1);
    expect(result.subscribersNotified).toBe(1);
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "chat-1", html: "chunk-1" })]);
  });

  it("passes a five-minute-lane soft deadline to fresh batch sends", async () => {
    const now = Math.floor(Date.now() / 1000);
    const dispatchStartedAtMs = Date.now();
    const { db } = createDispatchHarness();
    await deliverTelegramSubscriberQueue({
      db,
      subscriberQueue: freshQueue(),
      botToken: "bot-token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 10,
      nowSec: now,
      chatsInBackoff: new Map(),
      globalBackoffUntil: null,
      dispatchStartedAtMs,
    });

    expect(mockSendBatch.mock.calls[0]?.[4]).toEqual(
      expect.objectContaining({
        softDeadlineAtMs: dispatchStartedAtMs + TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
        beforeSendBatch: expect.any(Function),
        afterSendBatch: expect.any(Function),
      }),
    );
  });

  it("uses existing pending attempts when re-enqueuing a retryable fresh chunk", async () => {
    const now = Math.floor(Date.now() / 1000);
    const dedupeKey = buildDedupeKey({
      chatId: "chat-1",
      html: "chunk-0",
      canonicalHtml: "canonical-body",
      disableNotification: false,
      chunkIndex: 0,
      alertType: "depeg",
    });
    const harness = createDispatchHarness();
    harness.seed({
      pending: [{ chatId: "chat-1", html: "old", dedupeKey, attempts: 4, createdAt: now - 60, expiresAt: now + 600 }],
    });
    recordPendingEnqueueAttempts(harness.sqlite);
    scriptTelegramDeliveries({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 500,
      errorClass: "server_error",
      delivery: "retryable_failure",
      retryAfterSec: null,
    });
    const result = await deliverTelegramSubscriberQueue({
      db: harness.db,
      subscriberQueue: freshQueue(),
      botToken: "bot-token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 10,
      nowSec: now,
      chatsInBackoff: new Map(),
      globalBackoffUntil: null,
      dispatchStartedAtMs: Date.now(),
    });

    expect(result).toMatchObject({ freshAttempted: 1, freshRetryQueued: 1 });
    expect(
      harness.sqlite
        .prepare("SELECT not_before_at FROM telegram_pending_enqueue_transcript WHERE dedupe_key = ?")
        .get(dedupeKey),
    ).toMatchObject({ not_before_at: now + 600 });
  });

  it("treats stale pending attempts as reset when re-enqueuing a retryable fresh chunk", async () => {
    const now = Math.floor(Date.now() / 1000);
    const dedupeKey = buildDedupeKey({
      chatId: "chat-1",
      html: "chunk-0",
      canonicalHtml: "canonical-body",
      disableNotification: false,
      chunkIndex: 0,
      alertType: "depeg",
    });
    const harness = createDispatchHarness();
    harness.seed({
      pending: [
        { chatId: "chat-1", html: "old", dedupeKey, attempts: 4, createdAt: now - 90_000, expiresAt: now - 30 },
      ],
    });
    recordPendingEnqueueAttempts(harness.sqlite);
    scriptTelegramDeliveries({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 500,
      errorClass: "server_error",
      delivery: "retryable_failure",
      retryAfterSec: null,
    });
    const result = await deliverTelegramSubscriberQueue({
      db: harness.db,
      subscriberQueue: freshQueue(),
      botToken: "bot-token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 10,
      nowSec: now,
      chatsInBackoff: new Map(),
      globalBackoffUntil: null,
      dispatchStartedAtMs: Date.now(),
    });

    expect(result).toMatchObject({ freshAttempted: 1, freshRetryQueued: 1 });
    expect(
      harness.sqlite
        .prepare("SELECT not_before_at FROM telegram_pending_enqueue_transcript WHERE dedupe_key = ?")
        .get(dedupeKey),
    ).toMatchObject({ not_before_at: now + 60 });
  });

  it("does not format planned overflow while global backoff is active", async () => {
    const now = Math.floor(Date.now() / 1000);
    const overflowPlan = makeDewsOverflowPlan(now);
    const { db } = createDispatchHarness();
    const result = await deliverTelegramSubscriberQueue({
      db,
      subscriberQueue: [],
      overflowPlanned: [overflowPlan],
      overflowFormatBudget: 1,
      botToken: "bot-token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 10,
      nowSec: now,
      chatsInBackoff: new Map(),
      globalBackoffUntil: now + 60,
      dispatchStartedAtMs: Date.now(),
    });

    expect(formatConsolidatedMessageSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ pendingEnqueued: 0, freshOverflow: 1, remainingOverflowPlanned: [overflowPlan] });
  });

  it("skips when circuit breaker is open", async () => {
    mockShouldAttemptFetch.mockResolvedValue(false);
    const { db } = createDispatchHarness();
    const result = await dispatchTelegramAlerts(db, "bot-token");

    expect(JSON.parse(result.metadata)).toHaveProperty("skipped", "circuit-open");
    expect(result.itemCount).toBe(0);
    expect(telegramDeliveryTranscript).toEqual([]);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it("drains due pending rows even when the Telegram API circuit is open", async () => {
    mockShouldAttemptFetch.mockResolvedValue(false);
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    harness.seed({ pending: [{ id: 1, chatId: "100", html: "<b>Queued alert</b>", createdAt: now - 120 }] });
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(metadata).toMatchObject({
      skipped: "circuit-open",
      pendingAttempted: 1,
      pendingDrained: 1,
      messagesSent: 1,
    });
    expect(result.itemCount).toBe(1);
    expect(telegramDeliveryTranscript).toEqual([
      expect.objectContaining({ chatId: "100", html: "<b>Queued alert</b>" }),
    ]);
    expect(mockRecordOutcome).toHaveBeenCalledWith(harness.db, "telegram-api", true);
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
  });

  it("does not record a Telegram API circuit failure when dispatch is aborted before delivery", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("dispatch deadline", "AbortError"));
    const { db } = createDispatchHarness();
    await expect(dispatchTelegramAlerts(db, "bot-token", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("does not record a Telegram API circuit failure for source-loading D1 errors", async () => {
    const harness = createDispatchHarness([
      { operation: "active-snoozes", error: new Error("D1_ERROR: source load failed") },
    ]);
    await expect(dispatchTelegramAlerts(harness.db, "bot-token")).rejects.toThrow("D1_ERROR: source load failed");

    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("seeds snapshots on first run", async () => {
    const harness = createDispatchHarness();
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(result.itemCount).toBe(0);
    expect(metadata).toMatchObject({
      snapshotSeeded: true,
      subscribersNotified: 0,
      safetyAlertSourceState: "missing",
      safetyAlertsSuppressed: true,
    });
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 6 });
    expect(readCacheValue(harness.sqlite, "telegram:preset-query-failure-count")).toBe("0");
    expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
  });

  it("uses the eventless fast path without fan-out when snapshots are healthy and unchanged", async () => {
    const harness = createDispatchHarness();
    healthySources(harness, { dews: [{ stablecoinId: "usdc-circle", score: 12, band: "CALM" }] });
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(result.itemCount).toBe(0);
    expect(metadata).toMatchObject({
      eventlessFastPath: true,
      eventsDetected: { dews: 0, depeg: 0, safety: 0, launch: 0 },
      messagesSent: 0,
      pendingAttempted: 0,
    });
    expect(telegramDeliveryTranscript).toEqual([]);
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_source_events").get()).toEqual({
      count: 0,
    });
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_target_plans").get()).toEqual({
      count: 0,
    });
  });

  it("drains a legacy-source pending target during an eventless run", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    healthySources(harness, { dews: [{ stablecoinId: "usdc-circle", score: 12, band: "CALM" }] });
    harness.seed({
      pending: [
        {
          id: 1,
          chatId: "chat-imported",
          html: "<b>Imported overflow alert</b>",
          createdAt: now - 120,
          sourceType: "legacy",
        },
      ],
    });
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(result.itemCount).toBe(1);
    expect(metadata).toMatchObject({
      eventlessFastPath: true,
      pendingAttempted: 1,
      pendingDrained: 1,
      messagesSent: 1,
    });
    expect(formatConsolidatedMessageSpy).not.toHaveBeenCalled();
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "chat-imported" })]);
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
  });

  it("prunes forgotten chats from the stored overflow plan backlog", async () => {
    const now = Math.floor(Date.now() / 1000);
    const forgottenPlan = makeDewsOverflowPlan(now, "chat-forgotten");
    const keptPlan = makeDewsOverflowPlan(now, "chat-kept");
    const harness = createDispatchHarness();
    harness.cache(
      "telegram:dispatch-overflow-plan",
      {
        version: 1,
        writtenAt: now - 60,
        plans: [
          { ...forgottenPlan, expiresAt: now + 3_600 },
          { ...keptPlan, expiresAt: now + 3_600 },
        ],
      },
      now - 60,
    );

    await pruneOverflowPlanBacklogForChat(harness.db, "chat-forgotten", now);
    expect(JSON.parse(readCacheValue(harness.sqlite, "telegram:dispatch-overflow-plan") ?? "{}")).toMatchObject({
      plans: [{ chatId: "chat-kept" }],
    });
  });

  it("does not enqueue cached overflow plans for chats without active subscriptions", async () => {
    const now = Math.floor(Date.now() / 1000);
    const overflowPlan = makeDewsOverflowPlan(now, "chat-forgotten");
    const harness = createDispatchHarness();
    const result = await deliverTelegramSubscriberQueue({
      db: harness.db,
      subscriberQueue: [],
      overflowPlanned: [overflowPlan],
      overflowFormatBudget: 1,
      botToken: "bot-token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 10,
      nowSec: now,
      chatsInBackoff: new Map(),
      globalBackoffUntil: null,
      dispatchStartedAtMs: Date.now(),
    });

    expect(formatConsolidatedMessageSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ pendingEnqueued: 0, remainingOverflowPlanned: [] });
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
  });

  it("still drains due pending rows during an otherwise eventless run", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    healthySources(harness, { dews: [] });
    harness.seed({
      pending: [{ id: 1, chatId: "eventless-due", html: "<b>Due during eventless run</b>", createdAt: now - 120 }],
    });
    const progressUpdates: CronProgressUpdate[] = [];
    const reportProgress = vi.fn(async (update: CronProgressUpdate) => {
      progressUpdates.push(update);
    });
    const result = await dispatchTelegramAlerts(harness.db, "bot-token", undefined, undefined, reportProgress);
    const metadata = JSON.parse(result.metadata);

    expect(metadata).toMatchObject({ eventlessFastPath: true, pendingTotal: 0 });
    expect(result.itemCount).toBe(1);
    expect(progressUpdates.find((update) => update.stage === "source-loading")).toMatchObject({
      itemsTotal: 6,
      metadata: { providerFamilies: ["dews", "depeg", "safety", "launch", "reserve", "freeze"] },
    });
    expect(progressUpdates.find((update) => update.stage === "source-loaded")).toMatchObject({
      itemsDone: 6,
      itemsTotal: 6,
      metadata: {
        providerFamilies: ["dews", "depeg", "safety", "launch", "reserve", "freeze"],
        reserveSourceUnavailable: true,
        countTotals: { reserveDriftIds: 0 },
      },
    });
    expect(progressUpdates.find((update) => update.stage === "event-detection")).toMatchObject({
      itemsTotal: 6,
      metadata: {
        providerFamilies: ["dews", "depeg", "safety", "launch", "reserve", "freeze"],
        reserveSourceUnavailable: true,
      },
    });
    expect(progressUpdates.find((update) => update.stage === "pending-drain")).toMatchObject({
      metadata: {
        providerFamily: "telegram-api",
        phase: "pending-drain",
        eventlessFastPath: true,
        deferredTail: { total: 1, due: 1, deferred: 0, expired: 0 },
      },
    });
    expect(progressUpdates.find((update) => update.stage === "complete")).toMatchObject({
      metadata: {
        providerFamily: "telegram-dispatch",
        phase: "complete",
        countTotals: { pendingAttempted: 1, pendingSent: 1, pendingDeferred: 0, pendingDropped: 0 },
        deferredTail: { total: 0, due: 0 },
      },
    });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "eventless-due" })]);
  });

  it.each([
    {
      label: "source-event-backfill-required",
      status: "baseline_committed" as const,
      expiresAtOffset: 600,
      targetPlanState: "planning" as const,
      targets: true,
    },
    {
      label: "source-event-expired",
      status: "planned" as const,
      expiresAtOffset: -1,
      targetPlanState: "planning" as const,
      targets: false,
    },
  ])("drains due pending rows before the $label early return", async (scenario) => {
    const now = Math.floor(Date.now() / 1000);
    const sourceEventId = `telegram-source:test:v1:${scenario.label}`;
    const emptyEvents = JSON.stringify({
      dewsChanges: [],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [],
      safetyChanges: [],
      launchPromoted: [],
      reservePromoted: [],
      suppressedMethodologyChanges: 0,
      dewsIds: [],
      depegIds: [],
      safetyIds: [],
      launchIds: [],
      reserveIds: [],
    });
    const emptyBaseline = JSON.stringify({
      dews: {},
      dewsAlertable: {},
      depeg: {},
      safety: {},
      launch: [],
      reserveDispatched: [],
    });
    const harness = createDispatchHarness();
    harness.seed({
      pending: [
        { id: 1, chatId: `pending-${scenario.label}`, html: "<b>Queued recovery alert</b>", createdAt: now - 120 },
      ],
      sourceEvents: [
        {
          sourceEventId,
          status: scenario.status,
          detectedAt: now - 120,
          expiresAt: now + scenario.expiresAtOffset,
          eventPayload: emptyEvents,
          baselinePayload: emptyBaseline,
          baselineCommittedAt: scenario.status === "baseline_committed" ? now - 30 : null,
          targetPlanState: scenario.targetPlanState,
          targetPlanGeneration: 1,
        },
      ],
      targets: scenario.targets ? [{ sourceEventId, chatId: "planned-target", planGeneration: 1 }] : [],
    });
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(metadata).toMatchObject({
      skipped: scenario.label,
      pendingAttempted: 1,
      pendingDrained: 1,
      messagesSent: 1,
      subscribersNotified: 1,
    });
    expect(result.itemCount).toBe(1);
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: `pending-${scenario.label}` })]);
    expect(mockRecordOutcome).toHaveBeenCalledWith(harness.db, "telegram-api", true);
  });
});
