import { describe, expect, it } from "vitest";
import {
  buildTrackedIdSet,
  sortStablecoins,
  filterStablecoins,
  prioritizePinnedStablecoins,
  resolveEffectiveSortKey,
  type StablecoinTableSortKey,
} from "@/components/stablecoin-table-logic";
import {
  COMMODITY_PEG_TAGS,
  NON_USD_NON_COMMODITY_PEG_TAGS,
  getFilterTags,
  OTHER_PEG_TAGS,
} from "@shared/lib/filter-tags";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { StablecoinData } from "@shared/types";
import type { ColumnId } from "@/hooks/use-preferences";

// Minimal StablecoinData factory
function makeCoin(id: string, name: string, overrides: Partial<StablecoinData> = {}): StablecoinData {
  return {
    id,
    name,
    symbol: id.toUpperCase(),
    geckoId: null,
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: 1.0,
    priceSource: "coingecko",
    priceConfidence: "high",
    priceUpdatedAt: null,
    circulating: { peggedUSD: 1_000_000 },
    circulatingPrevDay: { peggedUSD: 1_000_000 },
    circulatingPrevWeek: { peggedUSD: 1_000_000 },
    circulatingPrevMonth: {},
    chainCirculating: {},
    consensusSources: [],
    agreeSources: [],
    supplySource: "defillama",
    chains: ["ethereum"],
    ...overrides,
  } as StablecoinData;
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
    expect(allVariants.has("usds-sky")).toBe(false);
    expect(allVariants.size).toBe(47);

    const strategy = buildTrackedIdSet(["variant-strategy-vault"]);
    expect(strategy).toEqual(
      new Set([
        "aa-falconx-mev-capital",
        "autousd-auto-finance",
        "apyusd-apyx",
        "bbqusdc-steakhouse",
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

describe("sortStablecoins — name", () => {
  it("sorts alphabetically ascending", () => {
    const coins = [makeCoin("b", "Zebra"), makeCoin("a", "Apple")];
    const result = sortStablecoins({
      filtered: coins,
      sort: sortAsc("name"),
      effectiveSortKey: "name",
      pegRates: {},
    });
    expect(result.map((c) => c.name)).toEqual(["Apple", "Zebra"]);
  });

  it("sorts alphabetically descending", () => {
    const coins = [makeCoin("a", "Apple"), makeCoin("b", "Zebra")];
    const result = sortStablecoins({
      filtered: coins,
      sort: sortDesc("name"),
      effectiveSortKey: "name",
      pegRates: {},
    });
    expect(result.map((c) => c.name)).toEqual(["Zebra", "Apple"]);
  });
});

describe("sortStablecoins — price", () => {
  it("sorts by price ascending", () => {
    const coins = [makeCoin("a", "A", { price: 1.05 }), makeCoin("b", "B", { price: 0.98 })];
    const result = sortStablecoins({
      filtered: coins,
      sort: sortAsc("price"),
      effectiveSortKey: "price",
      pegRates: {},
    });
    expect(result[0].id).toBe("b");
    expect(result[1].id).toBe("a");
  });

  it("treats null price as 0", () => {
    const coins = [makeCoin("a", "A", { price: null }), makeCoin("b", "B", { price: 1.0 })];
    const result = sortStablecoins({
      filtered: coins,
      sort: sortDesc("price"),
      effectiveSortKey: "price",
      pegRates: {},
    });
    expect(result[0].id).toBe("b");
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
      pegRates: {},
    });

    expect(result.map((coin) => coin.id)).toEqual(["b", "c", "a"]);
    expect(priceReads).toBe(coins.length);
  });
});

describe("sortStablecoins — mcap", () => {
  it("sorts by market cap descending", () => {
    const coins = [
      makeCoin("small", "Small", { circulating: { peggedUSD: 1_000 } }),
      makeCoin("large", "Large", { circulating: { peggedUSD: 1_000_000_000 } }),
    ];
    const result = sortStablecoins({
      filtered: coins,
      sort: sortDesc("mcap"),
      effectiveSortKey: "mcap",
      pegRates: {},
    });
    expect(result[0].id).toBe("large");
  });

  it("sorts by market cap ascending", () => {
    const coins = [
      makeCoin("large", "Large", { circulating: { peggedUSD: 1_000_000_000 } }),
      makeCoin("small", "Small", { circulating: { peggedUSD: 1_000 } }),
    ];
    const result = sortStablecoins({
      filtered: coins,
      sort: sortAsc("mcap"),
      effectiveSortKey: "mcap",
      pegRates: {},
    });
    expect(result[0].id).toBe("small");
  });
});

describe("sortStablecoins — stability (pegScore)", () => {
  it("sorts by peg score descending", () => {
    const coins = [makeCoin("a", "A"), makeCoin("b", "B")];
    const pegScores = new Map([
      [
        "a",
        { pegScore: 95, id: "a", symbol: "A" } as Parameters<typeof sortStablecoins>[0]["pegScores"] extends Map<
          string,
          infer V
        >
          ? V
          : never,
      ],
      [
        "b",
        { pegScore: 70, id: "b", symbol: "B" } as Parameters<typeof sortStablecoins>[0]["pegScores"] extends Map<
          string,
          infer V
        >
          ? V
          : never,
      ],
    ]);
    const result = sortStablecoins({
      filtered: coins,
      sort: sortDesc("stability"),
      effectiveSortKey: "stability",
      pegRates: {},
      pegScores,
    });
    expect(result[0].id).toBe("a");
  });

  it("places coins with null pegScore after coins with scores", () => {
    const coins = [makeCoin("noScore", "No Score"), makeCoin("hasScore", "Has Score")];
    const pegScores = new Map([
      [
        "hasScore",
        { pegScore: 80, id: "hasScore", symbol: "H" } as Parameters<typeof sortStablecoins>[0]["pegScores"] extends Map<
          string,
          infer V
        >
          ? V
          : never,
      ],
    ]);
    const result = sortStablecoins({
      filtered: coins,
      sort: sortDesc("stability"),
      effectiveSortKey: "stability",
      pegRates: {},
      pegScores,
    });
    expect(result[0].id).toBe("hasScore");
    expect(result[1].id).toBe("noScore");
  });
});

describe("sortStablecoins — liquidity (dexLiquidity)", () => {
  it("sorts by liquidity score descending", () => {
    const coins = [makeCoin("low", "Low"), makeCoin("high", "High")];
    const dexLiquidity = {
      low: { liquidityScore: 20 } as Parameters<typeof sortStablecoins>[0]["dexLiquidity"] extends Record<
        string,
        infer V
      >
        ? V
        : never,
      high: { liquidityScore: 90 } as Parameters<typeof sortStablecoins>[0]["dexLiquidity"] extends Record<
        string,
        infer V
      >
        ? V
        : never,
    };
    const result = sortStablecoins({
      filtered: coins,
      sort: sortDesc("liquidity"),
      effectiveSortKey: "liquidity",
      pegRates: {},
      dexLiquidity,
    });
    expect(result[0].id).toBe("high");
  });

  it("places coins with null liquidity after coins with scores", () => {
    const coins = [makeCoin("noLiq", "No Liq"), makeCoin("hasLiq", "Has Liq")];
    const dexLiquidity = {
      hasLiq: { liquidityScore: 50 } as Parameters<typeof sortStablecoins>[0]["dexLiquidity"] extends Record<
        string,
        infer V
      >
        ? V
        : never,
    };
    const result = sortStablecoins({
      filtered: coins,
      sort: sortDesc("liquidity"),
      effectiveSortKey: "liquidity",
      pegRates: {},
      dexLiquidity,
    });
    expect(result[0].id).toBe("hasLiq");
    expect(result[1].id).toBe("noLiq");
  });
});

describe("sortStablecoins — grade (reportCards)", () => {
  it("sorts by overall score descending", () => {
    const coins = [makeCoin("b", "B"), makeCoin("a", "A")];
    const reportCards = {
      a: { overallScore: 85 } as Parameters<typeof sortStablecoins>[0]["reportCards"] extends Record<string, infer V>
        ? V
        : never,
      b: { overallScore: 60 } as Parameters<typeof sortStablecoins>[0]["reportCards"] extends Record<string, infer V>
        ? V
        : never,
    };
    const result = sortStablecoins({
      filtered: coins,
      sort: sortDesc("grade"),
      effectiveSortKey: "grade",
      pegRates: {},
      reportCards,
    });
    expect(result[0].id).toBe("a");
  });

  it("places coins with null overallScore after coins with scores", () => {
    const coins = [makeCoin("noGrade", "No Grade"), makeCoin("hasGrade", "Has Grade")];
    const reportCards = {
      hasGrade: { overallScore: 70 } as Parameters<typeof sortStablecoins>[0]["reportCards"] extends Record<
        string,
        infer V
      >
        ? V
        : never,
    };
    const result = sortStablecoins({
      filtered: coins,
      sort: sortDesc("grade"),
      effectiveSortKey: "grade",
      pegRates: {},
      reportCards,
    });
    expect(result[0].id).toBe("hasGrade");
    expect(result[1].id).toBe("noGrade");
  });
});

describe("sortStablecoins — change24h", () => {
  it("sorts by 24h supply change descending", () => {
    const growing = makeCoin("grow", "Growing", {
      circulating: { peggedUSD: 1_100_000 },
      circulatingPrevDay: { peggedUSD: 1_000_000 }, // +10%
    });
    const shrinking = makeCoin("shrink", "Shrinking", {
      circulating: { peggedUSD: 900_000 },
      circulatingPrevDay: { peggedUSD: 1_000_000 }, // -10%
    });
    const result = sortStablecoins({
      filtered: [growing, shrinking],
      sort: sortDesc("change24h"),
      effectiveSortKey: "change24h",
      pegRates: {},
    });
    expect(result[0].id).toBe("grow");
  });
});

describe("sortStablecoins — change7d", () => {
  it("sorts by 7d supply change ascending", () => {
    const stable = makeCoin("stable", "Stable", {
      circulating: { peggedUSD: 1_000_000 },
      circulatingPrevWeek: { peggedUSD: 1_000_000 }, // 0%
    });
    const growing = makeCoin("grow", "Growing", {
      circulating: { peggedUSD: 1_200_000 },
      circulatingPrevWeek: { peggedUSD: 1_000_000 }, // +20%
    });
    const result = sortStablecoins({
      filtered: [growing, stable],
      sort: sortAsc("change7d"),
      effectiveSortKey: "change7d",
      pegRates: {},
    });
    expect(result[0].id).toBe("stable");
  });
});
