import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireCronLease, releaseCronLease, renewCronLease } from "../cron-lease-primitives";
import { handleBackfillStabilityIndex } from "../../api/backfill-stability-index";

const OVERLOAD = new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");

describe("standalone cron lease primitives", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries the acquire, renew, and release lifecycle used by the backfill route", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);

    const calls = new Map<string, number>();
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          run: async () => {
            const operation = sql.startsWith("INSERT") ? "acquire" : sql.startsWith("UPDATE") ? "renew" : "release";
            const count = (calls.get(operation) ?? 0) + 1;
            calls.set(operation, count);
            if (count === 1) throw OVERLOAD;
            return { success: true, meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database;

    const acquire = acquireCronLease(db, "backfill-stability-index", "owner", 600);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(acquire).resolves.toBe(true);

    const renew = renewCronLease(db, "backfill-stability-index", "owner", 600);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(renew).resolves.toBe(true);

    const release = releaseCronLease(db, "backfill-stability-index", "owner");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(release).resolves.toBeUndefined();

    expect(Object.fromEntries(calls)).toEqual({ acquire: 2, renew: 2, release: 2 });
  });

  it("lets the backfill route complete after a forced acquire overload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    const earliest = Math.floor(Date.parse("2026-09-16T00:00:00Z") / 1_000);
    let acquireAttempts = 0;
    const statement = (sql: string, binds: unknown[] = []) => ({
      bind: (...args: unknown[]) => statement(sql, args),
      first: async <T>() => (
        sql.includes("MIN(started_at)")
          ? { earliest } as T
          : null
      ),
      all: async <T>() => ({
        results: (
          sql.includes("FROM depeg_events")
            ? [{
                stablecoin_id: "usdc-circle",
                peak_deviation_bps: 200,
                peg_reference: 1,
                started_at: earliest,
                ended_at: earliest + 3_600,
              }]
            : []
        ) as T[],
        success: true,
        meta: {},
      }),
      run: async () => {
        if (sql.startsWith("INSERT INTO cron_leases")) {
          acquireAttempts++;
          if (acquireAttempts === 1) throw OVERLOAD;
        }
        return { success: true, meta: { changes: 1 } };
      },
      sql,
      binds,
    });
    const db = {
      prepare: (sql: string) => statement(sql),
      batch: async (statements: unknown[]) =>
        statements.map(() => ({ success: true, results: [], meta: { changes: 1 } })),
      exec: async () => ({ count: 0, duration: 0 }),
    } as unknown as D1Database;

    const pending = handleBackfillStabilityIndex({
      db,
      url: new URL("https://api.pharos.watch/api/backfill-stability-index"),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await pending;

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, daysEvaluated: 1 });
    expect(acquireAttempts).toBe(2);
  });
});
