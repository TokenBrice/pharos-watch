// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useRegisteredApiQueryMock, useStablecoinsMock } = vi.hoisted(() => ({
  useRegisteredApiQueryMock: vi.fn(),
  useStablecoinsMock: vi.fn(),
}));

vi.mock("../api-hooks", () => ({
  useRegisteredApiQuery: useRegisteredApiQueryMock,
}));

vi.mock("../use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

import { useChainStablecoins, useChains } from "../use-chains";

describe("useChains", () => {
  beforeEach(() => {
    useRegisteredApiQueryMock.mockReset();
    useStablecoinsMock.mockReset();
  });

  it("uses the shared chains endpoint polling contract", () => {
    useRegisteredApiQueryMock.mockReturnValue({ data: undefined, meta: null });

    renderHook(() => useChains());

    expect(useRegisteredApiQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["chains"],
        path: "/api/chains",
        producerIntervalMs: 15 * 60 * 1000,
        schema: expect.any(Function),
        metaMaxAgeSec: 1800,
      }),
    );
  });

  it("derives sorted per-chain coin data and chain-share math from stablecoin payloads", () => {
    useStablecoinsMock.mockReturnValue({
      data: {
        peggedAssets: [
          {
            id: "usdc-circle",
            name: "USD Coin",
            symbol: "USDC",
            price: 1,
            pegType: "peggedUSD",
            chainCirculating: {
              ethereum: {
                current: 100,
                circulatingPrevDay: 80,
                circulatingPrevWeek: 70,
                circulatingPrevMonth: 50,
              },
            },
          },
          {
            id: "usdt-tether",
            name: "Tether",
            symbol: "USDT",
            price: 1,
            pegType: "peggedUSD",
            chainCirculating: {
              ethereum: {
                current: 300,
                circulatingPrevDay: 250,
                circulatingPrevWeek: 200,
                circulatingPrevMonth: 150,
              },
              arbitrum: {
                current: 50,
                circulatingPrevDay: 40,
                circulatingPrevWeek: 35,
                circulatingPrevMonth: 30,
              },
            },
          },
        ],
      },
      isLoading: false,
      isError: false,
    });

    const { result } = renderHook(() => useChainStablecoins("ethereum"));

    expect(result.current.totalUsd).toBe(400);
    expect(result.current.coins.map((coin) => coin.id)).toEqual(["usdt-tether", "usdc-circle"]);
    expect(result.current.coins[0]).toMatchObject({
      supplyOnChain: 300,
      chainShare: 0.75,
      change24h: 50,
      change7d: 100,
      change30d: 150,
    });
    expect(result.current.coins[1]).toMatchObject({
      supplyOnChain: 100,
      chainShare: 0.25,
      change24hPct: 0.25,
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
  });
});
