import { describe, expect, it } from "vitest";
import { decodeState, encodeState, type UrlStateSchema } from "./url-state";

interface SampleState {
  view: "table" | "grid";
  page: number;
  query: string;
  expanded: boolean;
  pegs: readonly ("usd" | "eur" | "gbp")[];
}

interface NormalizedState {
  window: "7d" | "all";
  query: string;
}

const schema: UrlStateSchema<SampleState> = {
  view: { kind: "enum", defaultValue: "table", allowedValues: ["table", "grid"] },
  page: { kind: "boundedNumber", defaultValue: 1, min: 1, max: 100, integer: true },
  query: { kind: "string", defaultValue: "" },
  expanded: { kind: "boolean", defaultValue: false },
  pegs: {
    kind: "enumList",
    defaultValue: [] as readonly ("usd" | "eur" | "gbp")[],
    allowedValues: ["usd", "eur", "gbp"],
  },
};

describe("decodeState", () => {
  it("returns all defaults for an empty input", () => {
    expect(decodeState("", schema)).toEqual({
      view: "table",
      page: 1,
      query: "",
      expanded: false,
      pegs: [],
    });
  });

  it("accepts a URLSearchParams input", () => {
    const params = new URLSearchParams("view=grid");
    expect(decodeState(params, schema)).toMatchObject({ view: "grid" });
  });

  it("falls back to defaults for invalid enum, out-of-range number, and bad boolean", () => {
    const state = decodeState(
      "view=bogus&page=999&expanded=maybe&pegs=usd,jpy,eur",
      schema,
    );
    expect(state.view).toBe("table");
    expect(state.page).toBe(1);
    expect(state.expanded).toBe(false);
    expect(state.pegs).toEqual(["usd", "eur"]);
  });

  it.each([
    ["true", true], ["1", true], ["false", false], ["0", false],
  ] as const)("decodes expanded=%s as %s", (value, expected) => {
    expect(decodeState(`expanded=${value}`, schema).expanded).toBe(expected);
  });

  it.each([
    { name: "deduplicates enumList entries", query: "pegs=usd,usd,eur", maxItems: undefined },
    { name: "respects enumList maxItems", query: "pegs=usd,eur,gbp", maxItems: 2 },
  ])("$name", ({ query, maxItems }) => {
    const listSchema: UrlStateSchema<{ pegs: readonly string[] }> = {
      pegs: { kind: "enumList", defaultValue: [], allowedValues: ["usd", "eur", "gbp"], maxItems },
    };
    const state = maxItems === undefined ? decodeState(query, schema) : decodeState(query, listSchema);
    expect(state.pegs).toEqual(["usd", "eur"]);
  });

  it("normalizes enum aliases and preserves untrimmed string fields when configured", () => {
    const normalizedSchema: UrlStateSchema<NormalizedState> = {
      window: {
        kind: "enum",
        defaultValue: "7d",
        allowedValues: ["7d", "all"],
        normalize: (value) => value === "alltime" ? "all" : value,
        encode: (value) => value === "all" ? "alltime" : value,
      },
      query: { kind: "string", defaultValue: "", trim: false },
    };

    expect(decodeState("window=alltime&query=%20hello%20", normalizedSchema)).toEqual({
      window: "all",
      query: " hello ",
    });
    const encoded: NormalizedState = { window: "all", query: "" };
    expect(encodeState(encoded, normalizedSchema)).toBe("window=alltime");
  });
});

describe("encodeState", () => {
  it("returns an empty string when all fields are at default", () => {
    expect(encodeState(
      { view: "table", page: 1, query: "", expanded: false, pegs: [] },
      schema,
    )).toBe("");
  });

});

describe("round-trip", () => {
  it("preserves a non-default state across encode -> decode", () => {
    const state: SampleState = {
      view: "grid",
      page: 7,
      query: "usdc",
      expanded: true,
      pegs: ["usd", "gbp"],
    };
    expect(decodeState(encodeState(state, schema), schema)).toEqual(state);
  });

});
