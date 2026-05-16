import { describe, expect, it } from "vitest";
import {
  SCREENER_FILTER_DEFAULTS,
  SCREENER_URL_SCHEMA,
  applyFilters,
  hasActiveFilters,
  type ScreenerFilters,
  type ScreenerRow,
} from "./screener-filters";
import { decodeState, encodeState } from "@/lib/url-state";

function makeRow(overrides: Partial<ScreenerRow> = {}): ScreenerRow {
  return {
    id: "usdc-circle",
    name: "USD Coin",
    symbol: "USDC",
    lifecycle: "active",
    mechanism: "fiat-cash",
    peg: "USD",
    supplyUsd: 50_000_000_000,
    pegScore: 95,
    dewsScore: 20,
    liquidityScore: 85,
    safetyGrade: "A",
    safetyScore: 90,
    ...overrides,
  };
}

describe("applyFilters", () => {
  const rows: ScreenerRow[] = [
    makeRow(),
    makeRow({
      id: "dai-makerdao",
      name: "Dai",
      symbol: "DAI",
      mechanism: "cdp",
      pegScore: 88,
      dewsScore: 35,
      liquidityScore: 70,
      safetyScore: 80,
      safetyGrade: "B+",
      supplyUsd: 5_000_000_000,
    }),
    makeRow({
      id: "eurs-stasis",
      name: "STASIS Euro",
      symbol: "EURS",
      mechanism: "fiat-cash",
      peg: "EUR",
      pegScore: 70,
      dewsScore: 50,
      liquidityScore: 40,
      supplyUsd: 100_000_000,
      safetyGrade: "C+",
      safetyScore: 65,
    }),
    makeRow({
      id: "newcoin",
      name: "Brand New",
      symbol: "NEW",
      mechanism: null,
      pegScore: null,
      dewsScore: null,
      liquidityScore: null,
      supplyUsd: 1_000_000,
      lifecycle: "pre-launch",
      safetyGrade: null,
      safetyScore: null,
    }),
  ];

  it("returns all rows when no filter is active", () => {
    expect(applyFilters(rows, SCREENER_FILTER_DEFAULTS)).toHaveLength(rows.length);
  });

  it("filters by PegScore min, excluding unrated rows", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, pegScoreMin: 90 };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id)).toEqual(["usdc-circle"]);
  });

  it("filters by DEWS max, excluding unrated rows", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, dewsMax: 40 };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id).sort()).toEqual(["dai-makerdao", "usdc-circle"]);
  });

  it("filters by liquidity score range", () => {
    const filters: ScreenerFilters = {
      ...SCREENER_FILTER_DEFAULTS,
      liquidityMin: 50,
      liquidityMax: 80,
    };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id)).toEqual(["dai-makerdao"]);
  });

  it("filters by supply min only when min > 0", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, supplyMin: 1_000_000_000 };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id).sort()).toEqual(["dai-makerdao", "usdc-circle"]);
  });

  it("filters by supply max only when max > 0", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, supplyMax: 1_000_000_000 };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id).sort()).toEqual(["eurs-stasis", "newcoin"]);
  });

  it("filters by mechanism (multi-select)", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, mechanisms: ["cdp"] };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id)).toEqual(["dai-makerdao"]);
  });

  it("excludes rows with null mechanism when mechanism filter is active", () => {
    const filters: ScreenerFilters = {
      ...SCREENER_FILTER_DEFAULTS,
      mechanisms: ["cdp", "fiat-cash"],
    };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id).sort()).toEqual([
      "dai-makerdao",
      "eurs-stasis",
      "usdc-circle",
    ]);
    expect(result.find((r) => r.id === "newcoin")).toBeUndefined();
  });

  it("filters by peg currency (multi-select)", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, pegs: ["EUR"] };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id)).toEqual(["eurs-stasis"]);
  });

  it("filters by lifecycle status", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, lifecycle: ["pre-launch"] };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id)).toEqual(["newcoin"]);
  });

  it("retains unrated rows when score range is at defaults", () => {
    const filters: ScreenerFilters = {
      ...SCREENER_FILTER_DEFAULTS,
      pegs: ["USD"],
    };
    const result = applyFilters(rows, filters);
    // newcoin has no peg/dews/liquidity score but is still USD and active default
    // so it should pass the peg filter.
    expect(result.find((r) => r.id === "newcoin")).toBeDefined();
  });
});

describe("hasActiveFilters", () => {
  it("reports false for defaults", () => {
    expect(hasActiveFilters(SCREENER_FILTER_DEFAULTS)).toBe(false);
  });

  it("reports true when any range or multi-select is narrowed", () => {
    expect(hasActiveFilters({ ...SCREENER_FILTER_DEFAULTS, pegScoreMin: 50 })).toBe(true);
    expect(hasActiveFilters({ ...SCREENER_FILTER_DEFAULTS, mechanisms: ["cdp"] })).toBe(true);
    expect(hasActiveFilters({ ...SCREENER_FILTER_DEFAULTS, supplyMin: 1 })).toBe(true);
  });
});

describe("SCREENER_URL_SCHEMA codec", () => {
  it("round-trips a non-default filter set", () => {
    const filters: ScreenerFilters = {
      ...SCREENER_FILTER_DEFAULTS,
      pegScoreMin: 80,
      dewsMax: 40,
      mechanisms: ["cdp", "fiat-cash"],
      pegs: ["USD", "EUR"],
    };
    const encoded = encodeState(filters, SCREENER_URL_SCHEMA);
    expect(encoded).toContain("pegScoreMin=80");
    expect(encoded).toContain("dewsMax=40");
    expect(encoded).toContain("mechanisms=cdp%2Cfiat-cash");
    const decoded = decodeState(encoded, SCREENER_URL_SCHEMA);
    expect(decoded.pegScoreMin).toBe(80);
    expect(decoded.dewsMax).toBe(40);
    expect(decoded.mechanisms).toEqual(["cdp", "fiat-cash"]);
    expect(decoded.pegs).toEqual(["USD", "EUR"]);
  });

  it("omits defaults from the encoded URL", () => {
    expect(encodeState(SCREENER_FILTER_DEFAULTS, SCREENER_URL_SCHEMA)).toBe("");
  });

  it("decodes an empty query string to defaults", () => {
    expect(decodeState("", SCREENER_URL_SCHEMA)).toEqual(SCREENER_FILTER_DEFAULTS);
  });

  it("clamps out-of-range numbers to defaults", () => {
    const decoded = decodeState(
      "pegScoreMin=999&dewsMin=-5&supplyMin=-1",
      SCREENER_URL_SCHEMA,
    );
    expect(decoded.pegScoreMin).toBe(SCREENER_FILTER_DEFAULTS.pegScoreMin);
    expect(decoded.dewsMin).toBe(SCREENER_FILTER_DEFAULTS.dewsMin);
    expect(decoded.supplyMin).toBe(SCREENER_FILTER_DEFAULTS.supplyMin);
  });

  it("drops unknown enum values from multi-selects", () => {
    const decoded = decodeState(
      "mechanisms=cdp,unknown-archetype,fiat-cash",
      SCREENER_URL_SCHEMA,
    );
    expect(decoded.mechanisms).toEqual(["cdp", "fiat-cash"]);
  });
});
