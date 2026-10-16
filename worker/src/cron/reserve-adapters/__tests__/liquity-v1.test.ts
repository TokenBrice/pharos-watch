import { describe, expect, it } from "vitest";
import { runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";
import { NOW_SEC, WAD, v1Network } from "./liquity-v1.test-support";

function runV1(network: AdapterNetworkSpec = v1Network()) {
  return runAdapter("liquity-v1", "lusd-liquity", { network, nowSec: NOW_SEC });
}

describe("fetchLiquityV1Reserves", () => {
  it("emits degraded warning when collateralization ratio falls below 1.2", async () => {
    const { result } = await runV1(v1Network({ collateral: 100n * WAD, debt: 100n * WAD, price: WAD }, 1));
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "liquity-v1-low-collateralization-ratio", severity: "warning" }),
    );
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.0, 3);
  });

  it("keeps the protocol redemption gate readable when the ETH price is unavailable", async () => {
    const { result } = await runV1(
      v1Network({ collateral: 100n * WAD, debt: 100n * WAD }, null, null),
    );
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "defillama-quote-missing" }),
      expect.objectContaining({ code: "liquity-v1-eth-price-unavailable" }),
    ]);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "open" });
  });

  it("pauses the route when the protocol-priced TCR is below MCR", async () => {
    const { result } = await runV1(
      v1Network({ collateral: 100n * WAD, debt: 200_000n * WAD, price: 1_000n * WAD }, 3_000),
    );
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.5, 3);
    expect(result.metadata?.totalCollateralRatio).toBeCloseTo(0.5, 3);
    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "paused",
      routeStatusSource: "onchain",
      routeStatusReason: expect.stringContaining("below MCR"),
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "redemption-route-status-degraded", effect: "degraded" }),
    ]);
  });

  it("publishes an unknown route when the redemption gate is unreadable", async () => {
    const { result } = await runV1(v1Network({ tcrReadable: false }));
    expect(result.slices).toHaveLength(1);
    expect(result.metadata?.totalCollateralRatio).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "unknown",
      routeStatusReason: expect.stringContaining("Could not read the Liquity V1 redemption gate"),
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "redemption-route-status-unreadable", effect: "degraded" }),
    ]);
  });

  it("publishes an unknown route when the protocol price feed is unreadable", async () => {
    const { result } = await runV1(v1Network({ price: null }));
    expect(result.metadata?.details).toMatchObject({ protocolPriceRaw: null, tcrRaw: null });
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "unknown" });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "redemption-route-status-unreadable" }),
    ]);
  });

  it("fails closed when system collateral is unreadable", async () => {
    await expect(runV1(v1Network({ collateral: null }))).rejects.toThrow(
      "liquity-v1 getEntireSystemColl() returned zero/unreadable collateral",
    );
  });

  it("fails closed when system debt is zero", async () => {
    await expect(runV1(v1Network({ debt: 0n }))).rejects.toThrow(
      "liquity-v1 getEntireSystemDebt() returned zero/unreadable debt",
    );
  });
});
