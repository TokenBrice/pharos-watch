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
  const invoke = (method: "run" | "first", sql: string, binds: unknown[]) => {
    const call = { sql, binds };
    calls.push(call);
    const outcome = script[method]?.(call) ?? (method === "run" ? 0 : null);
    if (outcome instanceof Error) throw outcome;
    return method === "run" ? { success: true, meta: { changes: outcome } } : outcome;
  };
  const statement = (sql: string, binds: unknown[]): unknown => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => invoke("run", sql, binds),
    first: async () => invoke("first", sql, binds),
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
      run: (call) => call.sql.includes("alpha") ? (++alphaRuns === 1 ? 2 : 1) : 5,
      first: (call) => (call.sql.includes("remaining") ? { oldest_remaining_at: 17 } : null),
    });
    const probes = {
      remaining: { sql: "SELECT MIN(ts) AS oldest_remaining_at FROM alpha /* remaining */" },
      eligible: { sql: "SELECT ts AS oldest_eligible_at FROM alpha", binds: [99] },
    };
    const family = await runCappedPruneFamily({ db, statements: { alpha, beta }, probes });

    expect(family).toMatchObject({ changedRows: 8, changed: { alpha: 3, beta: 5 }, cappedAtLimit: true, error: null });
    expect(family.probes.remaining.oldest_remaining_at ?? null).toBe(17);
    expect(family.probes.eligible.oldest_eligible_at ?? null).toBeNull();
    expect(calls.map((call) => call.sql)).toEqual([alpha.sql, alpha.sql, beta.sql, probes.remaining.sql, probes.eligible.sql]);
    expect(calls[4].binds).toEqual([99]);
  });

  it("rethrows a shutdown abort instead of reporting it as a prune error", async () => {
    const controller = new AbortController();
    const { db } = makeScriptedD1({ run: () => { controller.abort(); return new Error("statement interrupted"); } });

    await expect(runCappedPruneFamily({ db, signal: controller.signal, statements: { alpha } })).rejects.toThrow();
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
  it("attributes a later window failure while retaining earlier commits", async () => {
    const { sqlite, db } = fixture();
    sqlite.exec("INSERT INTO alpha VALUES (1)");
    const failedRetentionGroup = [{ key: "alpha", window: "missing = 1" }];
    await expect(runRetentionPolicies(db, { alpha: { ...policy("alpha"), windows: [
      { windowSec: 10, predicate: "1 = 1" }, { windowSec: 20, predicate: "missing = 1" },
    ] } }, 100)).rejects.toMatchObject({ failedRetentionGroup, message: expect.stringContaining("alpha [missing = 1]") });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM alpha").get()).toEqual({ n: 0 });
  });

  it.each([false, true, "windows"])("reports retention and bounded costs (%s)", async (mode) => {
    const costs = mode === true, windowed = mode === "windows";
    const { sqlite, db, batch, execute } = fixture();
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValue(137);
    const key = "a".repeat(101);
    if (costs) batch.mockImplementation(async (statements) => (await execute(statements)).map((result, i) => {
      const n = batch.mock.calls.length * 10 + i;
      return { ...result, meta: { ...result.meta, rows_read: n, rows_written: n + 1, duration: n + 2 } };
    }));
    sqlite.exec("INSERT INTO alpha VALUES (1), (2), (3), (4), (90); INSERT INTO beta VALUES (1), (90)");
    const alphaPolicy = { ...policy("alpha"), windows: windowed ? [
      { windowSec: 90, predicate: "observed_at < 3" },
      { windowSec: 10, predicate: "observed_at = 3" },
      { windowSec: 1, predicate: "observed_at > 3" },
    ] : undefined };
    expect(await runRetentionPolicies(db, { [key]: alphaPolicy, beta: policy("beta") }, 100)).toEqual({
      [key]: { pruned: 3, cappedAtLimit: true }, beta: { pruned: 1, cappedAtLimit: false },
    });
    expect(sqlite.prepare("SELECT observed_at FROM alpha ORDER BY observed_at").all()).toEqual([{ observed_at: 4 }, { observed_at: 90 }]);
    expect(sqlite.prepare("SELECT observed_at FROM beta").all()).toEqual([{ observed_at: 90 }]);
    expect(batch.mock.calls.map(([statements]) => statements.length)).toEqual(windowed ? [1, 1, 1, 1] : [1, 1, 1]);
    expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({
      status: "ok", completedRounds: windowed ? 3 : 2, batchOutcomeUnknown: false, durationMs: 37,
      completed: [
        { key: "a".repeat(100), pruned: 3, rowsRead: costs ? 30 : null, rowsWritten: costs ? 32 : 3, d1DurationMs: costs ? 34 : null },
      ],
    });
    expect(JSON.parse(log.mock.calls[1][1]).completed).toEqual([
      { key: "beta", pruned: 1, rowsRead: costs ? 30 : null, rowsWritten: costs ? 31 : 1, d1DurationMs: costs ? 32 : null },
    ]);
  });

  it.each([false, true])("paces rounds, windows and policies after failure (overload=%s)", async (overload) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const { sqlite, db, batch, execute } = fixture();
      sqlite.exec("INSERT INTO alpha VALUES (1), (2)");
      const starts: number[] = [];
      batch.mockImplementation(async (statements) => {
        starts.push(Date.now());
        vi.setSystemTime(Date.now() + 10);
        if (overload && starts.length > 3 && starts.length < 8) throw new Error("D1 DB is overloaded. Too many resources consumed within a 10 second window");
        return execute(statements);
      });
      const pass = runRetentionPolicies(db, { alpha: { ...policy("alpha"), batchLimit: 1, windows: [
        { windowSec: 10, predicate: "1 = 1" }, { windowSec: 20, predicate: "missing = 1" },
      ] }, beta: policy("beta") }, 100).catch((error) => error);
      await vi.runAllTimersAsync();
      expect((await pass).completedResults).toEqual({ beta: { pruned: 0, cappedAtLimit: false } });
      if (overload) expect(starts[7] - starts[6]).toBeGreaterThanOrEqual(10_040);
      else expect(starts).toEqual([0, 40, 80, 120, 160]);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { label: "retains the retired-key shared run ceiling and declaration priority", alphaRows: 2, betaRows: 3, alphaPruned: 2, betaPruned: 1, left: 2, batches: 3 },
    { label: "reports a skipped sibling as truncated when the shared ceiling is exhausted", alphaRows: 3, betaRows: 1, alphaPruned: 3, betaPruned: 0, left: 1, batches: 2 },
  ])("$label", async ({ alphaRows, betaRows, alphaPruned, betaPruned, left, batches }) => {
    const { sqlite, db, batch } = fixture();
    for (const [table, count] of [["alpha", alphaRows], ["beta", betaRows]] as const) {
      for (let n = 1; n <= count; n++) sqlite.prepare(`INSERT INTO ${table} VALUES (?)`).run(n);
    }
    const results = await runRetentionPolicies(db, Object.fromEntries(["alpha", "beta"].map((table) =>
      [table, { ...policy(table), budgetGroup: "shared" }])), 100);
    expect(results).toEqual({
      alpha: { pruned: alphaPruned, cappedAtLimit: alphaPruned === 3 }, beta: { pruned: betaPruned, cappedAtLimit: true },
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM beta").get()).toEqual({ n: left });
    expect(batch).toHaveBeenCalledTimes(batches);
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

  it.each(["before", "after", "failed", "abort-object"])("preserves cause, commits and restart after %s interruption", async (when) => {
    const { sqlite, db, batch, execute } = fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    sqlite.exec("INSERT INTO alpha VALUES (1), (2), (3), (4)");
    const controller = new AbortController();
    const cause = when === "abort-object" ? { name: "AbortError", message: "x".repeat(900) } : new Error("x".repeat(900));
    if (when === "before") controller.abort(cause);
    else {
      batch.mockImplementationOnce(async (statements) => {
        const result = await execute(statements);
        if (when === "after") controller.abort(cause);
        return result;
      }).mockRejectedValueOnce(cause);
    }
    const pass = expect(runRetentionPolicies(db, { alpha: policy("alpha") }, 100, controller.signal)).rejects;
    if (when === "failed") await pass.toMatchObject({ cause, failedRetentionGroup: [{ key: "alpha" }] });
    else await pass.toBe(cause);
    expect(batch).toHaveBeenCalledTimes(when === "before" ? 0 : when === "after" ? 1 : 2);
    if (when !== "before") expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({
      status: when === "failed" ? "error" : "aborted", error: "x".repeat(500),
      completedRounds: 1, batchOutcomeUnknown: when !== "after", completed: [{ key: "alpha", pruned: 2 }],
    });
    batch.mockRestore();
    expect((await runRetentionPolicies(db, { alpha: policy("alpha") }, 100)).alpha.pruned).toBe(when === "before" ? 3 : 2);
  });

  it("keeps independent policies committed after an earlier failure", async () => {
    const { sqlite, db } = fixture();
    sqlite.exec("INSERT INTO alpha VALUES (1); INSERT INTO beta VALUES (1)");
    const first = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`first${i}`, policy("alpha")]));
    await expect(runRetentionPolicies(db, { ...first, missing: policy("missing"), beta: policy("beta") }, 100))
      .rejects.toMatchObject({ completedResults: { beta: { pruned: 1, cappedAtLimit: false } } });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM alpha").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM beta").get()).toEqual({ n: 0 });
  });

  it("does not spend a shared budget after an unconfirmed sibling", async () => {
    const { db, batch } = fixture();
    batch.mockRejectedValueOnce(new Error("unknown outcome"));
    await expect(runRetentionPolicies(db, { alpha: { ...policy("alpha"), budgetGroup: "shared" },
      beta: { ...policy("beta"), budgetGroup: "shared" } }, 100)).rejects.toMatchObject({
      failedRetentionGroup: [{ key: "alpha" }, { key: "beta" }], completedResults: {},
    });
    expect(batch).toHaveBeenCalledTimes(1);
  });
});
