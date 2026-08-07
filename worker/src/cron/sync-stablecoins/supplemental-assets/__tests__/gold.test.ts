import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";

// Live supplies observed 2026-07-29. Arbitrum is the conserved global total:
// its CCIP LockRelease pool holds exactly Ethereum + Pharos supply and the
// LayerZero OFTAdapter escrows the ApeChain representation.
const PGOLD_SUPPLY_UNITS: Record<string, number> = {
  arbitrum: 19_505,
  apechain: 0.05044,
  ethereum: 110,
  pharos: 1_000,
};
const PGOLD_PRICE = 4_042.62;

const selectCuratedAggregateContractsMock = vi.fn();
const probeTrackedTokenSupplyMock = vi.fn();

vi.mock("@shared/lib/stablecoins/registry", () => ({
  ACTIVE_STABLECOINS: [
    {
      id: "pgold-pleasing",
      name: "Pleasing Gold",
      symbol: "PGOLD",
      geckoId: "pleasing-gold",
      protocolSlug: "pleasing-gold",
      detailProvider: "commodity",
      commodityOunces: 1,
      contracts: [
        { chain: "arbitrum", address: "0x3e76bb02286bfeaa89dd35f11253f2cbce634f91", decimals: 18 },
        { chain: "apechain", address: "0x64ae250e044688ddd04262f17daca23c28d241c2", decimals: 18 },
        { chain: "ethereum", address: "0xfb0bd86210d2a10543bb40289e92d108b3a5334f", decimals: 18 },
        { chain: "pharos", address: "0x531f1e4a3ca96b9f42467659d8088b07fe8d2839", decimals: 18 },
      ],
      flags: {
        pegCurrency: "GOLD",
        backing: "rwa-backed",
        governance: "centralized",
        yieldBearing: false,
        rwa: true,
        navToken: false,
      },
    },
  ],
}));

vi.mock("@shared/lib/onchain-supply-probe", async (importOriginal) => {
  const original = await importOriginal<typeof import("@shared/lib/onchain-supply-probe")>();
  return {
    ...original,
    CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS: { "pgold-pleasing": "arbitrum" },
    selectCuratedAggregateOnchainSupplyProbeContracts: (...args: unknown[]) =>
      selectCuratedAggregateContractsMock(...args),
  };
});

vi.mock("../../../reserve-adapters/helpers", () => ({
  fetchErc20TotalSupply: vi.fn(),
  fetchOnchainUint256: vi.fn(),
  probeTrackedTokenSupply: (...args: unknown[]) => probeTrackedTokenSupplyMock(...args),
}));

import { fetchGoldTokens } from "../gold";

function stubGoldUpstreams(
  protocolMcap: number | null,
  priceObservedAt: number = Math.floor(Date.now() / 1000),
): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/prices/current/")) {
      return new Response(
        JSON.stringify({ coins: { "coingecko:pleasing-gold": { price: PGOLD_PRICE, timestamp: priceObservedAt } } }),
        { status: 200 },
      );
    }
    if (String(url).includes("/protocol/")) {
      return new Response(JSON.stringify(protocolMcap == null ? {} : { mcap: protocolMcap }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGoldTokens curated aggregate supply", () => {
  beforeEach(() => {
    selectCuratedAggregateContractsMock.mockReset();
    probeTrackedTokenSupplyMock.mockReset();
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) => {
      const units = PGOLD_SUPPLY_UNITS[input.chain];
      if (units == null) return null;
      return BigInt(Math.round(units * 1e6)) * 10n ** 12n;
    });
  });

  it("publishes per-chain rows and reallocates the canonical Arbitrum supply", async () => {
    selectCuratedAggregateContractsMock.mockImplementation((meta: StablecoinMeta) =>
      ["arbitrum", "apechain", "ethereum", "pharos"].map((chain) => ({
        config: { chain },
        contract: meta.contracts?.find((entry) => entry.chain === chain),
      })),
    );
    stubGoldUpstreams(78_852_290);

    const [asset] = await fetchGoldTokens({ "pleasing-gold": { usd: PGOLD_PRICE, usd_market_cap: 78_852_290 } });

    expect(asset?.supplySource).toBe("onchain-total-supply");
    expect(asset?.circulating?.peggedGOLD).toBeCloseTo(19_505 * PGOLD_PRICE, 4);
    expect(asset?.chainCirculating?.Arbitrum?.current).toBeCloseTo(18_394.94956 * PGOLD_PRICE, 4);
    expect(asset?.chainCirculating?.Ethereum?.current).toBeCloseTo(110 * PGOLD_PRICE, 4);
    expect(asset?.chainCirculating?.ApeChain?.current).toBeCloseTo(0.05044 * PGOLD_PRICE, 4);
    expect(asset?.chainCirculating?.["Pharos Network"]?.current).toBeCloseTo(1_000 * PGOLD_PRICE, 4);
    expect(asset?.chainCirculating?.Ethereum).toMatchObject({
      circulatingPrevDay: 0,
      circulatingPrevWeek: 0,
      circulatingPrevMonth: 0,
    });
    expect(probeTrackedTokenSupplyMock).toHaveBeenCalledTimes(4);
  });

  it("keeps the upstream market cap and empty chain rows without a curated config", async () => {
    selectCuratedAggregateContractsMock.mockReturnValue(null);
    stubGoldUpstreams(78_852_290);

    const [asset] = await fetchGoldTokens({ "pleasing-gold": { usd: PGOLD_PRICE, usd_market_cap: 78_852_290 } });

    expect(asset?.supplySource).toBe("defillama");
    expect(asset?.circulating?.peggedGOLD).toBe(78_852_290);
    expect(asset?.chainCirculating).toEqual({});
    expect(probeTrackedTokenSupplyMock).not.toHaveBeenCalled();
  });

  it("falls back to the upstream market cap when a configured leg cannot be read", async () => {
    selectCuratedAggregateContractsMock.mockImplementation((meta: StablecoinMeta) =>
      ["arbitrum", "apechain", "ethereum", "pharos"].map((chain) => ({
        config: { chain },
        contract: meta.contracts?.find((entry) => entry.chain === chain),
      })),
    );
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) => {
      if (input.chain === "pharos") throw new Error("rpc unavailable");
      const units = PGOLD_SUPPLY_UNITS[input.chain];
      return BigInt(Math.round(units * 1e6)) * 10n ** 12n;
    });
    stubGoldUpstreams(78_852_290);

    const [asset] = await fetchGoldTokens({ "pleasing-gold": { usd: PGOLD_PRICE, usd_market_cap: 78_852_290 } });

    expect(asset?.supplySource).toBe("defillama");
    expect(asset?.circulating?.peggedGOLD).toBe(78_852_290);
    expect(asset?.chainCirculating).toEqual({});
  });

  it("keeps positive upstream market cap when price evidence is stale", async () => {
    const staleAt = Math.floor(Date.now() / 1000) - 9 * 86400;
    selectCuratedAggregateContractsMock.mockReturnValue(null);
    stubGoldUpstreams(null, staleAt);

    const [asset] = await fetchGoldTokens({
      "pleasing-gold": {
        usd: PGOLD_PRICE,
        usd_market_cap: 78_852_290,
        last_updated_at: staleAt,
      },
    });

    expect(asset).toMatchObject({
      id: "pgold-pleasing",
      price: null,
      priceConfidence: null,
      priceUpdatedAt: null,
      priceObservedAt: null,
      priceObservedAtMode: null,
      priceSyncedAt: null,
      supplySource: "coingecko-fallback",
      circulating: { peggedGOLD: 78_852_290 },
    });
    expect(asset?.priceSource).toBeUndefined();
  });

  it("still drops a commodity row without trusted price or positive market cap", async () => {
    const staleAt = Math.floor(Date.now() / 1000) - 9 * 86400;
    selectCuratedAggregateContractsMock.mockReturnValue(null);
    stubGoldUpstreams(null, staleAt);

    const assets = await fetchGoldTokens({
      "pleasing-gold": {
        usd: PGOLD_PRICE,
        usd_market_cap: 0,
        last_updated_at: staleAt,
      },
    });

    expect(assets).toEqual([]);
  });
});
