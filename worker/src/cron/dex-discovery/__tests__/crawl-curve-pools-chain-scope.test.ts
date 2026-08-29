import { describe, expect, it } from "vitest";
import {
  CURVE_NATIVE_DISCOVERY_CHAINS,
  getDexDiscoveryProviders,
} from "@shared/lib/dex-deployment-coverage";
import { CURVE_API_CHAIN_PATHS, CURVE_CHAINS } from "../../dex-liquidity/constants";

describe("the Curve query list and census provider registry share one source", () => {
  it("queries exactly the chains that name Curve as a discovery provider", () => {
    expect([...CURVE_NATIVE_DISCOVERY_CHAINS]).toEqual([...CURVE_CHAINS]);
    for (const chain of CURVE_CHAINS) {
      expect(getDexDiscoveryProviders(chain), chain).toContain("curve");
    }
  });

  it("uses the configured non-identity Curve API path for Gnosis", () => {
    // `gnosis` is addressed as `xdai` by Curve; discovery built its URL from the
    // raw Pharos chain id, so every run burned its retry budget on a request the
    // endpoint answers with an error. Gnosis is now registered because the
    // discovery stage applies the same mapping as the liquidity stage.
    const mapped = [...CURVE_NATIVE_DISCOVERY_CHAINS].filter((chain) => CURVE_API_CHAIN_PATHS[chain] != null);
    expect(mapped).toEqual(["gnosis"]);
    expect(CURVE_API_CHAIN_PATHS.gnosis).toBe("xdai");
    expect(CURVE_NATIVE_DISCOVERY_CHAINS.has("gnosis")).toBe(true);
  });
});
