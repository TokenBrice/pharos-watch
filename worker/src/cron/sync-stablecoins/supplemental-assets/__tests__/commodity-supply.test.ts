import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../../test-helpers/cron";
import { mockFetch } from "@shared/test-utils/mock-fetch";

// One home for the supplemental commodity freshness policy: gold and silver both
// admit a row only from an observation that is itself fresh, and validate the
// supply observation independently of the market-cap observation.

const GOLD_PRICE = 4_042.62;
const SILVER_PRICE = 32;

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: [
    {
      id: "pgold-pleasing",
      name: "Pleasing Gold",
      symbol: "PGOLD",
      geckoId: "pleasing-gold",
      protocolSlug: "pleasing-gold",
      detailProvider: "commodity",
      commodityOunces: 1,
      flags: { pegCurrency: "GOLD", backing: "rwa-backed", governance: "centralized" },
    },
    {
      id: "silver-test",
      name: "Silver Test",
      symbol: "SILVER",
      geckoId: "silver-test",
      flags: { pegCurrency: "SILVER", backing: "rwa-backed", governance: "centralized" },
    },
  ],
}));

import { fetchGoldTokens } from "../gold";
import { fetchSilverTokens } from "../silver";

afterEach(() => vi.unstubAllGlobals());

const nowSec = () => Math.floor(Date.now() / 1000);
const staleSec = () => nowSec() - 9 * 86400;

const LANES = [
  {
    lane: "gold",
    geckoId: "pleasing-gold",
    pegKey: "peggedGOLD",
    price: GOLD_PRICE,
    stubUpstreams(observedAt: number): void {
      mockFetch([
        {
          match: "/prices/current/",
          body: { coins: { "coingecko:pleasing-gold": { price: GOLD_PRICE, timestamp: observedAt } } },
        },
        { match: "/protocol/", body: {} },
      ], { requireMatch: true });
    },
    fetchTokens: fetchGoldTokens,
  },
  {
    lane: "silver",
    geckoId: "silver-test",
    pegKey: "peggedSILVER",
    price: SILVER_PRICE,
    stubUpstreams(observedAt: number): void {
      mockFetch([
        {
          match: "/prices/current/",
          body: { coins: { "coingecko:silver-test": { price: SILVER_PRICE, timestamp: observedAt } } },
        },
        { match: "/coins/markets?", body: [] },
      ], { requireMatch: true });
    },
    fetchTokens: fetchSilverTokens,
  },
] as const;

describe.each(LANES)("$lane supplemental market-cap freshness", (lane) => {
  it("publishes the row from a fresh upstream market cap", async () => {
    const observedAt = nowSec() - 60;
    lane.stubUpstreams(observedAt);

    const [asset] = await lane.fetchTokens({
      [lane.geckoId]: { usd: lane.price, usd_market_cap: 78_852_290, last_updated_at: observedAt },
    });

    expect(asset?.supplyObservedAt).toBe(observedAt);
    expect(asset?.supplySource).toBe("coingecko-fallback");
    expect(asset?.circulating?.[lane.pegKey]).toBe(78_852_290);
  });

  it("rejects a stale upstream market cap independently of positive value", async () => {
    const observedAt = staleSec();
    lane.stubUpstreams(observedAt);

    const [asset] = await lane.fetchTokens({
      [lane.geckoId]: { usd: lane.price, usd_market_cap: 78_852_290, last_updated_at: observedAt },
    });

    expect(asset).toBeUndefined();
  });

  it("drops the row on a zero market cap even when its price is fresh", async () => {
    lane.stubUpstreams(nowSec());

    await expect(lane.fetchTokens({
      [lane.geckoId]: { usd: lane.price, usd_market_cap: 0, last_updated_at: nowSec() },
    })).resolves.toEqual([]);
  });
});

describe("silver supplemental supply observation", () => {
  it.each([
    { freshSupply: false, freshMcap: false, expected: null },
    { freshSupply: true, freshMcap: false, expected: 3_200 },
    { freshSupply: true, freshMcap: true, expected: 3_200 },
    { freshSupply: false, freshMcap: true, expected: 1_000 },
  ])(
    "validates supply and market-cap observations independently: $freshSupply/$freshMcap",
    async ({ freshSupply, freshMcap, expected }) => {
      const now = nowSec();
      const stale = staleSec();
      mockFetch([
        { match: "/prices/current/", body: { coins: { "coingecko:silver-test": { price: SILVER_PRICE, timestamp: now } } } },
        {
          match: "/coins/markets?",
          body: [{
            id: "silver-test",
            circulating_supply: 100,
            last_updated: new Date((freshSupply ? now - 30 : stale) * 1000).toISOString(),
          }],
        },
      ], { requireMatch: true });

      const [asset] = await fetchSilverTokens({
        "silver-test": { usd_market_cap: 1_000, last_updated_at: freshMcap ? now - 60 : stale },
      });

      if (expected == null) {
        expect(asset).toBeUndefined();
      } else {
        expect(asset?.circulating?.peggedSILVER).toBe(expected);
        expect(asset?.price).toBe(SILVER_PRICE);
        expect(asset?.supplyObservedAt).toBe(freshSupply ? now - 30 : now - 60);
      }
    },
  );
});
