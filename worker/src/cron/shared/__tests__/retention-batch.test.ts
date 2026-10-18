import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import type { WindowedRetentionPolicy } from "@shared/lib/retention-policy";
import { deleteCappedGroup, runRetentionPolicies } from "../capped-delete";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec("CREATE TABLE alpha (observed_at INTEGER); CREATE TABLE beta (observed_at INTEGER)");
  const db = createSqliteD1(sqlite);
  const batch = vi.spyOn(db, "batch");
  return { sqlite, db, batch };
}

const policy = (table: string): WindowedRetentionPolicy => ({
  table, timestampColumn: "observed_at", windowSec: 10, predicate: "1 = 1",
  owner: "test", permanent: false, batchLimit: 2, runLimit: 3,
});

describe("batched registry retention", () => {
  it("drains independent entries in shared rounds with separate partial caps and strict cutoffs", async () => {
    const { sqlite, db, batch } = fixture();
    sqlite.exec("INSERT INTO alpha VALUES (1), (2), (3), (4), (90); INSERT INTO beta VALUES (1), (90)");
    const results = await runRetentionPolicies(db, { alpha: policy("alpha"), beta: policy("beta") }, 100);
    expect(results).toEqual({
      alpha: { pruned: 3, cappedAtLimit: true }, beta: { pruned: 1, cappedAtLimit: false },
    });
    expect(sqlite.prepare("SELECT observed_at FROM alpha ORDER BY observed_at").all()).toEqual([{ observed_at: 4 }, { observed_at: 90 }]);
    expect(sqlite.prepare("SELECT observed_at FROM beta").all()).toEqual([{ observed_at: 90 }]);
    expect(batch.mock.calls.map(([statements]) => statements.length)).toEqual([2, 1]);
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

  it("does not admit a binding call for an already-aborted invocation", async () => {
    const { db, batch } = fixture();
    const controller = new AbortController();
    controller.abort(new Error("retention-cancelled"));
    await expect(runRetentionPolicies(db, { alpha: policy("alpha") }, 100, controller.signal)).rejects.toThrow("retention-cancelled");
    expect(batch).not.toHaveBeenCalled();
  });

  it("rolls back an entire failed group rather than publishing partial success", async () => {
    const { sqlite, db } = fixture();
    sqlite.exec("INSERT INTO alpha VALUES (1)");
    await expect(runRetentionPolicies(db, { alpha: policy("alpha"), missing: policy("missing") }, 100)).rejects.toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM alpha").get()).toEqual({ n: 1 });
  });
});
