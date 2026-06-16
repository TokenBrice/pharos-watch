import { describe, expect, it } from "vitest";
import { resolveRotatedConfigs } from "../mint-burn/run-state";

describe("resolveRotatedConfigs", () => {
  const configs = [
    { key: "ethereum-0xaaa" },
    { key: "ethereum-0xbbb" },
    { key: "ethereum-0xccc" },
  ];
  const keyFn = (c: { key: string }) => c.key;

  it("starts after the last-processed config", () => {
    expect(resolveRotatedConfigs("ethereum-0xaaa", configs, keyFn)).toEqual([
      configs[1], configs[2], configs[0],
    ]);
    expect(resolveRotatedConfigs("ethereum-0xbbb", configs, keyFn)).toEqual([
      configs[2], configs[0], configs[1],
    ]);
  });

  it("wraps around at end of list", () => {
    expect(resolveRotatedConfigs("ethereum-0xccc", configs, keyFn)).toEqual([
      configs[0], configs[1], configs[2],
    ]);
  });

  it("returns original order when key not found (config was removed)", () => {
    expect(resolveRotatedConfigs("ethereum-0xzzz", configs, keyFn)).toEqual(configs);
  });

  it("returns original order when key is null (first run)", () => {
    expect(resolveRotatedConfigs(null, configs, keyFn)).toEqual(configs);
  });

  it("returns empty array for empty config list", () => {
    expect(resolveRotatedConfigs("ethereum-0xaaa", [], keyFn)).toEqual([]);
  });
});
