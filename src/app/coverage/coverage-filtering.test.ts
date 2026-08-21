import { describe, expect, it } from "vitest";
import type { CoverageRow, CoverageStatus } from "@/lib/coverage";
import type { CoverageFeatureKey } from "@/lib/coverage";
import type { CoverageFilterKey } from "@/lib/coverage-page-config";
import { filterCoverageRows, hasCoverageFilters, matchesCoverageFilter, sortCoverageRows } from "./coverage-filtering";

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

function makeRow(overrides: Partial<CoverageRow> & Pick<CoverageRow, "id" | "name" | "symbol">): CoverageRow {
  const { blacklistStatus = null, ...rowOverrides } = overrides;
  const statuses: Record<CoverageFeatureKey, CoverageStatus> = {
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

  return {
    marketCapUsd: 0,
    pegLabel: "Tracked",
    backingLabel: "Curated",
    governanceLabel: "Neutral",
    coverageCount: 0,
    headlineCoverageCount: 0,
    advancedCoverageCount: 0,
    blacklistStatus,
    statuses,
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
      safety: status("tracked", true),
      dex: status("none", false),
      reserves: status("none", false),
      redemption: status("none", false),
      yield: status("none", false),
      flows: status("none", false),
      blacklist: status("none", false),
      dependency: status("tracked", true),
      mintAuthority: status("unknown", false),
      mica: status("unassessed", false),
      genius: status("unassessed", false),
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
      safety: status("tracked", true),
      dex: status("tracked", true, 2),
      reserves: status("live", true),
      redemption: status("configured", true),
      yield: status("available", true),
      flows: status("none", false),
      blacklist: status("live", true),
      dependency: status("tracked", true),
      mintAuthority: status("issuer-or-backend-mint", true),
      mica: status("unassessed", false),
      genius: status("unassessed", false),
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
      safety: status("tracked", true),
      dex: status("tracked", true, 1),
      reserves: status("none", false),
      redemption: status("none", false),
      yield: status("none", false),
      flows: status("available", true),
      blacklist: status("none", false),
      dependency: status("tracked", true),
      mintAuthority: status("unknown", false),
      mica: status("unassessed", false),
      genius: status("unassessed", false),
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
    statuses: {
      price: { ...status("tracked", true, 5), sourceCount: 5 },
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
    },
  }),
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

  it.each<[CoverageFilterKey, string[]]>([
    ["redemption", ["beta"]],
    ["live-reserves", ["beta"]],
    ["yield", ["beta"]],
    ["flows", ["gamma"]],
    ["blacklist", ["beta"]],
    ["weak-price", ["alpha"]],
    ["price-2-sources", ["alpha"]],
    ["missing-safety", []],
    ["missing-dex", ["alpha"]],
    ["missing-live-reserves", ["alpha", "gamma", "delta"]],
    ["missing-flows", ["alpha", "beta", "delta"]],
    ["missing-dependency", []],
    ["full-available", []],
    ["full-headline", []],
  ])("matches %s coverage against the expected rows", (filter, expectedIds) => {
    const matches = rows.filter((row) => matchesCoverageFilter(row, filter));

    expect(matches.map((row) => row.id)).toEqual(expectedIds);
  });

  it("matches redemption quick filter for configured states but excludes Data n/a", () => {
    const redemptionRows = [
      makeRow({
        id: "none",
        name: "No Route",
        symbol: "NONE",
        statuses: {
          ...rows[0].statuses,
          redemption: status("none", false),
        },
      }),
      makeRow({
        id: "data-na",
        name: "Data NA",
        symbol: "DNA",
        statuses: {
          ...rows[0].statuses,
          redemption: status("data-unavailable", false),
        },
      }),
      makeRow({
        id: "heuristic",
        name: "Heuristic Route",
        symbol: "HEUR",
        statuses: {
          ...rows[0].statuses,
          redemption: status("modeled-heuristic", false),
        },
      }),
      makeRow({
        id: "resolved",
        name: "Resolved Route",
        symbol: "RES",
        statuses: {
          ...rows[0].statuses,
          redemption: status("resolved-unscored", false),
        },
      }),
      makeRow({
        id: "impaired",
        name: "Impaired Route",
        symbol: "IMP",
        statuses: {
          ...rows[0].statuses,
          redemption: status("impaired", false),
        },
      }),
      makeRow({
        id: "scored",
        name: "Scored Route",
        symbol: "SCR",
        statuses: {
          ...rows[0].statuses,
          redemption: status("offchain-issuer", true),
        },
      }),
    ];

    expect(redemptionRows.filter((row) => matchesCoverageFilter(row, "redemption")).map((row) => row.id)).toEqual([
      "heuristic",
      "resolved",
      "impaired",
      "scored",
    ]);
  });

  it("filters by search across names and tickers with trimming and case folding", () => {
    const byName = filterCoverageRows(rows, "all", "market-cap", "  ga ");
    const bySymbol = filterCoverageRows(rows, "all", "market-cap", " alp ");

    expect(byName.map((row) => row.id)).toEqual(["gamma"]);
    expect(bySymbol.map((row) => row.id)).toEqual(["alpha"]);
  });

  it("reports whether any filters are active", () => {
    expect(hasCoverageFilters("all", "   ")).toBe(false);
    expect(hasCoverageFilters("yield", "")).toBe(true);
    expect(hasCoverageFilters("all", " beta ")).toBe(true);
  });
});
