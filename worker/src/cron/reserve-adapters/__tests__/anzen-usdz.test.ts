import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchErc20TotalSupply: vi.fn(),
  };
});

import { fetchErc20TotalSupply } from "../helpers";
import { fetchAnzenUsdzReserves } from "../anzen-usdz";

const signal = AbortSignal.timeout(5_000);

function makeCoin(): StablecoinMeta {
  return {
    id: "usdz-anzen",
    name: "Anzen USDz",
    ticker: "USDz",
    contracts: [
      { chain: "ethereum", address: "0xA469B7Ee9ee773642b3e93E842e5D9b5BaA10067", decimals: 18 },
      { chain: "base", address: "0x04D5ddf5f3a8939889F11E97f8c4BB48317F1938", decimals: 18 },
      { chain: "arbitrum", address: "0x5018609AB477cC502e170A5aCcf5312B86a4b94f", decimals: 18 },
      { chain: "blast", address: "0x52056ED29Fe015f4Ba2e3b079D10C0B87f46e8c6", decimals: 18 },
      { chain: "manta", address: "0x73d23F3778a90Be8846E172354A115543dF2a7E4", decimals: 18 },
    ],
  } as unknown as StablecoinMeta;
}

const config: LiveReservesConfig = {
  adapter: "anzen-usdz",
  version: 1,
  semantics: "single-asset",
  inputs: {
    primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchAnzenUsdzReserves", () => {
  it("computes multichain USDz supply against the onchain SPCT reserve pool", async () => {
    vi.mocked(fetchErc20TotalSupply)
      .mockResolvedValueOnce(10_000_000n * 10n ** 18n)
      .mockResolvedValueOnce(4_000_000n * 10n ** 18n)
      .mockResolvedValueOnce(2_500_000n * 10n ** 18n)
      .mockResolvedValueOnce(750_000n * 10n ** 18n)
      .mockResolvedValueOnce(250_000n * 10n ** 18n)
      .mockResolvedValueOnce(17_600_000n * 10n ** 18n);

    const result = await fetchAnzenUsdzReserves(makeCoin(), config, signal);

    expect(result.slices).toEqual([
      { name: "SPCT (Secured Private Credit Token)", pct: 100, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalReserveUsd: 17_600_000,
      supplyUsd: 17_500_000,
      collateralizationRatio: 17_600_000 / 17_500_000,
      details: {
        proofKind: "multichain-usdz-vs-spct-total-supply",
        reserveSourceLabel: "SPCT pool total supply",
        supplyByChainUsd: {
          ethereum: 10_000_000,
          base: 4_000_000,
          arbitrum: 2_500_000,
          blast: 750_000,
          manta: 250_000,
        },
      },
    });

    expect(fetchErc20TotalSupply).toHaveBeenCalledTimes(6);
    expect(vi.mocked(fetchErc20TotalSupply).mock.calls[3]?.[4]).toBe("https://rpc.blast.io");
    expect(vi.mocked(fetchErc20TotalSupply).mock.calls[4]?.[4]).toBe("https://pacific-rpc.manta.network/http");
  });

  it("fails closed when required chain metadata is missing", async () => {
    const coin = makeCoin();
    coin.contracts = coin.contracts?.filter((entry) => entry.chain !== "blast");

    await expect(fetchAnzenUsdzReserves(coin, config, signal)).rejects.toThrow(
      "anzen-usdz missing blast contract metadata",
    );
  });

  it("fails closed when a supply probe returns zero or null", async () => {
    vi.mocked(fetchErc20TotalSupply)
      .mockResolvedValueOnce(10_000_000n * 10n ** 18n)
      .mockResolvedValueOnce(4_000_000n * 10n ** 18n)
      .mockResolvedValueOnce(2_500_000n * 10n ** 18n)
      .mockResolvedValueOnce(null);

    await expect(fetchAnzenUsdzReserves(makeCoin(), config, signal)).rejects.toThrow(
      "anzen-usdz totalSupply probe failed for usdz-anzen on blast",
    );
  });
});
