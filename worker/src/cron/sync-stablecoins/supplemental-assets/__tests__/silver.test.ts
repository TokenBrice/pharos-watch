import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../../test-helpers/cron";
import { mockFetch } from "@shared/test-utils/mock-fetch";

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: [{
    id: "silver-test", name: "Silver Test", symbol: "SILVER", geckoId: "silver-test",
    flags: { pegCurrency: "SILVER", backing: "rwa-backed", governance: "centralized" },
  }],
}));

import { fetchSilverTokens } from "../silver";

afterEach(() => vi.unstubAllGlobals());

describe("silver supplemental supply freshness", () => {
  it.each([
    { freshSupply: false, freshMcap: false, expected: 0 },
    { freshSupply: true, freshMcap: false, expected: 3_200 },
    { freshSupply: false, freshMcap: true, expected: 1_000 },
  ])("validates supply and market-cap observations independently: $freshSupply/$freshMcap", async ({ freshSupply, freshMcap, expected }) => {
    const now = Math.floor(Date.now() / 1000);
    const stale = now - 9 * 86400;
    mockFetch([
      { match: "/prices/current/", body: { coins: { "coingecko:silver-test": { price: 32, timestamp: now } } } },
      { match: "/coins/markets?", body: [{ id: "silver-test", circulating_supply: 100, last_updated: new Date((freshSupply ? now : stale) * 1000).toISOString() }] },
    ], { requireMatch: true });
    const [asset] = await fetchSilverTokens({
      "silver-test": { usd_market_cap: 1_000, last_updated_at: freshMcap ? now : stale },
    });
    expect(asset?.circulating?.peggedSILVER).toBe(expected);
    expect(asset?.price).toBe(32);
  });
});
