import { describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../../test-helpers/cron";
import { mockFetch } from "../../../../test-helpers/__shared/mock-fetch";

const KAGT_PRICE = 34.5;

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: [
    {
      id: "kagt-single-chain-test",
      name: "Kag Single Chain Test Silver",
      symbol: "kagT",
      geckoId: "kag-single-chain-test-silver",
      detailProvider: "commodity",
      commodityOunces: 1,
      contracts: [
        { chain: "ethereum", address: "0x6666666666666666666666666666666666666fee", decimals: 18 },
      ],
      flags: {
        pegCurrency: "SILVER",
        backing: "rwa-backed",
        governance: "centralized",
        yieldBearing: false,
        rwa: true,
        navToken: false,
      },
    },
  ],
}));

import { fetchSilverTokens } from "../silver";

describe("fetchSilverTokens single-contract attribution", () => {
  it("attributes the CoinGecko aggregate to the single probeable deployment", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockFetch(
      [
        { match: "/prices/current/", body: { coins: {} } },
        { match: "/coins/markets", body: [] },
      ],
      { requireMatch: true },
    );

    const assets = await fetchSilverTokens({
      "kag-single-chain-test-silver": {
        usd: KAGT_PRICE,
        usd_market_cap: 34_500,
        last_updated_at: nowSec,
      },
    });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: "kagt-single-chain-test",
      supplySource: "coingecko-fallback",
      circulating: { peggedSILVER: 34_500 },
    });
    expect(assets[0]?.chainCirculating).toEqual({
      Ethereum: {
        current: 34_500,
        circulatingPrevDay: 0,
        circulatingPrevWeek: 0,
        circulatingPrevMonth: 0,
      },
    });
  });
});
