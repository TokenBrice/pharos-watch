import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedDispatchSnapshots } from "./dispatch-telegram-snapshots.test-support";
import {
  cleanupDispatchTelegramAlertsTest,
  createDispatchHarness as createBaseDispatchHarness,
  dispatchTelegramAlerts,
  makeSafetySnapshotCache,
  readCacheValue,
  resetDispatchTelegramAlertsTest,
  telegramDeliveryTranscript,
  mockRunTelegramRollupStep,
} from "./dispatch-telegram-alerts.test-support";

// Routing scenarios require published DEWS; pointerless diagnostic rows are not alert sources.
// Keep admission local so the base harness can still exercise unavailable publications.
function createDispatchHarness() {
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



function direct(chatId: string, alerts: Record<string, boolean>, options: Record<string, unknown> = {}) {
  return {
    subscribers: [{ chatId, ...((options.subscriber as object | undefined) ?? {}) }],
    subscriptions: [
      {
        chatId,
        stablecoinId: String(options.stablecoinId ?? "usdc-circle"),
        alerts,
        ...((options.subscription as object | undefined) ?? {}),
      },
    ],
  };
}

function global(chatId: string, alerts: Record<string, boolean>, options: Record<string, unknown> = {}) {
  return { subscribers: [{ chatId, global: alerts, ...options }] };
}

function queueBroadcastRow(harness: ReturnType<typeof createDispatchHarness>, now: number) {
  harness.sqlite.prepare(
    `INSERT INTO telegram_jobs (job_id, kind, payload_json, state, created_at, expires_at)
     VALUES ('broadcast:queued', 'broadcast', '{}', 'ready', ?, ?)`,
  ).run(now, now + 3600);
  harness.sqlite.prepare(
    `INSERT INTO telegram_deliveries (job_id, kind, chat_id, audience, body, body_hash, state, next_attempt_at, expires_at, created_at)
     VALUES ('broadcast:queued', 'broadcast', '12345', 'notice', 'queued notice', 'h', 'pending', ?, ?, ?)`,
  ).run(now, now + 3600, now);
}

describe("dispatchTelegramAlerts", () => {
  beforeEach(resetDispatchTelegramAlertsTest);
  afterEach(cleanupDispatchTelegramAlertsTest);

  it("detects DEWS/depeg/safety changes and fans out to subscribers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, {
      dews: { "usdc-circle": "CALM" },
      safety: { "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" } },
      safetySource: { "usdc-circle": { grade: "C", score: 61, methodologyVersion: "7.09" } },
    });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", signals: { supply: { value: 45, available: true } } }],
      depegs: [{ stablecoinId: "usdc-circle" }],
      safety: [{ stablecoinId: "usdc-circle", grade: "C", score: 61 }],
      subscribers: [
        { chatId: "12345", lastActiveAt: now },
        { chatId: "unrelated", lastActiveAt: now },
      ],
      subscriptions: [
        { chatId: "12345", stablecoinId: "usdc-circle", alerts: { dews: true, depeg: true, safety: true } },
        { chatId: "unrelated", stablecoinId: "usdt-tether", alerts: { dews: true, depeg: true, safety: true } },
      ],
    });
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(metadata.eventsDetected).toMatchObject({
      dews: 1,
      depeg: 1,
      depegTriggered: 1,
      depegResolved: 0,
      depegWorsening: 0,
      safety: 1,
      suppressedMethodologyChanges: 0,
    });
    expect(metadata).toMatchObject({ subscribersNotified: 1, messagesSent: 1 });
    expect(metadata.authoritativePlanning).toMatchObject({
      sourceEventId: expect.stringMatching(/^alert:/),
      sourceEventFamilies: ["dews", "depeg", "safety"],
      plannedTargetCount: 1,
      handoffEnqueuedCount: 1,
      handoffPageCount: 1,
    });
    // The job row and the advanced baseline commit together.
    expect(harness.sqlite.prepare("SELECT kind, state FROM telegram_jobs").get()).toEqual({ kind: "alert", state: "done" });
    expect(harness.sqlite.prepare("SELECT chat_id, state FROM telegram_deliveries").all())
      .toEqual([{ chat_id: "12345", state: "sent" }]);
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "12345" })]);
  });

  it("suppresses only safety alerts when the live safety source cache is from the wrong generation", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, {
      dews: { "usdc-circle": "CALM" },
      safety: makeSafetySnapshotCache(
        { "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.08" } },
        "legacy-generation",
      ).value,
      safetySource: {
        "usdc-circle": { grade: "C", score: 61, methodologyVersion: "9.0" },
      },
    });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      safety: [
        {
          stablecoinId: "usdc-circle",
          grade: "C",
          score: 61,
          prevGrade: "B",
          prevScore: 78,
          methodologyVersion: "7.09",
        },
      ],
      ...direct("12345", { dews: true, safety: true }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({
      eventsDetected: { dews: 1, safety: 0 },
      messagesSent: 1,
      safetyAlertSourceState: "ok",
      safetyAlertsSuppressed: true,
    });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "12345" })]);
  });

  it("keeps eventless degraded-safety runs on the queue path without capturing the subscriber cohort", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, {
      safety: makeSafetySnapshotCache(
        { "usdc-circle": { grade: "B", score: 78, methodologyVersion: "9.0" } },
        "legacy-generation",
      ).value,
      safetySource: {
        "usdc-circle": { grade: "C", score: 61, methodologyVersion: "9.0" },
      },
    });
    harness.seed({ ...global("12345", { safety: true }) });
    const heldSafetySnapshot = readCacheValue(harness.sqlite, "alert:safety-snapshot");

    const first = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);
    const second = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(first).toMatchObject({
      eventlessFastPath: true,
      eventsDetected: { safety: 0 },
      safetyAlertSourceState: "ok",
      safetyAlertsSuppressed: true,
      messagesSent: 0,
    });
    expect(second).toMatchObject({
      eventlessFastPath: true,
      safetyAlertsSuppressed: false,
      messagesSent: 0,
    });
    expect(
      harness.sqlite
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM telegram_jobs) AS jobs,
             (SELECT COUNT(*) FROM telegram_deliveries) AS deliveries`,
        )
        .get(),
    ).toEqual({ jobs: 0, deliveries: 0 });
    expect(readCacheValue(harness.sqlite, "alert:safety-snapshot")).not.toBe(heldSafetySnapshot);
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("keeps global (all-stablecoin) DEWS follows roll-up only: no live send", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", signals: { supply: { value: 45, available: true } } }],
      ...global("777", { dews: true }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { dews: 1 }, subscribersNotified: 0, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("keeps global (all-stablecoin) safety follows roll-up only: no live send", async () => {
    const harness = createDispatchHarness();
    const safety = { "usdc-circle": { grade: "C+", score: 66, methodologyVersion: "7.09" } };
    seedDispatchSnapshots(harness, {
      safety: { "usdc-circle": { grade: "B", score: 70, methodologyVersion: "7.09" } },
      safetySource: safety,
    });
    harness.seed({
      safety: [{ stablecoinId: "usdc-circle", grade: "C+", score: 66 }],
      ...global("777", { safety: true }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { safety: 1 }, subscribersNotified: 0, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("isolates a fan-out failure: queued rows still drain and the run ends degraded", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    harness.seed({ subscribers: [{ chatId: "12345", lastActiveAt: now }] });
    harness.sqlite.prepare(
      `INSERT INTO telegram_jobs (job_id, kind, payload_json, state, created_at, expires_at)
       VALUES ('alert:corrupt', 'alert', '{', 'planning', ?, ?), ('broadcast:queued', 'broadcast', '{}', 'ready', ?, ?)`,
    ).run(now, now + 3600, now, now + 3600);
    harness.sqlite.prepare(
      `INSERT INTO telegram_deliveries (job_id, kind, chat_id, audience, body, body_hash, state, next_attempt_at, expires_at, created_at)
       VALUES ('broadcast:queued', 'broadcast', '12345', 'notice', 'queued notice', 'h', 'pending', ?, ?, ?)`,
    ).run(now, now + 3600, now);
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(result).toMatchObject({ status: "degraded", error: expect.stringContaining("fanout:") });
    expect(metadata).toMatchObject({ messagesSent: 1, deliveryV2: { planningErrors: [expect.stringMatching(/^fanout:/)] } });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "12345" })]);
  });

  it("holds freeze rows (fail closed) when retraction checks fail, while other kinds still drain", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    harness.seed({ subscribers: [{ chatId: "12345", lastActiveAt: now }, { chatId: "678", lastActiveAt: now }] });
    harness.sqlite.prepare(
      `INSERT INTO telegram_jobs (job_id, kind, payload_json, state, created_at, expires_at)
       VALUES ('freeze:tape-x', 'freeze', '{}', 'ready', ?, ?), ('broadcast:queued', 'broadcast', '{}', 'ready', ?, ?)`,
    ).run(now, now + 3600, now, now + 3600);
    const insert = harness.sqlite.prepare(
      `INSERT INTO telegram_deliveries (job_id, kind, chat_id, audience, body, body_hash, state, next_attempt_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'body', 'h', 'pending', ?, ?, ?)`,
    );
    insert.run("freeze:tape-x", "freeze", "678", "alert", now, now + 3600, now);
    insert.run("broadcast:queued", "broadcast", "12345", "notice", now, now + 3600, now);
    // Retraction validation cannot read Tape this run.
    harness.sqlite.exec("DROP TABLE tape_events");
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(result.status).toBe("degraded");
    expect(metadata.deliveryV2).toMatchObject({ heldKinds: ["freeze", "freeze_batch"] });
    expect(metadata.deliveryV2.planningErrors).toEqual(expect.arrayContaining([expect.stringMatching(/^freeze-retraction:/)]));
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "12345" })]);
    expect(harness.sqlite.prepare("SELECT state FROM telegram_deliveries WHERE kind = 'freeze'").get())
      .toEqual({ state: "pending" });
  });

  it("does not block live alerts when the roll-up step throws", async () => {
    const harness = createDispatchHarness();
    mockRunTelegramRollupStep.mockRejectedValueOnce(new Error("roll-up down"));
    seedDispatchSnapshots(harness, {
      safety: { "usdc-circle": { grade: "B", score: 70, methodologyVersion: "7.09" } },
      safetySource: { "usdc-circle": { grade: "C+", score: 66, methodologyVersion: "7.09" } },
    });
    harness.seed({
      safety: [{ stablecoinId: "usdc-circle", grade: "C+", score: 66 }],
      ...direct("12345", { safety: true }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(mockRunTelegramRollupStep).toHaveBeenCalledOnce();
    expect(metadata).toMatchObject({ messagesSent: 1, deliveryV2: { rollupState: "failed" } });
  });

  it("names a thrown roll-up hook as the run's reason without inventing sub-step outcomes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    harness.seed({ subscribers: [{ chatId: "12345", lastActiveAt: now }] });
    queueBroadcastRow(harness, now);
    mockRunTelegramRollupStep.mockRejectedValueOnce(new Error("roll-up down"));
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(result.status).toBe("degraded");
    expect(metadata).toMatchObject({
      reason: "telegram-rollup-step-failed",
      reasons: ["telegram-rollup-step-failed"],
      noWorkRun: false,
      messagesSent: 1,
    });
    // Unrelated live work and the sweep still run.
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "12345" })]);
    expect(harness.sqlite.prepare("SELECT state FROM telegram_jobs WHERE job_id = 'broadcast:queued'").get())
      .toEqual({ state: "done" });
  });

  it.each([
    [{ rollup: "failed" }, ["telegram-rollup-failed"]],
    [{ rollup: "preset-resolution-failed" }, ["telegram-rollup-preset-resolution-failed"]],
    [{ freezeBatch: "failed" }, ["telegram-freeze-batch-failed"]],
    [{ rollup: "failed", freezeBatch: "failed" }, ["telegram-rollup-failed", "telegram-freeze-batch-failed"]],
  ] as const)("degrades on a returned roll-up step failure %j", async (states, reasons) => {
    const harness = createDispatchHarness();
    mockRunTelegramRollupStep.mockResolvedValueOnce({
      freezeBatch: { state: "freezeBatch" in states ? states.freezeBatch : "not-due", changes: 0 },
      rollup: { state: "rollup" in states ? states.rollup : "not-due", dueChats: 0, sentChats: 0, emptyChats: 0, deferredChats: 0 },
    });
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(result).toMatchObject({ status: "degraded", error: expect.stringContaining(reasons[0]) });
    expect(metadata).toMatchObject({ reason: reasons[0], reasons, noWorkRun: false });
  });

  it.each(["not-due", "empty", "queued"] as const)("keeps a successful %s roll-up step ok", async (freezeBatch) => {
    const harness = createDispatchHarness();
    mockRunTelegramRollupStep.mockResolvedValueOnce({
      freezeBatch: { state: freezeBatch, changes: 0 },
      rollup: { state: freezeBatch === "queued" ? "done" : "not-due", dueChats: 0, sentChats: 0, emptyChats: 0, deferredChats: 0 },
    });
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(result.status).toBeUndefined();
    expect(metadata.reason).toBeUndefined();
    expect(metadata.reasons).toBeUndefined();
  });

  it("degrades a caught fan-out page failure that never throws out of fan-out", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    harness.seed({ subscribers: [{ chatId: "12345", lastActiveAt: now }] });
    queueBroadcastRow(harness, now);
    // A page builder that throws is failed closed inside fan-out.
    harness.sqlite.prepare(
      `INSERT INTO telegram_jobs (job_id, kind, payload_json, state, created_at, expires_at)
       VALUES ('freeze_batch:bad', 'freeze_batch', 'null', 'planning', ?, ?)`,
    ).run(now, now + 3600);
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(result.status).toBe("degraded");
    expect(metadata).toMatchObject({
      reason: "fanout-page-failed",
      reasons: ["fanout-page-failed"],
      deliveryV2: { jobsFailedClosed: 1, planningErrors: [] },
      messagesSent: 1,
    });
    expect(harness.sqlite.prepare("SELECT state, cursor FROM telegram_jobs WHERE job_id = 'freeze_batch:bad'").get())
      .toEqual({ state: "planning", cursor: null });
  });

  it("orders simultaneous stage failures deterministically, planning first", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    harness.sqlite.prepare(
      `INSERT INTO telegram_jobs (job_id, kind, payload_json, state, created_at, expires_at)
       VALUES ('freeze_batch:bad', 'freeze_batch', 'null', 'planning', ?, ?)`,
    ).run(now, now + 3600);
    harness.sqlite.exec("DROP TABLE tape_events");
    mockRunTelegramRollupStep.mockResolvedValueOnce({
      freezeBatch: { state: "failed", changes: 0 },
      rollup: { state: "preset-resolution-failed", dueChats: 1, sentChats: 0, emptyChats: 0, deferredChats: 1 },
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.reason).toBe("telegram-planning-failed");
    expect(metadata.reasons).toEqual([
      "telegram-planning-failed",
      "fanout-page-failed",
      "telegram-rollup-preset-resolution-failed",
      "telegram-freeze-batch-failed",
    ]);
    expect(metadata.deliveryV2.planningErrors).toEqual(expect.arrayContaining([expect.stringMatching(/^freeze-retraction:/)]));
  });

  it("holds a fresh severe safety drop for the dwell, so a one-run flip never alerts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, {
      // Baseline B with no pending move: the drop to D is first seen this run.
      safety: { "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09", pendingSinceSec: now } },
      safetySource: { "usdc-circle": { grade: "D", score: 44, methodologyVersion: "7.09" } },
    });
    harness.seed({
      safety: [{ stablecoinId: "usdc-circle", grade: "D", score: 44 }],
      ...direct("12345", { safety: true }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { safety: 0 }, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
    const baseline = JSON.parse(readCacheValue(harness.sqlite, "alert:safety-snapshot") ?? "{}");
    expect(baseline.snapshot["usdc-circle"]).toMatchObject({
      grade: "B",
      pendingKind: "severe-downgrade",
      pendingSinceSec: now,
    });
  });

  it("holds a settled severe drop inside the per-coin downgrade cooldown", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, {
      safety: { "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09", lastAlertedAtSec: now - 3600 } },
      safetySource: { "usdc-circle": { grade: "D", score: 44, methodologyVersion: "7.09" } },
    });
    harness.seed({
      safety: [{ stablecoinId: "usdc-circle", grade: "D", score: 44 }],
      ...direct("12345", { safety: true }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { safety: 0 }, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
    // Held: the baseline keeps B, the pending clock and the cooldown clock, so
    // the drop is sent once the cooldown ends instead of being lost.
    const baseline = JSON.parse(readCacheValue(harness.sqlite, "alert:safety-snapshot") ?? "{}");
    expect(baseline.snapshot["usdc-circle"]).toMatchObject({
      grade: "B", pendingKind: "severe-downgrade", lastAlertedAtSec: now - 3600,
    });
  });

  it("holds a first-sighting DEWS escalation until a second computation", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", firstComputation: true }],
      ...direct("12345", { dews: true }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { dews: 0 }, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
    expect(JSON.parse(readCacheValue(harness.sqlite, "alert:dews-candidate-snapshot") ?? "{}")["usdc-circle"])
      .toMatchObject({ computations: 1 });
  });

  it("suppresses minor global safety downgrades", async () => {
    const harness = createDispatchHarness();
    const safety = { "usdc-circle": { grade: "C+", score: 64, methodologyVersion: "7.09" } };
    seedDispatchSnapshots(harness, {
      safety: { "usdc-circle": { grade: "B", score: 65, methodologyVersion: "7.09" } },
      safetySource: safety,
    });
    harness.seed({
      safety: [{ stablecoinId: "usdc-circle", grade: "C+", score: 64 }],
      ...global("777", { safety: true }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { safety: 1 }, subscribersNotified: 0, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("chunks resolved depeg IN queries above 100 changed coins", async () => {
    const now = Math.floor(Date.now() / 1000);
    const ids = Array.from({ length: 101 }, (_, index) => `synthetic-${index}`);
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, {
      depeg: Object.fromEntries(
        ids.map((id, index) => [
          id,
          { symbol: `S${index}`, direction: "below", deviationBps: 125, price: 0.9875, pegReference: 1 },
        ]),
      ),
    });
    harness.seed({
      depegs: ids.map((stablecoinId, index) => ({
        stablecoinId,
        symbol: `S${index}`,
        peakDeviationBps: 125,
        startedAt: now - 3_600,
        endedAt: now - 300,
        recoveryPrice: 1,
      })),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected.depegResolved).toBe(101);
    expect(
      harness.operations
        .filter((entry) => entry.operation === "resolved-depeg-lookup")
        .map((entry) => entry.binds.length),
    ).toEqual([90, 11]);
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_jobs WHERE kind = 'alert'").get()).toEqual({
      count: 1,
    });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("lets a per-coin DEWS threshold override a global all-stablecoin follow", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", band: "ALERT" }],
      subscribers: [{ chatId: "777", global: { dews: true } }],
      subscriptions: [{ chatId: "777", stablecoinId: "usdc-circle", alerts: { dews: true }, dewsMinBand: "WARNING" }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ subscribersNotified: 0, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("lets a per-coin safety follow override the global material-only safety tier", async () => {
    const harness = createDispatchHarness();
    const safety = { "usdc-circle": { grade: "C+", score: 64, methodologyVersion: "7.09" } };
    seedDispatchSnapshots(harness, {
      safety: { "usdc-circle": { grade: "B", score: 65, methodologyVersion: "7.09" } },
      safetySource: safety,
    });
    harness.seed({
      safety: [{ stablecoinId: "usdc-circle", grade: "C+", score: 64 }],
      subscribers: [{ chatId: "777", global: { safety: true } }],
      subscriptions: [{ chatId: "777", stablecoinId: "usdc-circle", alerts: { safety: true } }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ subscribersNotified: 1, messagesSent: 1 });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "777" })]);
  });

  it("lets a restrictive per-coin safety mode suppress the global safety tier", async () => {
    const harness = createDispatchHarness();
    const safety = { "usdc-circle": { grade: "C+", score: 66, methodologyVersion: "7.09" } };
    seedDispatchSnapshots(harness, {
      safety: { "usdc-circle": { grade: "B", score: 70, methodologyVersion: "7.09" } },
      safetySource: safety,
    });
    harness.seed({
      safety: [{ stablecoinId: "usdc-circle", grade: "C+", score: 66 }],
      subscribers: [{ chatId: "777", global: { safety: true } }],
      subscriptions: [
        { chatId: "777", stablecoinId: "usdc-circle", alerts: { safety: true }, safetyMode: "upgrade-only" },
      ],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ subscribersNotified: 0, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("treats first-seen ids in a partial legacy safety snapshot as seed-only without alerting", async () => {
    const now = 1_778_150_000;
    const updatedAt = now - 3_600;
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, {
      safety: JSON.stringify({ "usdc-circle": { grade: "A", score: 84 } }),
      safetySource: {
        "usdc-circle": { grade: "A", score: 84, methodologyVersion: "7.09" },
        "bold-liquity": { grade: "B+", score: 79, methodologyVersion: "7.09" },
      },
      updatedAt,
    });
    harness.seed({
      safety: [
        { stablecoinId: "usdc-circle", grade: "A", score: 84, recordedAt: updatedAt - 86_400 },
        {
          stablecoinId: "bold-liquity",
          grade: "B+",
          score: 79,
          prevGrade: "A-",
          prevScore: 80,
          recordedAt: updatedAt + 60,
        },
      ],
      ...direct("12345", { safety: true }, { stablecoinId: "bold-liquity" }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { safety: 0 }, subscribersNotified: 0 });
    expect(metadata).toMatchObject({ eventlessFastPath: true });
    expect(telegramDeliveryTranscript).toEqual([]);
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_jobs").get()).toEqual({ count: 0 });
    expect(readCacheValue(harness.sqlite, "alert:safety-snapshot")).toContain('"bold-liquity"');
    expect(readCacheValue(harness.sqlite, "alert:safety-snapshot")).toContain('"usdc-circle"');
  });

  it("does not alert on historical rows missing from a partial legacy safety snapshot", async () => {
    const now = 1_778_150_000;
    const updatedAt = now - 3_600;
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, {
      safety: JSON.stringify({ "usdc-circle": { grade: "A", score: 84 } }),
      safetySource: {
        "usdc-circle": { grade: "A", score: 84, methodologyVersion: "7.09" },
        "bold-liquity": { grade: "A-", score: 80, methodologyVersion: "7.09" },
      },
      updatedAt,
    });
    harness.seed({
      safety: [
        { stablecoinId: "usdc-circle", grade: "A", score: 84, recordedAt: updatedAt - 86_400 },
        {
          stablecoinId: "bold-liquity",
          grade: "A-",
          score: 80,
          prevGrade: "B+",
          prevScore: 79,
          recordedAt: updatedAt - 86_400,
        },
      ],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { safety: 0 }, subscribersNotified: 0, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
    expect(readCacheValue(harness.sqlite, "alert:safety-snapshot")).toContain('"bold-liquity"');
    expect(readCacheValue(harness.sqlite, "alert:safety-snapshot")).toContain('"usdc-circle"');
  });

  it("ignores DEWS transitions to CALM/WATCH", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, { dews: { "usdc-circle": "ALERT" } });
    harness.seed({ dews: [{ stablecoinId: "usdc-circle", score: 20, band: "WATCH" }] });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected.dews).toBe(0);
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("does not resend the same DEWS alert band after a silent WATCH/CALM dip", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, { dews: { "uusd-youves": "WATCH" }, dewsAlertable: { "uusd-youves": "ALERT" } });
    harness.seed({ dews: [{ stablecoinId: "uusd-youves", score: 39, band: "ALERT" }] });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { dews: 0 }, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
    expect(readCacheValue(harness.sqlite, "alert:dews-alertable-snapshot")).toContain('"uusd-youves":"ALERT"');
  });
});
