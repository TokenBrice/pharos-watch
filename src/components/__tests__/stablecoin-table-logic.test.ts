import { describe, expect, it } from "vitest";
import {
  buildTrackedIdSet,
  sortStablecoins,
  filterStablecoins,
  resolveEffectiveSortKey,
  type StablecoinTableSortKey,
} from "@/components/stablecoin-table-logic";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { OTHER_PEG_TAGS, getFilterTags, type StablecoinData } from "@shared/types";
import type { ColumnId } from "@/hooks/use-preferences";

// Minimal StablecoinData factory
function makeCoin(
  id: string,
  name: string,
  overrides: Partial<StablecoinData> = {},
): StablecoinData {
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
  };
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
  it("treats GBP and CHF pegs as part of the shared other-peg taxonomy", () => {
    expect(OTHER_PEG_TAGS).toContain("gbp-peg");
    expect(OTHER_PEG_TAGS).toContain("chf-peg");
  });

  it("returns active long-tail peg assets when filtering by other-peg", () => {
    const trackedIds = buildTrackedIdSet(["other-peg"]);
    const activeOtherPegIds = ACTIVE_STABLECOINS
      .filter((coin) => getFilterTags(coin).some((tag) => OTHER_PEG_TAGS.includes(tag)))
      .map((coin) => coin.id);

    expect(activeOtherPegIds.length).toBeGreaterThan(0);
    expect(activeOtherPegIds.every((id) => trackedIds.has(id))).toBe(true);
  });

  it("returns the normalized Liquity-family cohort when filtering by protocol lineage", () => {
    const trackedIds = buildTrackedIdSet(["liquity-family"]);
    expect(trackedIds.has("lusd-liquity")).toBe(true);
    expect(trackedIds.has("bold-liquity")).toBe(true);
    expect(trackedIds.has("usdaf-asymmetry")).toBe(true);
    expect(trackedIds.has("feusd-felix")).toBe(true);
    expect(trackedIds.has("usdt-tether")).toBe(false);
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
    const coins = [
      makeCoin("a", "A", { price: 1.05 }),
      makeCoin("b", "B", { price: 0.98 }),
    ];
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
    const coins = [
      makeCoin("a", "A", { price: null }),
      makeCoin("b", "B", { price: 1.0 }),
    ];
    const result = sortStablecoins({
      filtered: coins,
      sort: sortDesc("price"),
      effectiveSortKey: "price",
      pegRates: {},
    });
    expect(result[0].id).toBe("b");
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
      ["a", { pegScore: 95, id: "a", symbol: "A" } as Parameters<typeof sortStablecoins>[0]["pegScores"] extends Map<string, infer V> ? V : never],
      ["b", { pegScore: 70, id: "b", symbol: "B" } as Parameters<typeof sortStablecoins>[0]["pegScores"] extends Map<string, infer V> ? V : never],
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
      ["hasScore", { pegScore: 80, id: "hasScore", symbol: "H" } as Parameters<typeof sortStablecoins>[0]["pegScores"] extends Map<string, infer V> ? V : never],
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
      low: { liquidityScore: 20 } as Parameters<typeof sortStablecoins>[0]["dexLiquidity"] extends Record<string, infer V> ? V : never,
      high: { liquidityScore: 90 } as Parameters<typeof sortStablecoins>[0]["dexLiquidity"] extends Record<string, infer V> ? V : never,
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
      hasLiq: { liquidityScore: 50 } as Parameters<typeof sortStablecoins>[0]["dexLiquidity"] extends Record<string, infer V> ? V : never,
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
      a: { overallScore: 85 } as Parameters<typeof sortStablecoins>[0]["reportCards"] extends Record<string, infer V> ? V : never,
      b: { overallScore: 60 } as Parameters<typeof sortStablecoins>[0]["reportCards"] extends Record<string, infer V> ? V : never,
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
      hasGrade: { overallScore: 70 } as Parameters<typeof sortStablecoins>[0]["reportCards"] extends Record<string, infer V> ? V : never,
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
