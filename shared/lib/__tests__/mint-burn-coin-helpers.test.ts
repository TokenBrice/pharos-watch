import { describe, expect, it } from "vitest";
import {
  aggregateCoinFlows24h,
  inferHas24hActivity,
  resolveCoinNetFlow,
  resolvePressureScore,
  resolvePressureState,
  resolveNetDirection,
  resolveBaselineDailyNetUsd,
} from "@shared/lib/mint-burn-coin-helpers";
import { emptyMintBurnClassificationTally, summarizeMintBurnClassification } from "@shared/lib/mint-burn-classification";
import { MINT_BURN_NET_SUBSET_MIN_WEIGHT_SHARE as floor, sumMintBurnSignedNets } from "@shared/lib/mint-burn-valuation-display";
import { MintBurnFlowsResponseSchema, type MintBurnCoinFlow } from "@shared/types/mint-burn";
import { makeInactiveMintBurnFlowCoin, makeMintBurnCoinValuation as valuation24h, makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";

const PARTIAL_MINT_SIDE = { completeness: "partial", mintCompleteness: "partial", unpricedMintEventCount: 2 } as const;

function stubCoin(overrides: Partial<MintBurnCoinFlow> = {}): MintBurnCoinFlow {
  return makeInactiveMintBurnFlowCoin({
    stablecoinId: "test", symbol: "TEST",
    has24hActivity: undefined, netFlowDirection24h: undefined, pressureShiftState: undefined,
    ...overrides,
  });
}

describe("inferHas24hActivity", () => {
  it("keeps classification uncertainty in totals and withholds every derived claim", () => {
    const complete = summarizeMintBurnClassification(emptyMintBurnClassificationTally());
    const unresolved = summarizeMintBurnClassification({ ...emptyMintBurnClassificationTally(), unresolvedBurnEventCount: 1 });
    const coin = stubCoin({
      has24hActivity: false, mintVolume24hUsd: 20000, netFlow24hUsd: 20000,
      pressureShiftScore: 100, netFlowDirection24h: "minting", baselineDailyNetUsd: 200,
      valuation: valuation24h(), classification: { window24h: unresolved, baseline: unresolved,
        netFlow7d: unresolved, netFlow30d: unresolved, netFlow90d: unresolved },
    });
    expect(inferHas24hActivity(coin)).toBe(true);
    for (const window of ["24h", "7d", "30d", "90d"] as const) {
      expect(resolveCoinNetFlow(coin, window)).toMatchObject({ valueUsd: null, note: expect.stringContaining("Classification unresolved") });
      expect(resolveCoinNetFlow(coin, window).bound).toBeUndefined();
    }
    expect(resolvePressureScore(coin)).toBeNull();
    expect(resolvePressureState(coin)).toBe("nr");
    expect(resolveNetDirection(coin)).toBeNull();
    expect(resolveBaselineDailyNetUsd(coin)).toBeNull();
    expect(aggregateCoinFlows24h([coin])).toMatchObject({
      burnVolumeUsd: 0, burnClassificationCompleteness: "partial", unresolvedBurnEventCount: 1,
      net: { valueUsd: null }, direction: null,
    });
    const unknown = { ...complete, completeness: "unknown", burnCompleteness: "unknown", unavailableReason: "classification-unknown" } as const;
    expect(inferHas24hActivity({ ...coin, classification: { ...coin.classification!, window24h: unknown } })).toBeNull();
    expect(resolveBaselineDailyNetUsd({ ...coin, classification: undefined, valuation: { ...valuation24h(), baseline: "unknown" } })).toBeNull();
  });
});

it.each([
  ["explicit activity", inferHas24hActivity, { has24hActivity: true }, true],
  ["explicit quiet", inferHas24hActivity, { has24hActivity: false }, false],
  ["explicit unknown", inferHas24hActivity, { has24hActivity: null }, null],
  ["unknown with subtotals", inferHas24hActivity, { has24hActivity: null, mintCount24h: 1, mintVolume24hUsd: 100 }, null],
  ["legacy volume activity", inferHas24hActivity, { mintVolume24hUsd: 100 }, true],
  ["legacy count activity", inferHas24hActivity, { burnCount24h: 1 }, true],
  ["legacy quiet", inferHas24hActivity, {}, false],
  ["published pressure", resolvePressureScore, { pressureShiftScore: 42 }, 42],
  ["unavailable pressure", resolvePressureScore, {}, null],
  ["published state", resolvePressureState, { pressureShiftState: "improving" }, "improving"],
  ["derived improving", resolvePressureState, { pressureShiftScore: 50 }, "improving"],
  ["derived worsening", resolvePressureState, { pressureShiftScore: -50 }, "worsening"],
  ["published direction", resolveNetDirection, { netFlowDirection24h: "minting" }, "minting"],
  ["derived minting", resolveNetDirection, { netFlow24hUsd: 1000, mintVolume24hUsd: 1000 }, "minting"],
  ["quiet direction", resolveNetDirection, {}, "inactive"],
] satisfies [string, (coin: MintBurnCoinFlow) => unknown, Partial<MintBurnCoinFlow>, unknown][])("resolves %s", (_name, resolve, overrides, expected) => {
  expect(resolve(stubCoin(overrides))).toBe(expected);
});

it.each([
  [-1000, "burning", null],
  [1000, "minting", "minting"],
  [0, "flat", null],
  [null, null, null],
] as const)("gates the partial-window direction for net %s", (netFlow24hUsd, netFlowDirection24h, expected) => {
  expect(resolveNetDirection(stubCoin({ has24hActivity: true, netFlow24hUsd, netFlowDirection24h,
    valuation: netFlow24hUsd === null ? undefined : valuation24h(PARTIAL_MINT_SIDE),
  }))).toBe(expected);
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
  const active100 = stubCoin({ has24hActivity: true, netFlow24hUsd: 100, valuation: valuation24h() });
  it.each([10, 11, null, -1, Infinity, NaN])("qualifies a labelled subset against withheld weight %s", (weight) => {
    for (const completeness of ["complete", "partial"] as const) {
      const coins = [
        stubCoin({ netFlow24hUsd: 100, gaugeWeightUsd: floor * 100 }),
        stubCoin({ netFlow24hUsd: null, gaugeWeightUsd: weight, valuation: valuation24h({ completeness }) }),
      ];
      const net = aggregateCoinFlows24h(coins).net;
      expect(net.valueUsd).toBeNull();
      expect(net.subtotal).toEqual(weight === 10 ? { valueUsd: 100, included: 1, total: 2, weightShare: 0.9, coverageUnknown: true } : undefined);
      expect(sumMintBurnSignedNets(coins.map((coin) => resolveCoinNetFlow(coin, "24h"))).subtotal).toBeUndefined();
    }
  });

  it("makes the summed net and direction unavailable when one component is partial", () => {
    const aggregate = aggregateCoinFlows24h([
      stubCoin({ ...active100, mintVolume24hUsd: 100 }),
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
      active100,
      stubCoin({ has24hActivity: true, netFlow24hUsd: null, netFlowDirection24h: null, valuation: valuation24h() }),
    ]);
    expect(aggregate.net.valueUsd).toBeNull();
    expect(aggregate.direction).toBeNull();
  });

  it("sums complete components", () => {
    const aggregate = aggregateCoinFlows24h([
      active100,
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
      stubCoin({ has24hActivity: true, netFlow24hUsd: -50, gaugeWeightUsd: 90, valuation: valuation24h() }),
      stubCoin({
        has24hActivity: true, netFlow24hUsd: null, netFlowDirection24h: "minting",
        gaugeWeightUsd: 10, mintVolume24hUsd: 300, burnVolume24hUsd: 100, valuation: valuation24h(PARTIAL_MINT_SIDE),
      }),
    ]);
    expect(aggregate.direction).toBe("minting");
    expect(aggregate.net.valueUsd).toBeNull();
    expect(aggregate.net.bound).toEqual({ kind: "lower", valueUsd: 150 });
    expect(aggregate.net.subtotal).toBeUndefined();
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

  it("publishes no complete zero, inactive direction or scan proof for an empty cohort", () => {
    const aggregate = aggregateCoinFlows24h([]);
    expect(aggregate.net).toMatchObject({ valueUsd: null, completeness: "unknown" });
    expect(aggregate.has24hActivity).toBeNull();
    expect(aggregate.direction).toBeNull();
    expect(aggregate.scanComplete).toBe(false);
    expect(aggregate.mintCompleteness).toBe("unknown");
    expect(aggregate.burnCompleteness).toBe("unknown");
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
