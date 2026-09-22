import { describe, expect, it } from "vitest";
import { resolveCapacitySemantics } from "../redemption-backstop-confidence";
import { getRedemptionBackstopConfig } from "../redemption-backstops";

describe("getRedemptionBackstopConfig", () => {
  it("shares the Sky LitePSM capacity model across USDS and DAI", () => {
    const usds = getRedemptionBackstopConfig("usds-sky");
    const dai = getRedemptionBackstopConfig("dai-makerdao");

    expect(usds).not.toBeNull();
    expect(dai).not.toBeNull();
    expect(usds?.capacityModel).toEqual(dai?.capacityModel);
  });

  it.each(["frax-frax", "mai-qidao"])("keeps the explicitly unmodeled %s route absent", (id) => {
    expect(getRedemptionBackstopConfig(id)).toBeNull();
  });

  it.each([
    ["stkgho-umbrella-aave", "immediate-bounded"],
    ["usdrif-rif", "eventual-only"],
    ["susd1plus-lorenzo", "eventual-only"],
    ["witry-brix", "eventual-only"],
  ] as const)("resolves %s capacity as %s", (id, expected) => {
    const config = getRedemptionBackstopConfig(id);
    expect(config).not.toBeNull();
    expect(resolveCapacitySemantics(config!.capacityModel)).toBe(expected);
  });

  it.each([
    "uty-xsy",
    "hyusd-hylo",
    "dusd-dtrinity",
    "u-united-stables",
    "silk-shade-protocol",
    "satusd-river",
    "witry-brix",
    "dllr-sovryn",
    "deuro-deuro",
    "nect-beraborrow",
  ])("withholds unresolved output assets for %s", (id) => {
    const config = getRedemptionBackstopConfig(id);
    expect(config).not.toBeNull();
    expect(config?.outputAssets).toBeUndefined();
  });
});
