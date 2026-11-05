import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import type { WindowedRetentionPolicy } from "@shared/lib/retention-policy";

import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { deleteCapped, deleteCappedGroup, runCappedPruneFamily, runRetentionPolicies } from "../capped-delete";

interface RecordedCall {
  sql: string;
  binds: unknown[];
}

type RunOutcome = number | Error;
type FirstOutcome = Record<string, number | null> | null | Error;

function makeScriptedD1(script: {
  run?: (call: RecordedCall) => RunOutcome;
  first?: (call: RecordedCall) => FirstOutcome;
}): { db: D1Database; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const statement = (sql: string, binds: unknown[]): unknown => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => {
      const call = { sql, binds };
      calls.push(call);
      const outcome = script.run?.(call) ?? 0;
      if (outcome instanceof Error) throw outcome;
      return { success: true, meta: { changes: outcome } };
    },
    first: async () => {
      const call = { sql, binds };
      calls.push(call);
      const outcome = script.first?.(call) ?? null;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  const db = makeNoopD1({ prepare: (sql: string) => statement(sql, []) });
  return { db, calls };
}

const alpha = { sql: "DELETE FROM alpha LIMIT ?", bindsForLimit: (limit: number) => [limit], batchLimit: 2, runLimit: 4 };
const beta = { sql: "DELETE FROM beta LIMIT ?", bindsForLimit: (limit: number) => ["b", limit], batchLimit: 5, runLimit: 5 };

describe("capped batch lifecycle", () => {
  it.each([
    [[2, 1], 10, 3, false, [2, 2]],
    [[2, 2], 4, 4, true, [2, 2]],
    [[2, 1], 3, 3, true, [2, 1]],
  ] as const)("preserves short batches and exact or partial caps (%s)", async (batches, cap, pruned, cappedAtLimit, limits) => {
    let index = 0;
    const { db, calls } = makeScriptedD1({ run: () => batches[index++] });
    expect(await deleteCapped(db, alpha.sql, (limit) => [limit], 2, cap)).toEqual({ pruned, cappedAtLimit });
    expect(calls.map((call) => call.binds[0])).toEqual(limits);
  });

  it("retries overloads without spending the row budget", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const { db, calls } = makeScriptedD1({ run: () => ++attempts === 1 ? new Error("D1 DB is overloaded") : 1 });
      const pass = deleteCapped(db, alpha.sql, (limit) => [limit], 2, 3);
      await vi.runAllTimersAsync();
      expect(await pass).toEqual({ pruned: 1, cappedAtLimit: false });
      expect(calls.map((call) => call.binds)).toEqual([[2], [2]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not admit another batch after cancellation", async () => {
    const controller = new AbortController();
    const { db, calls } = makeScriptedD1({ run: () => { controller.abort(new Error("cancelled")); return 2; } });
    await expect(deleteCapped(db, alpha.sql, (limit) => [limit], 2, 4, controller.signal)).rejects.toThrow("cancelled");
    expect(calls).toHaveLength(1);
  });

});

describe("runCappedPruneFamily", () => {
  it("runs every statement before its probes and reports counts, cap and probe rows", async () => {
    let alphaRuns = 0;
    const { db, calls } = makeScriptedD1({
      run: (call) => {
        if (!call.sql.includes("alpha")) return 5;
        alphaRuns += 1;
        return alphaRuns === 1 ? 2 : 1;
      },
      first: (call) => (call.sql.includes("remaining") ? { oldest_remaining_at: 17 } : null),
    });
    const family = await runCappedPruneFamily({
      db,
      statements: { alpha, beta },
      probes: {
        remaining: { sql: "SELECT MIN(ts) AS oldest_remaining_at FROM alpha /* remaining */" },
        eligible: { sql: "SELECT ts AS oldest_eligible_at FROM alpha", binds: [99] },
      },
    });

    expect(family).toMatchObject({
      changedRows: 8,
      changed: { alpha: 3, beta: 5 },
      cappedAtLimit: true,
      error: null,
    });
    expect(family.probes.remaining.oldest_remaining_at ?? null).toBe(17);
    expect(family.probes.eligible.oldest_eligible_at ?? null).toBeNull();
    expect(calls.map((call) => call.sql)).toEqual([
      alpha.sql,
      alpha.sql,
      beta.sql,
      "SELECT MIN(ts) AS oldest_remaining_at FROM alpha /* remaining */",
      "SELECT ts AS oldest_eligible_at FROM alpha",
    ]);
    expect(calls[4].binds).toEqual([99]);
  });

  it("rethrows a shutdown abort instead of reporting it as a prune error", async () => {
    const controller = new AbortController();
    const { db } = makeScriptedD1({
      run: () => {
        controller.abort();
        return new Error("statement interrupted");
      },
    });

    await expect(
      runCappedPruneFamily({ db, signal: controller.signal, statements: { alpha } }),
    ).rejects.toThrow();
  });

  it("bounds a statement failure to 500 characters and keeps the counts already collected", async () => {
    const { db, calls } = makeScriptedD1({
      run: (call) => (call.sql.includes("alpha") ? 1 : new Error("x".repeat(900))),
    });

    const family = await runCappedPruneFamily({
      db,
      statements: { alpha, beta },
      probes: { remaining: { sql: "SELECT MIN(ts) AS oldest_remaining_at FROM alpha" } },
    });

    expect(family.changed).toEqual({ alpha: 1, beta: 0 });
    expect(family.changedRows).toBe(1);
    expect(family.error).toBe("x".repeat(500));
    expect(family.probes.remaining.oldest_remaining_at ?? null).toBeNull();
    expect(calls.map((call) => call.sql)).toEqual([alpha.sql, beta.sql]);
  });
});

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const sqlite of databases.splice(0)) sqlite.close();
});

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec("CREATE TABLE alpha (observed_at INTEGER); CREATE TABLE beta (observed_at INTEGER)");
  const db = createSqliteD1(sqlite);
  const execute = db.batch;
  const batch = vi.spyOn(db, "batch");
  return { sqlite, db, batch, execute };
}

const policy = (table: string): WindowedRetentionPolicy => ({
  table, timestampColumn: "observed_at", windowSec: 10, predicate: "1 = 1",
  owner: "test", permanent: false, batchLimit: 2, runLimit: 3,
});

describe("batched registry retention", () => {
  it.each([false, true])("reports retention and bounded costs (%s)", async (costs) => {
    const { sqlite, db, batch, execute } = fixture();
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValue(137);
    const key = "a".repeat(101);
    if (costs) batch.mockImplementation(async (statements) => (await execute(statements)).map((result, i) => {
      const n = batch.mock.calls.length * 10 + i;
      return { ...result, meta: { ...result.meta, rows_read: n, rows_written: n + 1, duration: n + 2 } };
    }));
    sqlite.exec("INSERT INTO alpha VALUES (1), (2), (3), (4), (90); INSERT INTO beta VALUES (1), (90)");
    expect(await runRetentionPolicies(db, { [key]: policy("alpha"), beta: policy("beta") }, 100)).toEqual({
      [key]: { pruned: 3, cappedAtLimit: true }, beta: { pruned: 1, cappedAtLimit: false },
    });
    expect(sqlite.prepare("SELECT observed_at FROM alpha ORDER BY observed_at").all()).toEqual([{ observed_at: 4 }, { observed_at: 90 }]);
    expect(sqlite.prepare("SELECT observed_at FROM beta").all()).toEqual([{ observed_at: 90 }]);
    expect(batch.mock.calls.map(([statements]) => statements.length)).toEqual([2, 1]);
    expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({
      status: "ok", completedRounds: 2, batchOutcomeUnknown: false, durationMs: 37,
      completed: [
        { key: "a".repeat(100), pruned: 3, rowsRead: costs ? 30 : null, rowsWritten: costs ? 32 : 3, d1DurationMs: costs ? 34 : null },
        { key: "beta", pruned: 1, rowsRead: costs ? 11 : null, rowsWritten: costs ? 12 : 1, d1DurationMs: costs ? 13 : null },
      ],
    });
  });

  it("retains the retired-key shared run ceiling and declaration priority", async () => {
    const { sqlite, db, batch } = fixture();
    sqlite.exec("INSERT INTO alpha VALUES (1), (2); INSERT INTO beta VALUES (1), (2), (3)");
    const results = await runRetentionPolicies(db, {
      alpha: { ...policy("alpha"), budgetGroup: "shared" },
      beta: { ...policy("beta"), budgetGroup: "shared" },
    }, 100);
    expect(results).toEqual({ alpha: { pruned: 2, cappedAtLimit: false }, beta: { pruned: 1, cappedAtLimit: true } });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM beta").get()).toEqual({ n: 2 });
    expect(batch).toHaveBeenCalledTimes(3);
  });

  it("reports a skipped sibling as truncated when the shared ceiling is exhausted", async () => {
    const { sqlite, db } = fixture();
    sqlite.exec("INSERT INTO alpha VALUES (1), (2), (3); INSERT INTO beta VALUES (1)");
    const results = await runRetentionPolicies(db, {
      alpha: { ...policy("alpha"), budgetGroup: "shared" },
      beta: { ...policy("beta"), budgetGroup: "shared" },
    }, 100);
    expect(results.beta).toEqual({ pruned: 0, cappedAtLimit: true });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM beta").get()).toEqual({ n: 1 });
  });

  it.each([[20, 4], [50, 10]])("packs %i independent empty statements into %i binding calls", async (count, calls) => {
    const { db, batch } = fixture();
    const statements = Array.from({ length: count }, () => ({
      sql: "DELETE FROM alpha WHERE observed_at < ? AND rowid IN (SELECT rowid FROM alpha LIMIT ?)",
      bindsForLimit: (limit: number) => [10, limit], batchLimit: 2, runLimit: 10,
    }));
    expect(await deleteCappedGroup(db, statements)).toHaveLength(count);
    expect(batch).toHaveBeenCalledTimes(calls);
  });

  it.each(["before", "after", "failed"])("preserves cause, commits and restart after %s interruption", async (when) => {
    const { sqlite, db, batch, execute } = fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    sqlite.exec("INSERT INTO alpha VALUES (1), (2), (3), (4)");
    const controller = new AbortController();
    const cause = new Error("x".repeat(900));
    if (when === "before") controller.abort(cause);
    else {
      batch.mockImplementationOnce(async (statements) => {
        const result = await execute(statements);
        if (when === "after") controller.abort(cause);
        return result;
      }).mockRejectedValueOnce(cause);
    }
    await expect(runRetentionPolicies(db, { alpha: policy("alpha") }, 100, controller.signal)).rejects.toBe(cause);
    expect(batch).toHaveBeenCalledTimes(when === "before" ? 0 : when === "after" ? 1 : 2);
    if (when !== "before") expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({
      status: when === "after" ? "aborted" : "error", error: "x".repeat(500),
      completedRounds: 1, batchOutcomeUnknown: when === "failed", completed: [{ key: "alpha", pruned: 2 }],
    });
    batch.mockRestore();
    expect((await runRetentionPolicies(db, { alpha: policy("alpha") }, 100)).alpha.pruned).toBe(when === "before" ? 3 : 2);
  });

  it("keeps prior groups committed but rolls back an entire failed later group", async () => {
    const { sqlite, db } = fixture();
    sqlite.exec("INSERT INTO alpha VALUES (1); INSERT INTO beta VALUES (1)");
    const first = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`first${i}`, policy("alpha")]));
    await expect(runRetentionPolicies(db, { ...first, beta: policy("beta"), missing: policy("missing") }, 100)).rejects.toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM alpha").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM beta").get()).toEqual({ n: 1 });
  });
});
