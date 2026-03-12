import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchEvmCallHexAtBlockMock = vi.fn();
const resolveClosestBlockAtOrBeforeTimestampMock = vi.fn();

vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_META_BY_ID: new Map([
    [
      "cusd-cap",
      {
        id: "cusd-cap",
        contracts: [
          { chain: "ethereum", address: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc", decimals: 18 },
        ],
      },
    ],
    [
      "usdc-circle",
      {
        id: "usdc-circle",
        contracts: [
          { chain: "ethereum", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
        ],
      },
    ],
  ]),
}));

vi.mock("../evm-rpc", () => ({
  fetchEvmCallHexAtBlock: (...args: unknown[]) => fetchEvmCallHexAtBlockMock(...args),
  resolveClosestBlockAtOrBeforeTimestamp: (...args: unknown[]) => resolveClosestBlockAtOrBeforeTimestampMock(...args),
}));

import {
  fetchAuthoritativeHistoricalPriceSeries,
  fetchAuthoritativeLivePriceOverrides,
} from "../authoritative-price-sources";

const QUOTE_HEX =
  "0x000000000000000000000000000000000000000000000000000000e8d435370b0000000000000000000000000000000000000000000000000000000000000000";

describe("authoritative-price-sources", () => {
  beforeEach(() => {
    fetchEvmCallHexAtBlockMock.mockReset();
    resolveClosestBlockAtOrBeforeTimestampMock.mockReset();
  });

  it("returns a live cUSD override from the authoritative redemption quote", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "cusd-cap",
        name: "Cap cUSD",
        symbol: "CUSD",
        circulating: { peggedUSD: 114_000_000 },
      },
      {
        id: "usdt-tether",
        name: "Tether",
        symbol: "USDT",
        circulating: { peggedUSD: 100_000_000_000 },
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      expect.stringMatching(/^0xb7c4a6bf/),
      "latest",
      expect.objectContaining({
        extraRpcUrls: ["https://ethereum-rpc.publicnode.com"],
      }),
    );

    expect(overrides.get("cusd-cap")).toEqual({
      price: 0.99999266,
      source: "protocol-redeem",
      confidence: "high",
    });
    expect(overrides.has("usdt-tether")).toBe(false);
  });

  it("replays historical cUSD prices through the same authoritative provider", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock
      .mockResolvedValueOnce(22_874_100)
      .mockResolvedValueOnce(22_875_000);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "cusd-cap",
        name: "Cap cUSD",
        symbol: "CUSD",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized-dependent",
          yieldBearing: false,
          rwa: false,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_710_000_000, 1_710_086_400],
        supplySnapshots: [
          { ts: 1_710_000_000, supply: 100_000_000 },
          { ts: 1_710_086_400, supply: 105_000_000 },
        ],
      },
    );

    expect(result).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_710_000_000, price: 0.99999266 },
        { timestamp: 1_710_086_400, price: 0.99999266 },
      ],
    });
    expect(resolveClosestBlockAtOrBeforeTimestampMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenNthCalledWith(
      1,
      "ethereum",
      "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      expect.stringMatching(/^0xb7c4a6bf/),
      22_874_100,
      expect.objectContaining({
        extraRpcUrls: ["https://ethereum-rpc.publicnode.com"],
      }),
    );
  });

  it("preserves existing backfill rows when authoritative history coverage is too low", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValueOnce(22_874_100);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "cusd-cap",
        name: "Cap cUSD",
        symbol: "CUSD",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized-dependent",
          yieldBearing: false,
          rwa: false,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_710_000_000, 1_710_086_400],
      },
    );

    expect(result).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: null,
    });
  });
});
