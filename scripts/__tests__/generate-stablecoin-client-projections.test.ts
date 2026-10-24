import { describe, expect, it } from "vitest";
import {
  buildStablecoinClientProjections,
  PRE_LAUNCH_HUB_MIN_COINS,
} from "../build-data/generate-stablecoin-client-projections";

function coin(id: string, pegCurrency: string, status?: string) {
  return { id, name: id, symbol: id.toUpperCase(), ...(status ? { status } : {}), flags: { pegCurrency } };
}

describe("pre-launch hub pegs", () => {
  it("admits a peg with no active coin once it has enough pre-launch coins, never OTHER", () => {
    const active = [coin("usd-a", "USD"), coin("krw-a", "KRW")];
    const preLaunch = [
      coin("hkd-a", "HKD", "pre-launch"),
      coin("hkd-b", "HKD", "pre-launch"),
      coin("krw-b", "KRW", "pre-launch"),
      coin("krw-c", "KRW", "pre-launch"),
      coin("inr-a", "INR", "pre-launch"),
      coin("other-a", "OTHER", "pre-launch"),
      coin("other-b", "OTHER", "pre-launch"),
    ];
    const projection = buildStablecoinClientProjections({
      tracked: [...active, ...preLaunch],
      active,
      coreAggregateActive: active,
      activeVariants: [],
      activeStableValueInvestments: [],
      preLaunch,
      dead: [],
    });

    expect(PRE_LAUNCH_HUB_MIN_COINS).toBe(2);
    // KRW already has an active hub; INR has one coin; OTHER is not a currency.
    expect(projection.preLaunchHubPegCurrencies).toEqual(["HKD"]);
    expect(projection.activePegCurrencies).toEqual(["USD", "KRW"]);
  });
});
