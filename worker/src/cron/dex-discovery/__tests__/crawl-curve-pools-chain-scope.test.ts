import { describe, expect, it } from "vitest";
import {
  CURVE_NATIVE_DISCOVERY_CHAINS,
  getDexDiscoveryProviders,
} from "@shared/lib/dex-deployment-coverage";
import { CURVE_API_CHAIN_PATHS, CURVE_CHAINS } from "../../dex-liquidity/constants";

/**
 * The discovery Curve stage and the deployment-census provider registry used to
 * disagree: discovery queried all 13 chains the liquidity stage fetches, while
 * only 8 of them name Curve in the persisted `providers` array the census
 * validates against. That gap produced provider evidence the census could not
 * attribute, and spent request budget on chains where a Curve answer could
 * never count.
 */
describe("the discovery Curve stage stays inside the registered provider set", () => {
  it("queries exactly the chains that name Curve as a discovery provider", () => {
    for (const chain of CURVE_NATIVE_DISCOVERY_CHAINS) {
      expect(getDexDiscoveryProviders(chain), chain).toContain("curve");
    }
    const registered = CURVE_CHAINS.filter((chain) => getDexDiscoveryProviders(chain).includes("curve"));
    expect(new Set(registered)).toEqual(new Set(CURVE_NATIVE_DISCOVERY_CHAINS));
  });

  it("keeps the liquidity stage's wider fetch set out of the census attribution set", () => {
    // The liquidity stage legitimately reads Curve on more chains than the
    // registry credits it for; those extra chains must not be crawled for
    // deployment outcomes.
    const stageOnly = CURVE_CHAINS.filter((chain) => !CURVE_NATIVE_DISCOVERY_CHAINS.has(chain));
    expect(stageOnly).toEqual(["optimism", "avalanche", "fantom", "gnosis"]);
  });

  it("leaves no discovery-crawled chain needing a non-identity Curve API path", () => {
    // `gnosis` is addressed as `xdai` by Curve; discovery built its URL from the
    // raw Pharos chain id, so every run burned its retry budget on a request the
    // endpoint answers with an error. Scoping to the registered set removes it,
    // and the stage now applies the mapping regardless.
    const mapped = [...CURVE_NATIVE_DISCOVERY_CHAINS].filter((chain) => CURVE_API_CHAIN_PATHS[chain] != null);
    expect(mapped).toEqual([]);
    expect(CURVE_API_CHAIN_PATHS.gnosis).toBe("xdai");
    expect(CURVE_NATIVE_DISCOVERY_CHAINS.has("gnosis")).toBe(false);
  });
});
