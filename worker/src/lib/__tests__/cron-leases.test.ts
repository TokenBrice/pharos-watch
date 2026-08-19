import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireCronLease,
  CRON_ABANDONED_JOB_GRACE_MS,
  CronJobAbandonedError,
  CronLeaseLostError,
  CronLeaseStateObserverError,
  CronTimeoutError,
  releaseCronLease,
  renewCronLease,
  runCronWithLease,
} from "../cron-lease-primitives";
import {
  SCHEDULED_SLOT_JOB_BUDGET_MS,
} from "../cron-timeouts";
import {
  isRetriableD1OverloadError,
  runWithOverloadRetry,
} from "../d1-overload-retry";
import { createScheduledRuntimeContext } from "../../handlers/scheduled/context";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

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
  execution_generation?: number;
  invocation_id?: string | null;
  worker_version?: string | null;
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
  sqlite: DatabaseSync;
  getSlot: (slotKey: string, slotStartedAt: number) => SlotExecutionRow | undefined;
  getLease: (job: string) => LeaseRow | undefined;
  getProgress: (job: string) => ProgressRow | undefined;
  getRuns: () => CronRunRow[];
  getCache: (key: string) => CacheRow | undefined;
}

const openLeaseDatabases: DatabaseSync[] = [];

function makeLeaseDb(seed?: {
  leases?: LeaseRow[];
  slots?: SlotExecutionRow[];
  progress?: ProgressRow[];
  runs?: CronRunRow[];
  cache?: CacheRow[];
  failSlotHeartbeatRuns?: number;
  failSlotFinishRuns?: number;
  failSlotProgressReads?: number;
  beforeSlotTakeover?: (sqlite: DatabaseSync) => void;
  beforeSlotReconciliationClaim?: (sqlite: DatabaseSync) => void;
}): TestLeaseDb {
  const { sqlite } = createLatestSchemaSqlite();
  openLeaseDatabases.push(sqlite);

  let failSlotHeartbeatRuns = seed?.failSlotHeartbeatRuns ?? 0;
  let failSlotFinishRuns = seed?.failSlotFinishRuns ?? 0;
  let failSlotProgressReads = seed?.failSlotProgressReads ?? 0;
  const beforeSlotTakeover = seed?.beforeSlotTakeover;
  const beforeSlotReconciliationClaim = seed?.beforeSlotReconciliationClaim;

  for (const lease of seed?.leases ?? []) {
    sqlite
      .prepare(
        `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(lease.job, lease.lease_owner, lease.lease_until, lease.heartbeat_at, lease.updated_at);
  }
  for (const slot of seed?.slots ?? []) {
    sqlite
      .prepare(
        `INSERT INTO cron_slot_executions (
           slot_key, slot_started_at, state, result_status, execution_owner, execution_generation,
           invocation_id, worker_version, started_at, finished_at, updated_at, metadata
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        slot.slot_key,
        slot.slot_started_at,
        slot.state,
        slot.result_status,
        slot.execution_owner,
        slot.execution_generation ?? 1,
        slot.invocation_id ?? null,
        slot.worker_version ?? null,
        slot.started_at,
        slot.finished_at,
        slot.updated_at,
        slot.metadata,
      );
  }
  for (const progress of seed?.progress ?? []) {
    sqlite
      .prepare(
        `INSERT INTO cron_run_progress (job, started_at, updated_at, stage, lease_owner, slot_started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        progress.job,
        progress.started_at,
        progress.updated_at,
        progress.stage,
        progress.lease_owner,
        progress.slot_started_at,
      );
  }
  for (const run of seed?.runs ?? []) {
    sqlite
      .prepare(
        `INSERT INTO cron_runs (job, started_at, duration_ms, status, error, metadata, slot_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(run.job, run.started_at, run.duration_ms, run.status, run.error, run.metadata, run.slot_started_at);
  }
  for (const row of seed?.cache ?? []) {
    sqlite
      .prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(row.key, row.value, row.updated_at);
  }

  const inner = createSqliteD1(sqlite);

  function stmt(sql: string, boundValues: unknown[] = []): D1PreparedStatement {
    const bound = boundValues.length > 0 ? inner.prepare(sql).bind(...boundValues) : inner.prepare(sql);
    return {
      bind: (...args: unknown[]) => stmt(sql, args),
      run: async () => {
        const isSlotUpdate = sql.includes("UPDATE cron_slot_executions");
        if (isSlotUpdate && sql.includes("SET updated_at = ?") && failSlotHeartbeatRuns > 0) {
          failSlotHeartbeatRuns--;
          throw new Error("slot heartbeat write failed");
        }
        if (isSlotUpdate && sql.includes("SET state = 'finished'") && failSlotFinishRuns > 0) {
          failSlotFinishRuns--;
          throw new Error("slot terminal write failed");
        }
        if (isSlotUpdate && sql.includes("SET state = 'reconciling'")) {
          beforeSlotReconciliationClaim?.(sqlite);
        }
        if (isSlotUpdate && sql.includes("SET execution_owner = ?")) {
          beforeSlotTakeover?.(sqlite);
        }
        return bound.run();
      },
      first: async <T>() => bound.first<T>(),
      all: async <T>() => {
        if (
          failSlotProgressReads > 0 &&
          sql.includes("FROM cron_run_progress") &&
          sql.includes("slot_started_at = ?")
        ) {
          failSlotProgressReads--;
          throw new Error("simulated reconciliation crash");
        }
        return bound.all<T>();
      },
    } as unknown as D1PreparedStatement;
  }

  return {
    sqlite,
    prepare: (sql: string) => stmt(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    getSlot: (slotKey: string, slotStartedAt: number) =>
      sqlite
        .prepare(
          `SELECT slot_key, slot_started_at, state, result_status, execution_owner, execution_generation,
                  invocation_id, worker_version, started_at, finished_at, updated_at, metadata
             FROM cron_slot_executions WHERE slot_key = ? AND slot_started_at = ?`,
        )
        .get(slotKey, slotStartedAt) as SlotExecutionRow | undefined,
    getLease: (job: string) =>
      sqlite
        .prepare(
          "SELECT job, lease_owner, lease_until, heartbeat_at, updated_at FROM cron_leases WHERE job = ?",
        )
        .get(job) as LeaseRow | undefined,
    getProgress: (job: string) =>
      sqlite
        .prepare(
          `SELECT job, started_at, updated_at, stage, lease_owner, slot_started_at
             FROM cron_run_progress WHERE job = ?`,
        )
        .get(job) as ProgressRow | undefined,
    getRuns: () =>
      sqlite
        .prepare(
          `SELECT job, started_at, duration_ms, status, error, metadata, slot_started_at
             FROM cron_runs ORDER BY id`,
        )
        .all() as CronRunRow[],
    getCache: (key: string) =>
      sqlite
        .prepare("SELECT key, value, updated_at FROM cache WHERE key = ?")
        .get(key) as CacheRow | undefined,
  } as unknown as TestLeaseDb;
}

describe("cron lease primitives", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const sqlite of openLeaseDatabases.splice(0)) sqlite.close();
  });

  it("acquires lease when no row exists", async () => {
    const db = makeLeaseDb();
    const ok = await acquireCronLease(db, "sync-stablecoins", "owner-a", 120);
    expect(ok).toBe(true);
  });

  it("fails to acquire lease when active owner exists", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      leases: [
        {
          job: "sync-stablecoins",
          lease_owner: "owner-a",
          lease_until: now + 600,
          heartbeat_at: now,
          updated_at: now,
        },
      ],
    });

    const ok = await acquireCronLease(db, "sync-stablecoins", "owner-b", 120);
    expect(ok).toBe(false);
  });

  it("acquires lease when previous lease is expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      leases: [
        {
          job: "sync-stablecoins",
          lease_owner: "owner-a",
          lease_until: now - 1,
          heartbeat_at: now - 60,
          updated_at: now - 60,
        },
      ],
    });

    const ok = await acquireCronLease(db, "sync-stablecoins", "owner-b", 120);
    expect(ok).toBe(true);
  });

  it("renews lease for current owner and rejects others", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      leases: [
        {
          job: "sync-stablecoins",
          lease_owner: "owner-a",
          lease_until: now + 10,
          heartbeat_at: now,
          updated_at: now,
        },
      ],
    });

    await expect(renewCronLease(db, "sync-stablecoins", "owner-a", 120)).resolves.toBe(true);
    await expect(renewCronLease(db, "sync-stablecoins", "owner-b", 120)).resolves.toBe(false);
  });

  it("release is owner-scoped", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      leases: [
        {
          job: "sync-stablecoins",
          lease_owner: "owner-a",
          lease_until: now + 120,
          heartbeat_at: now,
          updated_at: now,
        },
      ],
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
    expect(isRetriableD1OverloadError(new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."))).toBe(
      true,
    );
    expect(
      isRetriableD1OverloadError(
        new Error("D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset."),
      ),
    ).toBe(true);
    expect(isRetriableD1OverloadError(new Error("D1_ERROR: internal error; reference = abc123"))).toBe(true);
    expect(isRetriableD1OverloadError(new Error("D1_ERROR: Network connection lost."))).toBe(true);
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
      leases: [
        {
          job: "sync-stablecoins",
          lease_owner: "owner-a",
          lease_until: now + 600,
          heartbeat_at: now,
          updated_at: now,
        },
      ],
    });

    const result = await runCronWithLease(db, "sync-stablecoins", async () => ({ itemCount: 1 }), {
      owner: "owner-b",
      ttlSec: 120,
      heartbeatSec: 30,
    });

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

  it("emits lease state updates with lease_until from acquisition and renewal writes", async () => {
    const db = makeLeaseDb();
    const updates: Array<{ event: string; leaseUntil: number; heartbeatAt: number; leaseOwner: string }> = [];
    const now = Math.floor(Date.now() / 1000);

    const runPromise = runCronWithLease(
      db,
      "sync-stablecoins",
      async () => new Promise((resolve) => setTimeout(() => resolve("done"), 1500)),
      {
        owner: "owner-z",
        ttlSec: 120,
        heartbeatSec: 1,
        onLeaseState: (state) => {
          updates.push({
            event: state.event,
            leaseUntil: state.leaseUntil,
            heartbeatAt: state.heartbeatAt,
            leaseOwner: state.leaseOwner,
          });
        },
      },
    );

    await vi.advanceTimersByTimeAsync(1500);
    await expect(runPromise).resolves.toMatchObject({ status: "ok", result: "done" });

    expect(updates).toEqual([
      { event: "acquired", leaseUntil: now + 120, heartbeatAt: now, leaseOwner: "owner-z" },
      { event: "renewed", leaseUntil: now + 121, heartbeatAt: now + 1, leaseOwner: "owner-z" },
    ]);
  });

  it("isolates acquisition observer failures from job execution and lease release", async () => {
    const db = makeLeaseDb();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await runCronWithLease(db, "sync-stablecoins", async () => "done", {
        owner: "owner-z",
        ttlSec: 120,
        heartbeatSec: 30,
        onLeaseState: () => {
          throw new Error("observer failed");
        },
      });

      expect(result).toMatchObject({ status: "ok", result: "done" });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[cron-lease] Lease state observer failed for sync-stablecoins (acquired):"),
      );
      const reacquired = await acquireCronLease(db, "sync-stablecoins", "owner-next", 120);
      expect(reacquired).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fails before job execution and releases the lease when a required acquisition observer fails", async () => {
    const db = makeLeaseDb();
    const runJob = vi.fn(async () => "done");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        runCronWithLease(db, "sync-stablecoins", runJob, {
          owner: "owner-z",
          ttlSec: 120,
          heartbeatSec: 30,
          leaseStateObserverMode: "required",
          onLeaseState: () => {
            throw new Error("ledger lease write failed");
          },
        }),
      ).rejects.toBeInstanceOf(CronLeaseStateObserverError);

      expect(runJob).not.toHaveBeenCalled();
      await expect(acquireCronLease(db, "sync-stablecoins", "owner-next", 120)).resolves.toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("isolates renewal observer failures from lease health", async () => {
    const db = makeLeaseDb();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const runPromise = runCronWithLease(
        db,
        "sync-stablecoins",
        async () => new Promise((resolve) => setTimeout(() => resolve("done"), 1500)),
        {
          owner: "owner-z",
          ttlSec: 120,
          heartbeatSec: 1,
          maxRenewFailures: 1,
          onLeaseState: (state) => {
            if (state.event === "renewed") {
              throw new Error("observer failed");
            }
          },
        },
      );

      await vi.advanceTimersByTimeAsync(1500);
      await expect(runPromise).resolves.toMatchObject({
        status: "ok",
        result: "done",
        renewFailures: 0,
        leaseRenewFailuresTotal: 0,
        leaseRenewSuccesses: 1,
      });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[cron-lease] Lease state observer failed for sync-stablecoins (renewed):"),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("aborts without overlapping heartbeats when a required renewal observer fails", async () => {
    const db = makeLeaseDb();
    const events: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const runPromise = runCronWithLease(
        db,
        "sync-stablecoins",
        async ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        {
          owner: "owner-z",
          ttlSec: 120,
          heartbeatSec: 1,
          leaseStateObserverMode: "required",
          onLeaseState: (state) => {
            events.push(state.event);
            if (state.event === "renewed") throw new Error("ledger renewal write failed");
          },
        },
      );

      const expectation = expect(runPromise).rejects.toBeInstanceOf(CronLeaseStateObserverError);
      await vi.advanceTimersByTimeAsync(1_100);
      await expectation;

      expect(events).toEqual(["acquired", "renewed"]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(events).toEqual(["acquired", "renewed"]);
      await expect(acquireCronLease(db, "sync-stablecoins", "owner-next", 120)).resolves.toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("resets thrown renew failures after a successful heartbeat", async () => {
    const renewOutcomes: Array<"throw" | "success"> = ["throw", "success", "throw", "throw"];
    const sequencedRenewDb = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO cron_leases")) {
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE cron_leases")) {
              const outcome = renewOutcomes.shift();
              if (outcome === "throw") {
                throw new Error("permanent D1 renewal error");
              }
              return { success: true, meta: { changes: outcome === "success" ? 1 : 0 } };
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
      async ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      { owner: "owner-z", ttlSec: 120, heartbeatSec: 1, maxRenewFailures: 2 },
    );

    await vi.advanceTimersByTimeAsync(3200);
    let settled = false;
    void runPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(runPromise).rejects.toBeInstanceOf(CronLeaseLostError);
  });

  it("retries transient D1 overloads before counting a heartbeat failure", async () => {
    let renewCalls = 0;
    const transientRenewDb = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO cron_leases")) {
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE cron_leases")) {
              renewCalls++;
              if (renewCalls === 1) {
                throw new Error("D1 DB is overloaded");
              }
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
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    try {
      const runPromise = runCronWithLease(
        transientRenewDb,
        "sync-stablecoins",
        async () => new Promise((resolve) => setTimeout(() => resolve("done"), 1500)),
        { owner: "owner-z", ttlSec: 120, heartbeatSec: 1, maxRenewFailures: 1 },
      );

      await vi.advanceTimersByTimeAsync(1500);
      await expect(runPromise).resolves.toMatchObject({
        status: "ok",
        result: "done",
        renewFailures: 0,
        leaseRenewAttempts: 1,
        leaseRenewSuccesses: 1,
        leaseRenewFailuresTotal: 0,
      });
      expect(renewCalls).toBe(2);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("aborts immediately when renewal reports ownership loss", async () => {
    let renewCalls = 0;
    const ownershipLostDb = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO cron_leases")) {
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE cron_leases")) {
              renewCalls++;
              return { success: true, meta: { changes: 0 } };
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
      ownershipLostDb,
      "sync-stablecoins",
      async ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      { owner: "owner-z", ttlSec: 120, heartbeatSec: 1, maxRenewFailures: 3 },
    );

    const leaseLostExpectation = expect(runPromise).rejects.toBeInstanceOf(CronLeaseLostError);
    await vi.advanceTimersByTimeAsync(1000);
    await leaseLostExpectation;
    expect(renewCalls).toBe(1);
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
    const runPromise = runCronWithLease(countingDb, "sync-stablecoins", async () => new Promise(() => {}), {
      owner: "owner-z",
      ttlSec: 120,
      heartbeatSec: 1,
      abortSignal: ac.signal,
    });

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
    const runPromise = runCronWithLease(db, "sync-stablecoins", async () => new Promise(() => {}), {
      owner: "owner-z",
      ttlSec: 120,
      heartbeatSec: 30,
      abortSignal: ac.signal,
    });

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
          signal.addEventListener(
            "abort",
            () => {
              rejectSoon();
            },
            { once: true },
          );
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
    const runPromise = runCronWithLease(db, "sync-stablecoins", async () => new Promise(() => {}), {
      owner: "owner-z",
      ttlSec: 120,
      heartbeatSec: 30,
      abortSignal: ac.signal,
    });

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

    const runPromise = runCronWithLease(renewLostDb, "sync-stablecoins", async () => new Promise(() => {}), {
      owner: "owner-z",
      ttlSec: 120,
      heartbeatSec: 1,
      maxRenewFailures: 2,
    });

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

describe("scheduled runtime timeout budgeting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildRuntime(db: D1Database, slotBudgetStartedAtMs: number) {
    return createScheduledRuntimeContext(
      { DB: db } as unknown as Parameters<typeof createScheduledRuntimeContext>[0],
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
      {
        cron: "*/15 * * * *",
        scheduleKey: "quarterHourly",
        scheduledTimeMs: null,
        slotStartedAt: Math.floor(Date.now() / 1000),
        slotBudgetStartedAtMs,
      },
    );
  }

  it("truncates a late-starting job timeout and logs a controlled cron error", async () => {
    const db = makeLeaseDb();
    const remainingBudgetMs = 5_000;
    const runtime = buildRuntime(db, Date.now() - (SCHEDULED_SLOT_JOB_BUDGET_MS - remainingBudgetMs));
    const runJob = vi.fn(
      (signal: AbortSignal): Promise<void> =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const runPromise = runtime.runLeasedCron("snapshot-supply", (signal) => runJob(signal));
    const expectation = expect(runPromise).rejects.toBeInstanceOf(CronTimeoutError);
    await vi.advanceTimersByTimeAsync(remainingBudgetMs);
    await expectation;

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(db.getLease("snapshot-supply")).toBeUndefined();
    expect(db.getRuns()).toEqual([
      expect.objectContaining({
        job: "snapshot-supply",
        status: "error",
        slot_started_at: runtime.slotStartedAt,
        error: expect.stringContaining("CronTimeoutError"),
      }),
    ]);
    const timeoutRun = db.getRuns()[0];
    expect(timeoutRun?.metadata).toBeTruthy();
    expect(JSON.parse(timeoutRun?.metadata ?? "{}")).toMatchObject({
      reason: "cron-timeout",
      configuredTimeoutMs: 5 * 60_000,
      effectiveTimeoutMs: remainingBudgetMs,
      slotBudgetTruncated: true,
      remainingSlotBudgetMs: remainingBudgetMs,
    });
  });

  it("logs a controlled error without starting a job after the slot budget is exhausted", async () => {
    const db = makeLeaseDb();
    const runtime = buildRuntime(db, Date.now() - SCHEDULED_SLOT_JOB_BUDGET_MS - 1);
    const runJob = vi.fn(async () => ({ itemCount: 1 }));

    await expect(runtime.runLeasedCron("snapshot-supply", runJob)).rejects.toBeInstanceOf(CronTimeoutError);

    expect(runJob).not.toHaveBeenCalled();
    expect(db.getLease("snapshot-supply")).toBeUndefined();
    expect(db.getRuns()).toEqual([
      expect.objectContaining({
        job: "snapshot-supply",
        status: "error",
        slot_started_at: runtime.slotStartedAt,
        error: expect.stringContaining("scheduled slot budget was exhausted"),
      }),
    ]);
    const exhaustedRun = db.getRuns()[0];
    expect(exhaustedRun?.metadata).toBeTruthy();
    expect(JSON.parse(exhaustedRun?.metadata ?? "{}")).toMatchObject({
      reason: "cron-timeout",
      effectiveTimeoutMs: 0,
      slotBudgetTruncated: true,
      slotBudgetExhausted: true,
      remainingSlotBudgetMs: 0,
    });
  });
});
