import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDispatchSnapshots } from "./dispatch-telegram-snapshots.test-support";
import {
  cleanupDispatchTelegramAlertsTest,
  createDispatchHarness,
  defaultDispatchCaches,
  dispatchTelegramAlerts,
  formatConsolidatedMessageSpy,
  mockRecordOutcome,
  mockShouldAttemptFetch,
  readCacheValue,
  resetDispatchTelegramAlertsTest,
  telegramDeliveryTranscript,
  type CronProgressUpdate,
  type DispatchHarness,
} from "./dispatch-telegram-alerts.test-support";

function seedFreezeTapeObservation(harness: DispatchHarness, now: number): void {
  // A fresh project-tape run plus a cursor behind one parseable freeze row makes
  // the dedicated outbox observe exactly one event without queueing anything
  // (the fixture has no freeze audience).
  harness.sqlite
    .prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('project-tape', ?, 1, 'ok')")
    .run(now - 5);
  harness.cache("alert:freeze-tape-cursor", "0", now);
  harness.sqlite
    .prepare(
      `INSERT INTO tape_events (
         event_id, type, severity, ts, title, summary, payload_json,
         source_table, source_row_id, transition, created_at
       ) VALUES ('freeze-observed', 'freeze.blocked', 'warning', ?, 'x', 'x', ?,
         'blacklist_events', 'blacklist-observed', 'opened', ?)`,
    )
    .run(
      now * 1000,
      JSON.stringify({
        stablecoin: "USDC",
        stablecoinId: "usdc-circle",
        chainName: "Ethereum",
        sourceEventId: "blacklist-observed",
      }),
      now,
    );
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
  seedDispatchSnapshots(harness, {
    dews: { "usdc-circle": "CALM" }, safety, safetySource: safety, updatedAt: now - 60,
  });
}

describe("dispatchTelegramAlerts", () => {
  beforeEach(resetDispatchTelegramAlertsTest);
  afterEach(cleanupDispatchTelegramAlertsTest);

  it("skips when circuit breaker is open", async () => {
    mockShouldAttemptFetch.mockResolvedValue(false);
    const { db } = createDispatchHarness();
    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(metadata).toHaveProperty("skipped", "circuit-open");
    expect(metadata.noWorkRun).toBe(true);
    // The freeze outbox runs behind the circuit gate, so this zero is measured.
    expect(metadata.eventsDetected.freeze).toBe(0);
    expect(result.itemCount).toBe(0);
    expect(telegramDeliveryTranscript).toEqual([]);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it("drains due pending rows even when the Telegram API circuit is open", async () => {
    mockShouldAttemptFetch.mockResolvedValue(false);
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    // A pending row carrying the production job-target identity, so the drain's
    // terminal status write lands on a planning table. The target row requires a
    // materializable source event (schema generation guard).
    harness.seed({
      pending: [{
        id: 1,
        chatId: "100",
        html: "<b>Queued alert</b>",
        createdAt: now - 120,
        dedupeKey: "pending-key-1",
      }],
      sourceEvents: [{
        sourceEventId: "source-1",
        status: "planned",
        expiresAt: now + 600,
        eventPayload: "{}",
        baselinePayload: "{}",
        targetPlanState: "planning",
        targetPlanGeneration: 1,
      }],
      targets: [{
        sourceEventId: "source-1",
        chatId: "100",
        alertType: "dews",
        targetKey: "target-1",
        pendingDedupeKey: "pending-key-1",
        planGeneration: 1,
        status: "queued",
      }],
    });
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(metadata).toMatchObject({
      skipped: "circuit-open",
      pendingAttempted: 1,
      pendingDrained: 1,
      messagesSent: 1,
      noWorkRun: false,
      eventsDetected: { freeze: 0 },
    });
    expect(metadata).not.toHaveProperty("planningRowsWritten");
    expect(metadata).not.toHaveProperty("d1RowsWritten");
    expect(result.itemCount).toBe(1);
    expect(telegramDeliveryTranscript).toEqual([
      expect.objectContaining({ chatId: "100", html: "<b>Queued alert</b>" }),
    ]);
    expect(mockRecordOutcome).toHaveBeenCalledWith(expect.anything(), "telegram-api", true);
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
  });

  it("carries the freeze-outbox observation into the seed-path result", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    seedFreezeTapeObservation(harness, now);
    const progressUpdates: CronProgressUpdate[] = [];
    const reportProgress = vi.fn(async (update: CronProgressUpdate) => {
      progressUpdates.push(update);
    });
    const result = await dispatchTelegramAlerts(harness.db, "bot-token", undefined, undefined, reportProgress);
    const metadata = JSON.parse(result.metadata);

    expect(metadata.snapshotSeeded).toBe(true);
    expect(metadata.eventsDetected.freeze).toBe(1);
    expect(metadata.noWorkRun).toBe(false);
    expect(progressUpdates.find((update) => update.stage === "source-loaded")).toMatchObject({
      metadata: { countTotals: { freezeObserved: 1 } },
    });
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
      noWorkRun: false,
    });
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 7 });
    expect(readCacheValue(harness.sqlite, "alert:reserve-observed-snapshot")).not.toBeNull();
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
      noWorkRun: true,
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
    seedFreezeTapeObservation(harness, now);
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(metadata).toMatchObject({
      skipped: scenario.label,
      pendingAttempted: 1,
      pendingDrained: 1,
      messagesSent: 1,
      subscribersNotified: 1,
      eventsDetected: { freeze: 1 },
      noWorkRun: false,
    });
    expect(result.itemCount).toBe(1);
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: `pending-${scenario.label}` })]);
    expect(mockRecordOutcome).toHaveBeenCalledWith(expect.anything(), "telegram-api", true);
  });
});

