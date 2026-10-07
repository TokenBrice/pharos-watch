import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { resolveScheduledSlotPolicy } from "../scheduled-slot-policy";
import { runScheduledSlotWithFence, sweepStaleScheduledSlotExecutions } from "../scheduled-slot-fence";
import { markScheduledChildStarted } from "../scheduled-child-terminal";

const fixtures = createLatestSchemaFixtureTracker();
const longKeys = ["fiveMinuteReserveRecovery", "sixHourlyBlacklist", "halfHourlyMintBurnCritical", "twoHourlyDexDiscovery",
  "halfHourlyMintBurnExtended", "fourHourlyReserveSync", "hourlyYieldSync", "fourHourlyYieldSupplemental", "daily0300Utc",
  "daily0800Utc", "daily0805Utc", "daily0810Utc", "monthlyYieldAudit"];
const routes = ["global", "keyed", "presweep", "takeover"] as const;
const boundaries = [299, 300, 359, 360, 960];

describe("scheduled slot policy authority", () => {
  afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); vi.restoreAllMocks(); });
  it.each(Object.keys(SCHEDULED_SLOT_PLANS))("preserves registry policy for %s", (key) => {
    expect(resolveScheduledSlotPolicy(key)).toEqual({ heartbeatSec: 60, slotSilenceSec: longKeys.includes(key) ? 360 : 300,
      childSilenceSec: 300, hardDeadSec: 960 });
    expect(Object.isFrozen(resolveScheduledSlotPolicy(key))).toBe(true);
  });
  for (const route of routes) {
    for (const key of ["dewsPsiOffset", "fourHourlyReserveSync"]) {
      it.each(boundaries)(`${route} applies ${key} policy at %s seconds`, async (silence) => {
        vi.useFakeTimers(); vi.setSystemTime(2_000_000);
        const now = 2000; const slotStartedAt = 1000;
        const { sqlite, db } = fixtures.open();
        const hardDead = silence === 960;
        sqlite.prepare(`INSERT INTO cron_slot_executions (slot_key,slot_started_at,state,execution_owner,
          execution_generation,invocation_id,started_at,updated_at,child_marker_version)
          VALUES (?,?,'running','dead',1,'dead-invocation',?,?,1)`)
          .run(key, slotStartedAt, hardDead ? now - 960 : now - 500, hardDead ? now : now - silence);
        const stale = hardDead || silence >= resolveScheduledSlotPolicy(key).slotSilenceSec;
        if (route === "global" || route === "keyed") {
          const result = await sweepStaleScheduledSlotExecutions(db, { nowSec: now, staleAfterSec: 300,
            ...(route === "keyed" ? { slotKey: key } : {}) });
          expect(result.slotsReconciled).toBe(stale ? 1 : 0);
        } else if (route === "presweep") {
          await runScheduledSlotWithFence(db, key, async () => {}, { slotStartedAt: 2000, invocationId: "new", owner: "new" });
          expect(sqlite.prepare("SELECT state FROM cron_slot_executions WHERE slot_started_at=1000").get())
            .toEqual({ state: stale ? "finished" : "running" });
        } else {
          const work = vi.fn(async () => {});
          const result = await runScheduledSlotWithFence(db, key, work,
            { slotStartedAt, preSweepStale: false, owner: "new", invocationId: "new" });
          expect(result.status).toBe(stale ? "ok" : "skipped_running");
          expect(work).toHaveBeenCalledTimes(stale ? 1 : 0);
        }
      });
    }
  }
  for (const route of routes) {
    for (const [key, job] of [["dewsPsiOffset", "project-tape"], ["fourHourlyReserveSync", "sync-live-reserves"]]) {
      it.each([299, 300])(`${route} honors ${key} suppressed-child silence at %s seconds`, async (silence) => {
        vi.useFakeTimers(); vi.setSystemTime(2_000_000);
        const { sqlite, db } = fixtures.open();
        sqlite.prepare(`INSERT INTO cron_slot_executions (slot_key,slot_started_at,state,execution_owner,
          execution_generation,invocation_id,started_at,updated_at,child_marker_version)
          VALUES (?,1000,'running','dead',1,'dead-invocation',1500,1640,1)`).run(key);
        await markScheduledChildStarted(db, {
          scheduleKey: key, slotStartedAt: 1000, job, producerPath: key, producerKind: "scheduled-job",
          invocationId: "dead-invocation", attemptNo: 1,
          executionFence: { scheduleKey: key, slotStartedAt: 1000, owner: "dead", generation: 1,
            invocationId: "dead-invocation", workerRole: "public" },
        }, 1501, "child-owner");
        sqlite.prepare(`INSERT INTO cron_leases (job,lease_owner,lease_until,heartbeat_at,updated_at)
          VALUES (?,'child-owner',2200,?,?)`).run(job, 2000 - silence, 2000 - silence);
        if (route === "takeover") {
          const result = await runScheduledSlotWithFence(db, key, async () => {},
            { slotStartedAt: 1000, owner: "new", invocationId: "new", preSweepStale: false });
          expect(result.status).toBe(silence === 299 ? "skipped_running" : "ok");
        } else if (route === "presweep") {
          await runScheduledSlotWithFence(db, key, async () => {},
            { slotStartedAt: 2000, owner: "new", invocationId: "new" });
          expect(sqlite.prepare("SELECT state FROM cron_slot_executions WHERE slot_started_at=1000").get())
            .toEqual({ state: silence === 299 ? "running" : "finished" });
        } else {
          const result = await sweepStaleScheduledSlotExecutions(db, { nowSec: 2000,
            ...(route === "keyed" ? { slotKey: key } : {}) });
          expect(result.slotsReconciled).toBe(silence === 299 ? 0 : 1);
        }
      });
    }
  }
  it("filters the long-slot policy before LIMIT instead of starving an eligible short slot", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare(`INSERT INTO cron_slot_executions (slot_key,slot_started_at,state,execution_owner,
      execution_generation,invocation_id,started_at,updated_at) VALUES (? ,1000,'running','owner',1,'invocation',1500,?)`)
      .run("fourHourlyReserveSync", 1641);
    sqlite.prepare(`INSERT INTO cron_slot_executions (slot_key,slot_started_at,state,execution_owner,
      execution_generation,invocation_id,started_at,updated_at) VALUES ('dewsPsiOffset',1000,'running','owner',1,'invocation',1500,1700)`).run();
    const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec: 2000, limit: 1 });
    expect(summary.slotsReconciled).toBe(1);
    expect(summary.abandonedSlots[0]?.slotKey).toBe("dewsPsiOffset");
  });
  it("repeats policy and original heartbeat in CAS when a selected candidate renews", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO cron_slot_executions (slot_key,slot_started_at,state,execution_owner,
      execution_generation,invocation_id,started_at,updated_at) VALUES ('dewsPsiOffset',1000,'running','owner',1,'invocation',1500,1700)`);
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.includes("SET state = 'reconciling'")) sqlite.exec("UPDATE cron_slot_executions SET updated_at=2000");
      return prepare(sql);
    });
    expect((await sweepStaleScheduledSlotExecutions(db, { nowSec: 2000 })).slotsReconciled).toBe(0);
  });
});
