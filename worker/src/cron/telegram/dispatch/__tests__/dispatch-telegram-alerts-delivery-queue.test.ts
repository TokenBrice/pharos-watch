import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDispatchSnapshots } from "./dispatch-telegram-snapshots.test-support";
import {
  cleanupDispatchTelegramAlertsTest,
  createDispatchHarness,
  defaultDispatchCaches,
  dispatchTelegramAlerts,
  mockRecordOutcome,
  mockRunTelegramRollupStep,
  mockShouldAttemptFetch,
  readCacheValue,
  resetDispatchTelegramAlertsTest,
  scriptTelegramDeliveries,
  telegramDeliveryTranscript,
  type CronProgressUpdate,
  type DispatchHarness,
} from "./dispatch-telegram-alerts.test-support";
import {
  WORKER_ACTIVE_STABLECOINS,
  WORKER_TRACKED_META_BY_ID,
  hasWorkerLiveReserves,
} from "@shared/lib/stablecoins/worker-runtime-registry";
import { CIRCUIT_SOURCE, D1_BATCH_SIZE } from "../../../../lib/constants";
import { makeNoopD1 } from "../../../../test-helpers/noop-d1";
import { buildTelegramChangeLogStatements } from "../../rollup/change-log";
import * as dbCache from "../../../../lib/db-cache";
import * as freezeJob from "../../jobs/freeze-job";
import { TELEGRAM_DISPATCH_SOFT_DEADLINE_MS } from "../../../../telegram/common/constants";

function seedFreezeTapeObservation(harness: DispatchHarness, now: number): void {
  // Fresh Tape input exercises independent freeze detection without a live audience.
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

function seedQueuedDelivery(harness: DispatchHarness, kind = "broadcast", attempts = 0) {
  const now = Math.floor(Date.now() / 1000);
  harness.sqlite.prepare(
    `INSERT INTO telegram_jobs (job_id, kind, payload_json, state, created_at, expires_at)
     VALUES (?, ?, '{}', 'ready', ?, ?)`,
  ).run(`${kind}:queued`, kind, now, now + 3600);
  harness.sqlite.prepare(
    `INSERT INTO telegram_deliveries (job_id, kind, chat_id, audience, body, body_hash, state, attempts,
       next_attempt_at, expires_at, created_at)
     VALUES (?, ?, '12345', 'notice', 'queued notice', 'h', 'pending', ?, ?, ?, ?)`,
  ).run(`${kind}:queued`, kind, attempts, now, now + (attempts ? 7200 : 3600), now - attempts * 300);
}

function healthySources(
  harness: DispatchHarness,
  dews: Array<{ stablecoinId: string; score?: number; band?: "CALM" | "WATCH" | "ALERT" | "WARNING" | "DANGER" }> = [],
) {
  const now = Math.floor(Date.now() / 1000);
  const safety = { "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" } };
  harness.seed({ dews, cache: defaultDispatchCaches() });
  seedDispatchSnapshots(harness, {
    dews: { "usdc-circle": "CALM" }, safety, safetySource: safety, updatedAt: now - 60,
  });
}

describe("dispatchTelegramAlerts", () => {
  beforeEach(resetDispatchTelegramAlertsTest);
  afterEach(() => { vi.restoreAllMocks(); cleanupDispatchTelegramAlertsTest(); });

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

  it.each([true, false])("propagates signal/source aborts before delivery (%s)", async (preAborted) => {
    const controller = new AbortController();
    const error = new DOMException("dispatch deadline", "AbortError");
    if (preAborted) controller.abort(error);
    const { db } = createDispatchHarness([{ operation: "active-snoozes", error }]);
    await expect(dispatchTelegramAlerts(db, "bot-token", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it.each(["snooze", "cache", "deadline"])("continues independent stages after %s source failure", async (failure) => {
    const sent = failure === "deadline" ? 0 : 1;
    const error = new Error("D1_ERROR: source load failed");
    const harness = createDispatchHarness(failure === "snooze" ? [{ operation: "active-snoozes", error }] : []);
    healthySources(harness);
    harness.seed({ subscribers: [{ chatId: "12345" }] });
    seedQueuedDelivery(harness);
    seedQueuedDelivery(harness, "freeze");
    harness.sqlite.exec(`UPDATE telegram_jobs SET state = 'planning',
      payload_json = '{"scope":"all","messageHtml":"queued notice"}' WHERE kind = 'broadcast'`);
    seedFreezeTapeObservation(harness, Math.floor(Date.now() / 1000));
    const baselines = () => harness.sqlite.prepare("SELECT * FROM cache WHERE key LIKE '%snapshot' ORDER BY key").all();
    const before = baselines();
    const getCache = dbCache.getCache;
    if (failure !== "snooze") vi.spyOn(dbCache, "getCache").mockImplementation((db, key) => {
      if (key !== "alert:dews-snapshot") return getCache(db, key);
      if (!sent) vi.setSystemTime(Date.now() + TELEGRAM_DISPATCH_SOFT_DEADLINE_MS);
      return Promise.reject(error);
    });
    vi.spyOn(freezeJob, "cancelRetractedFreezeDeliveries").mockRejectedValue(error);
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(result).toMatchObject({ status: "degraded", itemCount: sent });
    expect(metadata).toMatchObject({ reason: "telegram-planning-failed", noWorkRun: false,
      snapshotSeeded: false, pendingAttempted: sent, pendingDrained: sent, pendingTotal: 2 - sent,
      chatsWithActiveSnooze: null, suppressedSafetyChangesAtSeed: null,
      safetyAlertSourceState: null, reserveAlertSourceState: null,
      safetyAlertsSuppressed: true, reserveAlertsSuppressed: true,
      eventsDetected: { dews: null, depeg: null, safety: null, reserve: null, freeze: 1 } });
    expect(metadata.authoritativePlanning.sourceEventFamilies).toBeNull();
    expect(metadata.deliveryV2).toMatchObject({ heldKinds: ["freeze", "freeze_batch"],
      fanoutPages: sent, jobsDone: sent, drainStoppedReason: sent ? "empty" : "deadline",
      planningErrors: [expect.stringMatching(/^source-loading:/), expect.stringMatching(/^freeze-retraction:/)] });
    expect(baselines()).toEqual(before);
    expect(harness.sqlite.prepare("SELECT kind FROM telegram_change_log").all()).toEqual([{ kind: "freeze" }]);
    expect(harness.sqlite.prepare("SELECT state FROM telegram_deliveries WHERE kind = 'freeze'").get())
      .toEqual({ state: "pending" });
    expect(harness.sqlite.prepare("SELECT state FROM telegram_jobs WHERE kind = 'broadcast'").get())
      .toEqual({ state: sent ? "done" : "planning" });
    expect(mockRunTelegramRollupStep).toHaveBeenCalledTimes(1);
    expect(mockRecordOutcome.mock.calls).toEqual([[harness.db, CIRCUIT_SOURCE.TELEGRAM_API, true]]);
    expect(telegramDeliveryTranscript).toEqual(sent ? [expect.objectContaining({ chatId: "12345" })] : []);
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
    healthySources(harness, [{ stablecoinId: "usdc-circle", score: 12, band: "CALM" }]);
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
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_jobs").get()).toEqual({ count: 0 });
  });

  it("publishes a retry-ceiling drop as a max-attempts fallback, not a permanent failure", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    harness.seed({ subscribers: [{ chatId: "12345", lastActiveAt: now }] });
    // Nineteen transient retries put the next 429 at the defensive ceiling, inside TTL.
    seedQueuedDelivery(harness, "broadcast", 19);
    scriptTelegramDeliveries({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 429,
      errorClass: "rate_limit",
      delivery: "retryable_failure",
      retryAfterSec: 1,
    });

    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    // The row really did exhaust transient retries rather than hit a permanent
    // Telegram rejection.
    expect(
      harness.sqlite
        .prepare("SELECT state, attempts, reason FROM telegram_deliveries WHERE chat_id = '12345'")
        .get(),
    ).toEqual({ state: "failed", attempts: 20, reason: "max_attempts" });

    expect(metadata.pendingDropped).toBe(1);
    expect(metadata.pendingDroppedMaxAttemptsFallback).toBe(1);
    expect(metadata.pendingDroppedPermanentFailure).toBe(0);
  });

  describe("roll-up transitions commit with their baselines", () => {
    function seedDewsDeescalation(harness: DispatchHarness) {
      const now = Math.floor(Date.now() / 1000);
      healthySources(harness, [{ stablecoinId: "usdc-circle", score: 20, band: "WATCH" }]);
      // ALERT was the observed and alerted band; WATCH is an unsent de-escalation.
      for (const key of ["alert:dews-snapshot", "alert:dews-alertable-snapshot"])
        harness.cache(key, { "usdc-circle": "ALERT" }, now - 60);
      harness.cache("dews:published-generation", { updatedAt: now, source: "compute-dews", publishStatus: "published" }, now);
    }
    const dewsBaseline = (harness: DispatchHarness) =>
      JSON.parse(String(readCacheValue(harness.sqlite, "alert:dews-snapshot")));
    const dewsRows = (harness: DispatchHarness) =>
      harness.sqlite.prepare("SELECT kind, stablecoin_id FROM telegram_change_log WHERE kind = 'dews'").all();

    it("keeps an eventless DEWS de-escalation and its baseline across a failed change-log write", async () => {
      const harness = createDispatchHarness();
      seedDewsDeescalation(harness);
      harness.sqlite.exec(
        "CREATE TRIGGER fail_change_log BEFORE INSERT ON telegram_change_log BEGIN SELECT RAISE(ABORT, 'change log unavailable'); END",
      );
      const failed = await dispatchTelegramAlerts(harness.db, "bot-token");
      const failedMetadata = JSON.parse(failed.metadata);

      expect(failed.status).toBe("degraded");
      expect(failedMetadata).toMatchObject({ reason: "telegram-planning-failed", reasons: ["telegram-planning-failed"] });
      expect(failedMetadata.deliveryV2.planningErrors).toEqual([expect.stringMatching(/^alert-detection:/)]);
      expect(dewsRows(harness)).toEqual([]);
      // The baseline was not consumed, so recovery can re-detect the move.
      expect(dewsBaseline(harness)).toEqual({ "usdc-circle": "ALERT" });

      harness.sqlite.exec("DROP TRIGGER fail_change_log");
      const recovered = await dispatchTelegramAlerts(harness.db, "bot-token");
      expect(recovered.status).toBeUndefined();
      expect(JSON.parse(recovered.metadata)).toMatchObject({ eventlessFastPath: true });
      expect(dewsRows(harness)).toEqual([{ kind: "dews", stablecoin_id: "usdc-circle" }]);
      expect(dewsBaseline(harness)).toEqual({ "usdc-circle": "WATCH" });

      await dispatchTelegramAlerts(harness.db, "bot-token");
      expect(dewsRows(harness)).toHaveLength(1);
    });

    it("rolls back the whole batch when a later statement fails, and still drains queued rows", async () => {
      const now = Math.floor(Date.now() / 1000);
      const harness = createDispatchHarness();
      seedDewsDeescalation(harness);
      harness.seed({ subscribers: [{ chatId: "12345", lastActiveAt: now }] });
      seedQueuedDelivery(harness);
      // The change-log insert succeeds; a snapshot upsert later in the batch fails.
      harness.sqlite.exec(
        `CREATE TRIGGER fail_snapshot BEFORE UPDATE ON cache WHEN NEW.key = 'alert:depeg-snapshot'
         BEGIN SELECT RAISE(ABORT, 'snapshot write unavailable'); END`,
      );
      const result = await dispatchTelegramAlerts(harness.db, "bot-token");

      expect(result.status).toBe("degraded");
      expect(dewsRows(harness)).toEqual([]);
      expect(dewsBaseline(harness)).toEqual({ "usdc-circle": "ALERT" });
      expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "12345" })]);
    });

    it("keeps a committed but unacknowledged batch: no duplicate transition on recovery", async () => {
      const harness = createDispatchHarness();
      seedDewsDeescalation(harness);
      let loseAck = true;
      const lossy = new Proxy(harness.db, {
        get(target, property, receiver) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              const results = await target.batch(statements);
              // The first batch that committed a transition loses its acknowledgement.
              if (loseAck && dewsRows(harness).length > 0) {
                loseAck = false;
                throw new Error("network: acknowledgement lost");
              }
              return results;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
      expect((await dispatchTelegramAlerts(lossy, "bot-token")).status).toBe("degraded");
      expect(dewsRows(harness)).toHaveLength(1);
      await dispatchTelegramAlerts(lossy, "bot-token");
      expect(dewsRows(harness)).toHaveLength(1);
      expect(dewsBaseline(harness)).toEqual({ "usdc-circle": "WATCH" });
    });

    it("bounds the admitted change-log cohort within one atomic batch", () => {
      // One safety and one DEWS entry per tracked asset, one reserve entry per
      // configured active asset; plus at most seven snapshot upserts, the
      // observed-safety upsert and the alert job. Catalog growth past the
      // 100-statement batch must be reviewed, never split into chunks.
      const tracked = WORKER_TRACKED_META_BY_ID.size;
      const reserve = WORKER_ACTIVE_STABLECOINS.filter(hasWorkerLiveReserves).length;
      const entries = Array.from({ length: tracked * 2 + reserve }, (_, index) => ({
        kind: "dews" as const,
        stablecoinId: `coin-${index}`,
        sourceKey: `dews:${index}`,
        observedAt: 1,
        payload: { symbol: "X", from: "ALERT", to: "WATCH", score: 1 },
      }));
      const changeLogStatements = buildTelegramChangeLogStatements(makeNoopD1({
        prepare: () => ({ bind: () => ({}) }),
      }), entries).length;
      expect(changeLogStatements + 7 + 1 + 1).toBeLessThanOrEqual(D1_BATCH_SIZE);
    });
  });

  // A failed snapshot write is isolated and named in deliveryV2.planningErrors,
  // so the same metadata must not also claim the write-back it did not commit
  // (docs/telegram-alerts.md#first-run--stale-snapshot-behavior).
  it.each(["seed", "eventless"])("does not claim an uncommitted %s snapshot write", async (stage) => {
    const harness = createDispatchHarness();
    const seeding = stage === "seed";
    if (!seeding) healthySources(harness, [{ stablecoinId: "usdc-circle", score: 12, band: "CALM" }]);
    harness.sqlite.exec(
      `CREATE TRIGGER fail_write BEFORE ${seeding ? "INSERT" : "UPDATE"} ON cache
       ${seeding ? "" : "WHEN NEW.key = 'alert:depeg-snapshot'"}
       BEGIN SELECT RAISE(ABORT, 'cache write unavailable'); END`,
    );
    const failed = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(failed.metadata);
    expect(failed.status).toBe("degraded");
    expect(metadata.deliveryV2.planningErrors).toEqual([expect.stringMatching(/^alert-detection:/)]);
    if (seeding) {
      expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 0 });
      expect(metadata.snapshotSeeded).toBe(false);
      harness.sqlite.exec("DROP TRIGGER fail_write");
      const recovered = await dispatchTelegramAlerts(harness.db, "bot-token");
      expect(JSON.parse(recovered.metadata).snapshotSeeded).toBe(true);
      expect(readCacheValue(harness.sqlite, "alert:depeg-snapshot")).not.toBeNull();
    } else {
      expect(metadata.eventlessFastPath).not.toBe(true);
    }
  });
});
