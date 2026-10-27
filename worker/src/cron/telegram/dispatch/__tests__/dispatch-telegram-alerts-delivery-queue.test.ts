import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDispatchSnapshots } from "./dispatch-telegram-snapshots.test-support";
import {
  cleanupDispatchTelegramAlertsTest,
  createDispatchHarness,
  defaultDispatchCaches,
  dispatchTelegramAlerts,
  mockRecordOutcome,
  mockShouldAttemptFetch,
  readCacheValue,
  resetDispatchTelegramAlertsTest,
  telegramDeliveryTranscript,
  type CronProgressUpdate,
  type DispatchHarness,
} from "./dispatch-telegram-alerts.test-support";
import {
  WORKER_ACTIVE_STABLECOINS,
  WORKER_TRACKED_META_BY_ID,
  hasWorkerLiveReserves,
} from "@shared/lib/stablecoins/worker-runtime-registry";
import { D1_BATCH_SIZE } from "../../../../lib/constants";
import { makeNoopD1 } from "../../../../test-helpers/noop-d1";
import { buildTelegramChangeLogStatements } from "../../rollup/change-log";

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
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_jobs").get()).toEqual({ count: 0 });
  });

  describe("roll-up transitions commit with their baselines", () => {
    function seedDewsDeescalation(harness: DispatchHarness) {
      const now = Math.floor(Date.now() / 1000);
      healthySources(harness, { dews: [{ stablecoinId: "usdc-circle", score: 20, band: "WATCH" }] });
      // ALERT was the observed and alerted band; WATCH is an unsent de-escalation.
      seedDispatchSnapshots(harness, {
        dews: { "usdc-circle": "ALERT" },
        dewsAlertable: { "usdc-circle": "ALERT" },
        safety: { "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" } },
        safetySource: { "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" } },
        updatedAt: now - 60,
      });
      harness.cache("dews:published-generation", { updatedAt: now, source: "compute-dews", publishStatus: "published" }, now);
    }
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
      expect(JSON.parse(String(readCacheValue(harness.sqlite, "alert:dews-snapshot")))).toEqual({ "usdc-circle": "ALERT" });

      harness.sqlite.exec("DROP TRIGGER fail_change_log");
      const recovered = await dispatchTelegramAlerts(harness.db, "bot-token");
      expect(recovered.status).toBeUndefined();
      expect(JSON.parse(recovered.metadata)).toMatchObject({ eventlessFastPath: true });
      expect(dewsRows(harness)).toEqual([{ kind: "dews", stablecoin_id: "usdc-circle" }]);
      expect(JSON.parse(String(readCacheValue(harness.sqlite, "alert:dews-snapshot")))).toEqual({ "usdc-circle": "WATCH" });

      await dispatchTelegramAlerts(harness.db, "bot-token");
      expect(dewsRows(harness)).toHaveLength(1);
    });

    it("rolls back the whole batch when a later statement fails, and still drains queued rows", async () => {
      const now = Math.floor(Date.now() / 1000);
      const harness = createDispatchHarness();
      seedDewsDeescalation(harness);
      harness.seed({ subscribers: [{ chatId: "12345", lastActiveAt: now }] });
      harness.sqlite.prepare(
        `INSERT INTO telegram_jobs (job_id, kind, payload_json, state, created_at, expires_at)
         VALUES ('broadcast:queued', 'broadcast', '{}', 'ready', ?, ?)`,
      ).run(now, now + 3600);
      harness.sqlite.prepare(
        `INSERT INTO telegram_deliveries (job_id, kind, chat_id, audience, body, body_hash, state, next_attempt_at, expires_at, created_at)
         VALUES ('broadcast:queued', 'broadcast', '12345', 'notice', 'queued notice', 'h', 'pending', ?, ?, ?)`,
      ).run(now, now + 3600, now);
      // The change-log insert succeeds; a snapshot upsert later in the batch fails.
      harness.sqlite.exec(
        `CREATE TRIGGER fail_snapshot BEFORE UPDATE ON cache WHEN NEW.key = 'alert:depeg-snapshot'
         BEGIN SELECT RAISE(ABORT, 'snapshot write unavailable'); END`,
      );
      const result = await dispatchTelegramAlerts(harness.db, "bot-token");

      expect(result.status).toBe("degraded");
      expect(dewsRows(harness)).toEqual([]);
      expect(JSON.parse(String(readCacheValue(harness.sqlite, "alert:dews-snapshot")))).toEqual({ "usdc-circle": "ALERT" });
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
      expect(JSON.parse(String(readCacheValue(harness.sqlite, "alert:dews-snapshot")))).toEqual({ "usdc-circle": "WATCH" });
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
});
