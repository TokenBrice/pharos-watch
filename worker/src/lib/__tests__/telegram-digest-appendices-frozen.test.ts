import { describe, expect, it } from "vitest";
import { diffFrozenIds } from "../telegram/digest-appendices";

describe("diffFrozenIds", () => {
  it("returns an empty set when nothing changed", () => {
    expect(diffFrozenIds(new Set(["usr-resolv"]), new Set(["usr-resolv"]))).toEqual(new Set());
  });

  it("returns newly added frozen ids", () => {
    expect(diffFrozenIds(new Set(["usr-resolv"]), new Set())).toEqual(new Set(["usr-resolv"]));
  });

  it("ignores removals (un-freezing is out of scope)", () => {
    expect(diffFrozenIds(new Set(), new Set(["usr-resolv"]))).toEqual(new Set());
  });
});
