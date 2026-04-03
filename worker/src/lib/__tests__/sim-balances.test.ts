import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { extractTrackedStableBalancesFromSimDefiPosition } from "../sim-balances";

describe("extractTrackedStableBalancesFromSimDefiPosition", () => {
  it("unwraps tokenized stable positions to the tracked underlying and marks the wrapper for de-duplication", () => {
    const usdc = TRACKED_META_BY_ID.get("usdc-circle");
    const usdcContract = usdc?.contracts?.find((deployment) => deployment.chain === "ethereum");
    expect(usdcContract).toBeTruthy();

    const balances = extractTrackedStableBalancesFromSimDefiPosition({
      chain_id: 1,
      value_usd: 1_250,
      token: {
        address: "0x000000000000000000000000000000000000beef",
      },
      underlying_token: {
        address: usdcContract!.address,
      },
    });

    expect(balances).toEqual([
      {
        chainId: 1,
        tokenAddress: usdcContract!.address,
        usdValue: 1_250,
        consumedBalanceKeys: ["1:0x000000000000000000000000000000000000beef"],
      },
    ]);
  });

  it("extracts tracked stable legs from LP-style positions", () => {
    const usdc = TRACKED_META_BY_ID.get("usdc-circle");
    const usdcContract = usdc?.contracts?.find((deployment) => deployment.chain === "ethereum");
    expect(usdcContract).toBeTruthy();

    const balances = extractTrackedStableBalancesFromSimDefiPosition({
      chain_id: 1,
      token0: {
        address: usdcContract!.address,
        price_usd: 1,
      },
      token1: {
        address: "0x000000000000000000000000000000000000cafe",
        price_usd: 2_000,
      },
      positions: [
        {
          token0: {
            holdings: 500,
          },
          token1: {
            holdings: 1,
          },
        },
      ],
    });

    expect(balances).toEqual([
      {
        chainId: 1,
        tokenAddress: usdcContract!.address,
        usdValue: 500,
        consumedBalanceKeys: undefined,
      },
    ]);
  });

  it("ignores positions whose underlying token does not resolve to a tracked stablecoin", () => {
    const balances = extractTrackedStableBalancesFromSimDefiPosition({
      chain_id: 1,
      value_usd: 800,
      underlying_token: {
        address: "0x000000000000000000000000000000000000dead",
      },
    });

    expect(balances).toEqual([]);
  });
});
