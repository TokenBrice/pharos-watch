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

  it("accepts a leading '?'", () => {
    expect(decodeState("?view=grid&page=5", schema)).toMatchObject({
      view: "grid",
      page: 5,
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

  it("ignores unknown params", () => {
    const state = decodeState("foo=bar&view=grid", schema);
    expect(state).toEqual({
      view: "grid",
      page: 1,
      query: "",
      expanded: false,
      pegs: [],
    });
  });

  it("decodes booleans from true/false/1/0", () => {
    expect(decodeState("expanded=true", schema).expanded).toBe(true);
    expect(decodeState("expanded=1", schema).expanded).toBe(true);
    expect(decodeState("expanded=false", schema).expanded).toBe(false);
    expect(decodeState("expanded=0", schema).expanded).toBe(false);
  });

  it("trims and decodes string fields", () => {
    expect(decodeState("query=%20hello%20", schema).query).toBe("hello");
  });

  it("deduplicates enumList entries", () => {
    expect(decodeState("pegs=usd,usd,eur", schema).pegs).toEqual(["usd", "eur"]);
  });

  it("respects enumList maxItems", () => {
    const cappedSchema: UrlStateSchema<{ pegs: readonly string[] }> = {
      pegs: {
        kind: "enumList",
        defaultValue: [],
        allowedValues: ["usd", "eur", "gbp"],
        maxItems: 2,
      },
    };
    expect(decodeState("pegs=usd,eur,gbp", cappedSchema).pegs).toEqual(["usd", "eur"]);
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

  it("omits fields that match the default", () => {
    expect(encodeState(
      { view: "grid", page: 1, query: "", expanded: false, pegs: [] },
      schema,
    )).toBe("view=grid");
  });

  it("emits encoded params for all non-default fields", () => {
    const encoded = encodeState(
      { view: "grid", page: 5, query: "usdc", expanded: true, pegs: ["usd", "eur"] },
      schema,
    );
    const params = new URLSearchParams(encoded);
    expect(params.get("view")).toBe("grid");
    expect(params.get("page")).toBe("5");
    expect(params.get("query")).toBe("usdc");
    expect(params.get("expanded")).toBe("true");
    expect(params.get("pegs")).toBe("usd,eur");
  });

  it("orders keys alphabetically", () => {
    const encoded = encodeState(
      { view: "grid", page: 5, query: "x", expanded: true, pegs: ["usd"] },
      schema,
    );
    expect(encoded).toBe("expanded=true&page=5&pegs=usd&query=x&view=grid");
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

  it("encodes defaults to empty and decodes empty back to defaults", () => {
    const defaults: SampleState = {
      view: "table",
      page: 1,
      query: "",
      expanded: false,
      pegs: [],
    };
    const encoded = encodeState(defaults, schema);
    expect(encoded).toBe("");
    expect(decodeState(encoded, schema)).toEqual(defaults);
  });
});
