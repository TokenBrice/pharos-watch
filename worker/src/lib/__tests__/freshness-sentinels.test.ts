import { describe, expect, it } from "vitest";

import { getFreshnessSentinelConfigs } from "../freshness-sentinels";

describe("freshness sentinel configuration", () => {
  it("validates the complete configuration when first accessed and memoizes it", () => {
    const configs = getFreshnessSentinelConfigs();

    expect(Object.keys(configs).sort()).toEqual(["dews", "dex-liquidity", "yield-data"]);
    expect(getFreshnessSentinelConfigs()).toBe(configs);
  });
});
