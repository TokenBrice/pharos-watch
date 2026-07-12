import { describe, expect, it } from "vitest";
import { compareLiquidityRows, type LiquidityRow, type LiquiditySortKey } from "@/components/liquidity-table";
import { sortTableRows, type TableSortState } from "@/hooks/use-sorted-table-rows";
import {
  derivePagination,
  reconcilePaginationStateOnTotalChange,
  type TablePaginationState,
} from "@/hooks/use-table-pagination";
import type { DexLiquidityData, StablecoinMeta } from "@shared/types";

const PAGE_SIZE = 25;

function makeRow(index: number, overrides: Partial<DexLiquidityData> = {}): LiquidityRow {
  return {
    meta: {
      id: `coin-${index}`,
      symbol: `C${index}`,
      name: `Coin ${index}`,
    } as StablecoinMeta,
    liq: {
      totalTvlUsd: 1_000_000 + index,
      totalVolume24hUsd: 100_000 + index,
      totalVolume7dUsd: 700_000 + index,
      tvlChange7d: index,
      poolCount: index,
      chainCount: index % 5,
      protocolTvl: {},
      sourceMix: { dl: { poolCount: index, tvlUsd: 1_000_000 + index } },
      liquidityScore: index,
      effectiveTvlUsd: index * 10,
      weightedBalanceRatio: index / 100,
      organicFraction: index / 100,
      durabilityScore: index,
      coverageClass: "primary",
      coverageConfidence: 1,
      balanceMeasuredTvlUsd: 1_000_000 + index,
      organicMeasuredTvlUsd: 1_000_000 + index,
      ...overrides,
    } as DexLiquidityData,
  };
}

function sortRows(rows: LiquidityRow[], sort: TableSortState<LiquiditySortKey>): LiquidityRow[] {
  return sortTableRows(rows, sort, compareLiquidityRows);
}

describe("compareLiquidityRows", () => {
  it("sorts by score in descending order", () => {
    const low = makeRow(1, { liquidityScore: 10 });
    const high = makeRow(2, { liquidityScore: 80 });

    const result = compareLiquidityRows(low, high, { key: "score", direction: "desc" });
    expect(result).toBeGreaterThan(0);
  });

  it("treats missing numeric fields as 0", () => {
    const missing = makeRow(1, { durabilityScore: null });
    const present = makeRow(2, { durabilityScore: 5 });

    const result = compareLiquidityRows(missing, present, {
      key: "durability",
      direction: "desc",
    });
    expect(result).toBeGreaterThan(0);
  });
});

describe("liquidity sorting and pagination flow", () => {
  it("keeps page reset after filter shrink then restore", () => {
    const allRows = Array.from({ length: 60 }, (_, index) => makeRow(index + 1));
    const sortedAll = sortRows(allRows, { key: "score", direction: "desc" });

    let pageState: TablePaginationState = { page: 2, totalRowsSnapshot: sortedAll.length };

    const beforeFilter = derivePagination(pageState, sortedAll.length, PAGE_SIZE, true);
    expect(beforeFilter.effectivePage).toBe(2);

    const filtered = sortedAll.filter((row) => row.liq.liquidityScore != null && row.liq.liquidityScore <= 8);
    pageState = reconcilePaginationStateOnTotalChange(pageState, filtered.length, true);
    const afterFilter = derivePagination(pageState, filtered.length, PAGE_SIZE, true);
    expect(afterFilter.effectivePage).toBe(0);

    pageState = reconcilePaginationStateOnTotalChange(pageState, sortedAll.length, true);
    const afterRestore = derivePagination(pageState, sortedAll.length, PAGE_SIZE, true);
    expect(afterRestore.effectivePage).toBe(0);
  });
});
