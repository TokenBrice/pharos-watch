import { describe, expect, it } from "vitest";
import {
  computeBlacklistAmountUsdAtEvent,
  getBlacklistPriceAssetId,
  getBlacklistNativeFractionDigits,
  isBlacklistStablecoin,
  isGoldBlacklistStablecoin,
} from "../blacklist";
import { BLACKLIST_STABLECOINS } from "../../types/market";

describe("blacklist price boundary", () => {
  it("records a pricing decision for every tracked symbol — an unmapped symbol fails here, not as $1.00", () => {
    for (const symbol of BLACKLIST_STABLECOINS) {
      expect(getBlacklistPriceAssetId(symbol), symbol).not.toBeUndefined();
    }
  });

  it("treats an explicit null as the reviewed USD-par decision, not a missing price", () => {
    expect(getBlacklistPriceAssetId("USDT")).toBeNull();
    expect(computeBlacklistAmountUsdAtEvent("USDT", 5_000)).toBe(5_000);
    expect(computeBlacklistAmountUsdAtEvent("USDT", 5_000, 0.98)).toBe(5_000);
  });

  it("prices non-USD-par assets through their tracked price asset and fails closed without a price", () => {
    expect(computeBlacklistAmountUsdAtEvent("PAXG", 10, 2_050)).toBe(20_500);
    expect(computeBlacklistAmountUsdAtEvent("PAXG", 10)).toBeNull();
    expect(computeBlacklistAmountUsdAtEvent("PAXG", null, 2_050)).toBeNull();
  });
});

describe("blacklist amount valuation", () => {
  it("maps non-USD tracked blacklist assets to price-cache IDs", () => {
    expect(getBlacklistPriceAssetId("A7A5")).toBe("a7a5-old-vector");
    expect(getBlacklistPriceAssetId("BRZ")).toBe("brz-transfero");
    expect(getBlacklistPriceAssetId("EURI")).toBe("euri-banking-circle");
    expect(getBlacklistPriceAssetId("TGBP")).toBe("tgbp-tokenised");
  });

  it("converts priced assets with supplied USD price and leaves USD assets at par", () => {
    expect(computeBlacklistAmountUsdAtEvent("BRZ", 1_000, 0.2)).toBe(200);
    expect(computeBlacklistAmountUsdAtEvent("FDUSD", 1_000)).toBe(1_000);
  });

  it("keeps the gold-only classification narrow", () => {
    for (const symbol of BLACKLIST_STABLECOINS) {
      const gold = ["PAXG", "XAUT", "XAUM"].includes(symbol);
      expect(isGoldBlacklistStablecoin(symbol), symbol).toBe(gold);
      expect(getBlacklistNativeFractionDigits(symbol), symbol).toBe(gold ? 4 : 2);
    }
    expect(isGoldBlacklistStablecoin("NOT-A-COIN")).toBe(false);
  });

  it("recognizes tracked blacklist stablecoins and rejects others", () => {
    expect(isBlacklistStablecoin("USDC")).toBe(true);
    expect(isBlacklistStablecoin("XAUT")).toBe(true);
    expect(isBlacklistStablecoin("NOT-A-COIN")).toBe(false);
  });
});
