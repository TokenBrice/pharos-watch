import { describe, expect, it, vi } from "vitest";

import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { deleteCapped, runCappedPruneFamily } from "../capped-delete";
import { pruneOldApiKeyRequestRateLimits } from "../../../lib/api-key-request-rate-limit-prune";

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

  it("shares the retired API-key row budget across both tables", async () => {
    const { db, calls } = makeScriptedD1({ run: (call) => call.sql.includes("api_key_request_rate_limit_v2") ? 1 : Number(call.binds[1]) });
    expect(await pruneOldApiKeyRequestRateLimits(db, 123, 2, 4)).toEqual({ deleted: 4, truncated: true });
    expect(calls.map((call) => call.binds)).toEqual([[123, 2], [123, 2], [123, 1]]);
    expect(calls.map((call) => call.sql.includes("api_key_request_rate_limit_v2"))).toEqual([true, false, false]);
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
