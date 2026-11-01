import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { ReserveContinuationMessage } from "@shared/types/reserve-continuation";
import { claimReserveContinuation, finishReserveContinuation, heartbeatReserveContinuation } from "../reserve-continuation-fence";
import { beginLiveReserveCheckpoint, continueLiveReserveCheckpoint, claimNextLiveReserveCheckpointRecovery, loadLiveReserveCheckpoint } from "../scheduled-recovery-checkpoint";
import { acquireCronLease, runCronWithLease } from "../cron-lease-primitives";
import { createSlotDeadline } from "../cron-timeouts";
import { markScheduledChildStarted, writeScheduledChildTerminal } from "../scheduled-child-terminal";
import type { ScheduledChildIdentity } from "../scheduled-child-terminal";
import { reconcileReserveContinuations } from "../reserve-continuation-reconciliation";

import { ACCEPTED_RESERVE_GENERATION_KEY, sealAcceptedReserveGeneration } from "../accepted-reserve-generation";
const fixtures = createLatestSchemaFixtureTracker();
const ROOT = 1_728_000_660;
const NOW = 1_728_003_600;
async function setup() {
  const fixture = fixtures.open();
  fixture.sqlite.function("unixepoch", () => NOW);
  fixture.sqlite.prepare(`INSERT INTO cron_slot_executions
    (slot_key, slot_started_at, state, execution_owner, execution_generation, invocation_id, started_at, updated_at, finished_at)
    VALUES ('fourHourlyReserveSync', ?, 'finished', 'head-owner', 1, 'head', ?, ?, ?)`)
    .run(ROOT, ROOT, ROOT + 100, ROOT + 100);
  const checkpoint = await beginLiveReserveCheckpoint(fixture.db, { slotStartedAt: ROOT, invocationId: "head" });
  fixture.sqlite.exec("UPDATE worker_scheduled_checkpoints SET items_total=2, items_done=1, next_item_key='coin-two'");
  await continueLiveReserveCheckpoint(fixture.db, checkpoint);
  await acquireCronLease(fixture.db, "reserve-recovery", "queue-lease", 900);
  const message: ReserveContinuationMessage = { version: 1, scheduleKey: "fourHourlyReserveSync", slotStartedAt: ROOT,
    attemptNo: 1, executionGeneration: 1, queueHash: checkpoint.queueHash, nextItemKey: "coin-two", itemsDone: 1,
    phase: "reserve", sourceInvocationId: "head" };
  const options = { deliveryId: "delivery-one", owner: "queue-owner", leaseOwner: "queue-lease", workerVersion: "test",
    deadline: createSlotDeadline(NOW * 1000) };
  return { ...fixture, message, options };
}

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(NOW * 1000); });
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

describe("reserve Queue exact checkpoint and execution authority", () => {
  it("admits an exhausted tail only with its full accepted generation, never a replaced seal", async () => {
    const f = await setup();
    f.sqlite.exec(`UPDATE worker_scheduled_checkpoints SET state='running', items_done=2, next_item_key=NULL,
      child_dispositions_json='{"sync-live-reserves":"running"}'`);
    const checkpoint = (await loadLiveReserveCheckpoint(f.db, f.message))!;
    const seal = await sealAcceptedReserveGeneration(f.db, checkpoint, f.message.queueHash, ["coin-one", "coin-two"], { status: "ok" }, NOW);
    expect(seal).not.toBeNull();
    await continueLiveReserveCheckpoint(f.db, checkpoint);
    const tail = { ...f.message, phase: "tail" as const, nextItemKey: null, itemsDone: 2 };
    const originalBatch = f.db.batch.bind(f.db);
    vi.spyOn(f.db, "batch").mockImplementationOnce(async (statements) => {
      f.sqlite.prepare("DELETE FROM cache WHERE key=?").run(ACCEPTED_RESERVE_GENERATION_KEY);
      return originalBatch(statements);
    });
    expect(await claimReserveContinuation(f.db, tail, f.options)).toBeNull();
    f.sqlite.prepare("INSERT INTO cache (key,value,updated_at) VALUES (?,?,?)")
      .run(ACCEPTED_RESERVE_GENERATION_KEY, JSON.stringify(seal), NOW);
    expect((await claimReserveContinuation(f.db, tail, f.options))?.checkpoint.nextItemKey).toBeNull();
  });
  it("recognizes its own committed claim after an ambiguous batch response", async () => {
    const { db, sqlite, message, options } = await setup();
    const originalBatch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await originalBatch(statements as never);
      throw new Error("Network connection lost");
    });
    const claim = await claimReserveContinuation(db, message, options);
    expect(claim?.fence.deliveryId).toBe("delivery-one");
    expect(claim?.checkpoint).toMatchObject({
      state: "recovering",
      invocationId: options.owner,
      recoveryOwner: options.owner,
    });
    expect(claim?.checkpoint.recoveryLeaseUntil).toBeGreaterThanOrEqual(NOW);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_continuation_executions").get()).toEqual({ count: 1 });
  });

  it("claims atomically, deduplicates delivery/frontier and preserves the original root", async () => {
    const { db, sqlite, message, options } = await setup();
    const claim = await claimReserveContinuation(db, message, options);
    expect(claim?.checkpoint).toMatchObject({ state: "recovering", slotStartedAt: ROOT, invocationId: "queue-owner" });
    expect(claim?.fence).toMatchObject({ kind: "reserve-continuation", deliveryId: "delivery-one" });
    expect(await claimReserveContinuation(db, message, { ...options, owner: "duplicate" })).toBeNull();
    expect(await claimReserveContinuation(db, message, { ...options, deliveryId: "another", owner: "another" })).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_slot_executions").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_continuation_executions").get()).toEqual({ count: 1 });
    await continueLiveReserveCheckpoint(db, claim!.checkpoint);
    expect(await claimNextLiveReserveCheckpointRecovery(db, { owner: "cron", leaseSec: 900, nowSec: NOW })).toMatchObject({ disposition: "none" });
    await finishReserveContinuation(db, claim!.fence, "ok", {});
    expect(await claimReserveContinuation(db, message, { ...options, owner: "late" })).toBeNull();
    expect(await claimNextLiveReserveCheckpointRecovery(db, { owner: "cron", leaseSec: 900, nowSec: NOW })).toMatchObject({ disposition: "claimed" });
  });

  it.each([
    { executionGeneration: 2 }, { attemptNo: 2 }, { slotStartedAt: ROOT - 14400 }, { queueHash: "changed" },
    { sourceInvocationId: "foreign" }, { nextItemKey: "old-frontier" }, { itemsDone: 0 }, { phase: "tail" as const },
  ])("rejects stale, foreign or incompatible hint %j", async (change) => {
    const { db, sqlite, message, options } = await setup();
    expect(await claimReserveContinuation(db, { ...message, ...change }, options)).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_continuation_executions").get()).toEqual({ count: 0 });
    expect((await loadLiveReserveCheckpoint(db, message))?.state).toBe("ready");
  });

  it.each(["completed", "failed"])("never reopens a %s cohort", async (state) => {
    const { db, sqlite, message, options } = await setup();
    sqlite.prepare("UPDATE worker_scheduled_checkpoints SET state=?, completed_at=?").run(state, NOW);
    expect(await claimReserveContinuation(db, message, options)).toBeNull();
  });

  it("requires the source event terminal, not just a ready checkpoint", async () => {
    const { db, sqlite, message, options } = await setup();
    sqlite.exec("UPDATE cron_slot_executions SET state='running', finished_at=NULL");
    expect(await claimReserveContinuation(db, message, options)).toBeNull();
    expect((await loadLiveReserveCheckpoint(db, message))?.state).toBe("ready");
  });

  it.each(["event", "checkpoint"])("rolls back both authorities when %s persistence fails", async (failure) => {
    const { db, sqlite, message, options } = await setup();
    sqlite.exec(failure === "event"
      ? "CREATE TRIGGER fail_claim BEFORE INSERT ON reserve_continuation_executions BEGIN SELECT RAISE(ABORT,'claim failure'); END"
      : "CREATE TRIGGER fail_claim BEFORE UPDATE ON worker_scheduled_checkpoints BEGIN SELECT RAISE(ABORT,'claim failure'); END");
    await expect(claimReserveContinuation(db, message, options)).rejects.toThrow("claim failure");
    expect((await loadLiveReserveCheckpoint(db, message))?.state).toBe("ready");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_continuation_executions").get()).toEqual({ count: 0 });
  });

  it("arbitrates concurrent cron and Queue frontier claims exactly once", async () => {
    const { db, message, options } = await setup();
    const [queue, cron] = await Promise.all([
      claimReserveContinuation(db, message, options),
      claimNextLiveReserveCheckpointRecovery(db, { owner: "cron", leaseSec: 900, nowSec: NOW }),
    ]);
    expect(Number(queue !== null) + Number(cron.disposition === "claimed")).toBe(1);
  });

  it("shares the global recovery lease with cron and never clears a live lease on retry", async () => {
    const { db, sqlite } = await setup();
    const run = vi.fn();
    expect(await runCronWithLease(db, "reserve-recovery", run, { owner: "cron" })).toMatchObject({ status: "skipped_locked" });
    expect(run).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT lease_owner FROM cron_leases WHERE job='reserve-recovery'").get()).toEqual({ lease_owner: "queue-lease" });
  });

  it("fences child terminal writes and reconciles dead Queue events without cron delivery rows", async () => {
    const { db, sqlite, message, options } = await setup();
    const claim = (await claimReserveContinuation(db, message, options))!;
    const identity: ScheduledChildIdentity = { scheduleKey: message.scheduleKey, slotStartedAt: ROOT,
      job: "sync-live-reserves", producerPath: message.scheduleKey, producerKind: "queue-recovery", invocationId: options.owner,
      workerVersion: "test", attemptNo: 1, executionFence: claim.fence };
    await markScheduledChildStarted(db, identity, NOW, "child-lease");
    expect(await finishReserveContinuation(db, claim.fence, "ok", {})).toBe(false);
    sqlite.exec(`UPDATE reserve_continuation_executions SET updated_at=${NOW - 200}, deadline_ms=${(NOW - 100) * 1000}`);
    await acquireCronLease(db, "sync-live-reserves", "child-lease", 900);
    expect(await reconcileReserveContinuations(db, new AbortController().signal)).toBe(0);
    sqlite.exec("UPDATE cron_leases SET lease_until=0");
    expect(await reconcileReserveContinuations(db, new AbortController().signal)).toBe(1);
    expect(await heartbeatReserveContinuation(db, claim.fence)).toBe(false);
    expect((await writeScheduledChildTerminal(db, { identity, source: "real", startedAt: NOW, completedAt: NOW,
      durationMs: 0, status: "ok", degradedReason: null, disposition: "completed", producerOutcome: "ok" })).accepted).toBe(false);
    expect(sqlite.prepare("SELECT state,result_status FROM reserve_continuation_executions").get()).toEqual({ state: "finished", result_status: "error" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_slot_executions").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT status,producer_kind FROM cron_runs").get()).toEqual({ status: "error", producer_kind: "queue-recovery" });
  });

  it("starts the absolute deadline before any claim read", async () => {
    const { db, message, options } = await setup();
    const prepare = vi.spyOn(db, "prepare");
    await expect(claimReserveContinuation(db, message, { ...options, deadline: createSlotDeadline(0, 1) })).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
  });
});
