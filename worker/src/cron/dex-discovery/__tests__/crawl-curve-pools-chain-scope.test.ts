import { describe, expect, it } from "vitest";
import {
  CURVE_NATIVE_DISCOVERY_CHAINS,
  getDexDiscoveryProviders,
} from "@shared/lib/dex-deployment-coverage";
import { CURVE_CHAINS } from "../../dex-liquidity/constants";

describe("the Curve query list and census provider registry share one source", () => {
  it("queries exactly the chains that name Curve as a discovery provider", () => {
    expect([...CURVE_NATIVE_DISCOVERY_CHAINS]).toEqual([...CURVE_CHAINS]);
    for (const chain of CURVE_CHAINS) {
      expect(getDexDiscoveryProviders(chain), chain).toContain("curve");
    }
  });

});
