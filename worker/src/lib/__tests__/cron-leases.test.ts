import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireCronLease,
  CronLeaseLostError,
  releaseCronLease,
  renewCronLease,
  runCronWithLease,
  runScheduledSlotWithFence,
} from "../cron-lease";

type LeaseRow = {
  job: string;
  lease_owner: string;
  lease_until: number;
  heartbeat_at: number;
  updated_at: number;
};

type SlotExecutionRow = {
  slot_key: string;
  slot_started_at: number;
  state: string;
  result_status: string | null;
  execution_owner: string;
  started_at: number;
  finished_at: number | null;
  updated_at: number;
  metadata: string | null;
};

function makeSlotMapKey(slotKey: string, slotStartedAt: number): string {
  return `${slotKey}:${slotStartedAt}`;
}

function makeLeaseDb(seed?: { leases?: LeaseRow[]; slots?: SlotExecutionRow[] }): D1Database {
  const leases = new Map<string, LeaseRow>();
  const slots = new Map<string, SlotExecutionRow>();

  for (const lease of seed?.leases ?? []) {
    leases.set(lease.job, lease);
  }
  for (const slot of seed?.slots ?? []) {
    slots.set(makeSlotMapKey(slot.slot_key, slot.slot_started_at), slot);
  }

  function stmt(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.includes("INSERT INTO cron_leases")) {
            const [job, owner, leaseUntil, heartbeatAt, updatedAt, nowSec] = args as [
              string,
              string,
              number,
              number,
              number,
              number,
            ];
            const existing = leases.get(job);
            if (!existing) {
              leases.set(job, {
                job,
                lease_owner: owner,
                lease_until: leaseUntil,
                heartbeat_at: heartbeatAt,
                updated_at: updatedAt,
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (existing.lease_until < nowSec || existing.lease_owner === owner) {
              leases.set(job, {
                job,
                lease_owner: owner,
                lease_until: leaseUntil,
                heartbeat_at: heartbeatAt,
                updated_at: updatedAt,
              });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }

          if (sql.includes("UPDATE cron_leases")) {
            const [leaseUntil, heartbeatAt, updatedAt, job, owner] = args as [
              number,
              number,
              number,
              string,
              string,
            ];
            const existing = leases.get(job);
            if (!existing || existing.lease_owner !== owner) {
              return { success: true, meta: { changes: 0 } };
            }
            leases.set(job, {
              ...existing,
              lease_until: leaseUntil,
              heartbeat_at: heartbeatAt,
              updated_at: updatedAt,
            });
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes("DELETE FROM cron_leases")) {
            const [job, owner] = args as [string, string];
            const existing = leases.get(job);
            if (!existing || existing.lease_owner !== owner) {
              return { success: true, meta: { changes: 0 } };
            }
            leases.delete(job);
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes("INSERT OR IGNORE INTO cron_slot_executions")) {
            const [slotKey, slotStartedAt, owner, startedAt, updatedAt] = args as [
              string,
              number,
              string,
              number,
              number,
            ];
            const key = makeSlotMapKey(slotKey, slotStartedAt);
            if (slots.has(key)) {
              return { success: true, meta: { changes: 0 } };
            }
            slots.set(key, {
              slot_key: slotKey,
              slot_started_at: slotStartedAt,
              state: "running",
              result_status: null,
              execution_owner: owner,
              started_at: startedAt,
              finished_at: null,
              updated_at: updatedAt,
              metadata: null,
            });
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes("UPDATE cron_slot_executions") && sql.includes("SET execution_owner = ?")) {
            const [owner, startedAt, updatedAt, slotKey, slotStartedAt, staleBefore] = args as [
              string,
              number,
              number,
              string,
              number,
              number,
            ];
            const key = makeSlotMapKey(slotKey, slotStartedAt);
            const existing = slots.get(key);
            if (!existing || existing.state !== "running" || existing.updated_at >= staleBefore) {
              return { success: true, meta: { changes: 0 } };
            }
            slots.set(key, {
              ...existing,
              execution_owner: owner,
              started_at: startedAt,
              updated_at: updatedAt,
              finished_at: null,
              result_status: null,
              metadata: null,
            });
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes("UPDATE cron_slot_executions") && sql.includes("SET updated_at = ?")) {
            const [updatedAt, slotKey, slotStartedAt, owner] = args as [number, string, number, string];
            const key = makeSlotMapKey(slotKey, slotStartedAt);
            const existing = slots.get(key);
            if (!existing || existing.execution_owner !== owner || existing.state !== "running") {
              return { success: true, meta: { changes: 0 } };
            }
            slots.set(key, { ...existing, updated_at: updatedAt });
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes("UPDATE cron_slot_executions") && sql.includes("SET state = 'finished'")) {
            const [resultStatus, finishedAt, updatedAt, metadata, slotKey, slotStartedAt, owner] = args as [
              string,
              number,
              number,
              string | null,
              string,
              number,
              string,
            ];
            const key = makeSlotMapKey(slotKey, slotStartedAt);
            const existing = slots.get(key);
            if (!existing || existing.execution_owner !== owner) {
              return { success: true, meta: { changes: 0 } };
            }
            slots.set(key, {
              ...existing,
              state: "finished",
              result_status: resultStatus,
              finished_at: finishedAt,
              updated_at: updatedAt,
              metadata,
            });
            return { success: true, meta: { changes: 1 } };
          }

          return { success: true, meta: { changes: 0 } };
        },
        first: async () => {
          if (sql.includes("SELECT state, execution_owner, updated_at")) {
            const [slotKey, slotStartedAt] = args as [string, number];
            const row = slots.get(makeSlotMapKey(slotKey, slotStartedAt));
            if (!row) return null;
            return {
              state: row.state,
              execution_owner: row.execution_owner,
              updated_at: row.updated_at,
            };
          }
          return null;
        },
        all: async () => ({ results: [], success: true, meta: {} }),
      }),
      run: async () => ({ success: true, meta: { changes: 0 } }),
      first: async () => null,
      all: async () => ({ results: [], success: true, meta: {} }),
    };
  }

  return {
    prepare: (sql: string) => stmt(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("cron lease primitives", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquires lease when no row exists", async () => {
    const db = makeLeaseDb();
    const ok = await acquireCronLease(db, "sync-stablecoins", "owner-a", 120);
    expect(ok).toBe(true);
  });

  it("fails to acquire lease when active owner exists", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      leases: [{
        job: "sync-stablecoins",
        lease_owner: "owner-a",
        lease_until: now + 600,
        heartbeat_at: now,
        updated_at: now,
      }],
    });

    const ok = await acquireCronLease(db, "sync-stablecoins", "owner-b", 120);
    expect(ok).toBe(false);
  });

  it("acquires lease when previous lease is expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      leases: [{
        job: "sync-stablecoins",
        lease_owner: "owner-a",
        lease_until: now - 1,
        heartbeat_at: now - 60,
        updated_at: now - 60,
      }],
    });

    const ok = await acquireCronLease(db, "sync-stablecoins", "owner-b", 120);
    expect(ok).toBe(true);
  });

  it("renews lease for current owner and rejects others", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      leases: [{
        job: "sync-stablecoins",
        lease_owner: "owner-a",
        lease_until: now + 10,
        heartbeat_at: now,
        updated_at: now,
      }],
    });

    await expect(renewCronLease(db, "sync-stablecoins", "owner-a", 120)).resolves.toBe(true);
    await expect(renewCronLease(db, "sync-stablecoins", "owner-b", 120)).resolves.toBe(false);
  });

  it("release is owner-scoped", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      leases: [{
        job: "sync-stablecoins",
        lease_owner: "owner-a",
        lease_until: now + 120,
        heartbeat_at: now,
        updated_at: now,
      }],
    });

    await expect(releaseCronLease(db, "sync-stablecoins", "owner-b")).resolves.toBeUndefined();
    const stillLocked = await acquireCronLease(db, "sync-stablecoins", "owner-c", 120);
    expect(stillLocked).toBe(false);

    await expect(releaseCronLease(db, "sync-stablecoins", "owner-a")).resolves.toBeUndefined();
    const acquiredAfterRelease = await acquireCronLease(db, "sync-stablecoins", "owner-c", 120);
    expect(acquiredAfterRelease).toBe(true);
  });
});

describe("runCronWithLease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns skipped_locked when lease acquisition fails", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      leases: [{
        job: "sync-stablecoins",
        lease_owner: "owner-a",
        lease_until: now + 600,
        heartbeat_at: now,
        updated_at: now,
      }],
    });

    const result = await runCronWithLease(
      db,
      "sync-stablecoins",
      async () => ({ itemCount: 1 }),
      { owner: "owner-b", ttlSec: 120, heartbeatSec: 30 },
    );

    expect(result.status).toBe("skipped_locked");
    expect(result.result).toBeUndefined();
  });

  it("executes job and releases lease", async () => {
    const db = makeLeaseDb();

    const result = await runCronWithLease(
      db,
      "sync-stablecoins",
      async ({ leaseOwner }) => {
        expect(typeof leaseOwner).toBe("string");
        return { itemCount: 2 };
      },
      { owner: "owner-z", ttlSec: 120, heartbeatSec: 30 },
    );

    expect(result.status).toBe("ok");
    expect(result.result).toEqual({ itemCount: 2 });

    const reacquired = await acquireCronLease(db, "sync-stablecoins", "owner-next", 120);
    expect(reacquired).toBe(true);
  });

  it("resets renew failures after a successful heartbeat", async () => {
    const renewOutcomes = [0, 1, 0, 0];
    const sequencedRenewDb = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO cron_leases")) {
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE cron_leases")) {
              return { success: true, meta: { changes: renewOutcomes.shift() ?? 0 } };
            }
            if (sql.includes("DELETE FROM cron_leases")) {
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          },
        }),
      }),
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const runPromise = runCronWithLease(
      sequencedRenewDb,
      "sync-stablecoins",
      async ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      { owner: "owner-z", ttlSec: 120, heartbeatSec: 1, maxRenewFailures: 2 },
    );

    await vi.advanceTimersByTimeAsync(3200);
    let settled = false;
    void runPromise.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(runPromise).rejects.toBeInstanceOf(CronLeaseLostError);
  });

  it("stops heartbeats once the outer abort signal fires", async () => {
    let renewCalls = 0;
    const countingDb = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO cron_leases")) {
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE cron_leases")) {
              renewCalls++;
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("DELETE FROM cron_leases")) {
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          },
        }),
      }),
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const ac = new AbortController();
    const runPromise = runCronWithLease(
      countingDb,
      "sync-stablecoins",
      async () => new Promise(() => {}),
      { owner: "owner-z", ttlSec: 120, heartbeatSec: 1, abortSignal: ac.signal },
    );

    ac.abort(new Error("stop now"));
    await expect(runPromise).rejects.toThrow("stop now");

    const renewCallsAtAbort = renewCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(renewCalls).toBe(renewCallsAtAbort);
  });
});

describe("runScheduledSlotWithFence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips a slot that already finished", async () => {
    const db = makeLeaseDb({
      slots: [{
        slot_key: "quarterHourly",
        slot_started_at: 1_772_495_700,
        state: "finished",
        result_status: "ok",
        execution_owner: "owner-a",
        started_at: 1_772_495_700,
        finished_at: 1_772_495_760,
        updated_at: 1_772_495_760,
        metadata: null,
      }],
    });
    const fn = vi.fn(async () => undefined);

    const result = await runScheduledSlotWithFence(
      db,
      "quarterHourly",
      fn,
      { slotStartedAt: 1_772_495_700, owner: "owner-b" },
    );

    expect(result.status).toBe("skipped_duplicate");
    expect(fn).not.toHaveBeenCalled();
  });

  it("skips a slot that is still marked running", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      slots: [{
        slot_key: "halfHourlyOffset",
        slot_started_at: now - 60,
        state: "running",
        result_status: null,
        execution_owner: "owner-a",
        started_at: now - 60,
        finished_at: null,
        updated_at: now - 10,
        metadata: null,
      }],
    });

    const result = await runScheduledSlotWithFence(
      db,
      "halfHourlyOffset",
      async () => undefined,
      { slotStartedAt: now - 60, owner: "owner-b" },
    );

    expect(result.status).toBe("skipped_running");
  });
});
