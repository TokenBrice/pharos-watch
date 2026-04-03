import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";

vi.mock("../fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

import { fetchWithRetry } from "../fetch-retry";
import {
  extractTrackedStableBalancesFromSimDefiPosition,
  fetchSimWalletBalances,
  fetchSimWalletDefiStableBalances,
} from "../sim-balances";

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

describe("Sim fetch helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-ok wallet balance responses after cancelling the unread body", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fetchWithRetry).mockResolvedValue({
      ok: false,
      status: 502,
      body: { cancel },
    } as unknown as Response);

    await expect(fetchSimWalletBalances({
      apiKey: "sim-key",
      address: "0xabc",
      chainIds: [1],
    })).rejects.toThrow("Sim balances request returned 502 for 0xabc");

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects non-ok DeFi position responses after cancelling the unread body", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fetchWithRetry).mockResolvedValue({
      ok: false,
      status: 503,
      body: { cancel },
    } as unknown as Response);

    await expect(fetchSimWalletDefiStableBalances({
      apiKey: "sim-key",
      address: "0xdef",
      chainIds: [1],
    })).rejects.toThrow("Sim DeFi positions request returned 503 for 0xdef");

    expect(cancel).toHaveBeenCalledOnce();
  });
});
