import { describe, expect, it } from "vitest";
import { runAdapter, type AdapterRpcValue } from "./reserve-adapter.test-support";
import {
  MAKINA_ASYNC_REDEEMER,
  MAKINA_BEACON,
  MAKINA_BLOCK,
  MAKINA_DUSD,
  MAKINA_LOCKED_SHARES,
  MAKINA_MACHINE,
  MAKINA_REVIEWED_IMPLEMENTATION,
  MAKINA_REVIEWED_IMPLEMENTATION_CODE_HASH,
  makinaNetworkSpec,
} from "./makina-strategy.test-support";

const CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";
const UNRELATED_ADDRESS = "0x9999999999999999999999999999999999999999";
// Replay clock just after the oldest captured position update.
const NOW_SEC = 1_785_265_103 + 600;

function convertToAssetsCalldata(lockedShares: bigint): string {
  return `${CONVERT_TO_ASSETS_SELECTOR}${lockedShares.toString(16).padStart(64, "0")}`;
}

async function runRedemptionReplay(rpcOverrides: Record<string, AdapterRpcValue> = {}, code?: Record<string, string>) {
  return runAdapter("makina-strategy", "dusd-dialectic", {
    network: makinaNetworkSpec({ rpc: rpcOverrides, code }),
    nowSec: NOW_SEC,
  });
}

describe("fetchMakinaStrategyReserves redemption telemetry", () => {
  it("publishes same-block backlog-adjusted DUSD queue capacity after validating the redeemer identity", async () => {
    const { result, network } = await runRedemptionReplay();

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      settlementBoundUnproven: true,
      capacityKind: "live-queue",
      freshnessKind: "same-run-onchain",
      blockNumber: MAKINA_BLOCK,
      holderEligibility: "any-holder",
      queueDepthUsd: 3_104.889979,
      routeStatus: "open",
      routeStatusSource: "onchain",
    });
    expect(result.metadata?.redemption).not.toHaveProperty("settlementDelaySec");
    expect(result.metadata?.redemptionQueue).toMatchObject({
      minimumFinalizationDelaySec: 43_200,
      pendingRequestCount: 1,
      lockedShares: 3_000,
      grossIdleCapacityUsd: 120.722783,
      queueDepthUsd: 3_104.889979,
      reservedUnclaimedUsdc: 0.003679,
      settlementBoundUnproven: true,
      capacityBasis: "live-proxy-buffer",
      implementationAddress: MAKINA_REVIEWED_IMPLEMENTATION,
      implementationRuntimeCodeHash: MAKINA_REVIEWED_IMPLEMENTATION_CODE_HASH,
    });

    // The route identity reads share one pinned-block Multicall3 batch, and the
    // queue depth is convertToAssets(lockedShares) at that same block.
    expect(network.rpcCalls).toContainEqual(expect.objectContaining({
      method: "eth_call",
      chain: "ethereum",
      viaMulticall: true,
      contract: MAKINA_ASYNC_REDEEMER,
      data: "0x75c60225",
      block: `0x${MAKINA_BLOCK.toString(16)}`,
    }));
    expect(network.rpcCalls).toContainEqual(expect.objectContaining({
      method: "eth_call",
      contract: MAKINA_MACHINE,
      data: convertToAssetsCalldata(MAKINA_LOCKED_SHARES),
      block: `0x${MAKINA_BLOCK.toString(16)}`,
    }));
  });

  it.each([
    { locked: 0n, converted: 0n, capacity: 120.722783, next: 343 },
    { locked: 100n * 10n ** 18n, converted: 103_496_333n, capacity: 17.22645, next: 344 },
  ])("subtracts converted locked shares from idle USDC: $capacity USD available", async ({ locked, converted, capacity, next }) => {
    const { result, network } = await runRedemptionReplay({
      [`${MAKINA_DUSD}:0x70a08231${BigInt(MAKINA_ASYNC_REDEEMER).toString(16).padStart(64, "0")}`]: locked,
      [`${MAKINA_MACHINE}:${convertToAssetsCalldata(locked)}`]: converted,
      [`${MAKINA_ASYNC_REDEEMER}:0x6a84a985`]: next,
    });

    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: expect.closeTo(capacity, 6) });
    expect(network.rpcCalls).toContainEqual(expect.objectContaining({
      method: "eth_call",
      contract: MAKINA_MACHINE,
      data: convertToAssetsCalldata(locked),
    }));
  });

  it("withholds telemetry when the unchanged implementation serves drifted runtime code", async () => {
    const { result } = await runRedemptionReplay({}, { [`ethereum:${MAKINA_REVIEWED_IMPLEMENTATION}`]: "0x6000" });

    expect(result.metadata?.totalReserveUsd).toBe(11_000);
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.warnings?.map(({ code }) => code)).toContain("makina-redemption-telemetry-unavailable");
  });

  it("withholds telemetry for each mismatched route identity", async () => {
    for (const [label, key] of [
      ["redeemer-machine", `${MAKINA_ASYNC_REDEEMER}:0x75c60225`],
      ["machine-accounting-token", `${MAKINA_MACHINE}:0xda68cf8b`],
      ["machine-share-token", `${MAKINA_MACHINE}:0x6c9fa59e`],
    ] as const) {
      const { result } = await runRedemptionReplay({ [key]: UNRELATED_ADDRESS });
      expect(result.metadata?.totalReserveUsd, label).toBe(11_000);
      expect(result.metadata?.redemption, label).toBeUndefined();
      expect(result.warnings?.map(({ code }) => code), label).toContain("makina-redemption-telemetry-unavailable");
    }
  });

  it("withholds telemetry when finalized request counter reaches or exceeds next request", async () => {
    for (const finalized of [344, 345]) {
      const { result } = await runRedemptionReplay({ [`${MAKINA_ASYNC_REDEEMER}:0x667a739e`]: finalized });
      expect(result.metadata?.totalReserveUsd).toBe(11_000);
      expect(result.metadata?.redemption).toBeUndefined();
      expect(result.warnings?.map(({ code }) => code)).toContain("makina-redemption-telemetry-unavailable");
    }
  });

  it("keeps reserve composition but withholds queue capacity when the redeemer implementation drifts", async () => {
    const { result, network } = await runRedemptionReplay({ [`${MAKINA_BEACON}:0x5c60da1b`]: UNRELATED_ADDRESS });

    expect(result.slices.length).toBeGreaterThan(0);
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.warnings?.map((warning) => warning.code)).toContain("makina-redemption-telemetry-unavailable");
    expect(network.rpcCalls.some((call) => call.data.startsWith(CONVERT_TO_ASSETS_SELECTOR))).toBe(false);
  });
});
