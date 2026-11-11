import { describe, expect, it } from "vitest";
import {
  applyReviewedAddressPriceTargetOverride,
  getReviewedAddressPriceTargetOverride,
} from "../address-price-providers/reviewed-target-overrides";

const VUSD_DEPLOYMENT = {
  chain: "iota-evm",
  address: "0x10740259a1860af3327dd0642ee35d6e8e7143ff",
};

describe("reviewed address-price target overrides", () => {
  it("recognizes and selects only the reviewed canonical deployment", () => {
    expect(getReviewedAddressPriceTargetOverride({
      stablecoinId: "vusd-virtue",
      ...VUSD_DEPLOYMENT,
    })).toEqual({ stablecoinId: "vusd-virtue", ...VUSD_DEPLOYMENT, prioritizeRequests: true, allowMissingLiquidity: true });

    expect(applyReviewedAddressPriceTargetOverride({
      stablecoinId: "vusd-virtue",
      deployments: [VUSD_DEPLOYMENT, {
        chain: "base",
        address: "0x0000000000000000000000000000000000000001",
      }],
      metadataDeployments: [VUSD_DEPLOYMENT],
      providerChainMap: { "iota-evm": "iota-evm", base: "base" },
    })).toEqual([VUSD_DEPLOYMENT]);
  });

  it("fails closed when current metadata no longer contains the override", () => {
    expect(applyReviewedAddressPriceTargetOverride({
      stablecoinId: "vusd-virtue",
      deployments: [VUSD_DEPLOYMENT],
      metadataDeployments: [],
      providerChainMap: { "iota-evm": "iota-evm" },
    })).toEqual([]);
  });
});
