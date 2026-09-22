import { describe, expect, it, vi } from "vitest";
import {
  buildTrackedIdSet,
  exportStablecoinsCsv,
  sortStablecoins,
  filterStablecoins,
  prioritizePinnedStablecoins,
  resolveEffectiveSortKey,
  type StablecoinTableSortKey,
} from "@/components/stablecoin-table-logic";
import { buildV9SafetyTableMap, type V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import {
  COMMODITY_PEG_TAGS,
  NON_USD_NON_COMMODITY_PEG_TAGS,
  getFilterTags,
  OTHER_PEG_TAGS,
} from "@shared/lib/filter-tags";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { PegSummaryCoin, StablecoinData } from "@shared/types";
import type { DexLiquidityMap } from "@shared/types/market";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import type { ColumnId } from "@/hooks/use-preferences";
import type { CsvColumn } from "@/lib/exports/csv";

const { downloadCsvMock } = vi.hoisted(() => ({
  downloadCsvMock: vi.fn(),
}));

vi.mock("@/lib/exports/csv", () => ({
  downloadCsv: downloadCsvMock,
}));

function makeCoin(id: string, name: string, overrides: Partial<StablecoinData> = {}): StablecoinData {
  return makeStablecoin({
    id, name, symbol: id.toUpperCase(),
    priceSource: "coingecko", priceConfidence: "high",
    circulatingPrevDay: { peggedUSD: 1_000_000 },
    circulatingPrevWeek: { peggedUSD: 1_000_000 },
    supplySource: "defillama", chains: ["ethereum"],
    ...overrides,
  });
}

const sortAsc = (key: StablecoinTableSortKey) => ({ key, direction: "asc" as const });
const sortDesc = (key: StablecoinTableSortKey) => ({ key, direction: "desc" as const });

describe("filterStablecoins", () => {
  it("returns empty array for undefined data", () => {
    const result = filterStablecoins(undefined, new Set(["a"]), "");
    expect(result).toEqual([]);
  });

  it("filters out coins not in trackedIds set", () => {
    const coins = [makeCoin("usdc", "USD Coin"), makeCoin("usdt", "Tether")];
    const result = filterStablecoins(coins, new Set(["usdc"]), "");
    expect(result.map((c) => c.id)).toEqual(["usdc"]);
  });

  it("filters by search query matching name", () => {
    const coins = [makeCoin("usdc", "USD Coin"), makeCoin("usdt", "Tether")];
    const result = filterStablecoins(coins, new Set(["usdc", "usdt"]), "Tether");
    expect(result.map((c) => c.id)).toEqual(["usdt"]);
  });

  it("filters by search query matching symbol (case-insensitive)", () => {
    const coins = [makeCoin("usdc", "USD Coin"), makeCoin("dai", "Dai")];
    const result = filterStablecoins(coins, new Set(["usdc", "dai"]), "DAI");
    expect(result.map((c) => c.id)).toEqual(["dai"]);
  });

  it("returns all tracked coins when query is empty", () => {
    const coins = [makeCoin("usdc", "USD Coin"), makeCoin("dai", "Dai")];
    const result = filterStablecoins(coins, new Set(["usdc", "dai"]), "");
    expect(result).toHaveLength(2);
  });
});

describe("buildTrackedIdSet", () => {
  it("intersects metadata filters with an explicit listing universe", () => {
    const eligible = new Set(["susds-sky", "usdt-tether"]);

    expect(buildTrackedIdSet([], undefined, eligible)).toBe(eligible);
    expect(buildTrackedIdSet(["variant-tracked"], undefined, eligible)).toEqual(new Set(["susds-sky"]));
  });

  it("treats GBP and CHF pegs as part of the shared other-peg taxonomy", () => {
    expect(OTHER_PEG_TAGS).toContain("gbp-peg");
    expect(OTHER_PEG_TAGS).toContain("chf-peg");
  });

  it("returns active long-tail peg assets when filtering by other-peg", () => {
    const trackedIds = buildTrackedIdSet(["other-peg"]);
    const activeOtherPegIds = ACTIVE_STABLECOINS.filter((coin) =>
      getFilterTags(coin).some((tag) => OTHER_PEG_TAGS.includes(tag)),
    ).map((coin) => coin.id);

    expect(activeOtherPegIds.length).toBeGreaterThan(0);
    expect(activeOtherPegIds.every((id) => trackedIds.has(id))).toBe(true);
  });

  it("returns active gold and silver assets when filtering by commodity-peg", () => {
    const trackedIds = buildTrackedIdSet(["commodity-peg"]);
    const activeCommodityIds = ACTIVE_STABLECOINS.filter((coin) =>
      getFilterTags(coin).some((tag) => COMMODITY_PEG_TAGS.includes(tag)),
    ).map((coin) => coin.id);

    expect(activeCommodityIds.length).toBeGreaterThan(0);
    expect(activeCommodityIds.every((id) => trackedIds.has(id))).toBe(true);
  });

  it("returns active non-USD non-commodity assets when filtering by fiat-non-usd-peg", () => {
    const trackedIds = buildTrackedIdSet(["fiat-non-usd-peg"]);
    const activeFiatNonUsdIds = ACTIVE_STABLECOINS.filter((coin) =>
      getFilterTags(coin).some((tag) => NON_USD_NON_COMMODITY_PEG_TAGS.includes(tag)),
    ).map((coin) => coin.id);

    expect(activeFiatNonUsdIds.length).toBeGreaterThan(0);
    expect(activeFiatNonUsdIds.every((id) => trackedIds.has(id))).toBe(true);
  });

  it("returns Liquity v1 infrastructure cohort when filtering by infrastructure-liquity-v1", () => {
    const trackedIds = buildTrackedIdSet(["infrastructure-liquity-v1"]);
    expect(trackedIds.has("lusd-liquity")).toBe(true);
    expect(trackedIds.has("satusd-river")).toBe(true);
    expect(trackedIds.has("meusd-mezo")).toBe(true);
    expect(trackedIds.has("btcusd-btcfi")).toBe(true);
    expect(trackedIds.has("usbd-bima")).toBe(true);
    expect(trackedIds.has("cjpy-yamato")).toBe(true);
    expect(trackedIds.has("bold-liquity")).toBe(false);
    expect(trackedIds.has("usdt-tether")).toBe(false);
  });

  it("returns Liquity v2 infrastructure cohort when filtering by infrastructure-liquity-v2", () => {
    const trackedIds = buildTrackedIdSet(["infrastructure-liquity-v2"]);
    expect(trackedIds.has("bold-liquity")).toBe(true);
    expect(trackedIds.has("usdaf-asymmetry")).toBe(true);
    expect(trackedIds.has("feusd-felix")).toBe(true);
    expect(trackedIds.has("lusd-liquity")).toBe(false);
  });

  it("returns the M0 cohort when filtering by infrastructure-m0", () => {
    const trackedIds = buildTrackedIdSet(["infrastructure-m0"]);
    expect(trackedIds.has("usdsc-startale")).toBe(true);
    expect(trackedIds.has("ctusd-citrea")).toBe(true);
    expect(trackedIds.has("usdat-saturn")).toBe(true);
    expect(trackedIds.has("usdn-noble")).toBe(true);
    expect(trackedIds.has("musd-metamask")).toBe(true);
    expect(trackedIds.has("wm-m0")).toBe(true);
    expect(trackedIds.has("usdnr-nerona")).toBe(true);
    expect(trackedIds.has("usdk-kast")).toBe(true);
    expect(trackedIds.has("xo-exodus")).toBe(true);
    expect(trackedIds.has("m-m0")).toBe(true);
    expect(trackedIds.has("susdai-usd-ai")).toBe(false);
  });

  it("returns only tracked parent variants for the variant filters", () => {
    const allVariants = buildTrackedIdSet(["variant-tracked"]);
    expect(allVariants.has("susds-sky")).toBe(true);
    expect(allVariants.has("susdai-usd-ai")).toBe(true);
    expect(allVariants.has("stusds-sky")).toBe(true);
    expect(allVariants.has("busd0-usual")).toBe(false);
    expect(allVariants.has("srusd-reservoir")).toBe(true);
    expect(allVariants.has("wm-m0")).toBe(true);
    expect(allVariants.has("iusd-initia")).toBe(true);
    expect(allVariants.has("usds-sky")).toBe(false);
    expect(allVariants.size).toBe(53);

    const strategy = buildTrackedIdSet(["variant-strategy-vault"]);
    expect(strategy).toEqual(
      new Set([
        "aa-falconx-mev-capital",
        "autousd-auto-finance",
        "apyusd-apyx",
        "bbqusdc-steakhouse",
        "dusd-dialectic",
        "eearn-ember",
        "fxsave-f-x-protocol",
        "gtusdc-gauntlet",
        "gtusdcp-gauntlet",
        "hbusdt-hyperbeat",
        "susd1plus-lorenzo",
        "savusd-avant",
        "susdai-usd-ai",
        "steakusdc-steakhouse",
        "steakusdt-steakhouse",
        "stcusd-cap",
        "syrupusdc-maple",
        "syrupusdt-maple",
        "yousd-yield-optimizer",
        "syzusd-yuzu",
        "said-gaib",
        "sdusd-dtrinity",
        "stusd-stoneyield",
        "usd3-3jane",
        "yvusdc-yearn",
        "ybold-yearn",
        "yusd-yieldfi",
      ]),
    );

    const riskAbsorption = buildTrackedIdSet(["variant-risk-absorption"]);
    expect(riskAbsorption).toEqual(
      new Set(["srusde-strata", "stusds-sky", "stkgho-umbrella-aave", "sbold-k3-capital"]),
    );

    const bond = buildTrackedIdSet(["variant-bond-maturity"]);
    expect(bond).toEqual(new Set());
  });
});

describe("resolveEffectiveSortKey", () => {
  it("returns the given key when column is visible", () => {
    const visible = new Set<ColumnId>(["mcap"]);
    expect(resolveEffectiveSortKey("mcap", visible)).toBe("mcap");
  });

  it("falls back to mcap when column is not visible", () => {
    const visible = new Set<ColumnId>(["name", "price"]);
    expect(resolveEffectiveSortKey("stability", visible)).toBe("mcap");
  });
});

describe("prioritizePinnedStablecoins", () => {
  it("moves pinned rows to the top in pinned order", () => {
    const rows = [makeCoin("usdt-tether", "Tether"), makeCoin("usdc-circle", "USD Coin"), makeCoin("dai-maker", "Dai")];

    const result = prioritizePinnedStablecoins(rows, ["dai-maker", "usdc-circle"]);

    expect(result.map((coin) => coin.id)).toEqual(["dai-maker", "usdc-circle", "usdt-tether"]);
  });

  it("ignores pinned ids that are not present in the current filtered rows", () => {
    const rows = [makeCoin("usdt-tether", "Tether"), makeCoin("usdc-circle", "USD Coin")];

    const result = prioritizePinnedStablecoins(rows, ["missing", "usdc-circle"]);

    expect(result.map((coin) => coin.id)).toEqual(["usdc-circle", "usdt-tether"]);
  });
});

function safetyTableRows(cards: SafetyScoreV9CurrentCard[]): Record<string, V9SafetyTableRow> {
  const response = makeReportCardsV9Response({ cards });
  const projection = buildV9SafetyTableMap(response, response.safetyScoreIdentity);
  return projection.status === "available" ? projection.value : {};
}

describe("sortStablecoins", () => {
  it.each<{
    name: string;
    rows: StablecoinData[];
    sort: { key: StablecoinTableSortKey; direction: "asc" | "desc" };
    sources?: {
      pegScores?: Map<string, PegSummaryCoin>;
      dexLiquidity?: DexLiquidityMap;
      reportCards?: Record<string, V9SafetyTableRow>;
    };
    expected: string[];
  }>([
    {
      name: "sorts names alphabetically ascending",
      rows: [makeCoin("b", "Zebra"), makeCoin("a", "Apple")],
      sort: sortAsc("name"),
      expected: ["a", "b"],
    },
    {
      name: "sorts names alphabetically descending",
      rows: [makeCoin("a", "Apple"), makeCoin("b", "Zebra")],
      sort: sortDesc("name"),
      expected: ["b", "a"],
    },
    {
      name: "sorts by price ascending",
      rows: [makeCoin("a", "A", { price: 1.05 }), makeCoin("b", "B", { price: 0.98 })],
      sort: sortAsc("price"),
      expected: ["b", "a"],
    },
    {
      name: "keeps an unknown price last when sorting descending",
      rows: [makeCoin("a", "A", { price: null }), makeCoin("b", "B", { price: 1.0 })],
      sort: sortDesc("price"),
      expected: ["b", "a"],
    },
    {
      // Ascending used to rank the unknown row as the cheapest coin on the page.
      name: "keeps an unknown price last when sorting ascending",
      rows: [makeCoin("a", "A", { price: null }), makeCoin("b", "B", { price: 1.0 })],
      sort: sortAsc("price"),
      expected: ["b", "a"],
    },
    {
      name: "sorts by the Worker current peg deviation",
      rows: [makeCoin("higher", "Higher", { price: 1.004949 }), makeCoin("lower", "Lower", { price: 1.004941 })],
      sort: sortAsc("peg"),
      sources: {
        pegScores: new Map([
          ["higher", makePegSummaryCoin({ id: "higher", currentDeviationBps: 50 })],
          ["lower", makePegSummaryCoin({ id: "lower", currentDeviationBps: 49 })],
        ]),
      },
      expected: ["lower", "higher"],
    },
    {
      name: "sorts by market cap descending",
      rows: [
        makeCoin("small", "Small", { circulating: { peggedUSD: 1_000 } }),
        makeCoin("large", "Large", { circulating: { peggedUSD: 1_000_000_000 } }),
      ],
      sort: sortDesc("mcap"),
      expected: ["large", "small"],
    },
    {
      name: "sorts by market cap ascending",
      rows: [
        makeCoin("large", "Large", { circulating: { peggedUSD: 1_000_000_000 } }),
        makeCoin("small", "Small", { circulating: { peggedUSD: 1_000 } }),
      ],
      sort: sortAsc("mcap"),
      expected: ["small", "large"],
    },
    {
      name: "sorts by peg score descending",
      rows: [makeCoin("a", "A"), makeCoin("b", "B")],
      sort: sortDesc("stability"),
      sources: {
        pegScores: new Map([
          ["a", makePegSummaryCoin({ id: "a", symbol: "A", pegScore: 95 })],
          ["b", makePegSummaryCoin({ id: "b", symbol: "B", pegScore: 70 })],
        ]),
      },
      expected: ["a", "b"],
    },
    {
      name: "places coins with no peg score after coins with scores",
      rows: [makeCoin("noScore", "No Score"), makeCoin("hasScore", "Has Score")],
      sort: sortDesc("stability"),
      sources: {
        pegScores: new Map([["hasScore", makePegSummaryCoin({ id: "hasScore", symbol: "H", pegScore: 80 })]]),
      },
      expected: ["hasScore", "noScore"],
    },
    {
      name: "sorts by liquidity score descending",
      rows: [makeCoin("low", "Low"), makeCoin("high", "High")],
      sort: sortDesc("liquidity"),
      sources: {
        dexLiquidity: {
          low: makeDexLiquidityData({ liquidityScore: 20 }),
          high: makeDexLiquidityData({ liquidityScore: 90 }),
        },
      },
      expected: ["high", "low"],
    },
    {
      name: "places coins with null liquidity after coins with scores",
      rows: [makeCoin("noLiq", "No Liq"), makeCoin("hasLiq", "Has Liq")],
      sort: sortDesc("liquidity"),
      sources: { dexLiquidity: { hasLiq: makeDexLiquidityData({ liquidityScore: 50 }) } },
      expected: ["hasLiq", "noLiq"],
    },
    {
      name: "sorts by V9 score descending",
      rows: [makeCoin("b", "B"), makeCoin("a", "A")],
      sort: sortDesc("grade"),
      sources: {
        reportCards: safetyTableRows([makeV9Card({ id: "a", score: 85 }), makeV9Card({ id: "b", score: 60 })]),
      },
      expected: ["a", "b"],
    },
    {
      name: "places coins with a null V9 score after coins with scores",
      rows: [makeCoin("noGrade", "No Grade"), makeCoin("hasGrade", "Has Grade")],
      sort: sortDesc("grade"),
      sources: { reportCards: safetyTableRows([makeV9Card({ id: "hasGrade", score: 70 })]) },
      expected: ["hasGrade", "noGrade"],
    },
    {
      name: "sorts by 24h supply change descending",
      rows: [
        makeCoin("grow", "Growing", {
          circulating: { peggedUSD: 1_100_000 },
          circulatingPrevDay: { peggedUSD: 1_000_000 }, // +10%
        }),
        makeCoin("shrink", "Shrinking", {
          circulating: { peggedUSD: 900_000 },
          circulatingPrevDay: { peggedUSD: 1_000_000 }, // -10%
        }),
      ],
      sort: sortDesc("change24h"),
      expected: ["grow", "shrink"],
    },
    {
      name: "sorts by 7d supply change ascending",
      rows: [
        makeCoin("grow", "Growing", {
          circulating: { peggedUSD: 1_200_000 },
          circulatingPrevWeek: { peggedUSD: 1_000_000 }, // +20%
        }),
        makeCoin("stable", "Stable", {
          circulating: { peggedUSD: 1_000_000 },
          circulatingPrevWeek: { peggedUSD: 1_000_000 }, // 0%
        }),
      ],
      sort: sortAsc("change7d"),
      expected: ["stable", "grow"],
    },
  ])("$name", ({ rows, sort, sources, expected }) => {
    const result = sortStablecoins({ filtered: rows, sort, effectiveSortKey: sort.key, ...sources });
    expect(result.map((coin) => coin.id)).toEqual(expected);
  });

  it("treats missing Worker deviations as absent peg signals", () => {
    const coins = [
      makeCoin("missing", "Missing", { price: null }),
      makeCoin("invalid", "Invalid", { price: Number.NaN }),
      makeCoin("exact", "Exact", { price: 1 }),
    ];

    const result = sortStablecoins({
      filtered: coins,
      sort: sortAsc("peg"),
      effectiveSortKey: "peg",
      pegScores: new Map([
        ["missing", makePegSummaryCoin({ id: "missing", currentDeviationBps: null })],
        ["invalid", makePegSummaryCoin({ id: "invalid", currentDeviationBps: null })],
        ["exact", makePegSummaryCoin({ id: "exact", currentDeviationBps: 0 })],
      ]),
    });

    expect(result[0]?.id).toBe("exact");
    expect(new Set(result.slice(1).map((coin) => coin.id))).toEqual(new Set(["missing", "invalid"]));
  });

  it("reads the selected sort value once per row", () => {
    let priceReads = 0;
    const withCountedPrice = (id: string, name: string, price: number): StablecoinData => {
      const coin = makeCoin(id, name);
      Object.defineProperty(coin, "price", {
        get() {
          priceReads += 1;
          return price;
        },
        configurable: true,
      });
      return coin;
    };
    const coins = [
      withCountedPrice("a", "A", 1.05),
      withCountedPrice("b", "B", 0.98),
      withCountedPrice("c", "C", 1.01),
    ];

    const result = sortStablecoins({
      filtered: coins,
      sort: sortAsc("price"),
      effectiveSortKey: "price",
    });

    expect(result.map((coin) => coin.id)).toEqual(["b", "c", "a"]);
    expect(priceReads).toBe(coins.length);
  });
});

describe("blacklistable projection", () => {
  const freezePossible = (id: string) =>
    makeV9Card({ id, accessPosture: { ...makeV9Card().accessPosture, freezeExposure: "possible" } });

  it("sorts reviewed FreezeWatch status before stale V9 freeze exposure", () => {
    const lisusd = makeCoin("lisusd-lista", "Lista USD");
    const runtimePossible = makeCoin("runtime-possible", "Runtime Possible");

    const result = sortStablecoins({
      filtered: [runtimePossible, lisusd],
      sort: sortAsc("blacklistable"),
      effectiveSortKey: "blacklistable",
      reportCards: safetyTableRows([freezePossible("lisusd-lista"), freezePossible("runtime-possible")]),
    });

    expect(result.map((row) => row.id)).toEqual(["lisusd-lista", "runtime-possible"]);
  });

  it("exports reviewed FreezeWatch status before stale V9 freeze exposure", () => {
    downloadCsvMock.mockReset();
    const lisusd = makeCoin("lisusd-lista", "Lista USD");

    exportStablecoinsCsv([lisusd], undefined, undefined, safetyTableRows([freezePossible("lisusd-lista")]));

    const [, columns] = downloadCsvMock.mock.calls[0]! as [
      StablecoinData[],
      CsvColumn<StablecoinData>[],
      string,
    ];
    const blacklistColumn = columns.find((column) => column.header === "Blacklistable");
    expect(blacklistColumn?.accessor(lisusd, 0)).toBe("No");
  });
});

describe("supply-change semantics", () => {
  it("sorts a missing previous supply last and exports it as null", () => {
    const missing = makeCoin("missing", "Missing", {
      circulating: { peggedUSD: 1_000_000 },
      circulatingPrevDay: undefined,
    });
    const growing = makeCoin("grow", "Growing", {
      circulating: { peggedUSD: 1_100_000 },
      circulatingPrevDay: { peggedUSD: 1_000_000 },
    });
    const shrinking = makeCoin("shrink", "Shrinking", {
      circulating: { peggedUSD: 900_000 },
      circulatingPrevDay: { peggedUSD: 1_000_000 },
    });

    const sorted = sortStablecoins({
      filtered: [missing, shrinking, growing],
      sort: sortDesc("change24h"),
      effectiveSortKey: "change24h",
    });
    // A coin with no prior sample used to land between a grower and a shrinker
    // as if it had been measured at 0%.
    expect(sorted.map((coin) => coin.id)).toEqual(["grow", "shrink", "missing"]);

    downloadCsvMock.mockReset();
    exportStablecoinsCsv([missing]);
    const [, columns] = downloadCsvMock.mock.calls[0]! as [
      StablecoinData[],
      CsvColumn<StablecoinData>[],
      string,
    ];
    const changeColumn = columns.find((column) => column.header === "24h Change (%)");
    expect(changeColumn?.accessor(missing, 0)).toBeNull();
  });
});
