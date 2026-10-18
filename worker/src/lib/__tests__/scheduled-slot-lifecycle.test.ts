import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlotDeadline, SCHEDULED_SLOT_JOB_BUDGET_MS } from "../cron-timeouts";
import { runScheduledSlotWithFence, sweepStaleScheduledSlotExecutions } from "../scheduled-slot-fence";
import { closeOpenLeaseDatabases, makeLeaseDb, makeRunningSlot, makeProgressRow, makeLeaseRow } from "./cron-leases.test-support";

/** Queue a real SQLite statement before execution, like an uncancellable D1 RPC. */
function stallStatement(db: D1Database, matches: (sql: string) => boolean) {
  const prepare = db.prepare.bind(db);
  let release!: () => void;
  const entered = vi.fn();
  let stalledOnce = false;
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!matches(sql) || stalledOnce) return statement;
    stalledOnce = true;
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...values) => {
      const bound = bind(...values);
      const run = bound.run.bind(bound);
      vi.spyOn(bound, "run").mockImplementation(async () => {
        entered();
        await new Promise<void>((resolve) => { release = resolve; });
        return run();
      });
      return bound;
    });
    return statement;
  });
  return { entered, release: () => release() };
}

const successfulSummary = { jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 };

describe("event-entry scheduled lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    closeOpenLeaseDatabases();
  });

  it.each(["claim", "child-marker"])("bounds stalled D1 before %s and fences its late result", async (stage) => {
    const db = makeLeaseDb();
    const entryMs = Date.now();
    const slotStartedAt = entryMs / 1000;
    const stalled = stallStatement(db, (sql) => stage === "claim"
      ? sql.includes("INSERT OR IGNORE INTO cron_slot_executions")
      : sql.includes("SET child_marker_version = 1"));
    const body = vi.fn(async () => successfulSummary);
    const tails: Promise<unknown>[] = [];
    const run = runScheduledSlotWithFence(db, "quarterHourly", body, {
      owner: "original", slotStartedAt,
      deadline: createSlotDeadline(entryMs), waitUntil: (tail) => { tails.push(tail); },
    });
    const failure = expect(run).rejects.toThrow("exceeded controlled deadline");
    await vi.waitFor(() => expect(stalled.entered).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(entryMs + SCHEDULED_SLOT_JOB_BUDGET_MS - Date.now());
    await vi.advanceTimersByTimeAsync(0);
    await failure;
    expect(Date.now() - entryMs).toBe(SCHEDULED_SLOT_JOB_BUDGET_MS);
    expect(body).not.toHaveBeenCalled();
    expect(tails).toHaveLength(1);
    let tailSettled = false;
    const retained = Promise.all(tails).then(() => { tailSettled = true; });
    await Promise.resolve();
    expect(tailSettled).toBe(false);
    if (stage === "claim") {
      expect(db.getSlot("quarterHourly", slotStartedAt)).toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"disposition":"delivered-not-admitted"'));
    }
    stalled.release();
    await retained;
    expect(body).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(db.getSlot("quarterHourly", slotStartedAt)).toMatchObject({ state: "finished", result_status: "error" }));
    expect(JSON.parse(db.getSlot("quarterHourly", slotStartedAt)!.metadata!)).toMatchObject({
      disposition: stage === "claim" ? "delivered-not-admitted" : "claimed-failed",
    });
  });

  it("rejects a late terminal after takeover without changing its generation or result", async () => {
    const db = makeLeaseDb();
    const slotStartedAt = Date.now() / 1000;
    const stalled = stallStatement(db, (sql) => sql.includes("SET state = 'finished'") && sql.includes("execution_generation = ?"));
    const run = runScheduledSlotWithFence(db, "quarterHourly", async () => successfulSummary, {
      owner: "original", slotStartedAt, deadline: createSlotDeadline(Date.now()),
    });
    const failure = expect(run).rejects.toThrow("ownership lost");
    await vi.waitFor(() => expect(stalled.entered).toHaveBeenCalledTimes(1));
    db.sqlite.prepare("UPDATE cron_slot_executions SET execution_owner = 'takeover', execution_generation = 2, result_status = 'degraded' WHERE slot_key = ? AND slot_started_at = ?")
      .run("quarterHourly", slotStartedAt);
    stalled.release();
    await failure;
    expect(db.getSlot("quarterHourly", slotStartedAt)).toMatchObject({
      state: "running", execution_owner: "takeover", execution_generation: 2, result_status: "degraded",
    });
  });

  it("bounds settlement with a stalled heartbeat and ignores its late write after takeover", async () => {
    const db = makeLeaseDb();
    const entryMs = Date.now();
    const slotStartedAt = entryMs / 1000;
    const stalled = stallStatement(db, (sql) => sql.includes("SET updated_at = MAX(updated_at, ?)"));
    let finish!: () => void;
    const body = vi.fn(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return successfulSummary;
    });
    const tails: Promise<unknown>[] = [];
    const run = runScheduledSlotWithFence(db, "quarterHourly", body, {
      owner: "original", slotStartedAt, heartbeatSec: 15,
      deadline: createSlotDeadline(entryMs), waitUntil: (tail) => { tails.push(tail); },
    });
    const failure = expect(run).rejects.toThrow("exceeded controlled deadline");
    await vi.waitFor(() => expect(body).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(stalled.entered).toHaveBeenCalledOnce();
    finish();
    // The body is drained but settlement is still awaiting the heartbeat.
    await vi.advanceTimersByTimeAsync(SCHEDULED_SLOT_JOB_BUDGET_MS - 15_000);
    await vi.advanceTimersByTimeAsync(0);
    await failure;
    db.sqlite.prepare("UPDATE cron_slot_executions SET execution_owner = 'takeover', execution_generation = 2, updated_at = ? WHERE slot_key = ? AND slot_started_at = ?")
      .run(slotStartedAt + 840, "quarterHourly", slotStartedAt);
    stalled.release();
    await Promise.all(tails);
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Late fenced lifecycle settled")));
    expect(db.getSlot("quarterHourly", slotStartedAt)).toMatchObject({ state: "running", execution_owner: "takeover", execution_generation: 2, updated_at: slotStartedAt + 840 });
  });

  it("groups one started and four required unstarted errors under one parent incident", async () => {
    const now = Date.now() / 1000;
    const startedAt = now - 1800;
    const db = makeLeaseDb({
      slots: [makeRunningSlot("fiveMinuteTelegramAlerts", startedAt, "dead-owner", now - 600)],
      progress: [makeProgressRow("dispatch-telegram-alerts", "dead-child", startedAt, startedAt + 1, now - 600, "sending")],
      leases: [makeLeaseRow("dispatch-telegram-alerts", "dead-child", now - 1, now - 600)],
    });
    db.sqlite.prepare("UPDATE cron_slot_executions SET child_marker_version = 1").run();
    const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec: now, limit: 10 });
    expect(summary).toMatchObject({ slotsReconciled: 1, syntheticCronRuns: 5, notStartedCronRuns: 4 });
    const runs = db.getRuns();
    expect(runs.every((run) => run.status === "error")).toBe(true);
    const metadata = runs.map((run) => JSON.parse(run.metadata!));
    for (const item of metadata) {
      expect(item.parentIncidentId).toBe(`scheduled-slot:fiveMinuteTelegramAlerts:${startedAt}:dead-owner`);
    }
    const event = db.getCache("cron:event:fiveminutetelegramalerts:scheduled-slot-abandoned");
    expect(JSON.parse(event!.value).metadata).toMatchObject({ childIncidentCounts: { started: 1, notStarted: 4 } });
  });
});
