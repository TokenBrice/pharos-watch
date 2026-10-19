import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { Env } from "../env";
import type { ReserveContinuationMessage } from "@shared/types/reserve-continuation";
import { beginLiveReserveCheckpoint, continueLiveReserveCheckpoint, loadLiveReserveCheckpoint } from "../scheduled-recovery-checkpoint";
import { handleReserveContinuationBatch } from "../../handlers/reserve-continuation";
import { runFourHourlyReserveSyncSlot } from "../../handlers/scheduled/four-hourly-reserves";
import { buildScheduledSlotSummary } from "../../handlers/scheduled/slot-summary";
import { sendReserveContinuation } from "../reserve-continuation-send";
import { createSlotDeadline } from "../cron-timeouts";
import { sealAcceptedReserveGeneration } from "../accepted-reserve-generation";

vi.mock("../../handlers/scheduled/four-hourly-reserves", () => ({ runFourHourlyReserveSyncSlot: vi.fn() }));
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
  const message: ReserveContinuationMessage = { version: 1, scheduleKey: "fourHourlyReserveSync", slotStartedAt: ROOT,
    attemptNo: 1, executionGeneration: 1, queueHash: checkpoint.queueHash, nextItemKey: "coin-two", itemsDone: 1,
    phase: "reserve", sourceInvocationId: "head" };
  const send = vi.fn(async () => undefined);
  const env = { DB: fixture.db, CF_VERSION_METADATA: { id: "test", tag: "", timestamp: "" },
    WORKER_RESERVE_QUEUE_MODE: "on", WORKER_RESERVE_RECOVERY_MODE: "recover", RESERVE_CONTINUATION_QUEUE: { send } } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (work: Promise<unknown>) => pending.push(work) } as unknown as ExecutionContext;
  const delivery = { id: "delivery-one", timestamp: new Date(NOW * 1000 - 500), attempts: 1,
    body: message, ack: vi.fn(), retry: vi.fn() };
  const batch = { queue: "pharos-reserve-continuation", messages: [delivery], ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<unknown>;
  return { ...fixture, env, ctx, pending, message, delivery, batch, send };
}

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(NOW * 1000); vi.mocked(runFourHourlyReserveSyncSlot).mockReset(); });
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

describe("reserve Queue delivery semantics", () => {
  it("delivers an exhausted sealed cohort as a fresh tail, with no producer frontier", async () => {
    const f = await setup();
    f.sqlite.exec(`UPDATE worker_scheduled_checkpoints SET state='running', items_done=2, next_item_key=NULL,
      child_dispositions_json='{"sync-live-reserves":"running"}'`);
    const checkpoint = (await loadLiveReserveCheckpoint(f.db, f.message))!;
    await sealAcceptedReserveGeneration(f.db, checkpoint, f.message.queueHash, ["coin-one", "coin-two"], { status: "ok" }, NOW);
    await continueLiveReserveCheckpoint(f.db, checkpoint);
    Object.assign(f.message, { phase: "tail", nextItemKey: null, itemsDone: 2 });
    await sendReserveContinuation(f.env, f.message, createSlotDeadline(NOW * 1000));
    expect(f.send).toHaveBeenCalledOnce();
    f.send.mockClear();
    vi.mocked(runFourHourlyReserveSyncSlot).mockImplementationOnce(async (runtime) => {
      expect(runtime.recoveryCheckpoint).toMatchObject({ nextItemKey: null, itemsDone: 2,
        childDispositions: { "sync-live-reserves": "completed" } });
      expect(runtime.reserveQueueMetadata?.phase).toBe("tail");
      return buildScheduledSlotSummary([]);
    });
    await handleReserveContinuationBatch(f.batch, f.env, f.ctx, NOW * 1000);
    expect(runFourHourlyReserveSyncSlot).toHaveBeenCalledOnce();
    expect(f.delivery.ack).toHaveBeenCalledOnce();
    expect(f.delivery.retry).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("acks successful work only after lease/event settlement and sends the next exact frontier", async () => {
    const f = await setup();
    vi.mocked(runFourHourlyReserveSyncSlot).mockImplementationOnce(async (runtime) => {
      expect(runtime.scheduledTimeMs).toBeNull();
      expect(runtime.executionFence?.kind).toBe("reserve-continuation");
      expect(runtime.deadline.eventEntryMs).toBe(NOW * 1000);
      expect(runtime.reserveQueueMetadata).toMatchObject({ deliveryLatencyMs: 500, deliveryAttempt: 1, phase: "reserve" });
      await runtime.runLeasedCron("cron-sentinel", async () => ({ status: "ok" }));
      await continueLiveReserveCheckpoint(f.db, runtime.recoveryCheckpoint!);
      return { ...buildScheduledSlotSummary([]), reserveContinuation: { ...f.message, sourceInvocationId: runtime.invocationId! } };
    });
    f.send.mockImplementationOnce(async () => {
      expect(f.sqlite.prepare("SELECT state FROM reserve_continuation_executions").get()).toEqual({ state: "finished" });
      expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM cron_leases").get()).toEqual({ count: 0 });
    });
    await handleReserveContinuationBatch(f.batch, f.env, f.ctx, NOW * 1000);
    expect(f.delivery.ack).toHaveBeenCalledOnce();
    expect(f.delivery.retry).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.sqlite.prepare("SELECT json_extract(metadata,'$.reserveQueue.phase') AS phase FROM cron_runs").get()).toEqual({ phase: "reserve" });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM cron_slot_executions").get()).toEqual({ count: 1 });
  });

  it("acks duplicates without running adapters or falling through to config recovery", async () => {
    const f = await setup();
    vi.mocked(runFourHourlyReserveSyncSlot).mockResolvedValue(buildScheduledSlotSummary([]));
    await handleReserveContinuationBatch(f.batch, f.env, f.ctx, NOW * 1000);
    await handleReserveContinuationBatch(f.batch, f.env, f.ctx, NOW * 1000);
    expect(runFourHourlyReserveSyncSlot).toHaveBeenCalledOnce();
    expect(f.delivery.ack).toHaveBeenCalledTimes(2);
  });

  it("retries an unclaimed infrastructure failure and lets the next delivery claim", async () => {
    const f = await setup();
    vi.spyOn(f.db, "prepare").mockImplementationOnce(() => { throw new Error("binding unavailable"); });
    await handleReserveContinuationBatch(f.batch, f.env, f.ctx, NOW * 1000);
    await Promise.all(f.pending);
    expect(f.delivery.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect((await loadLiveReserveCheckpoint(f.db, f.message))?.state).toBe("ready");
    vi.mocked(runFourHourlyReserveSyncSlot).mockResolvedValue(buildScheduledSlotSummary([]));
    await handleReserveContinuationBatch(f.batch, f.env, f.ctx, NOW * 1000);
    expect(runFourHourlyReserveSyncSlot).toHaveBeenCalledOnce();
    expect(f.delivery.ack).toHaveBeenCalledOnce();
  });

  it("records consumer failure; redelivery cannot create another domain attempt", async () => {
    const f = await setup();
    vi.mocked(runFourHourlyReserveSyncSlot).mockRejectedValue(new Error("consumer crashed"));
    await handleReserveContinuationBatch(f.batch, f.env, f.ctx, NOW * 1000);
    await Promise.all(f.pending);
    expect(f.delivery.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(f.sqlite.prepare("SELECT result_status FROM reserve_continuation_executions").get()).toEqual({ result_status: "error" });
    await handleReserveContinuationBatch(f.batch, f.env, f.ctx, NOW * 1000);
    expect(runFourHourlyReserveSyncSlot).toHaveBeenCalledOnce();
    expect(f.delivery.ack).toHaveBeenCalledOnce();
  });

  it("acknowledges a named semantic child failure without immediate chaining", async () => {
    const f = await setup();
    vi.mocked(runFourHourlyReserveSyncSlot).mockImplementationOnce(async (runtime) => {
      await continueLiveReserveCheckpoint(f.db, runtime.recoveryCheckpoint!);
      return buildScheduledSlotSummary([{ job: "sync-redemption-backstops", outcome: "error", status: "error", reason: "provider-failed" }]);
    });
    await handleReserveContinuationBatch(f.batch, f.env, f.ctx, NOW * 1000);
    expect(f.delivery.ack).toHaveBeenCalledOnce();
    expect(f.delivery.retry).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect((await loadLiveReserveCheckpoint(f.db, f.message))?.state).toBe("ready");
  });

  it("send failure leaves the durable handoff ready for cron and never retries producer work", async () => {
    const f = await setup();
    f.send.mockRejectedValueOnce(new Error("Queue unavailable"));
    await sendReserveContinuation(f.env, f.message, createSlotDeadline(NOW * 1000));
    expect(f.send).toHaveBeenCalledOnce();
    expect((await loadLiveReserveCheckpoint(f.db, f.message))?.state).toBe("ready");
    expect(runFourHourlyReserveSyncSlot).not.toHaveBeenCalled();
  });

  it.each(["malformed", "foreign-queue", "multi-message", "off"])("rejects %s without work", async (kind) => {
    const f = await setup();
    const batch = kind === "foreign-queue" ? { ...f.batch, queue: "other" }
      : kind === "multi-message" ? { ...f.batch, messages: [f.delivery, f.delivery] }
      : kind === "malformed" ? { ...f.batch, messages: [{ ...f.delivery, body: { version: 2 } }] } : f.batch;
    if (kind === "off") f.env.WORKER_RESERVE_QUEUE_MODE = "off";
    await handleReserveContinuationBatch(batch, f.env, f.ctx, NOW * 1000);
    expect(runFourHourlyReserveSyncSlot).not.toHaveBeenCalled();
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_continuation_executions").get()).toEqual({ count: 0 });
  });
});
