import { describe, expect, it } from "vitest";
import { StablecoinListResponseSchema } from "@shared/types";

describe("StablecoinListResponseSchema compatibility", () => {
  it("normalizes snake_case gecko IDs and nullable historical buckets", () => {
    const parsed = StablecoinListResponseSchema.parse({
      peggedAssets: [
        {
          id: "1",
          name: "Tether",
          symbol: "USDT",
          gecko_id: "tether",
          pegType: "peggedUSD",
          pegMechanism: "fiat-backed",
          price: 1,
          priceSource: "defillama",
          circulating: { peggedUSD: 1000 },
          circulatingPrevDay: null,
          circulatingPrevWeek: undefined,
          circulatingPrevMonth: { peggedUSD: 950 },
          chainCirculating: {
            Ethereum: {
              current: 1000,
              circulatingPrevDay: 990,
              circulatingPrevWeek: 980,
              circulatingPrevMonth: 970,
            },
          },
          chains: ["Ethereum"],
        },
      ],
      chains: ["Ethereum"],
      _meta: { updatedAt: 1, ageSeconds: 0, status: "fresh" },
    });

    const coin = parsed.peggedAssets[0];
    expect(coin.geckoId).toBe("tether");
    expect(coin.priceConfidence).toBeNull();
    expect(coin.circulatingPrevDay).toEqual({});
    expect(coin.circulatingPrevWeek).toEqual({});
    expect(coin.circulatingPrevMonth).toEqual({ peggedUSD: 950 });
  });

  it("defaults missing gecko ID to null", () => {
    const parsed = StablecoinListResponseSchema.parse({
      peggedAssets: [
        {
          id: "2",
          name: "Unknown",
          symbol: "UNK",
          pegType: "peggedUSD",
          pegMechanism: "fiat-backed",
          price: null,
          priceSource: "defillama",
          priceConfidence: null,
          circulating: { peggedUSD: 100 },
          circulatingPrevDay: { peggedUSD: 100 },
          circulatingPrevWeek: { peggedUSD: 100 },
          circulatingPrevMonth: { peggedUSD: 100 },
          chainCirculating: {},
          chains: [],
        },
      ],
    });

    expect(parsed.peggedAssets[0].geckoId).toBeNull();
  });
});
