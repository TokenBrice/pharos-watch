import { describe, expect, it } from "vitest";
import { DEX_DISCOVERY_PROVIDER_RUNTIME_REGISTRY } from "../provider-registry";
import { estimateDeploymentCrawlCostMs } from "../target-window";

describe("discovery provider runtime registry", () => {
  it("keeps pricing equal to the descriptors that drive execution", () => {
    const expected = DEX_DISCOVERY_PROVIDER_RUNTIME_REGISTRY
      .filter((entry) => entry.lifecycle === "active" && entry.supports("ethereum", "0x1111111111111111111111111111111111111111"))
      .reduce((sum, entry) => sum + entry.requestCostMs, 0);
    expect(estimateDeploymentCrawlCostMs("ethereum", "0x1111111111111111111111111111111111111111"))
      .toBe(expected);
  });

  it("retains disabled provider descriptors without crawler leaves", () => {
    expect(DEX_DISCOVERY_PROVIDER_RUNTIME_REGISTRY
      .filter((entry) => entry.providerId === "soroban-exhaustive" || entry.providerId === "btcusd-public-https")
      .map((entry) => [entry.providerId, entry.lifecycle, entry.crawlerLeaf]))
      .toEqual([
        ["soroban-exhaustive", "disabled", undefined],
        ["btcusd-public-https", "disabled", undefined],
      ]);
  });
});
