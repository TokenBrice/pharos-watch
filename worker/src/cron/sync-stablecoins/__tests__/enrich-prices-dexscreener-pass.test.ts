import { afterEach, describe, expect, it, vi } from "vitest";
import { runDexScreenerPass } from "../enrich-prices-dexscreener-pass";
import type { PeggedAsset } from "../enrich-prices";

function makeMissingAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return {
    id: "143",
    name: "Verified USD",
    symbol: "USDV",
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: null,
    priceSource: "missing",
    priceConfidence: null,
    priceUpdatedAt: null,
    circulating: { peggedUSD: 1_000_000 },
    chainCirculating: {},
    chains: ["Ethereum"],
    ...overrides,
  };
}

describe("runDexScreenerPass", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not use the retired symbol-search fallback for addressless assets", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await runDexScreenerPass([makeMissingAsset()], undefined, undefined);

    expect(result).toMatchObject({ resolved: 0, failures: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
