import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";

const fetchErc20TotalSupplyMock = vi.fn();
const probeTrackedTokenSupplyMock = vi.fn();

vi.mock("../../../reserve-adapters/helpers", () => ({
  fetchErc20TotalSupply: (...args: unknown[]) => fetchErc20TotalSupplyMock(...args),
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

function makeChfauMeta(): StablecoinMeta {
  return {
    id: "chfau-allunity",
    name: "AllUnity CHF",
    symbol: "CHFAU",
    detailProvider: "coingecko",
    contracts: [
      { chain: "ethereum", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 },
      { chain: "polygon", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 },
      { chain: "base", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 },
      { chain: "tempo", address: "0x20c00000000000000000000042109aef2f8b28e1", decimals: 6 },
    ],
    flags: {
      pegCurrency: "CHF",
      backing: "rwa-backed",
      governance: "centralized",
      yieldBearing: false,
      navToken: false,
    },
  } as StablecoinMeta;
}

describe("fetchCuratedAggregateOnChainMcap", () => {
  beforeEach(() => {
    fetchErc20TotalSupplyMock.mockReset();
    probeTrackedTokenSupplyMock.mockReset();
  });

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

  it("keeps CHFAU aggregate supply when reviewed native deployments have zero supply", async () => {
    fetchErc20TotalSupplyMock.mockImplementation(async (input) => {
      if (input?.chain === "ethereum") return 49_680_021_921_656n;
      if (input?.chain === "polygon") return 0n;
      if (input?.chain === "base") return 0n;
      if (input?.chain === "tempo") return 0n;
      return null;
    });

    const result = await fetchCuratedAggregateOnChainMcap(makeChfauMeta(), 1.12);

    expect(result?.supplySource).toBe("onchain-total-supply");
    expect(result?.mcap).toBeCloseTo(55_641_624.55225472, 6);
    expect(result?.chainCirculating?.Ethereum).toBeCloseTo(55_641_624.55225472, 6);
    expect(result?.chainCirculating?.Polygon).toBe(0);
    expect(result?.chainCirculating?.Base).toBe(0);
    expect(result?.chainCirculating?.Tempo).toBe(0);
    expect(fetchErc20TotalSupplyMock).toHaveBeenCalledTimes(4);
  });

  it("fails CHFAU aggregate supply closed when a reviewed native deployment cannot be read", async () => {
    fetchErc20TotalSupplyMock.mockImplementation(async (input) => {
      if (input?.chain === "ethereum") return 49_680_021_921_656n;
      if (input?.chain === "polygon") return 0n;
      if (input?.chain === "base") return null;
      if (input?.chain === "tempo") return 0n;
      return null;
    });

    await expect(fetchCuratedAggregateOnChainMcap(makeChfauMeta(), 1.12)).resolves.toBeNull();
  });
});
