import { describe, expect, it } from "vitest";
import { canonicalUniqueBy, parentAttributionFields } from "@shared/lib/safety-score-v9/primitives";

describe("Safety Score V9 canonical primitives", () => {
  it.each(["first", "last"] as const)("retains the %s duplicate payload and sorts without mutating inputs", (keep) => {
    const values = [
      { key: "b", payload: 1 },
      { key: "a", payload: 2 },
      { key: "b", payload: 3 },
      { key: "c", payload: 4 },
    ];
    const before = structuredClone(values);
    expect(canonicalUniqueBy(values, (value) => value.key, (a, b) => a.key.localeCompare(b.key), keep)).toEqual([
      { key: "a", payload: 2 },
      { key: "b", payload: keep === "first" ? 1 : 3 },
      { key: "c", payload: 4 },
    ]);
    expect(values).toEqual(before);
  });

  it("attributes fresh explanations once and preserves same-parent attribution on repetition", () => {
    const context = { pathPrefix: "parent:usdc:", messagePrefix: "Required parent usdc: " };
    const fresh = { source: "evidence", path: "reserve:cash", message: "Reserve evidence is stale." };
    const expected = {
      path: "parent:usdc:reserve:cash",
      message: "Required parent usdc: Reserve evidence is stale.",
    };
    expect(parentAttributionFields(fresh, context)).toEqual(expected);
    expect(parentAttributionFields({ source: "parent-score", ...expected }, context)).toEqual(expected);
  });
});
