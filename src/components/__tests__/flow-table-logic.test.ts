import { describe, expect, it } from "vitest";
import {
  getPressureScore,
  getPressureState,
  getCoverageBadge,
  compareFlowRows,
} from "@/components/flow-table-logic";
import type { MintBurnCoinFlow } from "@shared/types";
import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import type { FlowTableSortKey } from "@/components/flow-table-logic";
import { makeInactiveMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";

function makeFlow(overrides: Partial<MintBurnCoinFlow> = {}): MintBurnCoinFlow {
  return makeInactiveMintBurnFlowCoin({ stablecoinId: "usdc", pressureShiftState: "stable", ...overrides });
}

const sort = (key: FlowTableSortKey, direction: "asc" | "desc" = "desc"): TableSortState<FlowTableSortKey> => ({
  key,
  direction,
});

describe("getCoverageBadge", () => {
  it("returns null for undefined coverage", () => {
    const coin = makeFlow({ coverage: undefined });
    expect(getCoverageBadge(coin)).toBeNull();
  });

  it("returns partial-history badge", () => {
    const coin = makeFlow({ coverage: { status: "partial-history" } as MintBurnCoinFlow["coverage"] });
    const badge = getCoverageBadge(coin);
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("Partial history");
  });

  it("returns lagging badge", () => {
    const coin = makeFlow({ coverage: { status: "lagging" } as MintBurnCoinFlow["coverage"] });
    const badge = getCoverageBadge(coin);
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("Lagging");
  });

  it("returns bootstrapping badge", () => {
    const coin = makeFlow({ coverage: { status: "bootstrapping" } as MintBurnCoinFlow["coverage"] });
    const badge = getCoverageBadge(coin);
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("Bootstrapping");
  });

  it("returns unknown badge", () => {
    const coin = makeFlow({ coverage: { status: "unknown" } as MintBurnCoinFlow["coverage"] });
    const badge = getCoverageBadge(coin);
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("Unknown");
  });

  it("returns disabled badge", () => {
    const coin = makeFlow({ coverage: { status: "disabled" } as MintBurnCoinFlow["coverage"] });
    const badge = getCoverageBadge(coin);
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("Disabled");
  });
});

describe("compareFlowRows — numeric sort keys", () => {
  it("sorts net24h by signed value so a burn never outranks a mint descending", () => {
    const bigBurn = makeFlow({ netFlow24hUsd: -10_000_000 });
    const smallMint = makeFlow({ netFlow24hUsd: 500_000 });
    const result = compareFlowRows(bigBurn, smallMint, sort("net24h", "desc"));
    expect(result).toBeGreaterThan(0); // the mint ranks first
  });

  it.each(["asc", "desc"] as const)("sorts null and partial-valuation nets last (%s), never as zero", (direction) => {
    const smallBurn = makeFlow({ netFlow24hUsd: -1 });
    const nullNet = makeFlow({ netFlow24hUsd: null });
    const partialNet = makeFlow({
      netFlow24hUsd: 5_000_000,
      valuation: {
        window24h: {
          completeness: "partial",
          mintCompleteness: "complete",
          burnCompleteness: "partial",
          unpricedMintEventCount: 0,
          unpricedBurnEventCount: 1,
        },
        baseline: "complete",
        netFlow7d: "complete",
        netFlow30d: "complete",
        netFlow90d: "complete",
      },
    });
    expect(compareFlowRows(nullNet, smallBurn, sort("net24h", direction))).toBeGreaterThan(0);
    expect(compareFlowRows(partialNet, smallBurn, sort("net24h", direction))).toBeGreaterThan(0);
  });

});

describe("compareFlowRows — pressure sort key", () => {
  it("sorts a partial-baseline pressure score last as unavailable", () => {
    const partialBaseline = makeFlow({
      pressureShiftScore: 90,
      valuation: {
        window24h: {
          completeness: "complete",
          mintCompleteness: "complete",
          burnCompleteness: "complete",
          unpricedMintEventCount: 0,
          unpricedBurnEventCount: 0,
        },
        baseline: "partial",
        netFlow7d: "complete",
        netFlow30d: "complete",
        netFlow90d: "complete",
      },
    });
    const scored = makeFlow({ pressureShiftScore: -20 });
    expect(getPressureScore(partialBaseline)).toBeNull();
    expect(getPressureState(partialBaseline)).toBe("nr");
    expect(compareFlowRows(partialBaseline, scored, sort("pressure", "desc"))).toBeGreaterThan(0);
  });
});
