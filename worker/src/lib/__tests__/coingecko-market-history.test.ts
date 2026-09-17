import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { fetchCoinGeckoMarketHistory } from "../coingecko-market-history";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchCoinGeckoMarketHistory", () => {
  it("returns validated market history and circulating supply", async () => {
    mockFetch([
      {
        match: "/market_chart?",
        body: {
          prices: [[1_700_000_000_000, 1.001]],
          market_caps: [[1_700_000_000_000, 85_000_000_000]],
        },
      },
      {
        match: "/coins/tether?",
        body: { market_data: { circulating_supply: 84_900_000_000 } },
      },
    ]);

    await expect(fetchCoinGeckoMarketHistory("tether", { retries: 0 })).resolves.toEqual({
      prices: [[1_700_000_000_000, 1.001]],
      marketCaps: [[1_700_000_000_000, 85_000_000_000]],
      circulatingSupply: 84_900_000_000,
    });
  });

  it("returns null instead of exposing malformed market-cap arrays", async () => {
    mockFetch([
      {
        match: "/market_chart?",
        body: {
          prices: [[1_700_000_000_000, 1.001]],
          market_caps: { timestamp: 1_700_000_000_000, value: 85_000_000_000 },
        },
      },
      {
        match: "/coins/tether?",
        body: { market_data: { circulating_supply: 84_900_000_000 } },
      },
    ]);

    await expect(fetchCoinGeckoMarketHistory("tether", { retries: 0 })).resolves.toBeNull();
  });
});
