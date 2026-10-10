import { describe, expect, it } from "vitest";
import { DEX_EXECUTION_CAPABILITY_REGISTRY } from "@shared/lib/p4-exit-route-capability-policy";
import { DEX_EXACT_QUOTE_ADAPTER_IDS } from "@shared/types/measured-execution";
import { buildRegisteredDexExecutionTarget } from "../../dex-liquidity/execution-target-registry";
import { makeDexExecutionTargetFactoryInput } from "../../../test-helpers/__shared/dex-execution-target";

describe("execution capability contracts", () => {
  it("gives every execution capability one unique registered profile", () => {
    const profileIds = DEX_EXECUTION_CAPABILITY_REGISTRY.map((entry) => entry.profileId);
    expect(new Set(profileIds).size).toBe(profileIds.length);
    const adapterIds = Object.values(DEX_EXACT_QUOTE_ADAPTER_IDS);
    for (const capability of DEX_EXECUTION_CAPABILITY_REGISTRY) {
      expect(adapterIds).toContain(capability.adapterId);
    }
  });

  it.each([
    ["solana", "orca", undefined, "activation-pending"],
    ["solana", "raydium", "raydium-clmm", "activation-pending"],
    ["solana", "raydium", "raydium-amm", undefined],
    ["solana", "meteora", "meteora-dlmm", "activation-pending"],
    ["solana", "meteora", "cg-amm", undefined],
    ["ethereum", "orca", undefined, undefined],
    ["sui", "cetus", undefined, "target-unresolved"],
  ])("preserves native gate for %s/%s/%s", (chainNorm, protocol, poolType, reason) => {
    const input = makeDexExecutionTargetFactoryInput(chainNorm, protocol, poolType);
    const capability = buildRegisteredDexExecutionTarget(input);
    expect(capability.executionCapabilityGate?.reason).toBe(reason);
    expect(capability.measuredExecutionTarget).toBeUndefined();
  });
});
