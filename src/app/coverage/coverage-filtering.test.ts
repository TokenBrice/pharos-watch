import { describe, expect, it } from "vitest";
import { COVERAGE_FEATURES, type CoverageFeatureKey, type CoverageRow, type CoverageStatus } from "@/lib/coverage";
import type { CoverageFilterKey } from "@/lib/coverage-page-config";
import { filterCoverageRows, hasCoverageFilters, matchesCoverageFilter, sortCoverageRows } from "@/lib/coverage-filtering";

// The full-coverage filters are defined against the shipped feature registry.
const FEATURE_COUNT = COVERAGE_FEATURES.length;

function status(kind: string, available: boolean, sortRank = available ? 1 : 0): CoverageStatus {
  return {
    kind,
    label: kind,
    spokenLabel: kind,
    tone: "slate",
    available,
    sortRank,
    detail: kind,
  };
}

function defaultStatuses(): Record<CoverageFeatureKey, CoverageStatus> {
  return {
    price: status("tracked", true),
    safety: status("tracked", true),
    dex: status("tracked", true),
    reserves: status("none", false),
    redemption: status("none", false),
    yield: status("none", false),
    flows: status("none", false),
    blacklist: status("none", false),
    dependency: status("tracked", true),
    mintAuthority: status("unknown", false),
    mica: status("unassessed", false),
    genius: status("unassessed", false),
  };
}

type RowOverrides = Partial<Omit<CoverageRow, "statuses">> &
  Pick<CoverageRow, "id" | "name" | "symbol"> & { statuses?: Partial<Record<CoverageFeatureKey, CoverageStatus>> };

function makeRow(overrides: RowOverrides): CoverageRow {
  const { blacklistStatus = null, statuses, ...rowOverrides } = overrides;
  return {
    marketCapUsd: 0,
    pegLabel: "Tracked",
    backingLabel: "Curated",
    governanceLabel: "Neutral",
    coverageCount: 0,
    headlineCoverageCount: 0,
    advancedCoverageCount: 0,
    blacklistStatus,
    statuses: { ...defaultStatuses(), ...statuses },
    ...rowOverrides,
  };
}

const rows: CoverageRow[] = [
  makeRow({
    id: "alpha",
    name: "Alpha Stable",
    symbol: "ALP",
    marketCapUsd: 100,
    coverageCount: 2,
    headlineCoverageCount: 1,
    advancedCoverageCount: 1,
    statuses: {
      price: { ...status("tracked", true, 2), sourceCount: 2 },
      dex: status("none", false),
    },
  }),
  makeRow({
    id: "beta",
    name: "Beta Dollar",
    symbol: "BET",
    marketCapUsd: 300,
    coverageCount: 4,
    headlineCoverageCount: 4,
    advancedCoverageCount: 2,
    statuses: {
      price: { ...status("tracked", true, 4), sourceCount: 4 },
      dex: status("tracked", true, 2),
      reserves: status("live", true),
      redemption: status("configured", true),
      yield: status("available", true),
      blacklist: status("live", true),
      mintAuthority: status("issuer-or-backend-mint", true),
    },
  }),
  makeRow({
    id: "gamma",
    name: "Gamma Coin",
    symbol: "GAM",
    marketCapUsd: 300,
    coverageCount: 4,
    headlineCoverageCount: 3,
    advancedCoverageCount: 1,
    statuses: {
      price: { ...status("tracked", true, 3), sourceCount: 3 },
      dex: status("tracked", true, 1),
      flows: status("available", true),
    },
  }),
  makeRow({
    id: "delta",
    name: "Delta Token",
    symbol: "DEL",
    marketCapUsd: 50,
    coverageCount: 5,
    headlineCoverageCount: 5,
    advancedCoverageCount: 5,
    statuses: { price: { ...status("tracked", true, 5), sourceCount: 5 } },
  }),
];

// Sort fixtures stay minimal; filter fixtures add the safety/dependency gaps.
const filterRows: CoverageRow[] = [
  ...rows,
  makeRow({ id: "unsafe", name: "Unsafe Yield", symbol: "UNF", statuses: { safety: status("unassessed", false) } }),
  makeRow({ id: "nodep", name: "No Dependency", symbol: "NDP", statuses: { dependency: status("unassessed", false) } }),
];

describe("coverage filtering", () => {
  it("sorts by market cap, then name when caps tie", () => {
    const sorted = sortCoverageRows(rows, "market-cap");

    expect(sorted.map((row) => row.id)).toEqual(["beta", "gamma", "alpha", "delta"]);
  });

  it("sorts by most covered, then advanced coverage, then market cap", () => {
    const sorted = sortCoverageRows(rows, "most-covered");

    expect(sorted.map((row) => row.id)).toEqual(["delta", "beta", "gamma", "alpha"]);
  });

  it("sorts by least available coverage and headline coverage", () => {
    const sorted = sortCoverageRows(rows, "least-covered");

    expect(sorted.map((row) => row.id)).toEqual(["alpha", "gamma", "beta", "delta"]);
  });

  it("sorts by weakest feature status rank", () => {
    const sorted = sortCoverageRows(rows, "weakest-dex");

    expect(sorted.map((row) => row.id)).toEqual(["alpha", "gamma", "delta", "beta"]);
  });

  it("sorts alphabetically by name", () => {
    const sorted = sortCoverageRows(rows, "name");

    expect(sorted.map((row) => row.id)).toEqual(["alpha", "beta", "delta", "gamma"]);
  });

  it("orders most/least-headline by headline count even when coverage and market cap disagree", () => {
    const conflict = [
      makeRow({ id: "wide", name: "Wide Coin", symbol: "WID", marketCapUsd: 100, coverageCount: 6, headlineCoverageCount: 2 }),
      makeRow({ id: "deep", name: "Deep Coin", symbol: "DEP", marketCapUsd: 100, coverageCount: 2, headlineCoverageCount: 6 }),
    ];

    expect(sortCoverageRows(conflict, "most-headline").map((row) => row.id)).toEqual(["deep", "wide"]);
    expect(sortCoverageRows(conflict, "least-headline").map((row) => row.id)).toEqual(["wide", "deep"]);
    expect(sortCoverageRows(conflict, "most-covered").map((row) => row.id)).toEqual(["wide", "deep"]);
    expect(sortCoverageRows(conflict, "least-covered").map((row) => row.id)).toEqual(["deep", "wide"]);
  });

  it("breaks headline ties by coverage count and then market cap in both directions", () => {
    const tied = [
      makeRow({ id: "small", name: "Small Cap", symbol: "SML", marketCapUsd: 10, coverageCount: 5, headlineCoverageCount: 3 }),
      makeRow({ id: "large", name: "Large Cap", symbol: "LRG", marketCapUsd: 900, coverageCount: 5, headlineCoverageCount: 3 }),
    ];

    expect(sortCoverageRows(tied, "most-headline").map((row) => row.id)).toEqual(["large", "small"]);
    expect(sortCoverageRows(tied, "least-headline").map((row) => row.id)).toEqual(["large", "small"]);
  });

  it("resolves coverage ties by market cap and leaves the input array untouched", () => {
    const input = [
      makeRow({ id: "small", name: "Small Cap", symbol: "SML", marketCapUsd: 1, coverageCount: 3, headlineCoverageCount: 3 }),
      makeRow({ id: "large", name: "Large Cap", symbol: "LRG", marketCapUsd: 500, coverageCount: 3, headlineCoverageCount: 3 }),
    ];

    expect(sortCoverageRows(input, "most-covered").map((row) => row.id)).toEqual(["large", "small"]);
    expect(input.map((row) => row.id)).toEqual(["small", "large"]);
  });

  it.each<[CoverageFilterKey, string[]]>([
    ["redemption", ["beta"]],
    ["live-reserves", ["beta"]],
    ["yield", ["beta"]],
    ["flows", ["gamma"]],
    ["weak-price", ["alpha", "unsafe", "nodep"]],
    ["blacklist", ["beta"]],
    ["price-2-sources", ["alpha"]],
    ["missing-safety", ["unsafe"]],
    ["missing-dex", ["alpha"]],
    ["missing-live-reserves", ["alpha", "gamma", "delta", "unsafe", "nodep"]],
    ["missing-dependency", ["nodep"]],
    ["missing-flows", ["alpha", "beta", "delta", "unsafe", "nodep"]],
    ["full-available", []],
    ["full-headline", []],
  ])("matches %s coverage against the expected rows", (filter, expectedIds) => {
    const matches = filterRows.filter((row) => matchesCoverageFilter(row, filter));

    expect(matches.map((row) => row.id)).toEqual(expectedIds);
  });

  it("matches full-coverage filters only at the exact feature-count boundary", () => {
    const full = makeRow({ id: "full", name: "Full House", symbol: "FUL", coverageCount: FEATURE_COUNT, headlineCoverageCount: FEATURE_COUNT });
    const coverageOnly = makeRow({ id: "cov-only", name: "Coverage Only", symbol: "COV", coverageCount: FEATURE_COUNT, headlineCoverageCount: FEATURE_COUNT - 1 });
    const short = makeRow({ id: "short", name: "Short One", symbol: "SRT", coverageCount: FEATURE_COUNT - 1, headlineCoverageCount: FEATURE_COUNT - 1 });
    const candidates = [full, coverageOnly, short];

    expect(candidates.filter((row) => matchesCoverageFilter(row, "full-available")).map((row) => row.id)).toEqual(["full", "cov-only"]);
    expect(candidates.filter((row) => matchesCoverageFilter(row, "full-headline")).map((row) => row.id)).toEqual(["full"]);
  });

  it("excludes price-only rows from weak-price regardless of source count and reads a missing count as zero", () => {
    const priceOnly = makeRow({
      id: "p-only",
      name: "Price Only",
      symbol: "PON",
      statuses: { price: { ...status("price-only", false), sourceCount: 1 } },
    });
    const uncounted = makeRow({ id: "no-count", name: "No Count", symbol: "NOC" });

    expect(matchesCoverageFilter(priceOnly, "weak-price")).toBe(false);
    expect(matchesCoverageFilter(priceOnly, "price-2-sources")).toBe(false);
    expect(matchesCoverageFilter(uncounted, "weak-price")).toBe(true);
    expect(matchesCoverageFilter(uncounted, "price-2-sources")).toBe(false);
  });

  it.each<[string, boolean]>([
    ["none", false],
    ["data-unavailable", false],
    ["modeled-heuristic", true],
    ["resolved-unscored", true],
    ["impaired", true],
    ["offchain-issuer", true],
  ])("redemption quick filter admits the %s state only outside none/data-unavailable", (kind, expected) => {
    const row = makeRow({
      id: kind,
      name: kind,
      symbol: kind.toUpperCase(),
      statuses: { redemption: status(kind, kind === "offchain-issuer") },
    });

    expect(matchesCoverageFilter(row, "redemption")).toBe(expected);
  });

  it("filters by search across names and tickers with trimming and case folding", () => {
    const byName = filterCoverageRows(rows, "all", "market-cap", "  ga ");
    const bySymbol = filterCoverageRows(rows, "all", "market-cap", " alp ");

    expect(byName.map((row) => row.id)).toEqual(["gamma"]);
    expect(bySymbol.map((row) => row.id)).toEqual(["alpha"]);
  });

  it("intersects search with an active feature filter instead of widening it", () => {
    expect(filterCoverageRows(rows, "yield", "market-cap", "bet").map((row) => row.id)).toEqual(["beta"]);
    // Alpha matches the search but has no yield data, so it must stay excluded.
    expect(filterCoverageRows(rows, "yield", "market-cap", "alp").map((row) => row.id)).toEqual([]);
  });

  it("reports whether any filters are active", () => {
    expect(hasCoverageFilters("all", "   ")).toBe(false);
    expect(hasCoverageFilters("yield", "")).toBe(true);
    expect(hasCoverageFilters("all", " beta ")).toBe(true);
  });
});
