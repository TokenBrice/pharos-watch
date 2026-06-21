import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireCronLease,
  CRON_ABANDONED_JOB_GRACE_MS,
  CronJobAbandonedError,
  CronLeaseLostError,
  CronTimeoutError,
  isRetriableD1OverloadError,
  releaseCronLease,
  renewCronLease,
  runCronWithLease,
  runWithOverloadRetry,
  runScheduledSlotWithFence,
  sweepStaleScheduledSlotExecutions,
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

type ProgressRow = {
  job: string;
  started_at: number;
  updated_at: number;
  stage: string | null;
  lease_owner: string | null;
  slot_started_at: number | null;
};

type CronRunRow = {
  job: string;
  started_at: number;
  duration_ms: number;
  status: string;
  error: string | null;
  metadata: string | null;
  slot_started_at: number | null;
};

type CacheRow = {
  key: string;
  value: string;
  updated_at: number;
};

interface TestLeaseDb extends D1Database {
  getSlot: (slotKey: string, slotStartedAt: number) => SlotExecutionRow | undefined;
  getLease: (job: string) => LeaseRow | undefined;
  getProgress: (job: string) => ProgressRow | undefined;
  getRuns: () => CronRunRow[];
  getCache: (key: string) => CacheRow | undefined;
}

function makeSlotMapKey(slotKey: string, slotStartedAt: number): string {
  return `${slotKey}:${slotStartedAt}`;
}

function makeLeaseDb(seed?: {
  leases?: LeaseRow[];
  slots?: SlotExecutionRow[];
  progress?: ProgressRow[];
  runs?: CronRunRow[];
  cache?: CacheRow[];
}): TestLeaseDb {
  const leases = new Map<string, LeaseRow>();
  const slots = new Map<string, SlotExecutionRow>();
  const progressRows = new Map<string, ProgressRow>();
  const cronRuns: CronRunRow[] = [...(seed?.runs ?? [])];
  const cacheRows = new Map<string, CacheRow>();

  for (const lease of seed?.leases ?? []) {
    leases.set(lease.job, lease);
  }
  for (const slot of seed?.slots ?? []) {
    slots.set(makeSlotMapKey(slot.slot_key, slot.slot_started_at), slot);
  }
  for (const progress of seed?.progress ?? []) {
    progressRows.set(progress.job, progress);
  }
  for (const row of seed?.cache ?? []) {
    cacheRows.set(row.key, row);
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
            const [job, owner, nowSec] = args as [string, string, number | undefined];
            const existing = leases.get(job);
            if (!existing || existing.lease_owner !== owner) {
              return { success: true, meta: { changes: 0 } };
            }
            if (sql.includes("lease_until < ?") && !(typeof nowSec === "number" && existing.lease_until < nowSec)) {
              return { success: true, meta: { changes: 0 } };
            }
            leases.delete(job);
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes("INSERT INTO cron_runs") && sql.includes("status, error, item_count")) {
            const [job, startedAt, durationMs, error, metadata, slotStartedAt] = args as [
              string,
              number,
              number,
              string | null,
              string | null,
              number | null,
            ];
            cronRuns.push({
              job,
              started_at: startedAt,
              duration_ms: durationMs,
              status: "error",
              error,
              metadata,
              slot_started_at: slotStartedAt,
            });
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes("DELETE FROM cron_run_progress")) {
            const [job, slotStartedAt, owner] = args as [string, number, string];
            const existing = progressRows.get(job);
            if (
              !existing ||
              existing.slot_started_at !== slotStartedAt ||
              existing.lease_owner !== owner
            ) {
              return { success: true, meta: { changes: 0 } };
            }
            progressRows.delete(job);
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes("INSERT OR REPLACE INTO cache")) {
            const [key, value, updatedAt] = args as [string, string, number];
            cacheRows.set(key, {
              key,
              value,
              updated_at: updatedAt,
            });
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

          if (sql.includes("UPDATE cron_slot_executions") && sql.includes("result_status = 'error'")) {
            const [finishedAt, updatedAt, metadata, slotKey, slotStartedAt, staleBefore] = args as [
              number,
              number,
              string,
              string,
              number,
              number,
            ];
            let changes = 0;
            for (const [key, existing] of slots) {
              if (
                existing.slot_key === slotKey &&
                existing.slot_started_at === slotStartedAt &&
                existing.state === "running" &&
                existing.updated_at < staleBefore
              ) {
                slots.set(key, {
                  ...existing,
                  state: "finished",
                  result_status: "error",
                  finished_at: finishedAt,
                  updated_at: updatedAt,
                  metadata,
                });
                changes++;
              }
            }
            return { success: true, meta: { changes } };
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
          if (sql.includes("SELECT lease_owner, lease_until FROM cron_leases")) {
            const [job] = args as [string];
            const lease = leases.get(job);
            if (!lease) return null;
            return {
              lease_owner: lease.lease_owner,
              lease_until: lease.lease_until,
            };
          }
          if (sql.includes("SELECT id FROM cron_runs")) {
            const [job, slotStartedAt] = args as [string, number];
            const index = cronRuns.findIndex((run) => run.job === job && run.slot_started_at === slotStartedAt);
            return index >= 0 ? { id: index + 1 } : null;
          }
          return null;
        },
        all: async () => {
          if (sql.includes("FROM cron_slot_executions") && sql.includes("ORDER BY updated_at ASC")) {
            const slotScoped = sql.includes("slot_key = ?");
            const excludesSlotStartedAt = sql.includes("slot_started_at != ?");
            let slotKey: string | null;
            let excludeSlotStartedAt: number | null;
            let staleBefore: number;
            let limit: number;
            if (slotScoped && excludesSlotStartedAt) {
              [slotKey, excludeSlotStartedAt, staleBefore, limit] = args as [string, number, number, number];
            } else if (slotScoped) {
              [slotKey, staleBefore, limit] = args as [string, number, number];
              excludeSlotStartedAt = null;
            } else if (excludesSlotStartedAt) {
              [excludeSlotStartedAt, staleBefore, limit] = args as [number, number, number];
              slotKey = null;
            } else {
              [staleBefore, limit] = args as [number, number];
              slotKey = null;
              excludeSlotStartedAt = null;
            }
            return {
              results: [...slots.values()].filter((slot) =>
                (slotKey == null || slot.slot_key === slotKey) &&
                (excludeSlotStartedAt == null || slot.slot_started_at !== excludeSlotStartedAt) &&
                slot.state === "running" &&
                slot.updated_at < staleBefore,
              ).sort((a, b) => a.updated_at - b.updated_at || a.slot_started_at - b.slot_started_at).slice(0, limit),
              success: true,
              meta: {},
            };
          }
          if (sql.includes("FROM cron_run_progress") && sql.includes("slot_started_at = ?")) {
            const [slotStartedAt, ...jobs] = args as [number, ...string[]];
            return {
              results: [...progressRows.values()].filter((progress) =>
                progress.slot_started_at === slotStartedAt &&
                (jobs.length === 0 || jobs.includes(progress.job)) &&
                progress.lease_owner != null,
              ),
              success: true,
              meta: {},
            };
          }
          return { results: [], success: true, meta: {} };
        },
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
    getSlot: (slotKey: string, slotStartedAt: number) => slots.get(makeSlotMapKey(slotKey, slotStartedAt)),
    getLease: (job: string) => leases.get(job),
    getProgress: (job: string) => progressRows.get(job),
    getRuns: () => [...cronRuns],
    getCache: (key: string) => cacheRows.get(key),
  } as unknown as TestLeaseDb;
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

describe("D1 overload retry classification", () => {
  it("treats queued-too-long and internal-reference D1 errors as retriable", () => {
    expect(isRetriableD1OverloadError(new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."))).toBe(true);
    expect(isRetriableD1OverloadError(new Error("D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset."))).toBe(true);
    expect(isRetriableD1OverloadError(new Error("D1_ERROR: internal error; reference = abc123"))).toBe(true);
    expect(isRetriableD1OverloadError(new Error("D1_ERROR: no such table: cache"))).toBe(false);
  });

  it("aborts retry backoff without waiting for the retry timer", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fn = vi.fn(async () => {
        throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
      });

      const promise = runWithOverloadRetry(fn, 3, controller.signal);
      await Promise.resolve();
      await Promise.resolve();

      controller.abort(new Error("retry aborted"));

      await expect(promise).rejects.toThrow("retry aborted");
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

  it("stops heartbeats and leaves the lease until TTL when the outer abort signal fires", async () => {
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

    const abandonedExpectation = expect(runPromise).rejects.toBeInstanceOf(CronJobAbandonedError);
    ac.abort(new Error("stop now"));
    await vi.advanceTimersByTimeAsync(CRON_ABANDONED_JOB_GRACE_MS + 1);
    await abandonedExpectation;

    const renewCallsAtAbort = renewCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(renewCalls).toBe(renewCallsAtAbort);
  });

  it("does not release an abandoned job lease before TTL expiry", async () => {
    const db = makeLeaseDb();
    const ac = new AbortController();
    const runPromise = runCronWithLease(
      db,
      "sync-stablecoins",
      async () => new Promise(() => {}),
      { owner: "owner-z", ttlSec: 120, heartbeatSec: 30, abortSignal: ac.signal },
    );

    const abandonedExpectation = expect(runPromise).rejects.toBeInstanceOf(CronJobAbandonedError);
    ac.abort(new Error("timeout"));
    await vi.advanceTimersByTimeAsync(CRON_ABANDONED_JOB_GRACE_MS + 1);
    await abandonedExpectation;

    const stillLocked = await acquireCronLease(db, "sync-stablecoins", "owner-next", 120);
    expect(stillLocked).toBe(false);

    vi.setSystemTime(new Date(Date.now() + 121_000));
    const acquiredAfterTtl = await acquireCronLease(db, "sync-stablecoins", "owner-next", 120);
    expect(acquiredAfterTtl).toBe(true);
  });

  it("releases the lease when an aborted job settles during abandonment grace", async () => {
    const db = makeLeaseDb();
    const ac = new AbortController();
    const runPromise = runCronWithLease(
      db,
      "sync-stablecoins",
      async ({ signal }) =>
        new Promise((_resolve, reject) => {
          const rejectSoon = () => {
            setTimeout(() => reject(signal.reason), 10);
          };
          if (signal.aborted) {
            rejectSoon();
            return;
          }
          signal.addEventListener("abort", () => {
            rejectSoon();
          }, { once: true });
        }),
      { owner: "owner-z", ttlSec: 120, heartbeatSec: 30, abortSignal: ac.signal },
    );

    await vi.advanceTimersByTimeAsync(0);
    const stopExpectation = expect(runPromise).rejects.toThrow("stop now");
    ac.abort(new Error("stop now"));
    await vi.advanceTimersByTimeAsync(10);
    await stopExpectation;

    const reacquired = await acquireCronLease(db, "sync-stablecoins", "owner-next", 120);
    expect(reacquired).toBe(true);
  });

  it("releases the lease when a lease-loss abort settles during abandonment grace", async () => {
    const renewOutcomes = [0, 0];
    let deleteCalls = 0;
    const renewLostDb = {
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
              deleteCalls++;
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
      renewLostDb,
      "sync-stablecoins",
      async ({ signal }) =>
        new Promise((_resolve, reject) => {
          const rejectSoon = () => {
            setTimeout(() => reject(signal.reason), 10);
          };
          if (signal.aborted) {
            rejectSoon();
            return;
          }
          signal.addEventListener("abort", () => rejectSoon(), { once: true });
        }),
      { owner: "owner-z", ttlSec: 120, heartbeatSec: 1, maxRenewFailures: 2 },
    );

    const leaseLostExpectation = expect(runPromise).rejects.toBeInstanceOf(CronLeaseLostError);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(10);
    await leaseLostExpectation;
    expect(deleteCalls).toBe(1);
  });

  it("rejects with CronTimeoutError when the timeout abort wins but the job then fulfills in grace", async () => {
    const db = makeLeaseDb();
    const ac = new AbortController();
    const runPromise = runCronWithLease(
      db,
      "sync-stablecoins",
      // Job ignores the abort and fulfills shortly after, inside the grace window.
      async () => new Promise((resolve) => setTimeout(() => resolve("done"), 10)),
      { owner: "owner-z", ttlSec: 120, heartbeatSec: 30, abortSignal: ac.signal },
    );

    let captured: unknown;
    const timeoutExpectation = runPromise.catch((err) => {
      captured = err;
    });
    // A non-Error abort reason makes the wrapper fall back to its CronTimeoutError.
    ac.abort("timeout");
    await vi.advanceTimersByTimeAsync(10);
    await timeoutExpectation;

    expect(captured).toBeInstanceOf(CronTimeoutError);
  });

  it("classifies an abandoned job with stopReason 'timeout' when the timeout abort fires", async () => {
    const db = makeLeaseDb();
    const ac = new AbortController();
    const runPromise = runCronWithLease(
      db,
      "sync-stablecoins",
      async () => new Promise(() => {}),
      { owner: "owner-z", ttlSec: 120, heartbeatSec: 30, abortSignal: ac.signal },
    );

    let captured: CronJobAbandonedError | undefined;
    const abandonedExpectation = runPromise.catch((err) => {
      captured = err as CronJobAbandonedError;
    });
    ac.abort("timeout");
    await vi.advanceTimersByTimeAsync(CRON_ABANDONED_JOB_GRACE_MS + 1);
    await abandonedExpectation;

    expect(captured).toBeInstanceOf(CronJobAbandonedError);
    expect(captured!.metadata.stopReason).toBe("timeout");
  });

  it("classifies an abandoned job with stopReason 'lease_lost' when renewals fail", async () => {
    const renewOutcomes = [0, 0];
    const renewLostDb = {
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
      renewLostDb,
      "sync-stablecoins",
      async () => new Promise(() => {}),
      { owner: "owner-z", ttlSec: 120, heartbeatSec: 1, maxRenewFailures: 2 },
    );

    let captured: CronJobAbandonedError | undefined;
    const abandonedExpectation = runPromise.catch((err) => {
      captured = err as CronJobAbandonedError;
    });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(CRON_ABANDONED_JOB_GRACE_MS + 1);
    await abandonedExpectation;

    expect(captured).toBeInstanceOf(CronJobAbandonedError);
    expect(captured!.metadata.stopReason).toBe("lease_lost");
  });

  it("releases the lease when the job rejects in the same tick the stop signal fires", async () => {
    const db = makeLeaseDb();
    const ac = new AbortController();
    const runPromise = runCronWithLease(
      db,
      "sync-stablecoins",
      async ({ signal }) =>
        new Promise((_resolve, reject) => {
          // Job rejects almost simultaneously with the abort observation.
          const rejectSoon = () => {
            setTimeout(() => reject(signal.reason), 0);
          };
          if (signal.aborted) {
            rejectSoon();
            return;
          }
          signal.addEventListener("abort", () => rejectSoon(), { once: true });
        }),
      { owner: "owner-z", ttlSec: 120, heartbeatSec: 30, abortSignal: ac.signal },
    );

    const settled = runPromise.catch(() => {});
    ac.abort(new Error("stop now"));
    await vi.advanceTimersByTimeAsync(0);
    await settled;

    const reacquired = await acquireCronLease(db, "sync-stablecoins", "owner-next", 120);
    expect(reacquired).toBe(true);
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


  it("takes over a stale running row for the requested slot", async () => {
    const now = Math.floor(Date.now() / 1000);
    const slotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [{
        slot_key: "halfHourlyOffset",
        slot_started_at: slotStartedAt,
        state: "running",
        result_status: null,
        execution_owner: "owner-a",
        started_at: slotStartedAt,
        finished_at: null,
        updated_at: now - 1800,
        metadata: null,
      }],
    });
    const fn = vi.fn(async () => ({ jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 }));

    const result = await runScheduledSlotWithFence(
      db,
      "halfHourlyOffset",
      fn,
      { slotStartedAt, owner: "owner-b", staleAfterSec: 1200 },
    );

    expect(result.status).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    const slot = db.getSlot("halfHourlyOffset", slotStartedAt);
    expect(slot?.execution_owner).toBe("owner-b");
    expect(slot?.result_status).toBe("ok");
    expect(slot?.metadata).toBe(JSON.stringify({ jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 }));
  });

  it("marks stale running slots for the same schedule as expired before claiming a new slot", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const currentSlotStartedAt = now;
    const db = makeLeaseDb({
      slots: [{
        slot_key: "halfHourlyOffset",
        slot_started_at: staleSlotStartedAt,
        state: "running",
        result_status: null,
        execution_owner: "owner-a",
        started_at: staleSlotStartedAt,
        finished_at: null,
        updated_at: now - 1800,
        metadata: null,
      }],
    });
    const fn = vi.fn(async () => undefined);

    const result = await runScheduledSlotWithFence(
      db,
      "halfHourlyOffset",
      fn,
      { slotStartedAt: currentSlotStartedAt, owner: "owner-b", staleAfterSec: 1200 },
    );

    expect(result.status).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);

    const staleRetry = await runScheduledSlotWithFence(
      db,
      "halfHourlyOffset",
      async () => undefined,
      { slotStartedAt: staleSlotStartedAt, owner: "owner-c", staleAfterSec: 1200 },
    );
    expect(staleRetry.status).toBe("skipped_duplicate");
  });

  it("reconciles stale slot progress into a synthetic child cron run and clears expired ownership", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const currentSlotStartedAt = now;
    const db = makeLeaseDb({
      slots: [{
        slot_key: "hourlyYieldSync",
        slot_started_at: staleSlotStartedAt,
        state: "running",
        result_status: null,
        execution_owner: "slot-owner-a",
        started_at: staleSlotStartedAt,
        finished_at: null,
        updated_at: now - 1800,
        metadata: null,
      }],
      leases: [{
        job: "sync-yield-data",
        lease_owner: "yield-owner-a",
        lease_until: now - 60,
        heartbeat_at: now - 1800,
        updated_at: now - 1800,
      }],
      progress: [{
        job: "sync-yield-data",
        started_at: staleSlotStartedAt + 20,
        updated_at: now - 1800,
        stage: "evaluation",
        lease_owner: "yield-owner-a",
        slot_started_at: staleSlotStartedAt,
      }],
    });

    const result = await runScheduledSlotWithFence(
      db,
      "hourlyYieldSync",
      async () => undefined,
      { slotStartedAt: currentSlotStartedAt, owner: "slot-owner-b", staleAfterSec: 1200 },
    );

    expect(result.status).toBe("ok");
    expect(db.getRuns()).toEqual([
      expect.objectContaining({
        job: "sync-yield-data",
        status: "error",
        slot_started_at: staleSlotStartedAt,
        error: "scheduled slot heartbeat stale; child job progress abandoned",
      }),
    ]);
    expect(db.getProgress("sync-yield-data")).toBeUndefined();
    expect(db.getLease("sync-yield-data")).toBeUndefined();
    const staleSlot = db.getSlot("hourlyYieldSync", staleSlotStartedAt);
    expect(staleSlot?.result_status).toBe("error");
    expect(staleSlot?.metadata ? JSON.parse(staleSlot.metadata) : null).toMatchObject({
      error: "scheduled slot heartbeat stale; marked expired by later invocation",
      staleSlotReconciliation: {
        syntheticCronRuns: 1,
        progressRowsCleared: 1,
        leasesCleared: 1,
        abandonedJobs: [
          {
            job: "sync-yield-data",
            progressStage: "evaluation",
            leaseOwner: "yield-owner-a",
            leaseUntil: now - 60,
          },
        ],
      },
    });
    const eventMarker = db.getCache("cron:event:hourlyyieldsync:scheduled-slot-abandoned");
    expect(eventMarker).toBeDefined();
    expect(eventMarker?.value ? JSON.parse(eventMarker.value) : null).toMatchObject({
      event: "cron_event",
      job: "hourlyYieldSync",
      eventType: "scheduled-slot-abandoned",
      severity: "error",
      metadata: {
        slotKey: "hourlyYieldSync",
        slotOwner: "slot-owner-a",
        staleSlotReconciliation: {
          abandonedJobs: [
            {
              job: "sync-yield-data",
              progressStage: "evaluation",
              leaseOwner: "yield-owner-a",
            },
          ],
        },
      },
    });
  });

  it("sweeps stale slot progress across schedule keys before the next same slot runs", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [{
        slot_key: "hourlyYieldSync",
        slot_started_at: staleSlotStartedAt,
        state: "running",
        result_status: null,
        execution_owner: "slot-owner-a",
        started_at: staleSlotStartedAt,
        finished_at: null,
        updated_at: now - 1800,
        metadata: null,
      }],
      leases: [{
        job: "sync-yield-data",
        lease_owner: "yield-owner-a",
        lease_until: now - 60,
        heartbeat_at: now - 1800,
        updated_at: now - 1800,
      }],
      progress: [{
        job: "sync-yield-data",
        started_at: staleSlotStartedAt + 20,
        updated_at: now - 1800,
        stage: "publication",
        lease_owner: "yield-owner-a",
        slot_started_at: staleSlotStartedAt,
      }],
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec: now, staleAfterSec: 1200 });

    expect(summary).toMatchObject({
      candidateSlots: 1,
      slotsReconciled: 1,
      syntheticCronRuns: 1,
      progressRowsCleared: 1,
      leasesCleared: 1,
    });
    expect(summary.abandonedSlots).toEqual([
      expect.objectContaining({
        slotKey: "hourlyYieldSync",
        slotStartedAt: staleSlotStartedAt,
        abandonedJobs: [
          expect.objectContaining({
            job: "sync-yield-data",
            progressStage: "publication",
            leaseOwner: "yield-owner-a",
          }),
        ],
      }),
    ]);
    expect(db.getRuns()).toEqual([
      expect.objectContaining({
        job: "sync-yield-data",
        status: "error",
        slot_started_at: staleSlotStartedAt,
      }),
    ]);
    expect(db.getProgress("sync-yield-data")).toBeUndefined();
    expect(db.getLease("sync-yield-data")).toBeUndefined();
    expect(db.getSlot("hourlyYieldSync", staleSlotStartedAt)?.result_status).toBe("error");
    expect(db.getCache("cron:event:hourlyyieldsync:scheduled-slot-abandoned")).toBeDefined();
  });

  it("does not reconcile child progress from a different schedule with a colliding slot timestamp", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [{
        slot_key: "quarterHourly",
        slot_started_at: staleSlotStartedAt,
        state: "running",
        result_status: null,
        execution_owner: "slot-owner-a",
        started_at: staleSlotStartedAt,
        finished_at: null,
        updated_at: now - 1800,
        metadata: null,
      }],
      leases: [{
        job: "daily-digest",
        lease_owner: "digest-owner-a",
        lease_until: now - 60,
        heartbeat_at: now - 1800,
        updated_at: now - 1800,
      }],
      progress: [{
        job: "daily-digest",
        started_at: staleSlotStartedAt + 20,
        updated_at: now - 1800,
        stage: "digest-trigger-poll",
        lease_owner: "digest-owner-a",
        slot_started_at: staleSlotStartedAt,
      }],
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec: now, staleAfterSec: 1200 });

    expect(summary).toMatchObject({
      candidateSlots: 1,
      slotsReconciled: 1,
      syntheticCronRuns: 0,
      progressRowsCleared: 0,
      leasesCleared: 0,
    });
    expect(summary.abandonedSlots).toEqual([
      expect.objectContaining({
        slotKey: "quarterHourly",
        slotStartedAt: staleSlotStartedAt,
        abandonedJobs: [],
      }),
    ]);
    expect(db.getRuns()).toEqual([]);
    expect(db.getProgress("daily-digest")).toBeDefined();
    expect(db.getLease("daily-digest")).toBeDefined();
    expect(db.getSlot("quarterHourly", staleSlotStartedAt)?.result_status).toBe("error");
  });

  it("does not synthesize a stale child cron run while the matching child lease is still active", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const currentSlotStartedAt = now;
    const db = makeLeaseDb({
      slots: [{
        slot_key: "hourlyYield",
        slot_started_at: staleSlotStartedAt,
        state: "running",
        result_status: null,
        execution_owner: "slot-owner-a",
        started_at: staleSlotStartedAt,
        finished_at: null,
        updated_at: now - 1800,
        metadata: null,
      }],
      leases: [{
        job: "sync-yield-data",
        lease_owner: "yield-owner-a",
        lease_until: now + 300,
        heartbeat_at: now - 60,
        updated_at: now - 60,
      }],
      progress: [{
        job: "sync-yield-data",
        started_at: staleSlotStartedAt + 20,
        updated_at: now - 60,
        stage: "evaluation",
        lease_owner: "yield-owner-a",
        slot_started_at: staleSlotStartedAt,
      }],
    });

    const result = await runScheduledSlotWithFence(
      db,
      "hourlyYield",
      async () => undefined,
      { slotStartedAt: currentSlotStartedAt, owner: "slot-owner-b", staleAfterSec: 1200 },
    );

    expect(result.status).toBe("ok");
    expect(db.getRuns()).toEqual([]);
    expect(db.getProgress("sync-yield-data")).toBeDefined();
    expect(db.getLease("sync-yield-data")).toBeDefined();
    const staleSlot = db.getSlot("hourlyYield", staleSlotStartedAt);
    expect(staleSlot?.metadata ? JSON.parse(staleSlot.metadata) : null).toMatchObject({
      staleSlotReconciliation: {
        syntheticCronRuns: 0,
        progressRowsCleared: 0,
        leasesCleared: 0,
      },
    });
  });

  it("stores child job summaries and degraded slot status", async () => {
    const slotStartedAt = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb();

    const summary = {
      jobsRun: 1,
      jobsSkipped: 1,
      jobsDegraded: 1,
      jobsErrored: 0,
      budgetOnlyJobs: 0,
      jobs: [
        { job: "ok-job", outcome: "ok" },
        { job: "skipped-job", outcome: "skipped", reason: "lease-locked" },
        { job: "degraded-job", outcome: "degraded", status: "degraded" },
      ],
    };

    const result = await runScheduledSlotWithFence(
      db,
      "daily0800Utc",
      async () => summary,
      { slotStartedAt, owner: "owner-summary" },
    );

    expect(result.status).toBe("ok");
    expect(result.resultStatus).toBe("degraded");
    expect(result.metadata).toEqual(summary);
    const slot = db.getSlot("daily0800Utc", slotStartedAt);
    expect(slot?.result_status).toBe("degraded");
    expect(slot?.metadata ? JSON.parse(slot.metadata) : null).toEqual(summary);
  });
});
