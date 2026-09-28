import { describe, expect, it } from "vitest";
import {
  aggregateCoinFlows24h,
  inferHas24hActivity,
  resolveCoinNetFlow,
  resolvePressureScore,
  resolvePressureState,
  resolveNetDirection,
} from "../mint-burn-coin-helpers";
import type { MintBurnCoinFlow, MintBurnValuation } from "@shared/types";

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

  it("derives burning from negative net flow", () => {
    expect(resolveNetDirection(stubCoin({ netFlow24hUsd: -1000, burnVolume24hUsd: 1000 }))).toBe("burning");
  });

  it("returns inactive when all zeros (no activity)", () => {
    expect(resolveNetDirection(stubCoin())).toBe("inactive");
  });

  it("returns flat when net flow is zero but activity exists", () => {
    expect(resolveNetDirection(stubCoin({ netFlow24hUsd: 0, mintVolume24hUsd: 500, burnVolume24hUsd: 500 }))).toBe("flat");
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
  it("withholds a partial window net with the unpriced counts", () => {
    const net = resolveCoinNetFlow(stubCoin({ netFlow24hUsd: 5, valuation: valuation24h(PARTIAL_MINT_SIDE) }), "24h");
    expect(net.valueUsd).toBeNull();
    expect(net.note).toBe("Partial valuation: 2 mint / 0 burn events unpriced; signed net unavailable");
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
});
