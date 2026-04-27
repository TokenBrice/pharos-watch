import { describe, expect, it } from "vitest";
import { StablecoinListResponseSchema } from "../market";

function makeRawAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test-coin",
    name: "Test",
    symbol: "TEST",
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: 1,
    priceSource: "defillama",
    circulating: { peggedUSD: 1000 },
    chainCirculating: {
      Ethereum: {
        current: 1000,
        circulatingPrevDay: 1000,
        circulatingPrevWeek: 1000,
        circulatingPrevMonth: 1000,
      },
    },
    chains: ["Ethereum"],
    ...overrides,
  };
}

describe("/api/stablecoins payload shape — frozen fields", () => {
  it("includes frozen and frozenAt when present on the raw asset", () => {
    const parsed = StablecoinListResponseSchema.parse({
      peggedAssets: [
        makeRawAsset({ id: "frozen-coin", frozen: true, frozenAt: "2026-04-27" }),
      ],
    });
    const entry = parsed.peggedAssets[0] as { frozen?: boolean; frozenAt?: string };
    expect(entry.frozen).toBe(true);
    expect(entry.frozenAt).toBe("2026-04-27");
  });

  it("omits frozen and frozenAt when not present on the raw asset", () => {
    const parsed = StablecoinListResponseSchema.parse({
      peggedAssets: [makeRawAsset()],
    });
    const entry = parsed.peggedAssets[0] as { frozen?: boolean; frozenAt?: string };
    expect(entry.frozen).toBeUndefined();
    expect(entry.frozenAt).toBeUndefined();
  });
});
