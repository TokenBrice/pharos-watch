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

  it("rejects malformed frozenAt values", () => {
    expect(() => StablecoinListResponseSchema.parse({
      peggedAssets: [makeRawAsset({ id: "frozen-coin", frozen: true, frozenAt: "not-a-registry-date" })],
    })).toThrow();
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

describe("/api/stablecoins payload shape — contracts field", () => {
  it("passes through curated contracts with chain/address/decimals", () => {
    const parsed = StablecoinListResponseSchema.parse({
      peggedAssets: [
        makeRawAsset({
          contracts: [
            { chain: "ethereum", address: "0xB1c2Db5d6cA03FCe73dBd304d320bF76C55Ae1B1", decimals: 18 },
          ],
        }),
      ],
    });
    const entry = parsed.peggedAssets[0] as {
      contracts?: { chain: string; address: string; decimals: number }[];
    };
    expect(entry.contracts).toEqual([
      { chain: "ethereum", address: "0xB1c2Db5d6cA03FCe73dBd304d320bF76C55Ae1B1", decimals: 18 },
    ]);
  });

  it("omits contracts when not present or empty", () => {
    const withoutContracts = StablecoinListResponseSchema.parse({
      peggedAssets: [makeRawAsset()],
    });
    const withEmpty = StablecoinListResponseSchema.parse({
      peggedAssets: [makeRawAsset({ contracts: [] })],
    });
    expect((withoutContracts.peggedAssets[0] as { contracts?: unknown }).contracts).toBeUndefined();
    expect((withEmpty.peggedAssets[0] as { contracts?: unknown }).contracts).toBeUndefined();
  });
});

describe("/api/stablecoins payload shape — chain supply", () => {
  it.each([
    ["current", -1],
    ["circulatingPrevDay", Number.NaN],
    ["circulatingPrevWeek", Number.POSITIVE_INFINITY],
    ["circulatingPrevMonth", Number.NEGATIVE_INFINITY],
  ])("rejects invalid %s values", (field, value) => {
    const asset = makeRawAsset();
    const chainCirculating = asset.chainCirculating as Record<string, Record<string, number>>;
    chainCirculating.Ethereum[field] = value;

    expect(StablecoinListResponseSchema.safeParse({ peggedAssets: [asset] }).success).toBe(false);
  });
});
