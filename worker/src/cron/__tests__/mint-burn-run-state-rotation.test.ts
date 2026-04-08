import { describe, expect, it } from "vitest";
import { resolveStartIndex } from "../mint-burn/run-state";

describe("resolveStartIndex", () => {
  const configs = [
    { key: "ethereum-0xaaa" },
    { key: "ethereum-0xbbb" },
    { key: "ethereum-0xccc" },
  ];
  const keyFn = (c: { key: string }) => c.key;

  it("returns index after the last-processed config", () => {
    expect(resolveStartIndex("ethereum-0xaaa", configs, keyFn)).toBe(1);
    expect(resolveStartIndex("ethereum-0xbbb", configs, keyFn)).toBe(2);
  });

  it("wraps around at end of list", () => {
    expect(resolveStartIndex("ethereum-0xccc", configs, keyFn)).toBe(0);
  });

  it("returns 0 when key not found (config was removed)", () => {
    expect(resolveStartIndex("ethereum-0xzzz", configs, keyFn)).toBe(0);
  });

  it("returns 0 when key is null (first run)", () => {
    expect(resolveStartIndex(null, configs, keyFn)).toBe(0);
  });

  it("returns 0 for empty config list", () => {
    expect(resolveStartIndex("ethereum-0xaaa", [], keyFn)).toBe(0);
  });
});
