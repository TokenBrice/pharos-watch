import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";

describe("tracked stablecoin metadata", () => {
  it("does not attach a CoinGecko slug to M by M0 when the base token is not contract-resolved on CoinGecko", () => {
    const coin = TRACKED_META_BY_ID.get("m-m0");

    expect(coin).toBeDefined();
    expect(coin?.geckoId).toBeUndefined();
    expect(coin?.contracts?.some(
      (contract) => contract.chain === "ethereum" && contract.address.toLowerCase() === "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b",
    )).toBe(true);
  });
});
