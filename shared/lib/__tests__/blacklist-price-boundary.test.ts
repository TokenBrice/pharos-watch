import { describe, expect, it } from "vitest";
import { computeBlacklistAmountUsdAtEvent, getBlacklistPriceAssetId } from "../blacklist";
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
