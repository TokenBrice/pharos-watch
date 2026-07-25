import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";

const probeTrackedTokenSupplyMock = vi.fn();

vi.mock("../../../reserve-adapters/helpers", () => ({
  fetchOnchainUint256: vi.fn(),
  probeTrackedTokenSupply: (...args: unknown[]) => probeTrackedTokenSupplyMock(...args),
}));

import { fetchCuratedAggregateOnChainMcap } from "../onchain-supply";

function makeSkyMeta(): StablecoinMeta {
  return {
    id: "susds-sky",
    name: "Savings USDS",
    symbol: "sUSDS",
    detailProvider: "coingecko",
    contracts: [
      { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 18 },
      { chain: "base", address: "0x0000000000000000000000000000000000000002", decimals: 18 },
      { chain: "optimism", address: "0x0000000000000000000000000000000000000003", decimals: 18 },
      { chain: "arbitrum", address: "0x0000000000000000000000000000000000000004", decimals: 18 },
    ],
    flags: {
      pegCurrency: "USD",
      backing: "crypto-backed",
      governance: "centralized-dependent",
      yieldBearing: true,
      navToken: true,
    },
  } as StablecoinMeta;
}

describe("fetchCuratedAggregateOnChainMcap", () => {
  beforeEach(() => probeTrackedTokenSupplyMock.mockReset());

  it("reallocates canonical lock/mint supply without double counting representations", async () => {
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) => {
      if (input?.chain === "ethereum") return 1_000n * 10n ** 18n;
      if (input?.chain === "base") return 100n * 10n ** 18n;
      if (input?.chain === "optimism") return 50n * 10n ** 18n;
      if (input?.chain === "arbitrum") return 25n * 10n ** 18n;
      return 0n;
    });

    await expect(fetchCuratedAggregateOnChainMcap(makeSkyMeta(), 1)).resolves.toEqual({
      mcap: 1_000,
      supplySource: "onchain-total-supply",
      chainCirculating: {
        Ethereum: 825,
        Base: 100,
        Optimism: 50,
        Arbitrum: 25,
      },
    });
  });

  it("fails closed when representation supply is not smaller than canonical supply", async () => {
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) =>
      input?.chain === "ethereum" ? 100n * 10n ** 18n : 50n * 10n ** 18n,
    );

    await expect(fetchCuratedAggregateOnChainMcap(makeSkyMeta(), 1)).resolves.toBeNull();
  });
});
