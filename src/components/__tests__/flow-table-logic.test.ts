import { describe, expect, it } from "vitest";
import {
  getPressureScore,
  getPressureState,
  getCoverageBadge,
  compareFlowRows,
  PRESSURE_VALUE_CLASS,
} from "@/components/flow-table-logic";
import type { MintBurnCoinFlow } from "@shared/types";
import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import type { FlowTableSortKey } from "@/components/flow-table-logic";

function makeFlow(overrides: Partial<MintBurnCoinFlow> = {}): MintBurnCoinFlow {
  return {
    stablecoinId: "usdc",
    symbol: "USDC",
    flowIntensity: 0,
    pressureShiftScore: null,
    pressureShiftState: "stable",
    netFlowDirection24h: "inactive",
    has24hActivity: false,
    baselineDailyNetUsd: null,
    baselineDailyAbsUsd: null,
    baselineDataDays: null,
    netFlow24hUsd: 0,
    mintVolume24hUsd: 0,
    burnVolume24hUsd: 0,
    mintCount24h: 0,
    burnCount24h: 0,
    netFlow7dUsd: 0,
    netFlow30dUsd: 0,
    netFlow90dUsd: 0,
    largestEvent24h: null,
    ...overrides,
  } as MintBurnCoinFlow;
}

const sort = (key: FlowTableSortKey, direction: "asc" | "desc" = "desc"): TableSortState<FlowTableSortKey> => ({
  key,
  direction,
});

describe("getPressureScore", () => {
  it("prefers pressureShiftScore over flowIntensity", () => {
    const coin = makeFlow({ pressureShiftScore: 42, flowIntensity: 10 });
    expect(getPressureScore(coin)).toBe(42);
  });

  it("falls back to flowIntensity when pressureShiftScore is null", () => {
    const coin = makeFlow({ pressureShiftScore: null, flowIntensity: 15 });
    expect(getPressureScore(coin)).toBe(15);
  });

  it("returns null when both are null", () => {
    const coin = makeFlow({ pressureShiftScore: null, flowIntensity: null });
    expect(getPressureScore(coin)).toBeNull();
  });
});

describe("getPressureState", () => {
  it("returns pressureShiftState if present on coin", () => {
    const coin = makeFlow({ pressureShiftState: "improving", pressureShiftScore: 50 });
    expect(getPressureState(coin)).toBe("improving");
  });

  it("derives state from score when pressureShiftState is undefined", () => {
    const coin = makeFlow({ pressureShiftState: undefined, pressureShiftScore: 50 });
    expect(getPressureState(coin)).toBe("improving"); // score > 10 → improving
  });

  it("derives worsening when score < -10", () => {
    const coin = makeFlow({ pressureShiftState: undefined, pressureShiftScore: -50 });
    expect(getPressureState(coin)).toBe("worsening");
  });

  it("derives stable when score is within band", () => {
    const coin = makeFlow({ pressureShiftState: undefined, pressureShiftScore: 5 });
    expect(getPressureState(coin)).toBe("stable");
  });

  it("returns nr when no score available", () => {
    const coin = makeFlow({ pressureShiftState: undefined, pressureShiftScore: null, flowIntensity: null });
    expect(getPressureState(coin)).toBe("nr");
  });
});

describe("PRESSURE_VALUE_CLASS", () => {
  it("has entries for all pressure shift states", () => {
    const states = ["improving", "stable", "worsening", "nr"] as const;
    for (const state of states) {
      expect(PRESSURE_VALUE_CLASS[state]).toBeDefined();
      expect(typeof PRESSURE_VALUE_CLASS[state]).toBe("string");
    }
  });
});

describe("getCoverageBadge", () => {
  it("returns null for undefined coverage", () => {
    const coin = makeFlow({ coverage: undefined });
    expect(getCoverageBadge(coin)).toBeNull();
  });

  it("returns null for full coverage status", () => {
    const coin = makeFlow({ coverage: { status: "full" } as MintBurnCoinFlow["coverage"] });
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
  it("sorts net24h: larger absolute value ranks higher descending", () => {
    const large = makeFlow({ netFlow24hUsd: -10_000_000 });
    const small = makeFlow({ netFlow24hUsd: 500_000 });
    const result = compareFlowRows(large, small, sort("net24h", "desc"));
    // large |val| = 10M, small |val| = 0.5M
    // desc: smallVal - largeVal = 0.5M - 10M < 0 → large ranks first
    expect(result).toBeLessThan(0);
  });

  it("sorts mint24h descending", () => {
    const high = makeFlow({ mintVolume24hUsd: 8_000_000 });
    const low = makeFlow({ mintVolume24hUsd: 1_000_000 });
    const result = compareFlowRows(high, low, sort("mint24h", "desc"));
    expect(result).toBeLessThan(0); // high ranks first
  });

  it("sorts burn24h ascending", () => {
    const high = makeFlow({ burnVolume24hUsd: 8_000_000 });
    const low = makeFlow({ burnVolume24hUsd: 1_000_000 });
    const result = compareFlowRows(high, low, sort("burn24h", "asc"));
    // asc: aVal - bVal = 8M - 1M > 0 → low ranks first
    expect(result).toBeGreaterThan(0);
  });

  it("sorts net7d by abs value descending", () => {
    const a = makeFlow({ netFlow7dUsd: -20_000_000 });
    const b = makeFlow({ netFlow7dUsd: 5_000_000 });
    const result = compareFlowRows(a, b, sort("net7d", "desc"));
    expect(result).toBeLessThan(0); // |a| = 20M > |b| = 5M → a ranks first
  });

  it("sorts net30d by abs value", () => {
    const a = makeFlow({ netFlow30dUsd: 100_000_000 });
    const b = makeFlow({ netFlow30dUsd: -50_000_000 });
    const result = compareFlowRows(a, b, sort("net30d", "desc"));
    expect(result).toBeLessThan(0); // |a| > |b|
  });

  it("sorts net90d by abs value", () => {
    const a = makeFlow({ netFlow90dUsd: -300_000_000 });
    const b = makeFlow({ netFlow90dUsd: 200_000_000 });
    const result = compareFlowRows(a, b, sort("net90d", "desc"));
    expect(result).toBeLessThan(0); // |a| > |b|
  });

  it("sorts largest event by amountUsd", () => {
    const a = makeFlow({
      largestEvent24h: { direction: "mint", amountUsd: 5_000_000, txHash: "0x", timestamp: 0 },
    });
    const b = makeFlow({
      largestEvent24h: { direction: "burn", amountUsd: 1_000_000, txHash: "0x", timestamp: 0 },
    });
    const result = compareFlowRows(a, b, sort("largest", "desc"));
    expect(result).toBeLessThan(0); // a ranks first
  });

  it("treats missing largestEvent as 0 amountUsd", () => {
    const a = makeFlow({ largestEvent24h: null });
    const b = makeFlow({
      largestEvent24h: { direction: "mint", amountUsd: 1_000_000, txHash: "0x", timestamp: 0 },
    });
    const result = compareFlowRows(a, b, sort("largest", "desc"));
    expect(result).toBeGreaterThan(0); // b ranks first
  });
});

describe("compareFlowRows — pressure sort key", () => {
  it("sorts pressure descending with null pushing to end", () => {
    const hasScore = makeFlow({ pressureShiftScore: 50, flowIntensity: 50 });
    const noScore = makeFlow({ pressureShiftScore: null, flowIntensity: null });
    const result = compareFlowRows(hasScore, noScore, sort("pressure", "desc"));
    expect(result).toBeLessThan(0); // hasScore ranks first (non-null before null)
  });

  it("sorts pressure numerically descending", () => {
    const high = makeFlow({ pressureShiftScore: 80, flowIntensity: 80 });
    const low = makeFlow({ pressureShiftScore: 20, flowIntensity: 20 });
    const result = compareFlowRows(high, low, sort("pressure", "desc"));
    expect(result).toBeLessThan(0); // high ranks first
  });
});

describe("compareFlowRows — default fallback", () => {
  it("returns 0 for unknown sort key (no-op)", () => {
    const a = makeFlow({ netFlow24hUsd: 10_000_000 });
    const b = makeFlow({ netFlow24hUsd: 1_000_000 });
    // Cast to satisfy TS — simulates unknown key
    const result = compareFlowRows(a, b, { key: "unknown" as FlowTableSortKey, direction: "desc" });
    expect(result).toBe(0); // unknown key preserves original order
  });
});
