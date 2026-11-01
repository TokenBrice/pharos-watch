import { describe, expect, it } from "vitest";

import {
  loadDexYieldWatchConditions,
  loadMeasuredExecutionChainWatch,
  loadYieldDataCoverageWatch,
} from "../operator-watch-dex-yield";

interface CacheRow {
  value: string;
  updated_at: number;
}

function fakeDb(options: {
  yieldRuns?: Record<string, unknown>[];
  measuredRuns?: Record<string, unknown>[];
  cache?: Record<string, CacheRow>;
  failQuery?: string;
}): { db: D1Database; cache: Map<string, CacheRow> } {
  const cache = new Map(Object.entries(options.cache ?? {}));
  const firstFor = async (sql: string, args: unknown[]) => {
    if (sql.includes("FROM cache WHERE key = ?")) {
      const row = cache.get(args[0] as string);
      return row ? { value: row.value, updated_at: row.updated_at } : null;
    }
    return null;
  };
  const allFor = async (sql: string) => {
    if (options.failQuery && sql.includes(options.failQuery)) throw new Error("d1 down");
    if (sql.includes("'sync-yield-data'")) return { results: options.yieldRuns ?? [] };
    if (sql.includes("'sync-cl-exit-depth'")) return { results: options.measuredRuns ?? [] };
    return { results: [] };
  };
  const runFor = async (sql: string, args: unknown[]) => {
    if (sql.startsWith("INSERT INTO cache")) {
      cache.set(args[0] as string, { value: args[1] as string, updated_at: args[2] as number });
    }
    return { meta: { changes: 1 } };
  };
  const db = {
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => ({
          first: () => firstFor(sql, args),
          all: () => allFor(sql),
          run: () => runFor(sql, args),
        }),
        first: () => firstFor(sql, []),
        all: () => allFor(sql),
        run: () => runFor(sql, []),
      };
    },
  } as unknown as D1Database;
  return { db, cache };
}

function yieldRow(counts: {
  rankings: number | null;
  tracked?: number | null;
  opportunity?: number | null;
  reasons?: string[];
}) {
  return {
    started_at: 1_700_000_000,
    published_ranking_count: counts.rankings,
    published_tracked_count: counts.tracked ?? 200,
    published_opportunity_count: counts.opportunity ?? 40,
    quality_reasons: counts.reasons ? JSON.stringify(counts.reasons) : null,
  };
}

describe("dex/yield operator watch", () => {
  it("activates yield coverage only after two consecutive generations below the pre-event baseline", async () => {
    const options = {
      yieldRuns: [yieldRow({ rankings: 86 }), yieldRow({ rankings: 100 })],
    };
    const { db } = fakeDb(options);
    const first = await loadYieldDataCoverageWatch(db, 1_700_000_000);
    expect(first.conditions.find((condition) => condition.id === "yield-data-coverage")).toMatchObject({
      active: false,
    });

    options.yieldRuns = [yieldRow({ rankings: 80 }), yieldRow({ rankings: 86 })];
    const second = await loadYieldDataCoverageWatch(db, 1_700_000_900);
    const coverage = second.conditions.find((condition) => condition.id === "yield-data-coverage");
    expect(coverage).toMatchObject({ active: true });
    expect(coverage?.label).toContain("rankings 80 vs 100");
    expect(coverage?.label).toContain("budget 90%");

    options.yieldRuns = [yieldRow({ rankings: 95 }), yieldRow({ rankings: 80 })];
    const recovered = await loadYieldDataCoverageWatch(db, 1_700_001_800);
    expect(recovered.conditions.find((condition) => condition.id === "yield-data-coverage")).toMatchObject({
      active: false,
    });
  });

  it("keeps a confirmed coverage loss active until the level recovers", async () => {
    const state = {
      version: 1,
      series: { rankings: { baseline: 100, active: true } },
    };
    const { db } = fakeDb({
      cache: {
        "operator-watch:yield-data-coverage:v1": { value: JSON.stringify(state), updated_at: 1_700_000_000 },
      },
      yieldRuns: [yieldRow({ rankings: 70 }), yieldRow({ rankings: 72 })],
    });
    const result = await loadYieldDataCoverageWatch(db, 1_700_000_900);
    expect(result.conditions.find((condition) => condition.id === "yield-data-coverage")).toMatchObject({
      active: true,
    });
  });

  it("reports unknown when a yield coverage count cannot be read", async () => {
    const { db } = fakeDb({
      yieldRuns: [yieldRow({ rankings: null }), yieldRow({ rankings: 100 })],
    });
    const result = await loadYieldDataCoverageWatch(db, 1_700_000_000);
    expect(result.conditions.find((condition) => condition.id === "yield-data-coverage")).toMatchObject({
      active: false,
      unknown: true,
    });
  });

  it("names a degraded supplemental family from the latest successful yield publication", async () => {
    const { db } = fakeDb({
      yieldRuns: [
        yieldRow({ rankings: 90, reasons: ["yield-supplemental:family-degraded:morpho:family-count-drop"] }),
        yieldRow({ rankings: 90 }),
      ],
    });
    const result = await loadYieldDataCoverageWatch(db, 1_700_000_000);
    const family = result.conditions.find((condition) => condition.id === "yield-supplemental-family-degraded");
    expect(family).toMatchObject({ active: true });
    expect(family?.label).toContain("morpho:family-count-drop");
  });

  it("reports unknown when the yield history read fails", async () => {
    const { db } = fakeDb({ failQuery: "'sync-yield-data'" });
    const result = await loadDexYieldWatchConditions(db, 1_700_000_000);
    expect(result.conditions.find((condition) => condition.id === "yield-data-coverage")?.unknown).toBe(true);
    expect(result.conditions.find((condition) => condition.id === "yield-supplemental-family-degraded")?.unknown)
      .toBe(true);
    // A sibling detector whose own read succeeded keeps its own evidence.
    expect(result.conditions.find((condition) => condition.id === "measured-execution-chain-coverage"))
      .toMatchObject({ active: false });
  });

  it("flags a chain with score-eligible targets and no measured quote across two generations", async () => {
    const chains = { base: { scoreEligibleTargets: 4, measured: 0, failed: 4, deferred: 0 } };
    const { db } = fakeDb({
      measuredRuns: [
        { started_at: 2, chains_json: JSON.stringify(chains) },
        { started_at: 1, chains_json: JSON.stringify(chains) },
      ],
    });
    const result = await loadMeasuredExecutionChainWatch(db);
    const condition = result.conditions[0];
    expect(condition).toMatchObject({ active: true });
    expect(condition.label).toContain("base 0/4");
  });

  it("does not flag a chain that measured in either generation", async () => {
    const { db } = fakeDb({
      measuredRuns: [
        { started_at: 2, chains_json: JSON.stringify({ base: { scoreEligibleTargets: 4, measured: 0, failed: 4, deferred: 0 } }) },
        { started_at: 1, chains_json: JSON.stringify({ base: { scoreEligibleTargets: 4, measured: 2, failed: 2, deferred: 0 } }) },
      ],
    });
    const result = await loadMeasuredExecutionChainWatch(db);
    expect(result.conditions[0]).toMatchObject({ active: false });
  });

  it("reports unknown when chain evidence is missing from a generation", async () => {
    const { db } = fakeDb({
      measuredRuns: [
        { started_at: 2, chains_json: null },
        { started_at: 1, chains_json: JSON.stringify({ base: { scoreEligibleTargets: 4, measured: 2, failed: 2, deferred: 0 } }) },
      ],
    });
    const result = await loadMeasuredExecutionChainWatch(db);
    expect(result.conditions[0]).toMatchObject({ active: false, unknown: true });
  });
});
