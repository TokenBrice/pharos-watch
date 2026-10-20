import { describe, expect, expectTypeOf, it } from "vitest";
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

it("admits only schema kinds and options compatible with the state value", () => {
  expectTypeOf(decodeState("", schema)).toEqualTypeOf<SampleState>();
  expectTypeOf<UrlStateSchema<SampleState>["page"]["kind"]>().toEqualTypeOf<"boundedNumber">();
  expectTypeOf<UrlStateSchema<SampleState>["expanded"]["kind"]>().toEqualTypeOf<"boolean">();
  expectTypeOf<UrlStateSchema<SampleState>["pegs"]["kind"]>().toEqualTypeOf<"enumList">();
  // @ts-expect-error Numeric fields cannot use a string decoder.
  const numeric: UrlStateSchema<{ page: number }> = { page: { kind: "string", defaultValue: 1 } };
  // @ts-expect-error Scalar fields cannot use a list decoder.
  const scalar: UrlStateSchema<{ query: string }> = { query: { kind: "enumList", defaultValue: "" } };
  // @ts-expect-error Enum options must belong to the declared literal union.
  const enumValue: UrlStateSchema<Pick<SampleState, "view">> = { view: { kind: "enum", defaultValue: "table", allowedValues: ["other"] } };
  // @ts-expect-error List options must belong to the declared item union.
  const listValue: UrlStateSchema<Pick<SampleState, "pegs">> = { pegs: { kind: "enumList", defaultValue: [], allowedValues: ["jpy"] } };
  void [numeric, scalar, enumValue, listValue];
});

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

  it("normalizes list items before filtering, deduplication and limiting", () => {
    const normalizedSchema: UrlStateSchema<Pick<SampleState, "pegs">> = {
      pegs: { ...schema.pegs, delimiter: "|", maxItems: 2, normalizeItem: (value) => {
        const item = value.toLowerCase();
        return item === "usd" || item === "eur" || item === "gbp" ? item : null;
      } },
    };
    const decoded = decodeState("pegs=USD|usd|skip|EUR|GBP", normalizedSchema);
    expect(decoded.pegs).toEqual(["usd", "eur"]);
    expect(encodeState(decoded, normalizedSchema)).toBe("pegs=usd%7Ceur");
    expect(decodeState(encodeState(decoded, normalizedSchema), normalizedSchema)).toEqual(decoded);
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
