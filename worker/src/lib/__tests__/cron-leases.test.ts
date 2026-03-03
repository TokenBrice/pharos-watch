import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireCronLease,
  renewCronLease,
  releaseCronLease,
  runCronWithLease,
} from "../db";

type LeaseRow = {
  job: string;
  lease_owner: string;
  lease_until: number;
  heartbeat_at: number;
  updated_at: number;
};

function makeLeaseDb(seed?: LeaseRow): D1Database {
  const leases = new Map<string, LeaseRow>();
  if (seed) leases.set(seed.job, seed);

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

          return { success: true, meta: { changes: 0 } };
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
  } as unknown as D1Database;
}

describe("cron lease primitives", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T10:00:00Z"));
  });

  it("acquires lease when no row exists", async () => {
    const db = makeLeaseDb();
    const ok = await acquireCronLease(db, "sync-stablecoins", "owner-a", 120);
    expect(ok).toBe(true);
  });

  it("fails to acquire lease when active owner exists", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      job: "sync-stablecoins",
      lease_owner: "owner-a",
      lease_until: now + 600,
      heartbeat_at: now,
      updated_at: now,
    });

    const ok = await acquireCronLease(db, "sync-stablecoins", "owner-b", 120);
    expect(ok).toBe(false);
  });

  it("acquires lease when previous lease is expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      job: "sync-stablecoins",
      lease_owner: "owner-a",
      lease_until: now - 1,
      heartbeat_at: now - 60,
      updated_at: now - 60,
    });

    const ok = await acquireCronLease(db, "sync-stablecoins", "owner-b", 120);
    expect(ok).toBe(true);
  });

  it("renews lease for current owner and rejects others", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      job: "sync-stablecoins",
      lease_owner: "owner-a",
      lease_until: now + 10,
      heartbeat_at: now,
      updated_at: now,
    });

    await expect(renewCronLease(db, "sync-stablecoins", "owner-a", 120)).resolves.toBe(true);
    await expect(renewCronLease(db, "sync-stablecoins", "owner-b", 120)).resolves.toBe(false);
  });

  it("release is owner-scoped", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      job: "sync-stablecoins",
      lease_owner: "owner-a",
      lease_until: now + 120,
      heartbeat_at: now,
      updated_at: now,
    });

    await expect(releaseCronLease(db, "sync-stablecoins", "owner-b")).resolves.toBeUndefined();
    const stillLocked = await acquireCronLease(db, "sync-stablecoins", "owner-c", 120);
    expect(stillLocked).toBe(false);

    await expect(releaseCronLease(db, "sync-stablecoins", "owner-a")).resolves.toBeUndefined();
    const acquiredAfterRelease = await acquireCronLease(db, "sync-stablecoins", "owner-c", 120);
    expect(acquiredAfterRelease).toBe(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe("runCronWithLease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T10:00:00Z"));
  });

  it("returns skipped_locked when lease acquisition fails", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      job: "sync-stablecoins",
      lease_owner: "owner-a",
      lease_until: now + 600,
      heartbeat_at: now,
      updated_at: now,
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

  afterEach(() => {
    vi.useRealTimers();
  });
});
