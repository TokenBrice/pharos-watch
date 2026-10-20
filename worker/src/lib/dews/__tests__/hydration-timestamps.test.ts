import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { hydrateDexLiquidity, hydrateDexLiquidityHistory, hydrateLatestPsiScore, hydrateYieldRankingsCache } from "../source-state/hydration";
import { DEWS_PSI_FRESHNESS_BUDGET_SEC } from "../source-state/budgets";
import { computeDEWS } from "../../dews";
import { makeDewsInput } from "../../__tests__/dews.test-support";
import { makeDexLiquidityRow } from "../../../test-helpers/__shared/fixtures";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { loadDewsSourceState } from "../source-state";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { resolveCronTimeoutBudget } from "../../cron-timeouts";

const RUN_AT = 1_800_000_000;
const YIELD_BUDGET_SEC = CRON_INTERVALS["sync-yield-data"]
  + resolveCronTimeoutBudget("sync-yield-data").configuredTimeoutMs / 1000;
afterEach(() => vi.useRealTimers());

describe("DEWS hydration timestamp admission", () => {
  it.each([
    ["valid", RUN_AT, 0, null],
    ["inclusive budget", RUN_AT - YIELD_BUDGET_SEC, 0, null],
    ["stale", RUN_AT - YIELD_BUDGET_SEC - 1, 0, "exceeds"],
    ["run/read overlap", RUN_AT + 120, 120, null],
    ["inclusive read skew", RUN_AT + 180, 120, null],
    ["beyond read skew", RUN_AT + 181, 120, "future-timestamp"],
    ["one day future", RUN_AT + 86400, 0, "future-timestamp"],
    ["invalid", Number.POSITIVE_INFINITY, 0, "invalid-timestamp"],
    ["missing", null, 0, "missing-timestamp"],
  ] as const)("holds inadmissible %s yield clocks without discarding readable diagnostics", async (_label, updatedAt, readOffset, reason) => {
    vi.useFakeTimers();
    vi.setSystemTime((RUN_AT + readOffset) * 1000);
    const registerSourceFailure = vi.fn();
    const hydrated = await hydrateYieldRankingsCache({
      db: mockD1([{ match: "pharos:dews:yield-rankings-cache", rows: [], first: {
        updated_at: updatedAt,
        value: JSON.stringify({ rankings: [{
          id: "usdt-tether", sourceRisk: { rewardShare: 0.9 },
          rankChangeAttribution: { rankDelta: -5, primaryDriver: "source-risk" },
        }] }),
      } }]),
      nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput: vi.fn(),
    });
    expect(hydrated.yieldSourceRisk.get("usdt-tether")?.rewardShare).toBe(0.9);
    expect(hydrated.yieldRankChangeAttribution.get("usdt-tether")).toMatchObject({
      rankDelta: -5, primaryDriver: "source-risk",
    });
    if (reason == null) {
      expect(registerSourceFailure).not.toHaveBeenCalled();
    } else {
      expect(registerSourceFailure).toHaveBeenCalledTimes(1);
      expect(registerSourceFailure).toHaveBeenCalledWith("yield-rankings-freshness", expect.stringContaining(reason));
    }
  });

  it.each([
    ["fresh", RUN_AT, null],
    ["boundary", RUN_AT - DEWS_PSI_FRESHNESS_BUDGET_SEC, null],
    ["stale", RUN_AT - DEWS_PSI_FRESHNESS_BUDGET_SEC - 1, "stale-sample"],
    ["future", RUN_AT + 61, "future-timestamp"],
    ["invalid", Number.POSITIVE_INFINITY, "invalid-timestamp"],
    ["missing", null, "missing-sample"],
  ] as const)("admits PSI %s with the original sample clock and budget", async (_label, storedAt, reason) => {
    const registerSourceFailure = vi.fn();
    const hydrated = await hydrateLatestPsiScore({
      db: mockD1([{ match: "stability_index_samples", rows: [], first: storedAt == null ? null : { score: 0, stored_at: storedAt } }]),
      nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput: vi.fn(),
    });
    expect(hydrated.latestPsiScore).toBe(reason == null ? 0 : null);
    expect(hydrated.dependencyDiagnostics).toMatchObject({
      updatedAt: storedAt != null && Number.isFinite(storedAt) ? storedAt : null, freshnessBudgetSec: DEWS_PSI_FRESHNESS_BUDGET_SEC, reason,
    });
    expect(registerSourceFailure).not.toHaveBeenCalled();
    const scored = computeDEWS(makeDewsInput({ dexPriceUsd: 0.99, psiScore: hydrated.latestPsiScore }));
    expect(scored?.amplifiers.psi).toBe(reason == null ? 1.3 : 1);
  });
  it("admits an overlapping publication but excludes clocks beyond read-time skew", async () => {
    vi.useFakeTimers();
    vi.setSystemTime((RUN_AT + 120) * 1000);
    const row = (stablecoin_id: string, updated_at: number) => ({
      stablecoin_id, updated_at, weighted_balance_ratio: 0.9, avg_pool_stress: 0,
      top_pools_json: "[]", liquidity_score: 80, total_tvl_usd: 1_000_000,
    });
    const db = mockD1([
      { match: "SELECT stablecoin_id, weighted_balance_ratio", rows: [
        row("overlap", RUN_AT + 120), row("allowed", RUN_AT + 180), row("future", RUN_AT + 181),
      ] },
      { match: "FROM dex_liquidity_publication_generations", rows: [], first: null },
    ]);
    const hydrated = await hydrateDexLiquidity({
      db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
    });
    expect([...hydrated.dexLiqMap.keys()]).toEqual(["overlap", "allowed"]);
    expect([...hydrated.dexLiqStaleIds]).toEqual(["future"]);
  });

  it.each([
    [0.5, 100, 36 * 3600, true],
    [0.499, 100, 36 * 3600, false],
    [null, 100, 36 * 3600, false],
    [0.5, 0, 36 * 3600, false],
    [0.5, 100, 36 * 3600 + 1, false],
  ])("admits weekly history confidence=%s TVL=%s distance=%s", async (confidence, tvl, distance, admitted) => {
    const target = RUN_AT - 7 * 86400;
    const db = mockD1([{ match: "FROM dex_liquidity_history", rows: [
      { stablecoin_id: "test", snapshot_date: target - distance, liquidity_score: 73, total_tvl_usd: tvl, coverage_confidence: confidence, methodology_version: null },
      { stablecoin_id: "test", snapshot_date: target, liquidity_score: 99, total_tvl_usd: 1000, coverage_confidence: 0.49, methodology_version: null },
    ] }]);
    const hydrated = await hydrateDexLiquidityHistory({ db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() },
      new Map([["test", makeDexLiquidityRow({ stablecoin_id: "test" })]]));
    expect(hydrated.liqHist7dMap.get("test")).toEqual(admitted ? { score: 73, tvl: 100, date: target - distance } : undefined);
    expect(db.getHistory()[0].binds).toEqual([RUN_AT - 8.5 * 86400]);
    expect(db.getHistory()[0].sql).toContain("coverage_confidence");
  });

  it("fetches the older daily bucket at the inclusive live 8.5-day bound", async () => {
    const now = 20000 * 86400 + 12 * 3600;
    const date = (20000 - 8) * 86400;
    const db = mockD1([{ match: "FROM dex_liquidity_history", rows: [
      { stablecoin_id: "daily", snapshot_date: date, liquidity_score: 80, total_tvl_usd: 100, coverage_confidence: 0.5, methodology_version: null },
    ] }]);
    const hydrated = await hydrateDexLiquidityHistory({ db, nowSec: now, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() },
      new Map([["daily", makeDexLiquidityRow({ stablecoin_id: "daily" })]]));
    expect(db.getHistory()[0].binds).toEqual([date]);
    expect(hydrated.liqHist7dMap.get("daily")).toEqual({ score: 80, tvl: 100, date });
  });

  it.each([
    ["6.95", "6.92", null],
    ["6.95", "6.94", 100],
    ["6.92", "6.92", 100],
    ["3.2", "3.1", 100],
  ] as const)("hydrates history against the stored current version %s, not runtime (%s)", async (current, historical, tvl) => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_AT * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    const date = RUN_AT - 7 * 86400;
    try {
      sqlite.prepare("INSERT INTO dex_liquidity (stablecoin_id, symbol, total_tvl_usd, liquidity_score, updated_at, methodology_version) VALUES ('usdt-tether', 'USDT', 200, 80, ?, ?)")
        .run(RUN_AT, current);
      sqlite.prepare("INSERT INTO dex_liquidity_history (stablecoin_id, total_tvl_usd, liquidity_score, snapshot_date, coverage_class, coverage_confidence, methodology_version) VALUES ('usdt-tether', 100, 73, ?, 'primary', 0.9, ?)")
        .run(date, historical);
      const hydrated = await loadDewsSourceState({
        db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
      });
      expect(hydrated.dexLiqMap.get("usdt-tether")?.methodology_version).toBe(current);
      expect(hydrated.liqHist7dMap.get("usdt-tether")).toEqual({ score: 73, tvl, date });
    } finally {
      sqlite.close();
    }
  });

  it.each(["legacy", "absent-current", "omitted-current", "omitted-history"] as const)(
    "retains independent historical scores while distinguishing %s identity", async (identity) => {
      const current = { ...makeDexLiquidityRow(), methodology_version: null as string | null };
      const history = { stablecoin_id: "usdt-tether", total_tvl_usd: 100, liquidity_score: 73,
        snapshot_date: RUN_AT - 7 * 86400, coverage_class: "primary", coverage_confidence: 0.9,
        methodology_version: null };
      if (identity === "omitted-current") Reflect.deleteProperty(current, "methodology_version");
      if (identity === "omitted-history") Reflect.deleteProperty(history, "methodology_version");
      const hydrated = await hydrateDexLiquidityHistory({
        db: mockD1([{ match: "FROM dex_liquidity_history", rows: [history] }]),
        nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
      }, identity === "absent-current" ? new Map() : new Map([["usdt-tether", current]]));
      expect(hydrated.liqHist7dMap.get("usdt-tether")).toEqual({
        score: 73, tvl: identity === "legacy" ? 100 : null, date: history.snapshot_date,
      });
    },
  );
});
