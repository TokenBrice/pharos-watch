import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { markScheduledChildStarted, scheduledChildAttemptKey, writeScheduledChildTerminal, CronChildTerminalSupersededError, type ScheduledChildIdentity, type ScheduledChildTerminalInput } from "../scheduled-child-terminal";
import { CronTerminalAccountingError, logCronRun } from "../cron-logger";
import { sweepStaleScheduledSlotExecutions } from "../scheduled-slot-fence";

const fixtures = createLatestSchemaFixtureTracker();
function setup() {
  const fixture = fixtures.open();
  const identity: ScheduledChildIdentity = {
    scheduleKey: "dewsPsiOffset", slotStartedAt: 1000, job: "project-tape", producerPath: "dewsPsiOffset",
    producerKind: "scheduled-job", invocationId: "producer", attemptNo: 1, workerVersion: "worker",
    executionFence: { scheduleKey: "dewsPsiOffset", slotStartedAt: 1000, invocationId: "execution",
      owner: "owner", generation: 1, workerRole: "public" },
  };
  fixture.sqlite.prepare(`INSERT INTO cron_slot_executions (slot_key,slot_started_at,state,execution_owner,
    execution_generation,invocation_id,worker_version,started_at,updated_at,child_marker_version)
    VALUES ('dewsPsiOffset',1000,'running','owner',1,'execution','worker',1000,1000,1)`).run();
  return { ...fixture, identity };
}
function terminal(identity: ScheduledChildIdentity, source: "real" | "synthetic" = "real"): ScheduledChildTerminalInput {
  return { identity, source, token: source, ...(source === "synthetic" ? {
    reconciler: { owner: "reconciler", generation: 2, state: "reconciling" as const },
  } : {}), startedAt: 1001, completedAt: 1002, durationMs: 1000,
    status: source === "real" ? "ok" : "error", disposition: source === "real" ? "completed" : "abandoned",
    degradedReason: source === "real" ? null : "stale-slot-reconciled", producerOutcome: source === "real" ? "ok" : "abandoned",
    productivity: { productive: source === "real" },
  };
}

describe("scheduled child transactional terminal arbitration", () => {
  afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("hashes an unambiguous full identity tuple including source and execution", async () => {
    const { identity } = setup();
    const key = await scheduledChildAttemptKey(identity);
    expect(key).toMatch(/^scheduled-child:[a-f0-9]{64}$/);
    expect(await scheduledChildAttemptKey({ ...identity })).toBe(key);
    for (const changed of [
      { ...identity, producerPath: "different" }, { ...identity, invocationId: "other" },
      { ...identity, attemptNo: 2 }, { ...identity, slotStartedAt: 900 },
      { ...identity, executionFence: { ...identity.executionFence, generation: 2 } },
      { ...identity, executionFence: { ...identity.executionFence, invocationId: "other" } },
    ]) expect(await scheduledChildAttemptKey(changed)).not.toBe(key);
  });

  it.each(["real-first", "synthetic-first"])("accepts one terminal in %s order and survives cron pruning", async (order) => {
    const { identity, sqlite, db } = setup();
    const key = await markScheduledChildStarted(db, identity, 1001);
    if (order === "real-first") expect((await writeScheduledChildTerminal(db, terminal(identity))).accepted).toBe(true);
    sqlite.exec("UPDATE cron_slot_executions SET state='reconciling',execution_owner='reconciler',execution_generation=2");
    const synthetic = await writeScheduledChildTerminal(db, terminal(identity, "synthetic"));
    expect(synthetic.accepted).toBe(order === "synthetic-first");
    expect((await writeScheduledChildTerminal(db, { ...terminal(identity), token: "late-real" })).accepted).toBe(false);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT terminal_source FROM scheduled_child_attempts WHERE attempt_key=?").get(key))
      .toEqual({ terminal_source: order === "real-first" ? "real" : "synthetic" });
    sqlite.exec("DELETE FROM cron_runs");
    expect((await writeScheduledChildTerminal(db, { ...terminal(identity), token: "late" })).accepted).toBe(false);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs").get()).toEqual({ count: 0 });
  });

  it("rechecks exact fence inside SQL after takeover between preparation and batch", async () => {
    const { identity, sqlite, db } = setup();
    await markScheduledChildStarted(db, identity, 1001);
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      sqlite.exec("UPDATE cron_slot_executions SET execution_owner='new-owner',execution_generation=2,invocation_id='new-invocation'");
      return batch(statements);
    });
    expect((await writeScheduledChildTerminal(db, terminal(identity))).accepted).toBe(false);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM worker_producer_history").get()).toEqual({ count: 0 });
  });

  it("reuses a contender token after an ambiguous committed overload", async () => {
    const { identity, sqlite, db } = setup();
    await markScheduledChildStarted(db, identity, 1001);
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await batch(statements); throw new Error("Network connection lost");
    });
    const result = await writeScheduledChildTerminal(db, { ...terminal(identity), token: "same-retry-token" });
    expect(result.accepted).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT invocation_count FROM worker_producer_heads").get()).toEqual({ invocation_count: 1 });
  });

  it("rolls back claim and terminal when producer projection fails", async () => {
    const { identity, sqlite, db } = setup();
    await markScheduledChildStarted(db, identity, 1001);
    sqlite.exec("CREATE TRIGGER fail_history BEFORE INSERT ON worker_producer_history BEGIN SELECT RAISE(ABORT,'projection failed'); END;");
    await expect(writeScheduledChildTerminal(db, terminal(identity))).rejects.toThrow("projection failed");
    expect(sqlite.prepare("SELECT terminal_token FROM scheduled_child_attempts").get()).toEqual({ terminal_token: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs").get()).toEqual({ count: 0 });
  });

  it("accepts replay attempt two after synthetic one without increasing invocation count", async () => {
    const { identity, sqlite, db } = setup();
    await markScheduledChildStarted(db, identity, 1001);
    sqlite.exec("UPDATE cron_slot_executions SET state='reconciling',execution_owner='reconciler',execution_generation=2");
    await writeScheduledChildTerminal(db, terminal(identity, "synthetic"));
    sqlite.exec("UPDATE cron_slot_executions SET state='running',execution_owner='replay-owner',execution_generation=3,invocation_id='replay'");
    const replay = { ...identity, attemptNo: 2, executionFence: { ...identity.executionFence, owner: "replay-owner", generation: 3, invocationId: "replay" } };
    await markScheduledChildStarted(db, replay, 1003);
    expect((await writeScheduledChildTerminal(db, { ...terminal(replay), completedAt: 1004 })).accepted).toBe(true);
    expect(sqlite.prepare("SELECT outcome FROM worker_producer_history").get()).toEqual({ outcome: "ok" });
    expect(sqlite.prepare("SELECT invocation_count FROM worker_producer_heads").get()).toEqual({ invocation_count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs").get()).toEqual({ count: 2 });
  });

  it("retains newer attempt projection when an older accepted attempt finalizes later", async () => {
    const { identity, sqlite, db } = setup();
    const newer = { ...identity, attemptNo: 2 };
    await markScheduledChildStarted(db, identity, 1001);
    await markScheduledChildStarted(db, newer, 1001);
    await writeScheduledChildTerminal(db, { ...terminal(newer), status: "degraded", producerOutcome: "degraded", degradedReason: "partial" });
    await writeScheduledChildTerminal(db, { ...terminal(identity), completedAt: 1005 });
    expect(sqlite.prepare("SELECT outcome FROM worker_producer_history").get()).toEqual({ outcome: "degraded" });
    expect(sqlite.prepare("SELECT last_outcome FROM worker_producer_heads").get()).toEqual({ last_outcome: "degraded" });
  });

  it("keeps paths and producer invocations separate", async () => {
    const { identity, sqlite, db } = setup();
    for (const child of [identity, { ...identity, producerPath: "second" }, { ...identity, invocationId: "second" }]) {
      await markScheduledChildStarted(db, child, 1001);
      await writeScheduledChildTerminal(db, terminal(child));
    }
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs").get()).toEqual({ count: 3 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM worker_producer_history").get()).toEqual({ count: 3 });
  });

  it("preserves publications when a synthetic terminal loses", async () => {
    const { identity, sqlite, db } = setup();
    await markScheduledChildStarted(db, identity, 1001);
    await writeScheduledChildTerminal(db, { ...terminal(identity), productivity: { productive: true,
      publications: [{ surface: "stablecoins", generationId: "published", publishedAt: 1002 }] } });
    const before = sqlite.prepare("SELECT * FROM surface_publication_generations WHERE generation_id='published'").get();
    sqlite.exec("UPDATE cron_slot_executions SET state='reconciling',execution_owner='reconciler',execution_generation=2");
    expect((await writeScheduledChildTerminal(db, terminal(identity, "synthetic"))).accepted).toBe(false);
    expect(sqlite.prepare("SELECT * FROM surface_publication_generations WHERE generation_id='published'").get()).toEqual(before);
  });

  it("blocks work when required marker persistence fails", async () => {
    const { identity, sqlite, db } = setup();
    sqlite.exec("CREATE TRIGGER fail_marker BEFORE INSERT ON scheduled_child_attempts BEGIN SELECT RAISE(ABORT,'marker unavailable'); END;");
    const work = vi.fn();
    await expect(logCronRun(db, identity.job, work, { producer: identity, executionFence: identity.executionFence })).rejects.toThrow("marker unavailable");
    expect(work).not.toHaveBeenCalled();
  });

  it("marks progress-suppressed ownerless work and records its lease owner before skip", async () => {
    const { identity, sqlite, db } = setup();
    await logCronRun(db, identity.job, async (_signal, report) => {
      expect(sqlite.prepare("SELECT started_at FROM scheduled_child_attempts").get()).toEqual({ started_at: expect.any(Number) });
      await report({ leaseOwner: "lease", stage: "running" });
      expect(sqlite.prepare("SELECT lease_owner FROM scheduled_child_attempts").get()).toEqual({ lease_owner: "lease" });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_run_progress").get()).toEqual({ count: 0 });
      return {};
    }, { producer: identity, executionFence: identity.executionFence });
    expect(sqlite.prepare("SELECT terminal_source FROM scheduled_child_attempts").get()).toEqual({ terminal_source: "real" });
  });

  it("surfaces supersession without writing a second failure and carries publication evidence", async () => {
    const { identity, sqlite, db } = setup();
    await expect(logCronRun(db, identity.job, async () => {
      sqlite.exec("UPDATE cron_slot_executions SET execution_generation=2,execution_owner='reconciler',state='reconciling'");
      await writeScheduledChildTerminal(db, terminal(identity, "synthetic"));
      return { status: "ok", metadata: JSON.stringify({ outputPublishedAt: 1002 }), productivity: { productive: true } };
    }, { producer: identity, executionFence: identity.executionFence })).rejects.toMatchObject({
      name: "CronChildTerminalSupersededError", productive: true, outputPublishedAt: 1002,
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs").get()).toEqual({ count: 1 });
  });

  it("wraps a failed terminal batch without re-executing work or rewriting producer success", async () => {
    const { identity, sqlite, db } = setup();
    sqlite.exec("CREATE TRIGGER fail_history BEFORE INSERT ON worker_producer_history BEGIN SELECT RAISE(ABORT,'accounting failed'); END;");
    const work = vi.fn(async () => ({ status: "ok" as const, productivity: { productive: true } }));
    await expect(logCronRun(db, identity.job, work, { producer: identity, executionFence: identity.executionFence })).rejects.toMatchObject({
      name: "CronTerminalAccountingError", stage: "terminal-batch", productive: true,
    });
    expect(work).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT terminal_token FROM scheduled_child_attempts").get()).toEqual({ terminal_token: null });
  });

  it("reconciles a suppressed replay child through its executing fence, not its source slot", async () => {
    const { identity, sqlite, db } = setup();
    const replay = { ...identity, slotStartedAt: 500, attemptNo: 2 };
    await markScheduledChildStarted(db, replay, 1001);
    const result = await sweepStaleScheduledSlotExecutions(db, { nowSec: 1500, slotKey: "dewsPsiOffset" });
    expect(result.slotsReconciled).toBe(1);
    expect(sqlite.prepare("SELECT status,slot_started_at FROM cron_runs WHERE job='project-tape'").get()).toEqual({ status: "error", slot_started_at: 500 });
    expect(sqlite.prepare("SELECT terminal_source FROM scheduled_child_attempts WHERE started_at IS NOT NULL").get()).toEqual({ terminal_source: "synthetic" });
  });

  it.each([null, 1])("classifies missing evidence with protocol %s", async (version) => {
    const { sqlite, db } = setup();
    sqlite.prepare("UPDATE cron_slot_executions SET child_marker_version=?").run(version);
    await sweepStaleScheduledSlotExecutions(db, { nowSec: 1500, slotKey: "dewsPsiOffset" });
    const row = sqlite.prepare("SELECT metadata,item_count,duration_ms FROM cron_runs WHERE job='project-tape'").get() as { metadata: string; item_count: number | null; duration_ms: number };
    expect(JSON.parse(row.metadata).childDisposition).toBe(version === 1 ? "not_started" : "execution_unknown");
    expect(JSON.parse(row.metadata).durationBasis).toBe(version === 1 ? "not-started" : "unknown");
    expect(row.item_count).toBeNull();
    expect(row.duration_ms).toBe(0);
  });

  it("inherits retention by cascade without deleting terminals when cron rows are pruned", async () => {
    const { identity, sqlite, db } = setup();
    await markScheduledChildStarted(db, identity, 1001);
    await writeScheduledChildTerminal(db, terminal(identity));
    sqlite.exec("DELETE FROM cron_runs");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM scheduled_child_attempts").get()).toEqual({ count: 1 });
    sqlite.exec("PRAGMA foreign_keys=ON; DELETE FROM cron_slot_executions");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM scheduled_child_attempts").get()).toEqual({ count: 0 });
  });
});
