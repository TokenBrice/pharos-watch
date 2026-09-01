import { describe, expect, it } from "vitest";
import { DEX_EXECUTION_CAPABILITY_REGISTRY } from "@shared/lib/p4-exit-route-capability-policy";
import { DEX_EXACT_QUOTE_ADAPTER_REGISTRY } from "../registry";
import { DEX_EXECUTION_TARGET_FACTORY_REGISTRY } from "../../dex-liquidity/execution-target-registry";
import {
  DEX_POOL_SOURCE_REGISTRY,
} from "../../dex-liquidity/orchestrator-phases/direct-api";
import { runSolanaClmmShadowLane } from "../solana-clmm/inventory";

describe("Wave 0 registration fan-out", () => {
  it("gives every execution capability exactly one predeclared adapter slot", () => {
    const adapterIds = DEX_EXACT_QUOTE_ADAPTER_REGISTRY.map((entry) => entry.adapterId);
    expect(new Set(adapterIds).size).toBe(adapterIds.length);
    for (const capability of DEX_EXECUTION_CAPABILITY_REGISTRY) {
      const slot = DEX_EXACT_QUOTE_ADAPTER_REGISTRY.find((entry) => entry.adapterId === capability.adapterId);
      expect(slot?.profileIds).toContain(capability.profileId);
      expect(slot?.platform).toBe(capability.platform);
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

  it("predeclares U2's isolated shadow hook as a no-op", async () => {
    const baseResult = { status: "ok" as const, itemCount: 7 };
    await expect(runSolanaClmmShadowLane({
      db: {} as D1Database,
      chainRpcs: new Map(),
      baseResult,
    })).resolves.toBe(baseResult);
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
  });
});
