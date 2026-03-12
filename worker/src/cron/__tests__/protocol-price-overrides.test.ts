import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchEvmCallHexMock = vi.fn();

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

vi.mock("../reserve-adapters/evm", () => ({
  fetchEvmCallHex: (...args: unknown[]) => fetchEvmCallHexMock(...args),
  resolveCoinContractAddress: (
    coin: { contracts?: Array<{ chain: string; address: string }> },
    chainId: string,
  ) => coin.contracts?.find((entry) => entry.chain === chainId)?.address ?? null,
}));

import { fetchProtocolPriceOverrides } from "../protocol-price-overrides";

describe("fetchProtocolPriceOverrides", () => {
  beforeEach(() => {
    fetchEvmCallHexMock.mockReset();
  });

  it("returns a cUSD price override from the Cap redemption quote", async () => {
    fetchEvmCallHexMock.mockResolvedValue(
      "0x000000000000000000000000000000000000000000000000000000e8d435370b0000000000000000000000000000000000000000000000000000000000000000",
    );

    const overrides = await fetchProtocolPriceOverrides([
      {
        id: "cusd-cap",
        name: "Cap cUSD",
        symbol: "CUSD",
        circulating: { peggedUSD: 114_000_000 },
      },
    ]);

    expect(fetchEvmCallHexMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexMock).toHaveBeenCalledWith(
      "ethereum",
      "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      expect.stringMatching(/^0xb7c4a6bf/),
      undefined,
    );

    const callData = fetchEvmCallHexMock.mock.calls[0][2] as string;
    expect(callData).toContain("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");

    expect(overrides.get("cusd-cap")).toEqual({
      price: 0.99999266,
      source: "protocol-redeem",
      confidence: "high",
    });
  });

  it("ignores assets without a configured protocol override", async () => {
    const overrides = await fetchProtocolPriceOverrides([
      {
        id: "usdt-tether",
        name: "Tether",
        symbol: "USDT",
        circulating: { peggedUSD: 100_000_000_000 },
      },
    ]);

    expect(fetchEvmCallHexMock).not.toHaveBeenCalled();
    expect(overrides.size).toBe(0);
  });
});
