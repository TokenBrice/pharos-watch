import { describe, expect, it } from "vitest";
import { resolveMintBurnResumeConfigKey, resolveRotatedConfigs } from "../mint-burn/run-state";

describe("resolveRotatedConfigs", () => {
  const configs = [
    { key: "ethereum-0xaaa" },
    { key: "ethereum-0xbbb" },
    { key: "ethereum-0xccc" },
  ];
  const keyFn = (c: { key: string }) => c.key;

  it("starts at the persisted resume frontier", () => {
    expect(resolveRotatedConfigs("ethereum-0xaaa", configs, keyFn)).toEqual([
      configs[0], configs[1], configs[2],
    ]);
    expect(resolveRotatedConfigs("ethereum-0xbbb", configs, keyFn)).toEqual([
      configs[1], configs[2], configs[0],
    ]);
  });

  it("wraps around at end of list", () => {
    expect(resolveRotatedConfigs("ethereum-0xccc", configs, keyFn)).toEqual([
      configs[2], configs[0], configs[1],
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

  it("covers 127 configs across two 94-config runs", () => {
    const fullSet = Array.from({ length: 127 }, (_, index) => ({ key: `config-${index}` }));
    const firstRun = fullSet.map((config, index) => ({
      key: config.key,
      skippedReason: index < 94 ? null : "runtime-budget-exhausted",
    }));
    const resumeKey = resolveMintBurnResumeConfigKey(firstRun);

    expect(resumeKey).toBe("config-94");
    const secondOrder = resolveRotatedConfigs(resumeKey, fullSet, keyFn);
    const attempted = new Set([
      ...fullSet.slice(0, 94).map((config) => config.key),
      ...secondOrder.slice(0, 94).map((config) => config.key),
    ]);
    expect(attempted.size).toBe(127);
  });
});
