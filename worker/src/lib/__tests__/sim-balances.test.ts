import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";

vi.mock("../fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

import { fetchWithRetry } from "../fetch-retry";
import {
  extractTreasuryDerivedPositionFromSimDefiPosition,
  fetchSimWalletBalances,
  fetchSimWalletDefiTreasuryPositions,
} from "../sim-balances";

describe("extractTreasuryDerivedPositionFromSimDefiPosition", () => {
  it("unwraps tokenized stable positions to the tracked underlying and marks the wrapper for de-duplication", () => {
    const usdc = TRACKED_META_BY_ID.get("usdc-circle");
    const usdcContract = usdc?.contracts?.find((deployment) => deployment.chain === "ethereum");
    expect(usdcContract).toBeTruthy();

    const position = extractTreasuryDerivedPositionFromSimDefiPosition("0xabc", {
      chain_id: 1,
      value_usd: 1_250,
      token: {
        address: "0x000000000000000000000000000000000000beef",
      },
      underlying_token: {
        address: usdcContract!.address,
      },
    });

    expect(position).toEqual({
      positionUsd: 1_250,
      stableLegs: [
        {
          chainId: 1,
          tokenAddress: usdcContract!.address,
          usdValue: 1_250,
          balanceKey: `0xabc:1:${usdcContract!.address.toLowerCase()}`,
        },
      ],
      consumedBalanceKeys: ["0xabc:1:0x000000000000000000000000000000000000beef"],
      partialStableExposure: false,
      warnings: [],
    });
  });

  it("extracts stable legs from LP-style positions and preserves the total position value", () => {
    const usdc = TRACKED_META_BY_ID.get("usdc-circle");
    const usdcContract = usdc?.contracts?.find((deployment) => deployment.chain === "ethereum");
    expect(usdcContract).toBeTruthy();

    const position = extractTreasuryDerivedPositionFromSimDefiPosition("0xabc", {
      chain_id: 1,
      value_usd: 2_500,
      token0: {
        address: usdcContract!.address,
        price_usd: 1,
      },
      token1: {
        address: "0x000000000000000000000000000000000000cafe",
        symbol: "ETH",
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

    expect(position.positionUsd).toBe(2_500);
    expect(position.partialStableExposure).toBe(false);
    expect(position.stableLegs).toEqual([
      {
        chainId: 1,
        tokenAddress: usdcContract!.address,
        usdValue: 500,
        balanceKey: `0xabc:1:${usdcContract!.address.toLowerCase()}`,
      },
    ]);
  });

  it("preserves provider-identified stable legs that do not resolve to a tracked Pharos contract", () => {
    const position = extractTreasuryDerivedPositionFromSimDefiPosition("0xabc", {
      chain_id: 1,
      value_usd: 800,
      asset: {
        address: "0x000000000000000000000000000000000000dead",
        symbol: "USDC",
        asset_class: "stablecoin",
      },
    });

    expect(position.partialStableExposure).toBe(false);
    expect(position.stableLegs).toEqual([
      {
        chainId: 1,
        tokenAddress: "0x000000000000000000000000000000000000dead",
        usdValue: 800,
        balanceKey: "0xabc:1:0x000000000000000000000000000000000000dead",
      },
    ]);
  });

  it("marks the position partial when a stable-like leg lacks a usable USD value", () => {
    const position = extractTreasuryDerivedPositionFromSimDefiPosition("0xabc", {
      chain_id: 1,
      underlying_token: {
        symbol: "USDC",
        asset_class: "stablecoin",
      },
    });

    expect(position.positionUsd).toBeNull();
    expect(position.stableLegs).toEqual([]);
    expect(position.partialStableExposure).toBe(true);
    expect(position.warnings).toContain(
      "Derived treasury position omitted a stable-like underlying token without a usable USD value.",
    );
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

    await expect(fetchSimWalletDefiTreasuryPositions({
      apiKey: "sim-key",
      address: "0xdef",
      chainIds: [1],
    })).rejects.toThrow("Sim DeFi positions request returned 503 for 0xdef");

    expect(cancel).toHaveBeenCalledOnce();
  });
});
