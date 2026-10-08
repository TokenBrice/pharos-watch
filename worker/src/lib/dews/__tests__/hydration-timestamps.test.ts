import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { hydrateDexLiquidity, hydrateDexLiquidityHistory } from "../source-state/hydration";

const RUN_AT = 1_800_000_000;
afterEach(() => vi.useRealTimers());

describe("DEWS hydration timestamp admission", () => {
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
    ], { requireMatch: true });
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
      { stablecoin_id: "test", snapshot_date: target - distance, liquidity_score: 73, total_tvl_usd: tvl, coverage_confidence: confidence },
      { stablecoin_id: "test", snapshot_date: target, liquidity_score: 99, total_tvl_usd: 1000, coverage_confidence: 0.49 },
    ] }], { requireMatch: true });
    const hydrated = await hydrateDexLiquidityHistory({ db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() });
    expect(hydrated.liqHist7dMap.get("test")).toEqual(admitted ? { score: 73, tvl: 100, date: target - distance } : undefined);
    expect(db.getHistory()[0].binds).toEqual([RUN_AT - 8.5 * 86400]);
    expect(db.getHistory()[0].sql).toContain("coverage_confidence");
  });

  it("fetches the older daily bucket at the inclusive live 8.5-day bound", async () => {
    const now = 20000 * 86400 + 12 * 3600;
    const date = (20000 - 8) * 86400;
    const db = mockD1([{ match: "FROM dex_liquidity_history", rows: [
      { stablecoin_id: "daily", snapshot_date: date, liquidity_score: 80, total_tvl_usd: 100, coverage_confidence: 0.5 },
    ] }]);
    const hydrated = await hydrateDexLiquidityHistory({ db, nowSec: now, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() });
    expect(db.getHistory()[0].binds).toEqual([date]);
    expect(hydrated.liqHist7dMap.get("daily")).toEqual({ score: 80, tvl: 100, date });
  });
});
