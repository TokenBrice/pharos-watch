import { describe, expect, it } from "vitest";
import { DEX_EXECUTION_CAPABILITY_REGISTRY } from "@shared/lib/p4-exit-route-capability-policy";
import { DEX_EXACT_QUOTE_ADAPTER_IDS } from "@shared/types/measured-execution";
import { DEX_EXECUTION_TARGET_FACTORY_REGISTRY } from "../../dex-liquidity/execution-target-registry";
import {
  DEX_POOL_SOURCE_REGISTRY,
} from "../../dex-liquidity/orchestrator-phases/direct-api";

describe("Wave 0 registration fan-out", () => {
  it("gives every execution capability one unique registered profile", () => {
    const profileIds = DEX_EXECUTION_CAPABILITY_REGISTRY.map((entry) => entry.profileId);
    expect(new Set(profileIds).size).toBe(profileIds.length);
    const adapterIds = Object.values(DEX_EXACT_QUOTE_ADAPTER_IDS);
    for (const capability of DEX_EXECUTION_CAPABILITY_REGISTRY) {
      expect(adapterIds).toContain(capability.adapterId);
    }
  });

  it("predeclares the U1, U2, and U5 target leaves", () => {
    expect(DEX_EXECUTION_TARGET_FACTORY_REGISTRY.map((entry) => entry.slotId)).toEqual([
      "quoter-v2",
      "uniswap-v4",
      "orca-whirlpool",
      "raydium-clmm",
      "evm-v2",
    ]);
    expect(DEX_EXECUTION_TARGET_FACTORY_REGISTRY.every((entry) => entry.implementationModule.length > 0)).toBe(true);
  });


  it("predeclares pool/source leaves needed by the fan-out", () => {
    const slots = DEX_POOL_SOURCE_REGISTRY.map((entry) => entry.slotId);
    expect(slots).toEqual(expect.arrayContaining([
      "evm-v4",
      "raydium-clmm",
      "orca-clmm",
      "soroban-exhaustive",
      "btcusd-provider-investigation",
    ]));
    expect(DEX_POOL_SOURCE_REGISTRY
      .filter((entry) => entry.slotId === "soroban-exhaustive" || entry.slotId === "btcusd-provider-investigation")
      .map(({ slotId, platform, lifecycle, implementationModule }) => [slotId, platform, lifecycle, implementationModule]))
      .toEqual([
        ["soroban-exhaustive", "soroban", "disabled", "@shared/lib/dex-deployment-coverage"],
        ["btcusd-provider-investigation", "offchain", "disabled", "@shared/lib/dex-deployment-coverage"],
      ]);
  });
});
