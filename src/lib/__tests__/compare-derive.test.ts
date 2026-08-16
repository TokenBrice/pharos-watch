import { describe, expect, it } from "vitest";
import { deriveComparisonCoins, deriveSupplySeries, deriveFlowSeries, deriveFlowCardData } from "@/lib/compare-derive";
import { COMPARE_COLORS } from "@/lib/compare-config";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import type { StablecoinData } from "@shared/types";
import type { StablecoinMeta } from "@shared/types/core";
import type { NetFlowDirection24h, PressureShiftState } from "@shared/lib/mint-burn-signals";

// ---------------------------------------------------------------------------
// Minimal fixture helpers
// ---------------------------------------------------------------------------

function makeAsset(id: string, symbol = id.toUpperCase()): StablecoinData {
  return makeStablecoin({
    id,
    name: `${symbol} Name`,
    symbol,
    circulating: { peggedUSD: 1_000_000 },
  });
}

function makeMeta(id: string, symbol = id.toUpperCase()): StablecoinMeta {
  return {
    id,
    name: `${symbol} Name`,
    symbol,
    flags: {
      pegCurrency: "USD",
      governance: "centralized",
      backing: "rwa-backed",
    },
  } as StablecoinMeta;
}

function makeCard(id: string, grade: ReturnType<typeof makeV9Card>["grade"]) {
  return makeV9Card({ id, grade, score: 75 });
}

function makeFlowCoin(
  stablecoinId: string,
  overrides: {
    netFlow24hUsd?: number;
    netFlow30dUsd?: number;
    pressureShiftScore?: number | null;
    netFlowDirection24h?: NetFlowDirection24h;
    pressureShiftState?: PressureShiftState;
  } = {},
) {
  return {
    stablecoinId,
    netFlow24hUsd: 1000,
    netFlow30dUsd: 30000,
    pressureShiftScore: null as number | null,
    netFlowDirection24h: "minting" as NetFlowDirection24h,
    pressureShiftState: "stable" as PressureShiftState,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveComparisonCoins
// ---------------------------------------------------------------------------

describe("deriveComparisonCoins", () => {
  it("returns empty array when assetMap is empty", () => {
    const result = deriveComparisonCoins({
      selectedIds: ["usdc"],
      assetMap: new Map(),
      metaMap: new Map([["usdc", makeMeta("usdc")]]),
      pegCoinMap: new Map(),
      dexData: undefined,
      cardMap: new Map(),
      flowCoinMap: new Map(),
    });
    expect(result).toEqual([]);
  });

  it("returns empty array when selectedIds is empty", () => {
    const assetMap = new Map([["usdc", makeAsset("usdc")]]);
    const result = deriveComparisonCoins({
      selectedIds: [],
      assetMap,
      metaMap: new Map([["usdc", makeMeta("usdc")]]),
      pegCoinMap: new Map(),
      dexData: undefined,
      cardMap: new Map(),
      flowCoinMap: new Map(),
    });
    expect(result).toEqual([]);
  });

  it("skips coins missing from assetMap", () => {
    const assetMap = new Map([["usdc", makeAsset("usdc")]]);
    const metaMap = new Map([
      ["usdc", makeMeta("usdc")],
      ["usdt", makeMeta("usdt")],
    ]);
    const result = deriveComparisonCoins({
      selectedIds: ["usdc", "usdt"],
      assetMap,
      metaMap,
      pegCoinMap: new Map(),
      dexData: undefined,
      cardMap: new Map(),
      flowCoinMap: new Map(),
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("usdc");
  });

  it("skips coins missing from metaMap", () => {
    const assetMap = new Map([
      ["usdc", makeAsset("usdc")],
      ["usdt", makeAsset("usdt")],
    ]);
    const metaMap = new Map([["usdc", makeMeta("usdc")]]);
    const result = deriveComparisonCoins({
      selectedIds: ["usdc", "usdt"],
      assetMap,
      metaMap,
      pegCoinMap: new Map(),
      dexData: undefined,
      cardMap: new Map(),
      flowCoinMap: new Map(),
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("usdc");
  });

  it("maps pegScore from pegCoinMap", () => {
    const assetMap = new Map([["usdc", makeAsset("usdc")]]);
    const metaMap = new Map([["usdc", makeMeta("usdc")]]);
    const pegCoinMap = new Map([["usdc", { id: "usdc", pegScore: 92 }]]);
    const result = deriveComparisonCoins({
      selectedIds: ["usdc"],
      assetMap,
      metaMap,
      pegCoinMap,
      dexData: undefined,
      cardMap: new Map(),
      flowCoinMap: new Map(),
    });
    expect(result[0].pegScore).toBe(92);
  });

  it("returns null pegScore when coin is not in pegCoinMap", () => {
    const assetMap = new Map([["usdc", makeAsset("usdc")]]);
    const metaMap = new Map([["usdc", makeMeta("usdc")]]);
    const result = deriveComparisonCoins({
      selectedIds: ["usdc"],
      assetMap,
      metaMap,
      pegCoinMap: new Map(),
      dexData: undefined,
      cardMap: new Map(),
      flowCoinMap: new Map(),
    });
    expect(result[0].pegScore).toBeNull();
  });

  it("maps liquidityScore from dexData", () => {
    const assetMap = new Map([["usdc", makeAsset("usdc")]]);
    const metaMap = new Map([["usdc", makeMeta("usdc")]]);
    const dexData = { usdc: { liquidityScore: 85 } };
    const result = deriveComparisonCoins({
      selectedIds: ["usdc"],
      assetMap,
      metaMap,
      pegCoinMap: new Map(),
      dexData,
      cardMap: new Map(),
      flowCoinMap: new Map(),
    });
    expect(result[0].liquidityScore).toBe(85);
  });

  it("maps safetyGrade from cardMap", () => {
    const assetMap = new Map([["usdc", makeAsset("usdc")]]);
    const metaMap = new Map([["usdc", makeMeta("usdc")]]);
    const cardMap = new Map([["usdc", makeCard("usdc", "A")]]);
    const result = deriveComparisonCoins({
      selectedIds: ["usdc"],
      assetMap,
      metaMap,
      pegCoinMap: new Map(),
      dexData: undefined,
      cardMap,
      flowCoinMap: new Map(),
    });
    expect(result[0].safetyGrade).toBe("A");
  });

  it("maps netFlow30d from flowCoinMap", () => {
    const assetMap = new Map([["usdc", makeAsset("usdc")]]);
    const metaMap = new Map([["usdc", makeMeta("usdc")]]);
    const flowCoinMap = new Map([["usdc", makeFlowCoin("usdc", { netFlow30dUsd: 500_000 })]]);
    const result = deriveComparisonCoins({
      selectedIds: ["usdc"],
      assetMap,
      metaMap,
      pegCoinMap: new Map(),
      dexData: undefined,
      cardMap: new Map(),
      flowCoinMap,
    });
    expect(result[0].netFlow30d).toBe(500_000);
  });

  it("preserves selectedIds order in output", () => {
    const assetMap = new Map([
      ["usdc", makeAsset("usdc")],
      ["usdt", makeAsset("usdt")],
      ["dai", makeAsset("dai")],
    ]);
    const metaMap = new Map([
      ["usdc", makeMeta("usdc")],
      ["usdt", makeMeta("usdt")],
      ["dai", makeMeta("dai")],
    ]);
    const result = deriveComparisonCoins({
      selectedIds: ["dai", "usdt", "usdc"],
      assetMap,
      metaMap,
      pegCoinMap: new Map(),
      dexData: undefined,
      cardMap: new Map(),
      flowCoinMap: new Map(),
    });
    expect(result.map((c) => c.id)).toEqual(["dai", "usdt", "usdc"]);
  });
});

// ---------------------------------------------------------------------------
// deriveSupplySeries
// ---------------------------------------------------------------------------

describe("deriveSupplySeries", () => {
  it("returns empty array when no histories provided", () => {
    const result = deriveSupplySeries({
      selectedIds: ["usdc", "usdt"],
      histories: [undefined, undefined],
      metaMap: new Map(),
    });
    expect(result).toEqual([]);
  });

  it("skips coins with empty history arrays", () => {
    const result = deriveSupplySeries({
      selectedIds: ["usdc"],
      histories: [[]],
      metaMap: new Map([["usdc", { name: "USD Coin" }]]),
    });
    expect(result).toEqual([]);
  });

  it("builds series from history points with correct timestamp conversion", () => {
    const history = [
      { date: 1700000000, circulatingUsd: 1_000_000, price: 1.0 },
      { date: 1700086400, circulatingUsd: 1_050_000, price: 1.0 },
    ];
    const result = deriveSupplySeries({
      selectedIds: ["usdc"],
      histories: [history],
      metaMap: new Map([["usdc", { name: "USD Coin" }]]),
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("usdc");
    expect(result[0].label).toBe("USD Coin");
    expect(result[0].data[0].ts).toBe(1700000000 * 1000);
    expect(result[0].data[0].value).toBe(1_000_000);
    expect(result[0].data[1].ts).toBe(1700086400 * 1000);
  });

  it("uses coin id as label fallback when metaMap has no entry", () => {
    const history = [{ date: 1700000000, circulatingUsd: 500_000, price: null }];
    const result = deriveSupplySeries({
      selectedIds: ["unknown-coin"],
      histories: [history],
      metaMap: new Map(),
    });
    expect(result[0].label).toBe("unknown-coin");
  });

  it("assigns colors by index cycling through COMPARE_COLORS", () => {
    const history = [{ date: 1700000000, circulatingUsd: 1_000_000, price: 1.0 }];
    const ids = ["a", "b", "c", "d", "e", "f"]; // 6 items, 5 colors → wraps
    const result = deriveSupplySeries({
      selectedIds: ids,
      histories: ids.map(() => history),
      metaMap: new Map(ids.map((id) => [id, { name: id }])),
    });
    expect(result[0].color).toBe(COMPARE_COLORS[0]);
    expect(result[4].color).toBe(COMPARE_COLORS[4]);
    expect(result[5].color).toBe(COMPARE_COLORS[0]); // wraps around
  });
});

// ---------------------------------------------------------------------------
// deriveFlowSeries
// ---------------------------------------------------------------------------

describe("deriveFlowSeries", () => {
  it("returns empty array when all flow details are undefined", () => {
    const result = deriveFlowSeries({
      selectedIds: ["usdc"],
      flowDetails: [undefined],
      metaMap: new Map(),
    });
    expect(result).toEqual([]);
  });

  it("skips entries with empty hourly arrays", () => {
    const detail = {
      stablecoinId: "usdc",
      symbol: "USDC",
      mintVolumeUsd: 0,
      burnVolumeUsd: 0,
      netFlowUsd: 0,
      mintCount: 0,
      burnCount: 0,
      chains: [],
      hourly: [],
      updatedAt: 0,
    };
    const result = deriveFlowSeries({
      selectedIds: ["usdc"],
      flowDetails: [detail],
      metaMap: new Map([["usdc", { symbol: "USDC" }]]),
    });
    expect(result).toEqual([]);
  });

  it("builds flow series from hourly buckets with correct timestamp conversion", () => {
    const detail = {
      stablecoinId: "usdc",
      symbol: "USDC",
      mintVolumeUsd: 100,
      burnVolumeUsd: 50,
      netFlowUsd: 50,
      mintCount: 1,
      burnCount: 1,
      chains: [],
      hourly: [
        { hourTs: 1700000000, netFlowUsd: 50_000, mintVolumeUsd: 100_000, burnVolumeUsd: 50_000 },
        { hourTs: 1700003600, netFlowUsd: -20_000, mintVolumeUsd: 0, burnVolumeUsd: 20_000 },
      ],
      updatedAt: 1700010000,
    };
    const result = deriveFlowSeries({
      selectedIds: ["usdc"],
      flowDetails: [detail],
      metaMap: new Map([["usdc", { symbol: "USDC" }]]),
    });
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("USDC");
    expect(result[0].data[0].ts).toBe(1700000000 * 1000);
    expect(result[0].data[0].netFlowUsd).toBe(50_000);
    expect(result[0].data[1].netFlowUsd).toBe(-20_000);
  });

  it("uses coin id as symbol fallback", () => {
    const detail = {
      stablecoinId: "usdc",
      symbol: "USDC",
      mintVolumeUsd: 0,
      burnVolumeUsd: 0,
      netFlowUsd: 0,
      mintCount: 0,
      burnCount: 0,
      chains: [],
      hourly: [{ hourTs: 1700000000, netFlowUsd: 0, mintVolumeUsd: 0, burnVolumeUsd: 0 }],
      updatedAt: 0,
    };
    const result = deriveFlowSeries({
      selectedIds: ["usdc"],
      flowDetails: [detail],
      metaMap: new Map(), // no meta
    });
    expect(result[0].label).toBe("usdc");
  });
});

// ---------------------------------------------------------------------------
// deriveFlowCardData
// ---------------------------------------------------------------------------

describe("deriveFlowCardData", () => {
  it("returns empty array when flowCoinMap is empty", () => {
    const result = deriveFlowCardData({
      selectedIds: ["usdc"],
      flowCoinMap: new Map(),
      metaMap: new Map([["usdc", { symbol: "USDC" }]]),
    });
    expect(result).toEqual([]);
  });

  it("skips selected ids not present in flowCoinMap", () => {
    const flowCoinMap = new Map([["usdc", makeFlowCoin("usdc")]]);
    const result = deriveFlowCardData({
      selectedIds: ["usdc", "usdt"],
      flowCoinMap,
      metaMap: new Map([
        ["usdc", { symbol: "USDC" }],
        ["usdt", { symbol: "USDT" }],
      ]),
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("usdc");
  });

  it("maps flow coin fields correctly", () => {
    const coin = makeFlowCoin("usdc", {
      netFlow24hUsd: 500_000,
      pressureShiftScore: 0.75,
      netFlowDirection24h: "minting",
      pressureShiftState: "worsening",
    });
    const flowCoinMap = new Map([["usdc", coin]]);
    const result = deriveFlowCardData({
      selectedIds: ["usdc"],
      flowCoinMap,
      metaMap: new Map([["usdc", { symbol: "USDC" }]]),
    });
    expect(result[0].netFlow24hUsd).toBe(500_000);
    expect(result[0].pressureShiftScore).toBe(0.75);
    expect(result[0].netFlowDirection24h).toBe("minting");
    expect(result[0].pressureShiftState).toBe("worsening");
  });

  it("defaults netFlowDirection24h to 'inactive' when null", () => {
    const coin = {
      stablecoinId: "usdc",
      netFlow24hUsd: 1000,
      netFlow30dUsd: 30000,
      pressureShiftScore: null as number | null,
      netFlowDirection24h: null as NetFlowDirection24h | null,
      pressureShiftState: "stable" as PressureShiftState,
    };
    const flowCoinMap = new Map([["usdc", coin]]);
    const result = deriveFlowCardData({
      selectedIds: ["usdc"],
      flowCoinMap,
      metaMap: new Map([["usdc", { symbol: "USDC" }]]),
    });
    expect(result[0].netFlowDirection24h).toBe("inactive");
  });

  it("defaults pressureShiftState to 'nr' when null", () => {
    const coin = {
      stablecoinId: "usdc",
      netFlow24hUsd: 1000,
      netFlow30dUsd: 30000,
      pressureShiftScore: null as number | null,
      netFlowDirection24h: "minting" as NetFlowDirection24h,
      pressureShiftState: null as PressureShiftState | null,
    };
    const flowCoinMap = new Map([["usdc", coin]]);
    const result = deriveFlowCardData({
      selectedIds: ["usdc"],
      flowCoinMap,
      metaMap: new Map([["usdc", { symbol: "USDC" }]]),
    });
    expect(result[0].pressureShiftState).toBe("nr");
  });

  it("uses coin id as symbol fallback when meta is missing", () => {
    const flowCoinMap = new Map([["usdc", makeFlowCoin("usdc")]]);
    const result = deriveFlowCardData({
      selectedIds: ["usdc"],
      flowCoinMap,
      metaMap: new Map(),
    });
    expect(result[0].symbol).toBe("usdc");
  });

  it("assigns colors by index cycling through COMPARE_COLORS", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const flowCoinMap = new Map(ids.map((id) => [id, makeFlowCoin(id)]));
    const metaMap = new Map(ids.map((id) => [id, { symbol: id.toUpperCase() }]));
    const result = deriveFlowCardData({ selectedIds: ids, flowCoinMap, metaMap });
    expect(result[0].color).toBe(COMPARE_COLORS[0]);
    expect(result[5].color).toBe(COMPARE_COLORS[0]); // wraps
  });
});
