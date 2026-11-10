import { describe, expect, it } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import {
  MINT_BURN_EXTENDED_COVERAGE_WINDOW_SEC,
  updateMintBurnAttemptState,
} from "../mint-burn/run-state";

const EXTENDED_JOB = "sync-mint-burn-extended";
const EXTENDED_CACHE_KEY = `mint-burn:attempt-state:${EXTENDED_JOB}`;
const INTERVAL_SEC = 1_800;

const keys = Array.from({ length: 127 }, (_, index) => `config-${index}`);


type AttemptInput = Parameters<typeof updateMintBurnAttemptState>[0];
function updateAttempt(input: Omit<AttemptInput, "jobName" | "lane" | "activeProviderDeferrals">
  & Partial<Pick<AttemptInput, "jobName" | "lane" | "activeProviderDeferrals">>) {
  return updateMintBurnAttemptState({ jobName: EXTENDED_JOB, lane: "extended", activeProviderDeferrals: new Map(), ...input });
}

function breakdown(order: readonly string[], attempted: ReadonlySet<string>) {
  return order.map((key) => ({
    key,
    attempted: attempted.has(key),
    skippedReason: attempted.has(key) ? null : "extended-deferred-under-pressure",
    advancedTo: attempted.has(key) ? 1 : null,
  }));
}

function cachedRow(cacheKey: string, value: string, updatedAt: number) {
  return {
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: [cacheKey],
    rows: [{ key: cacheKey, value, updated_at: updatedAt }],
  };
}

function stateWrite(db: MockD1Database, cacheKey: string) {
  return db.getHistory().find((entry) =>
    entry.sql.includes("INSERT INTO cache") && entry.binds[0] === cacheKey
  );
}

function persistedState(db: MockD1Database, cacheKey: string): string {
  const write = stateWrite(db, cacheKey);
  expect(write).toBeDefined();
  return write!.binds[1] as string;
}

describe("mint/burn per-config attempt state", () => {
  it("covers a 129-config roster 40 per run without ever stalling", async () => {
    const roster = Array.from({ length: 129 }, (_, index) => `config-${index}`);
    let persisted: string | null = null;
    const run = async (runIndex: number) => {
      const nowSec = 1_000_000 + runIndex * INTERVAL_SEC;
      const attempted = new Set(
        Array.from({ length: 40 }, (_, offset) => roster[(runIndex * 40 + offset) % roster.length]!),
      );
      const db = mockD1(persisted ? [cachedRow(EXTENDED_CACHE_KEY, persisted, nowSec)] : []);
      const result = await updateAttempt({ db, enabledConfigKeys: roster, configBreakdown: breakdown(roster, attempted), nowSec });
      expect(result.summary.attemptedThisRun).toBe(40);
      persisted = persistedState(db, EXTENDED_CACHE_KEY);
      return result;
    };

    const first = await run(0);
    const second = await run(1);
    const third = await run(2);
    const fourth = await run(3);

    for (const [index, update] of [first, second, third].entries()) {
      expect(update.coverageCycle?.status, `run ${index + 1}`).toBe("cycle-in-progress");
      expect(update.coverageCycle?.coverageCycleSec, `run ${index + 1}`).toBeNull();
    }
    expect(third.coverageCycle?.incompleteConfigs).toBe(9);
    expect(fourth.coverageCycle).toMatchObject({
      status: "complete",
      coverageCycleSec: 3 * INTERVAL_SEC,
      incompleteConfigs: 0,
    });

    expect(first.summary.neverAttemptedCount).toBe(89);
    expect(fourth.summary.neverAttemptedCount).toBe(0);
    expect(fourth.coverageCycle).toMatchObject({
      lastCompletedAt: 1_000_000 + 3 * INTERVAL_SEC,
      expectedWindowSec: MINT_BURN_EXTENDED_COVERAGE_WINDOW_SEC,
    });

    const fifth = await run(4);
    expect(fifth.coverageCycle?.status).toBe("complete");
    expect(fifth.coverageCycle?.coverageCycleSec).toBe(3 * INTERVAL_SEC);
    expect(fifth.coverageCycle?.cycleElapsedSec).toBe(INTERVAL_SEC);
  });

  it("reports cycle-in-progress with no completed cycle instead of healthy", async () => {
    const db = mockD1();
    const cold = await updateAttempt({ db, enabledConfigKeys: keys, configBreakdown: breakdown(keys, new Set()), nowSec: 2_000_000 });

    expect(cold.coverageCycle).toEqual({
      status: "cycle-in-progress",
      expectedWindowSec: MINT_BURN_EXTENDED_COVERAGE_WINDOW_SEC,
      coverageCycleSec: null,
      cycleElapsedSec: 0,
      lastCompletedAt: null,
      incompleteConfigs: keys.length,
      providerDeferredConfigs: 0,
      stuckConfigs: [],
      stuckConfigCount: 0,
    });
  });

  it("keeps a config past the old 75-minute clock inside the pass window non-stalled", async () => {
    const cached = JSON.stringify({
      version: 1,
      updatedAt: 1_000,
      cycle: { startedAt: 1_000, lastCompletedAt: null, lastDurationSec: null },
      entries: {
        "config-0": {
          firstObservedAt: 1_000,
          lastAttemptedAt: null,
          lastDisposition: "extended-deferred-under-pressure",
          providerDeferredUntil: null,
        },
      },
    });
    const nowSec = 1_000 + 76 * 60;
    const db = mockD1([cachedRow("mint-burn:attempt-state:job", cached, 1_000)]);

    const result = await updateAttempt({ db, jobName: "job", enabledConfigKeys: ["config-0"], configBreakdown: [{ key: "config-0", attempted: false, skippedReason: "extended-deferred-under-pressure" }], nowSec });

    expect(result.summary.oldestAttemptAgeSec).toBe(76 * 60);
    expect(result.coverageCycle).toMatchObject({
      status: "cycle-in-progress",
      cycleElapsedSec: 76 * 60,
      incompleteConfigs: 1,
    });
  });

  it("stalls only once the running pass exceeds the expected window", async () => {
    const roster = ["config-0", "config-1"];
    let persisted: string | null = null;
    const run = async (nowSec: number) => {
      const db = mockD1(persisted ? [cachedRow(EXTENDED_CACHE_KEY, persisted, nowSec)] : []);
      const result = await updateAttempt({ db, enabledConfigKeys: roster, configBreakdown: breakdown(roster, new Set([roster[0]!])), nowSec });
      persisted = persistedState(db, EXTENDED_CACHE_KEY);
      return result;
    };

    const startedAt = 3_000_000;
    expect((await run(startedAt)).coverageCycle?.status).toBe("cycle-in-progress");

    const insideWindow = await run(startedAt + MINT_BURN_EXTENDED_COVERAGE_WINDOW_SEC);
    expect(insideWindow.coverageCycle?.status).toBe("cycle-in-progress");

    const stalled = await run(startedAt + MINT_BURN_EXTENDED_COVERAGE_WINDOW_SEC + 1);
    expect(stalled.coverageCycle).toMatchObject({
      status: "stalled",
      cycleElapsedSec: MINT_BURN_EXTENDED_COVERAGE_WINDOW_SEC + 1,
      expectedWindowSec: MINT_BURN_EXTENDED_COVERAGE_WINDOW_SEC,
      incompleteConfigs: 1,
    });
  });

  it("requires an actual attempt even while a provider deferral is active", async () => {
    const cached = JSON.stringify({
      version: 1,
      updatedAt: 1_000,
      cycle: { startedAt: 1_000, lastCompletedAt: null, lastDurationSec: null },
      entries: {
        "config-0": {
          firstObservedAt: 1_000,
          lastAttemptedAt: null,
          lastDisposition: "runtime-budget-exhausted",
          providerDeferredUntil: null,
        },
      },
    });
    const deferred = await updateAttempt({ db: mockD1([cachedRow("mint-burn:attempt-state:job", cached, 1_000)]), jobName: "job", enabledConfigKeys: ["config-0"], configBreakdown: [{ key: "config-0", attempted: false, skippedReason: "deferred" }], activeProviderDeferrals: new Map([["config-0", 7_000]]), nowSec: 6_000 });

    expect(deferred.summary.providerDeferredThisRun).toBe(1);
    expect(deferred.coverageCycle).toMatchObject({
      status: "cycle-in-progress",
      incompleteConfigs: 1,
      providerDeferredConfigs: 1,
      coverageCycleSec: null,
    });

    const attempted = await updateAttempt({ db: mockD1([cachedRow("mint-burn:attempt-state:job", cached, 1_000)]), jobName: "job", enabledConfigKeys: ["config-0"], configBreakdown: [{ key: "config-0", attempted: true, skippedReason: null }], nowSec: 6_100 });

    expect(attempted.coverageCycle).toMatchObject({
      status: "complete",
      incompleteConfigs: 0,
      coverageCycleSec: 5_100,
    });
  });

  it("never treats an absent attempt record as coverage", async () => {
    const cached = JSON.stringify({
      version: 1,
      updatedAt: 1_000,
      cycle: { startedAt: 1_000, lastCompletedAt: null, lastDurationSec: null },
      entries: {},
    });
    const db = mockD1([cachedRow("mint-burn:attempt-state:job", cached, 1_000)]);

    const result = await updateAttempt({ db, jobName: "job", enabledConfigKeys: ["config-0"], configBreakdown: [{ key: "config-0", attempted: false, skippedReason: "extended-deferred-under-pressure" }], nowSec: 6_000 });

    expect(result.coverageCycle).toMatchObject({
      status: "cycle-in-progress",
      incompleteConfigs: 1,
      coverageCycleSec: null,
    });
  });

  it("flags a config whose attempted scans never advance and clears it on progress", async () => {
    const roster = ["config-0", "config-1"];
    let persisted: string | null = null;
    const run = async (nowSec: number, advancedTo: number | null) => {
      const db = mockD1(persisted ? [cachedRow(EXTENDED_CACHE_KEY, persisted, nowSec)] : []);
      const result = await updateAttempt({ db, enabledConfigKeys: roster, configBreakdown: roster.map((key) => ({
          key,
          attempted: key === "config-0",
          skippedReason: key === "config-0" ? null : "extended-deferred-under-pressure",
          advancedTo: key === "config-0" ? advancedTo : null,
        })), nowSec });
      persisted = persistedState(db, EXTENDED_CACHE_KEY);
      return result;
    };

    const first = await run(1_000_000, null);
    expect(first.coverageCycle).toMatchObject({ stuckConfigs: [], stuckConfigCount: 0 });

    const second = await run(1_000_000 + INTERVAL_SEC, null);
    expect(second.coverageCycle).toMatchObject({
      stuckConfigs: ["config-0"],
      stuckConfigCount: 1,
    });

    const recovered = await run(1_000_000 + 2 * INTERVAL_SEC, 500);
    expect(recovered.coverageCycle).toMatchObject({ stuckConfigs: [], stuckConfigCount: 0 });
  });

  it("carries no cycle verdict for the critical lane", async () => {
    const db = mockD1();
    const result = await updateAttempt({ db, jobName: "sync-mint-burn", lane: "critical", enabledConfigKeys: keys, configBreakdown: breakdown(keys, new Set(keys)), nowSec: 4_000_000 });

    expect(result.coverageCycle).toBeNull();
    const persisted = JSON.parse(persistedState(db, "mint-burn:attempt-state:sync-mint-burn")) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("cycle");
  });
});
