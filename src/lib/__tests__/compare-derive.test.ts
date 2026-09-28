import { describe, expect, it } from "vitest";
import {
  buildCompareRadarCohortBaseline,
  deriveComparisonCoins,
  deriveSupplySeries,
  deriveFlowSeries,
  deriveFlowCardData,
  type CompareRadarCardEntry,
} from "@/lib/compare-derive";
import { COMPARE_COLORS } from "@/lib/compare-config";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import type { MintBurnCoinFlow, MintBurnPerCoinResponse, StablecoinData } from "@shared/types";
import type { StablecoinMeta } from "@shared/types/core";
import type { PressureShiftState } from "@shared/lib/mint-burn-signals";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";

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
  overrides: Partial<MintBurnCoinFlow> = {},
): MintBurnCoinFlow {
  return {
    stablecoinId,
    symbol: stablecoinId.toUpperCase(),
    pressureShiftScore: null,
    pressureShiftState: "stable",
    netFlowDirection24h: "minting",
    has24hActivity: false,
    baselineDailyNetUsd: null,
    baselineDailyAbsUsd: null,
    baselineDataDays: null,
    netFlow24hUsd: 1000,
    mintVolume24hUsd: 0,
    burnVolume24hUsd: 0,
    mintCount24h: 0,
    burnCount24h: 0,
    netFlow7dUsd: 7000,
    netFlow30dUsd: 30000,
    netFlow90dUsd: 90000,
    largestEvent24h: null,
    ...overrides,
  };
}

type ComparisonInput = Parameters<typeof deriveComparisonCoins>[0];

function comparisonInput(overrides: Partial<ComparisonInput> = {}): ComparisonInput {
  return {
    selectedIds: [],
    assetMap: new Map(),
    metaMap: new Map(),
    pegCoinMap: new Map(),
    dexData: undefined,
    cardMap: new Map(),
    flowCoinMap: new Map(),
    ...overrides,
  };
}

function assetMapFor(...ids: string[]) {
  return new Map(ids.map((id) => [id, makeAsset(id)]));
}

function metaMapFor(...ids: string[]) {
  return new Map(ids.map((id) => [id, makeMeta(id)]));
}

function makeFlowDetail(overrides: Partial<MintBurnPerCoinResponse> = {}): MintBurnPerCoinResponse {
  return {
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
    ...overrides,
  };
}

function makeSelectedRadarCards(
  response: ReturnType<typeof makeReportCardsV9Response>,
  selectedIds: string[],
): CompareRadarCardEntry[] {
  return selectedIds.map((id, index) => ({
    card: response.cards.find((card) => card.id === id)!,
    identity: response.safetyScoreIdentity,
    color: COMPARE_COLORS[index],
    symbol: id,
  }));
}

// ---------------------------------------------------------------------------
// buildCompareRadarCohortBaseline
// ---------------------------------------------------------------------------

describe("buildCompareRadarCohortBaseline", () => {
  it("returns an empty all-cohort baseline until cards and a selection are available", () => {
    expect(buildCompareRadarCohortBaseline(undefined, [], "peg")).toEqual({
      effectiveCohort: "all",
      series: [],
      memberCount: 0,
    });

    const response = makeReportCardsV9Response();
    expect(buildCompareRadarCohortBaseline(response.cards, [], "mechanism")).toEqual({
      effectiveCohort: "all",
      series: [],
      memberCount: 0,
    });
  });

  it("builds a peg cohort from the lead selected card and preserves baseline presentation fields", () => {
    const response = makeReportCardsV9Response({
      cards: [
        makeCard("usdc-circle", "A"),
        makeCard("usdt-tether", "A-"),
        makeCard("pyusd-paypal", "B+"),
        makeCard("eurc-circle", "B"),
      ],
    });
    const selected = makeSelectedRadarCards(response, ["usdc-circle", "usdt-tether"]);

    const result = buildCompareRadarCohortBaseline(response.cards, selected, "peg");

    expect(result.effectiveCohort).toBe("peg");
    expect(result.memberCount).toBe(3);
    expect(result.series.map((entry) => entry.card.id)).toEqual([
      "usdc-circle",
      "usdt-tether",
      "pyusd-paypal",
    ]);
    expect(result.series.every((entry) => entry.color === "#64748b")).toBe(true);
    expect(result.series.every((entry) => entry.identity === response.safetyScoreIdentity)).toBe(true);
  });

  it("falls back to all rated cards when the requested cohort has fewer than three members", () => {
    const response = makeReportCardsV9Response({
      cards: [
        makeCard("usde-ethena", "A"),
        makeCard("susde-ethena", "A-"),
        makeCard("usdc-circle", "B+"),
        makeCard("eurc-circle", "B"),
      ],
    });
    const selected = makeSelectedRadarCards(response, ["usde-ethena", "susde-ethena"]);

    const result = buildCompareRadarCohortBaseline(response.cards, selected, "mechanism");

    expect(result.effectiveCohort).toBe("all");
    expect(result.memberCount).toBe(4);
    expect(result.series.map((entry) => entry.card.id)).toEqual(response.cards.map((card) => card.id));
  });
});

// ---------------------------------------------------------------------------
// deriveComparisonCoins
// ---------------------------------------------------------------------------

describe("deriveComparisonCoins", () => {
  it.each<{ name: string; input: Partial<ComparisonInput>; expectedIds: string[] }>([
    {
      name: "returns no coins when assetMap is empty",
      input: { selectedIds: ["usdc"], metaMap: metaMapFor("usdc") },
      expectedIds: [],
    },
    {
      name: "returns no coins when selectedIds is empty",
      input: { selectedIds: [], assetMap: assetMapFor("usdc"), metaMap: metaMapFor("usdc") },
      expectedIds: [],
    },
    {
      name: "skips coins missing from assetMap",
      input: { selectedIds: ["usdc", "usdt"], assetMap: assetMapFor("usdc"), metaMap: metaMapFor("usdc", "usdt") },
      expectedIds: ["usdc"],
    },
    {
      name: "skips coins missing from metaMap",
      input: { selectedIds: ["usdc", "usdt"], assetMap: assetMapFor("usdc", "usdt"), metaMap: metaMapFor("usdc") },
      expectedIds: ["usdc"],
    },
    {
      name: "preserves selectedIds order in output",
      input: {
        selectedIds: ["dai", "usdt", "usdc"],
        assetMap: assetMapFor("usdc", "usdt", "dai"),
        metaMap: metaMapFor("usdc", "usdt", "dai"),
      },
      expectedIds: ["dai", "usdt", "usdc"],
    },
  ])("$name", ({ input, expectedIds }) => {
    expect(deriveComparisonCoins(comparisonInput(input)).map((coin) => coin.id)).toEqual(expectedIds);
  });

  it("maps peg, liquidity and safety sources onto the comparison row", () => {
    const result = deriveComparisonCoins(
      comparisonInput({
        selectedIds: ["usdc"],
        assetMap: assetMapFor("usdc"),
        metaMap: metaMapFor("usdc"),
        pegCoinMap: new Map([["usdc", makePegSummaryCoin({ id: "usdc", pegScore: 92 })]]),
        dexData: { usdc: makeDexLiquidityData({ liquidityScore: 85 }) },
        cardMap: new Map([["usdc", makeCard("usdc", "A")]]),
      }),
    );

    expect(result[0].pegDetails?.pegScore).toBe(92);
    expect(result[0].liquidity?.liquidityScore).toBe(85);
    expect(result[0].safetyCard?.grade).toBe("A");
  });

  it("returns null pegDetails when coin is not in pegCoinMap", () => {
    const result = deriveComparisonCoins(
      comparisonInput({
        selectedIds: ["usdc"],
        assetMap: assetMapFor("usdc"),
        metaMap: metaMapFor("usdc"),
      }),
    );
    expect(result[0].pegDetails).toBeNull();
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
  it.each<{ name: string; flowDetails: (MintBurnPerCoinResponse | undefined)[] }>([
    { name: "returns empty array when all flow details are undefined", flowDetails: [undefined] },
    { name: "skips entries with empty hourly arrays", flowDetails: [makeFlowDetail()] },
  ])("$name", ({ flowDetails }) => {
    const result = deriveFlowSeries({
      selectedIds: ["usdc"],
      flowDetails,
      metaMap: new Map([["usdc", { symbol: "USDC" }]]),
    });
    expect(result).toEqual([]);
  });

  it("builds flow series from hourly buckets with correct timestamp conversion", () => {
    const detail = makeFlowDetail({
      mintVolumeUsd: 100,
      burnVolumeUsd: 50,
      netFlowUsd: 50,
      mintCount: 1,
      burnCount: 1,
      hourly: [
        { hourTs: 1700000000, netFlowUsd: 50_000, mintVolumeUsd: 100_000, burnVolumeUsd: 50_000 },
        { hourTs: 1700003600, netFlowUsd: -20_000, mintVolumeUsd: 0, burnVolumeUsd: 20_000 },
      ],
      updatedAt: 1700010000,
    });
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

  it("omits null and partial-valuation hours instead of plotting them as zero", () => {
    const detail = makeFlowDetail({
      hourly: [
        { hourTs: 1700000000, netFlowUsd: 10, mintVolumeUsd: 10, burnVolumeUsd: 0, valuation: "complete" },
        { hourTs: 1700003600, netFlowUsd: 5, mintVolumeUsd: 5, burnVolumeUsd: 0, valuation: "partial" },
        { hourTs: 1700007200, netFlowUsd: null, mintVolumeUsd: 0, burnVolumeUsd: 0, valuation: "partial" },
        { hourTs: 1700010800, netFlowUsd: -3, mintVolumeUsd: 0, burnVolumeUsd: 3 },
      ],
    });
    const [series] = deriveFlowSeries({
      selectedIds: ["usdc"],
      flowDetails: [detail],
      metaMap: new Map([["usdc", { symbol: "USDC" }]]),
    });
    expect(series.data).toEqual([
      { ts: 1700000000 * 1000, netFlowUsd: 10 },
      { ts: 1700010800 * 1000, netFlowUsd: -3 },
    ]);
    expect(series.unavailableHours).toBe(2);
    // The legacy hour without `valuation` stays plotted but is counted as coverage unknown.
    expect(series.unknownCoverageHours).toBe(1);
  });

  it("uses coin id as symbol fallback", () => {
    const detail = makeFlowDetail({
      hourly: [{ hourTs: 1700000000, netFlowUsd: 0, mintVolumeUsd: 0, burnVolumeUsd: 0 }],
    });
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
    expect(result[0].netFlow24h).toEqual({
      valueUsd: 500_000,
      completeness: "unknown",
      note: expect.stringMatching(/coverage unknown/i),
    });
    expect(result[0].pressureShiftScore).toBe(0.75);
    expect(result[0].netFlowDirection24h).toBe("minting");
    expect(result[0].pressureShiftState).toBe("worsening");
  });

  it("defaults a null pressureShiftState to 'nr'", () => {
    const coin = makeFlowCoin("usdc", {
      pressureShiftState: null as unknown as PressureShiftState,
    });
    const result = deriveFlowCardData({
      selectedIds: ["usdc"],
      flowCoinMap: new Map([["usdc", coin]]),
      metaMap: new Map([["usdc", { symbol: "USDC" }]]),
    });
    expect(result[0].pressureShiftState).toBe("nr");
  });

  it("keeps a null wire direction unavailable instead of defaulting it to inactive", () => {
    const coin = makeFlowCoin("usdc", { netFlowDirection24h: null, netFlow24hUsd: null, has24hActivity: true });
    const [card] = deriveFlowCardData({
      selectedIds: ["usdc"],
      flowCoinMap: new Map([["usdc", coin]]),
      metaMap: new Map([["usdc", { symbol: "USDC" }]]),
    });
    expect(card.netFlowDirection24h).toBeNull();
    expect(card.netFlow24h.valueUsd).toBeNull();
  });

  it("withholds net, pressure, and unproven direction for a partial 24h window", () => {
    const coin = makeFlowCoin("usdc", {
      has24hActivity: true,
      netFlow24hUsd: -2_000,
      netFlowDirection24h: "burning",
      pressureShiftScore: -40,
      pressureShiftState: "worsening",
      valuation: {
        window24h: {
          completeness: "partial",
          mintCompleteness: "partial",
          burnCompleteness: "complete",
          unpricedMintEventCount: 3,
          unpricedBurnEventCount: 0,
        },
        baseline: "complete",
        netFlow7d: "complete",
        netFlow30d: "complete",
        netFlow90d: "complete",
      },
    });
    const [card] = deriveFlowCardData({
      selectedIds: ["usdc"],
      flowCoinMap: new Map([["usdc", coin]]),
      metaMap: new Map([["usdc", { symbol: "USDC" }]]),
    });
    // Unpriced mints could lift the net above zero, so "burning" is not proven.
    expect(card.netFlowDirection24h).toBeNull();
    expect(card.netFlow24h.valueUsd).toBeNull();
    expect(card.netFlow24h.note).toContain("3 mint / 0 burn events unpriced");
    expect(card.pressureShiftScore).toBeNull();
    expect(card.pressureShiftState).toBe("nr");
    expect(card.pressureUnavailableNote).toMatch(/partial valuation/i);
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
