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
    // Detection still runs (here: the first-run seed); only transport is skipped.
    expect(metadata.snapshotSeeded).toBe(true);
    expect(metadata.deliveryV2).toMatchObject({ drainStoppedReason: "circuit-open", claimed: 0 });
    expect(result.itemCount).toBe(0);
    expect(telegramDeliveryTranscript).toEqual([]);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
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
    expect(metadata.deliveryV2).toMatchObject({ freezeState: "idle", freezeJobsCreated: 0 });
    expect(progressUpdates[progressUpdates.length - 1]).toMatchObject({ stage: "complete" });
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
    // No DEWS rows were readable, so the three DEWS keys stay unwritten (R2).
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 3 });
    expect(readCacheValue(harness.sqlite, "alert:dews-snapshot")).toBeNull();
    expect(readCacheValue(harness.sqlite, "alert:reserve-observed-snapshot")).not.toBeNull();
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_jobs").get()).toEqual({ count: 0 });
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

});

