import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DataQualityCards } from "@/components/status/data-quality-cards";

describe("DataQualityCards", () => {
  it("does not warn on a tiny missing-price count that is below status thresholds", () => {
    const html = renderToStaticMarkup(
      <DataQualityCards
        dq={{
          nowSeconds: 1_772_100_000,
          stablecoinsCacheStatus: "ok",
          stablecoinsCacheReason: null,
          totalStablecoins: 156,
          missingPrices: 1,
          blacklistMissingAmounts: 0,
          blacklistRecentMissingAmounts: 0,
          blacklistRecentWindowSec: 86_400,
          blacklistMissingRatio: 0,
          blacklistTotal: 1000,
          onchainSupplyDivergences: 0,
          onchainDivergenceRatio: 0,
          onchainSupplyMonitoring: "active",
          onchainSupplyLatestAt: 1_772_099_000,
          onchainSupplyTrackedCoins: 12,
          activeDepegs: 0,
          staleOnchainSupply: 0,
          onchainStaleRatio: 0,
        }}
      />,
    );

    expect(html).not.toContain("text-amber-600");
    expect(html).not.toContain("text-red-600");
  });

  it("labels active depegs as informational rather than a status warning", () => {
    const html = renderToStaticMarkup(
      <DataQualityCards
        dq={{
          nowSeconds: 1_772_100_000,
          stablecoinsCacheStatus: "ok",
          stablecoinsCacheReason: null,
          totalStablecoins: 156,
          missingPrices: 0,
          blacklistMissingAmounts: 0,
          blacklistRecentMissingAmounts: 0,
          blacklistRecentWindowSec: 86_400,
          blacklistMissingRatio: 0,
          blacklistTotal: 1000,
          onchainSupplyDivergences: 0,
          onchainDivergenceRatio: 0,
          onchainSupplyMonitoring: "active",
          onchainSupplyLatestAt: 1_772_099_000,
          onchainSupplyTrackedCoins: 12,
          activeDepegs: 3,
          staleOnchainSupply: 0,
          onchainStaleRatio: 0,
        }}
      />,
    );

    expect(html).toContain("informational only; active depegs do not change /status health");
  });
});
