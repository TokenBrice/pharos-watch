import { describe, expect, it, vi } from "vitest";
import {
  buildTrackedIdSet,
  exportStablecoinsCsv,
  sortStablecoins,
  filterStablecoins,
  prioritizePinnedStablecoins,
  type StablecoinTableSortKey,
} from "@/components/stablecoin-table-logic";
import { buildV9SafetyTableMap, type V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import type { PegSummaryCoin, StablecoinData } from "@shared/types";
import type { DexLiquidityMap } from "@shared/types/market";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import type { CsvColumn } from "@/lib/exports/csv";
import { buildCsvBody } from "@shared/lib/csv";
import type { ExportPreamble } from "@/lib/exports/preamble";
import { formatPreambleCsv } from "@/lib/exports/preamble";
import { createTableComparator } from "@/lib/table-comparator";

const { downloadCsvMock } = vi.hoisted(() => ({
  downloadCsvMock: vi.fn(),
}));

vi.mock("@/lib/exports/csv", () => ({
  downloadCsvWithPreamble: downloadCsvMock,
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
describe("nominal price consumers", () => {
  it("sorts nominal prices as missing and exports no observed quote", () => {
    downloadCsvMock.mockReset();
    const nominal = makeCoin("nominal", "Nominal", {
      price: 1,
      priceSource: "protocol-par",
      priceObservedAtMode: "nominal_reference",
      priceConfidence: "high",
    });
    const market = makeCoin("market", "Market", { price: 1.1 });
    const sorted = sortStablecoins({
      filtered: [nominal, market],
      sort: sortAsc("price"),
      effectiveSortKey: "price",
    });
    expect(sorted.map((coin) => coin.id)).toEqual(["market", "nominal"]);
    exportStablecoinsCsv(sorted, new Map([["market", 1], ["nominal", 2]]));
    const [, columns] = downloadCsvMock.mock.calls[0]! as [StablecoinData[], CsvColumn<StablecoinData>[], string];
    const priceColumn = columns.find((column) => column.header === "Price")!;
    expect(priceColumn.accessor(nominal, 1)).toBeNull();
    expect(priceColumn.accessor(market, 0)).toBe(1.1);
  });
});

describe("stablecoin export provenance", () => {
  it("records supplied upstream generations instead of download time and preserves unknown clocks and cells", () => {
    downloadCsvMock.mockReset();
    const rows = [
      makeCoin("zero", "Zero", { circulating: { peggedUSD: 0 } }),
      makeCoin("unknown", "Unknown", { circulating: {} }),
    ];
    const sourceTime = Date.parse("2026-09-01T12:00:00Z") / 1000;
    exportStablecoinsCsv(rows, new Map([["zero", 1], ["unknown", 2]]), new Map(), {}, {}, { stablecoins: sourceTime, pegSummary: sourceTime - 60, reportCards: null });
    const [exported, columns, , preamble] = downloadCsvMock.mock.calls[0] as [StablecoinData[], CsvColumn<StablecoinData>[], string, ExportPreamble];
    expect(exported).toBe(rows);
    expect(preamble.asOfISO).toBe("2026-09-01T12:00:00.000Z");
    const header = formatPreambleCsv(preamble);
    expect(header).toContain("pegSummary=2026-09-01T11:59:00.000Z");
    expect(header).toContain("dexLiquidity=unknown");
    expect(header).toContain("reportCards=unknown");
    const supply = columns.find((column) => column.header === "Market Cap (USD)")!;
    expect(supply.accessor(rows[0], 0)).toBe(0);
    expect(supply.accessor(rows[1], 1)).toBeNull();
    exportStablecoinsCsv(rows, new Map([["zero", 1], ["unknown", 2]]));
    expect(downloadCsvMock.mock.calls[1][3].asOfISO).toBe("unknown");
  });
});

describe("supply availability consumers", () => {
  const unavailable = makeCoin("unavailable", "Unavailable", { circulating: {} });
  const observed = makeCoin("observed", "Observed", { circulating: { peggedUSD: 50 } });
  const zero = makeCoin("zero", "Zero", { circulating: { peggedUSD: 0 } });
  const missingDay = makeCoin("missing-day", "Missing Day", {
    circulating: { peggedUSD: 50 },
    circulatingPrevDay: {},
    circulatingPrevWeek: { peggedUSD: 40 },
  });

  it.each(["mcap", "change24h", "change7d"] as const)(
    "sorts unavailable %s last in either direction and retains observed zero",
    (key) => {
      const rows = [unavailable, observed, zero];
      expect(sortStablecoins({ filtered: rows, sort: sortAsc(key), effectiveSortKey: key }).map((coin) => coin.id))
        .toEqual(["zero", "observed", "unavailable"]);
      expect(sortStablecoins({ filtered: rows, sort: sortDesc(key), effectiveSortKey: key }).map((coin) => coin.id))
        .toEqual(["observed", "zero", "unavailable"]);
    },
  );

  it("sorts missing day history last without discarding its weekly observation", () => {
    expect(sortStablecoins({
      filtered: [missingDay, observed], sort: sortAsc("change24h"), effectiveSortKey: "change24h",
    }).map((coin) => coin.id)).toEqual(["observed", "missing-day"]);
    expect(sortStablecoins({
      filtered: [missingDay, observed], sort: sortDesc("change7d"), effectiveSortKey: "change7d",
    }).map((coin) => coin.id)).toEqual(["missing-day", "observed"]);
  });

  it("exports absent supply and deltas as empty cells but explicit zero as zero and -100", () => {
    downloadCsvMock.mockReset();
    exportStablecoinsCsv([unavailable, missingDay, zero], new Map([["unavailable", 1], ["missing-day", 2], ["zero", 3]]));
    const [rows, columns] = downloadCsvMock.mock.calls[0]! as [StablecoinData[], CsvColumn<StablecoinData>[], string];
    const supplyColumns = columns.filter((column) =>
      ["Market Cap (USD)", "24h Change (%)", "7d Change (%)"].includes(column.header));
    expect(buildCsvBody(rows, supplyColumns)).toEqual([
      "Market Cap (USD),24h Change (%),7d Change (%)",
      ",,",
      "50,,25",
      "0,-100,-100",
    ]);
  });
});


describe("filterStablecoins", () => {

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

  it.each([
    { direction: "asc", filtered: false, pinned: false, expected: ["1,Alpha", "2,Beta", "3,Gamma"] },
    { direction: "asc", filtered: false, pinned: true, expected: ["2,Beta", "1,Alpha", "3,Gamma"] },
    { direction: "desc", filtered: false, pinned: false, expected: ["1,Gamma", "2,Beta", "3,Alpha"] },
    { direction: "desc", filtered: false, pinned: true, expected: ["2,Beta", "1,Gamma", "3,Alpha"] },
    { direction: "asc", filtered: true, pinned: false, expected: ["1,Alpha", "2,Beta"] },
    { direction: "asc", filtered: true, pinned: true, expected: ["2,Beta", "1,Alpha"] },
    { direction: "desc", filtered: true, pinned: false, expected: ["1,Beta", "2,Alpha"] },
    { direction: "desc", filtered: true, pinned: true, expected: ["1,Beta", "2,Alpha"] },
  ] as const)("exports pre-pin ranks in full displayed order ($direction, filtered=$filtered, pinned=$pinned)", ({
    direction, filtered, pinned, expected,
  }) => {
    downloadCsvMock.mockReset();
    const rows = [
      makeCoin("alpha", "Alpha", { circulating: { peggedUSD: 10 } }),
      makeCoin("beta", "Beta", { circulating: { peggedUSD: 20 } }),
      makeCoin("gamma", "Gamma", { circulating: { peggedUSD: 30 } }),
    ];
    const eligibleIds = new Set(filtered ? ["alpha", "beta"] : ["alpha", "beta", "gamma"]);
    const sorted = sortStablecoins({
      filtered: filterStablecoins(rows, eligibleIds, ""),
      sort: { key: "mcap", direction },
      effectiveSortKey: "mcap",
    });
    const sortedRankById = new Map(sorted.map((row, index) => [row.id, index + 1]));
    const displayed = prioritizePinnedStablecoins(sorted, pinned ? ["beta"] : []);
    exportStablecoinsCsv(displayed, sortedRankById);
    const [exported, columns] = downloadCsvMock.mock.calls[0]! as [StablecoinData[], CsvColumn<StablecoinData>[]];
    expect(exported).toBe(displayed);
    expect(buildCsvBody(exported, columns.filter((column) => ["Rank", "Name"].includes(column.header))))
      .toEqual(["Rank,Name", ...expected]);
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

});

describe("blacklistable projection", () => {
  const freezePossible = (id: string) =>
    makeV9Card({ id, accessPosture: { ...makeV9Card().accessPosture, freezeExposure: "possible" } });

  it("sorts reviewed FreezeWatch status before stale V9 freeze exposure", () => {
    const lusd = makeCoin("lusd-liquity", "Liquity USD");
    const runtimePossible = makeCoin("runtime-possible", "Runtime Possible");

    const result = sortStablecoins({
      filtered: [runtimePossible, lusd],
      sort: sortAsc("blacklistable"),
      effectiveSortKey: "blacklistable",
      reportCards: safetyTableRows([freezePossible("lusd-liquity"), freezePossible("runtime-possible")]),
    });

    expect(result.map((row) => row.id)).toEqual(["lusd-liquity", "runtime-possible"]);
  });

  it("exports reviewed FreezeWatch status before stale V9 freeze exposure", () => {
    downloadCsvMock.mockReset();
    const lusd = makeCoin("lusd-liquity", "Liquity USD");

    exportStablecoinsCsv([lusd], new Map([["lusd-liquity", 1]]), undefined, undefined, safetyTableRows([freezePossible("lusd-liquity")]));

    const [, columns] = downloadCsvMock.mock.calls[0]! as [
      StablecoinData[],
      CsvColumn<StablecoinData>[],
      string,
    ];
    const blacklistColumn = columns.find((column) => column.header === "Blacklistable");
    expect(blacklistColumn?.accessor(lusd, 0)).toBe("No");
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
    exportStablecoinsCsv([missing], new Map([["missing", 1]]));
    const [, columns] = downloadCsvMock.mock.calls[0]! as [
      StablecoinData[],
      CsvColumn<StablecoinData>[],
      string,
    ];
    const changeColumn = columns.find((column) => column.header === "24h Change (%)");
    expect(changeColumn?.accessor(missing, 0)).toBeNull();
  });
});

interface ComparatorRow {
  name: string;
  value: number;
  score: number | null;
}

describe("createTableComparator", () => {
  it.each<{
    name: string;
    key: keyof ComparatorRow;
    direction: "asc" | "desc";
    nullPosition?: "first";
    rows: ComparatorRow[];
    expected: (number | string | null)[];
  }>([
    {
      name: "sorts numbers ascending", key: "value", direction: "asc",
      rows: [{ name: "B", value: 20, score: null }, { name: "A", value: 10, score: null }],
      expected: [10, 20],
    },
    {
      name: "sorts strings ascending", key: "name", direction: "asc",
      rows: [{ name: "Banana", value: 1, score: null }, { name: "Apple", value: 2, score: null }],
      expected: ["Apple", "Banana"],
    },
    {
      name: "sorts null after non-null ascending by default", key: "score", direction: "asc",
      rows: [{ name: "A", value: 1, score: null }, { name: "B", value: 2, score: 50 }],
      expected: [50, null],
    },
    {
      name: "sorts null before non-null ascending when configured", key: "score", direction: "asc", nullPosition: "first",
      rows: [{ name: "B", value: 2, score: 50 }, { name: "A", value: 1, score: null }],
      expected: [null, 50],
    },
    {
      name: "sorts mixed null and non-null entries descending", key: "score", direction: "desc",
      rows: [
        { name: "A", value: 1, score: null }, { name: "B", value: 2, score: 80 },
        { name: "C", value: 3, score: null }, { name: "D", value: 4, score: 30 },
        { name: "E", value: 5, score: 60 },
      ],
      expected: [80, 60, 30, null, null],
    },
  ])("$name", ({ key, direction, nullPosition, rows, expected }) => {
    const compare = createTableComparator<keyof ComparatorRow, ComparatorRow>({
      name: (r) => r.name, value: (r) => r.value, score: (r) => r.score,
    }, nullPosition ? { nullPosition } : undefined);
    rows.sort((a, b) => compare(a, b, { key, direction }));
    expected.forEach((value, index) => {
      if (value === null) expect(rows[index][key]).toBeNull();
      else expect(rows[index][key]).toBe(value);
    });
  });

  it("returns 0 for an unrecognized key", () => {
    const compare = createTableComparator<keyof ComparatorRow, ComparatorRow>({
      name: (r) => r.name, value: (r) => r.value, score: (r) => r.score,
    });
    expect(compare(
      { name: "A", value: 1, score: null },
      { name: "B", value: 2, score: null },
      { key: "unknown" as "name", direction: "asc" },
    )).toBe(0);
  });
});
