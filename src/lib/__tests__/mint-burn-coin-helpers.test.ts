import { describe, expect, it } from "vitest";
import {
  aggregateCoinFlows24h,
  inferHas24hActivity,
  resolveCoinNetFlow,
  resolvePressureScore,
  resolvePressureState,
  resolveNetDirection,
} from "@shared/lib/mint-burn-coin-helpers";
import type { MintBurnCoinFlow, MintBurnValuation } from "@shared/types";
import { MintBurnFlowsResponseSchema } from "@shared/types/mint-burn";
import { makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";

function valuation24h(overrides: Partial<MintBurnValuation> = {}): NonNullable<MintBurnCoinFlow["valuation"]> {
  return {
    window24h: {
      completeness: "complete",
      mintCompleteness: "complete",
      burnCompleteness: "complete",
      unpricedMintEventCount: 0,
      unpricedBurnEventCount: 0,
      ...overrides,
    },
    baseline: "complete",
    netFlow7d: "complete",
    netFlow30d: "complete",
    netFlow90d: "complete",
  };
}

const PARTIAL_MINT_SIDE = { completeness: "partial", mintCompleteness: "partial", unpricedMintEventCount: 2 } as const;

function stubCoin(overrides: Partial<MintBurnCoinFlow> = {}): MintBurnCoinFlow {
  return {
    stablecoinId: "test",
    symbol: "TEST",
    mintVolume24hUsd: 0,
    burnVolume24hUsd: 0,
    netFlow24hUsd: 0,
    mintCount24h: 0,
    burnCount24h: 0,
    netFlow7dUsd: 0,
    netFlow30dUsd: 0,
    netFlow90dUsd: 0,
    pressureShiftScore: null,
    ...overrides,
  } as MintBurnCoinFlow;
}

describe("inferHas24hActivity", () => {
  it("returns explicit has24hActivity when present", () => {
    expect(inferHas24hActivity(stubCoin({ has24hActivity: true }))).toBe(true);
    expect(inferHas24hActivity(stubCoin({ has24hActivity: false }))).toBe(false);
  });

  it("preserves an explicit unknown flag even with observed subtotals", () => {
    expect(inferHas24hActivity(stubCoin({ has24hActivity: null }))).toBeNull();
    expect(inferHas24hActivity(stubCoin({ has24hActivity: null, mintCount24h: 1, mintVolume24hUsd: 100 }))).toBeNull();
  });

  it("derives from volume fields when has24hActivity missing", () => {
    expect(inferHas24hActivity(stubCoin({ mintVolume24hUsd: 100 }))).toBe(true);
    expect(inferHas24hActivity(stubCoin({ burnCount24h: 1 }))).toBe(true);
    expect(inferHas24hActivity(stubCoin())).toBe(false);
  });
});

describe("resolvePressureScore", () => {
  it("returns the canonical pressure shift score", () => {
    expect(resolvePressureScore(stubCoin({ pressureShiftScore: 42 }))).toBe(42);
  });

  it("returns null when the score is unavailable", () => {
    expect(resolvePressureScore(stubCoin())).toBeNull();
  });
});

describe("resolvePressureState", () => {
  it("returns explicit state when present", () => {
    expect(resolvePressureState(stubCoin({ pressureShiftState: "improving" }))).toBe("improving");
  });

  it("derives from score when state missing", () => {
    expect(resolvePressureState(stubCoin({ pressureShiftScore: 50 }))).toBe("improving");
    expect(resolvePressureState(stubCoin({ pressureShiftScore: -50 }))).toBe("worsening");
  });
});

describe("resolveNetDirection", () => {
  it("returns explicit direction when present", () => {
    expect(resolveNetDirection(stubCoin({ netFlowDirection24h: "minting" }))).toBe("minting");
  });

  it("derives from net flow when direction missing", () => {
    expect(resolveNetDirection(stubCoin({ netFlow24hUsd: 1000, mintVolume24hUsd: 1000 }))).toBe("minting");
  });

  it("returns inactive when all zeros (no activity)", () => {
    expect(resolveNetDirection(stubCoin())).toBe("inactive");
  });

});

describe("resolveNetDirection — valuation completeness", () => {
  it("drops a burning direction that unpriced mints could overturn", () => {
    const coin = stubCoin({
      has24hActivity: true,
      netFlow24hUsd: -1000,
      netFlowDirection24h: "burning",
      valuation: valuation24h(PARTIAL_MINT_SIDE),
    });
    expect(resolveNetDirection(coin)).toBeNull();
  });

  it("keeps minting when only mints are unpriced, because they can only raise the net", () => {
    const coin = stubCoin({
      has24hActivity: true,
      netFlow24hUsd: 1000,
      netFlowDirection24h: "minting",
      valuation: valuation24h(PARTIAL_MINT_SIDE),
    });
    expect(resolveNetDirection(coin)).toBe("minting");
  });

  it("never reports flat for a partial window with zero known net", () => {
    const coin = stubCoin({
      has24hActivity: true,
      netFlow24hUsd: 0,
      netFlowDirection24h: "flat",
      valuation: valuation24h(PARTIAL_MINT_SIDE),
    });
    expect(resolveNetDirection(coin)).toBeNull();
  });

  it("keeps a null wire direction unavailable", () => {
    expect(resolveNetDirection(stubCoin({ has24hActivity: true, netFlow24hUsd: null, netFlowDirection24h: null }))).toBeNull();
  });
});

describe("resolveCoinNetFlow", () => {
  it("withholds a one-sided partial net but keeps its proven bound", () => {
    const net = resolveCoinNetFlow(stubCoin({
      netFlow24hUsd: null, mintVolume24hUsd: 30, burnVolume24hUsd: 25, valuation: valuation24h(PARTIAL_MINT_SIDE),
    }), "24h");
    expect(net.valueUsd).toBeNull();
    expect(net.bound).toEqual({ kind: "lower", valueUsd: 5 });
    expect(net.note).toBe("Lower bound: 2 mint / 0 burn events unpriced; unpriced mints can only raise the net");
  });

  it("bounds a burn-side partial net from above", () => {
    const net = resolveCoinNetFlow(stubCoin({
      netFlow24hUsd: null, mintVolume24hUsd: 10, burnVolume24hUsd: 25,
      valuation: valuation24h({ completeness: "partial", burnCompleteness: "partial", unpricedBurnEventCount: 1 }),
    }), "24h");
    expect(net.bound).toEqual({ kind: "upper", valueUsd: -15 });
  });

  it("withholds a net with no bound when both sides are partial", () => {
    const net = resolveCoinNetFlow(stubCoin({
      netFlow24hUsd: null, mintVolume24hUsd: 30, burnVolume24hUsd: 25,
      valuation: valuation24h({ ...PARTIAL_MINT_SIDE, burnCompleteness: "partial", unpricedBurnEventCount: 1 }),
    }), "24h");
    expect(net.valueUsd).toBeNull();
    expect(net.bound).toBeUndefined();
    expect(net.note).toBe("Partial valuation: 2 mint / 1 burn events unpriced; signed net unavailable");
  });

  it("renders a null net unavailable, never 0", () => {
    expect(resolveCoinNetFlow(stubCoin({ netFlow30dUsd: null, valuation: valuation24h() }), "30d").valueUsd).toBeNull();
  });

  it("keeps a legacy (no valuation) net visible as coverage unknown", () => {
    const net = resolveCoinNetFlow(stubCoin({ netFlow7dUsd: 42 }), "7d");
    expect(net).toMatchObject({ valueUsd: 42, completeness: "unknown" });
    expect(net.note).toMatch(/coverage unknown/i);
  });
});

describe("pressure gating", () => {
  it("withholds pressure when the 24h window is partial", () => {
    const coin = stubCoin({
      pressureShiftScore: -40,
      pressureShiftState: "worsening",
      valuation: valuation24h(PARTIAL_MINT_SIDE),
    });
    expect(resolvePressureScore(coin)).toBeNull();
    expect(resolvePressureState(coin)).toBe("nr");
  });
});

describe("aggregateCoinFlows24h", () => {
  it("makes the summed net and direction unavailable when one component is partial", () => {
    const aggregate = aggregateCoinFlows24h([
      stubCoin({ has24hActivity: true, netFlow24hUsd: 100, mintVolume24hUsd: 100, valuation: valuation24h() }),
      stubCoin({
        has24hActivity: true,
        netFlow24hUsd: -300,
        burnVolume24hUsd: 300,
        valuation: valuation24h(PARTIAL_MINT_SIDE),
      }),
    ]);
    expect(aggregate.net.valueUsd).toBeNull();
    expect(aggregate.direction).toBeNull();
    expect(aggregate.mintVolumeUsd).toBe(100);
    expect(aggregate.mintCompleteness).toBe("partial");
    expect(aggregate.unpricedMintEventCount).toBe(2);
  });

  it("makes the summed net unavailable when a component net is null", () => {
    const aggregate = aggregateCoinFlows24h([
      stubCoin({ has24hActivity: true, netFlow24hUsd: 100, valuation: valuation24h() }),
      stubCoin({ has24hActivity: true, netFlow24hUsd: null, netFlowDirection24h: null, valuation: valuation24h() }),
    ]);
    expect(aggregate.net.valueUsd).toBeNull();
    expect(aggregate.direction).toBeNull();
  });

  it("sums complete components", () => {
    const aggregate = aggregateCoinFlows24h([
      stubCoin({ has24hActivity: true, netFlow24hUsd: 100, valuation: valuation24h() }),
      stubCoin({ has24hActivity: true, netFlow24hUsd: -40, valuation: valuation24h() }),
    ]);
    expect(aggregate.net).toEqual({ valueUsd: 60, completeness: "complete", note: null });
    expect(aggregate.direction).toBe("minting");
  });

  it.each([100, -100, 0])("withholds unknown-valued direction while retaining the legacy net %s and coverage note", (netFlow24hUsd) => {
    const aggregate = aggregateCoinFlows24h([stubCoin({
      has24hActivity: true, netFlow24hUsd, netFlowDirection24h: null,
      valuation: valuation24h({ completeness: "unknown", mintCompleteness: "unknown", burnCompleteness: "unknown" }),
    })]);
    expect(aggregate.direction).toBeNull();
    expect(aggregate.net.valueUsd).toBe(netFlow24hUsd);
    expect(aggregate.net.completeness).toBe("unknown");
    expect(aggregate.net.note).toMatch(/coverage unknown/i);
  });

  it("proves the aggregate direction and bound from a partial coin's known subtotals", () => {
    const aggregate = aggregateCoinFlows24h([
      stubCoin({ has24hActivity: true, netFlow24hUsd: -50, valuation: valuation24h() }),
      stubCoin({
        has24hActivity: true, netFlow24hUsd: null, netFlowDirection24h: "minting",
        mintVolume24hUsd: 300, burnVolume24hUsd: 100, valuation: valuation24h(PARTIAL_MINT_SIDE),
      }),
    ]);
    expect(aggregate.direction).toBe("minting");
    expect(aggregate.net.valueUsd).toBeNull();
    expect(aggregate.net.bound).toEqual({ kind: "lower", valueUsd: 150 });
  });

  it("leaves the aggregate unbounded when components are bounded on opposite sides", () => {
    const aggregate = aggregateCoinFlows24h([
      stubCoin({ has24hActivity: true, netFlow24hUsd: null, mintVolume24hUsd: 300, valuation: valuation24h(PARTIAL_MINT_SIDE) }),
      stubCoin({
        has24hActivity: true, netFlow24hUsd: null, burnVolume24hUsd: 100,
        valuation: valuation24h({ completeness: "partial", burnCompleteness: "partial", unpricedBurnEventCount: 1 }),
      }),
    ]);
    expect(aggregate.direction).toBeNull();
    expect(aggregate.net.bound).toBeUndefined();
  });

  it("keeps the aggregate direction when missing valuation cannot overturn it", () => {
    const aggregate = aggregateCoinFlows24h([stubCoin({
      has24hActivity: true, netFlow24hUsd: 100, valuation: valuation24h(PARTIAL_MINT_SIDE),
    })]);
    expect(aggregate.direction).toBe("minting");
    expect(aggregate.net.valueUsd).toBeNull();
  });

  it.each([false, true])("does not infer quiet, direction or a net when a required window is unknown (observed=%s)", (observed) => {
    const unknown = stubCoin({ has24hActivity: null, netFlow24hUsd: null, netFlowDirection24h: null, valuation: valuation24h() });
    const other = stubCoin({ has24hActivity: observed, netFlow24hUsd: observed ? 100 : 0, valuation: valuation24h() });
    for (const coins of [[unknown, other], [other, unknown]]) {
      const aggregate = aggregateCoinFlows24h(coins);
      expect(aggregate.has24hActivity).toBe(observed ? true : null);
      expect(aggregate.direction).toBeNull();
      expect(aggregate.net.valueUsd).toBeNull();
      expect(aggregate.net.bound).toBeUndefined();
    }
  });

  it("keeps a proven quiet control distinct from unknown scan activity", () => {
    const aggregate = aggregateCoinFlows24h([stubCoin({ has24hActivity: false, valuation: valuation24h() })]);
    expect(aggregate.has24hActivity).toBe(false);
    expect(aggregate.direction).toBe("inactive");
    expect(aggregate.net.valueUsd).toBe(0);
  });
});

describe("nullable scan-window reader contract", () => {
  it("parses unknown activity and all four unavailable window nets without coercing them", () => {
    const coin = makeMintBurnFlowCoin({
      has24hActivity: null,
      netFlowDirection24h: null,
      pressureShiftScore: null,
      pressureShiftState: "nr",
      netFlow24hUsd: null,
      netFlow7dUsd: null,
      netFlow30dUsd: null,
      netFlow90dUsd: null,
    });
    expect(MintBurnFlowsResponseSchema.shape.coins.element.parse(coin)).toEqual(coin);
    for (const window of ["24h", "7d", "30d", "90d"] as const) {
      expect(resolveCoinNetFlow(coin, window).valueUsd).toBeNull();
    }
    expect(resolveNetDirection(coin)).toBeNull();
    expect(resolvePressureScore(coin)).toBeNull();
    expect(resolvePressureState(coin)).toBe("nr");
  });

  it("does not turn unknown scan coverage into a valuation-only bound or pressure reading", () => {
    const coin = stubCoin({
      has24hActivity: null,
      netFlow24hUsd: null,
      mintVolume24hUsd: 100,
      pressureShiftScore: 42,
      valuation: valuation24h(PARTIAL_MINT_SIDE),
    });
    const net = resolveCoinNetFlow(coin, "24h");
    expect(net.valueUsd).toBeNull();
    expect(net.bound).toBeUndefined();
    expect(resolvePressureScore(coin)).toBeNull();
    expect(resolvePressureState(coin)).toBe("nr");
    expect(aggregateCoinFlows24h([coin]).net.bound).toBeUndefined();
  });

  it("does not derive a valuation bound from observed activity in an incompletely scanned window", () => {
    const missing = { complete: false, unavailableReason: "scan-coverage-incomplete" } as const;
    const coin = makeMintBurnFlowCoin({
      has24hActivity: true, netFlow24hUsd: null, netFlow7dUsd: null, netFlow30dUsd: null, netFlow90dUsd: null,
      mintVolume24hUsd: 100, valuation: valuation24h(PARTIAL_MINT_SIDE),
      coverage: { startBlock: 1, lastSyncedBlock: 2, lagBlocks: 0, historyStartAt: null,
        has24hWindow: false, has30dWindow: false, has90dWindow: false, isPartial: true, status: "unknown",
        windows: { window24h: missing, window7d: missing, window30d: missing, window90d: missing } },
    });
    for (const window of ["24h", "7d", "30d", "90d"] as const) {
      expect(resolveCoinNetFlow(coin, window)).toMatchObject({ valueUsd: null });
      expect(resolveCoinNetFlow(coin, window).bound).toBeUndefined();
    }
    expect(inferHas24hActivity(coin)).toBe(true);
    expect(resolveNetDirection(coin)).toBeNull();
    expect(resolvePressureScore(coin)).toBeNull();
    expect(aggregateCoinFlows24h([coin])).toMatchObject({ has24hActivity: true, direction: null, net: { valueUsd: null } });
    expect(aggregateCoinFlows24h([coin]).net.bound).toBeUndefined();
  });
});
