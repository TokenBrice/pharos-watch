import { describe, expect, it } from "vitest";
import {
  DEX_DISCOVERY_PROVIDER_REGISTRY,
  getDexDiscoveryProviders,
  getGeckoTerminalDiscoveryTarget,
  isCensusProviderSetSupersededByRegistry,
} from "@shared/lib/dex-deployment-coverage";
import { CHAIN_META } from "@shared/types/chain-identity";
import { estimateDeploymentCrawlCostMs } from "../target-window";

describe("discovery provider registry", () => {
  it("keeps pricing equal to the descriptors that drive execution", () => {
    const expected = DEX_DISCOVERY_PROVIDER_REGISTRY
      .filter((entry) => entry.lifecycle === "active" && entry.supports("ethereum", "0x1111111111111111111111111111111111111111"))
      .reduce((sum, entry) => sum + entry.requestCostMs, 0);
    expect(estimateDeploymentCrawlCostMs("ethereum", "0x1111111111111111111111111111111111111111"))
      .toBe(expected);
  });

  it("registers Arc chain 5042 with the existing priced GeckoTerminal provider", () => {
    const address = "0x8e357432cc12ff425c36432f312968aeb16112af";
    expect(CHAIN_META.arc.evmChainId).toBe(5042);
    expect(getGeckoTerminalDiscoveryTarget("arc", address)).toEqual({ network: "arc", address });
    expect(getDexDiscoveryProviders("arc", address)).toEqual(["geckoterminal"]);
    expect(estimateDeploymentCrawlCostMs("arc", address)).toBe(2_800);
    expect(isCensusProviderSetSupersededByRegistry("arc", address, 0)).toBe(true);
  });

});
