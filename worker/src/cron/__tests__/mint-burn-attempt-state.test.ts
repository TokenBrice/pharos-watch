import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { updateMintBurnAttemptState } from "../mint-burn/run-state";

const keys = Array.from({ length: 127 }, (_, index) => `config-${index}`);

function breakdown(order: readonly string[], attemptedCount: number) {
  return order.map((key, index) => ({
    key,
    attempted: index < attemptedCount,
    skippedReason: index < attemptedCount ? null : "runtime-budget-exhausted",
  }));
}

describe("mint/burn per-config attempt state", () => {
  it("proves 127 configs are observed across two 94-config runs", async () => {
    const firstDb = mockD1();
    const first = await updateMintBurnAttemptState({
      db: firstDb,
      jobName: "sync-mint-burn-extended",
      enabledConfigKeys: keys,
      configBreakdown: breakdown(keys, 94),
      activeProviderDeferrals: new Map(),
      nowSec: 1_000_000,
    });
    expect(first.attemptedThisRun).toBe(94);
    expect(first.neverAttemptedCount).toBe(33);
    expect(first.staleAttemptCount).toBe(0);

    const stateWrite = firstDb.getHistory().find((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === "mint-burn:attempt-state:sync-mint-burn-extended"
    );
    expect(stateWrite).toBeDefined();
    const secondOrder = [...keys.slice(94), ...keys.slice(0, 94)];
    const secondDb = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["mint-burn:attempt-state:sync-mint-burn-extended"],
      rows: [{
        key: "mint-burn:attempt-state:sync-mint-burn-extended",
        value: stateWrite!.binds[1] as string,
        updated_at: 1_000_000,
      }],
    }]);
    const second = await updateMintBurnAttemptState({
      db: secondDb,
      jobName: "sync-mint-burn-extended",
      enabledConfigKeys: keys,
      configBreakdown: breakdown(secondOrder, 94),
      activeProviderDeferrals: new Map(),
      nowSec: 1_001_800,
    });

    expect(second.attemptedThisRun).toBe(94);
    expect(second.neverAttemptedCount).toBe(0);
    expect(second.staleAttemptCount).toBe(0);
    expect(second.twoCycleCoverageSatisfied).toBe(true);
  });

  it("exempts an active provider deferral but flags an overdue unattempted config", async () => {
    const cachedState = JSON.stringify({
      version: 1,
      updatedAt: 1_000,
      entries: {
        "config-0": {
          firstObservedAt: 1_000,
          lastAttemptedAt: null,
          lastDisposition: "runtime-budget-exhausted",
          providerDeferredUntil: null,
        },
      },
    });
    const makeDb = () => mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [{ key: "mint-burn:attempt-state:job", value: cachedState, updated_at: 1_000 }],
    }]);

    const deferred = await updateMintBurnAttemptState({
      db: makeDb(),
      jobName: "job",
      enabledConfigKeys: ["config-0"],
      configBreakdown: [{ key: "config-0", attempted: false, skippedReason: "deferred" }],
      activeProviderDeferrals: new Map([["config-0", 7_000]]),
      nowSec: 6_000,
    });
    expect(deferred.staleAttemptCount).toBe(0);
    expect(deferred.providerDeferredThisRun).toBe(1);

    const overdue = await updateMintBurnAttemptState({
      db: makeDb(),
      jobName: "job",
      enabledConfigKeys: ["config-0"],
      configBreakdown: [{ key: "config-0", attempted: false, skippedReason: "runtime-budget-exhausted" }],
      activeProviderDeferrals: new Map(),
      nowSec: 6_000,
    });
    expect(overdue.staleAttemptCount).toBe(1);
    expect(overdue.twoCycleCoverageSatisfied).toBe(false);
  });
});
