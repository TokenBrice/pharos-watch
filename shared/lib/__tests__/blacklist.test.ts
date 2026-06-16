import { describe, expect, it } from "vitest";
import {
  computeBlacklistAmountUsdAtEvent,
  getBlacklistPriceAssetId,
  isBlacklistStablecoin,
  isGoldBlacklistStablecoin,
} from "../blacklist";

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
    expect(isGoldBlacklistStablecoin("PAXG")).toBe(true);
    expect(isGoldBlacklistStablecoin("A7A5")).toBe(false);
  });

  it("recognizes tracked blacklist stablecoins and rejects others", () => {
    expect(isBlacklistStablecoin("USDC")).toBe(true);
    expect(isBlacklistStablecoin("XAUT")).toBe(true);
    expect(isBlacklistStablecoin("NOT-A-COIN")).toBe(false);
  });
});
