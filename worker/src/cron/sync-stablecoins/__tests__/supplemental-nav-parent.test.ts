import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../test-helpers/cron";
import type * as FetchRetry from "../../../lib/fetch-retry";
import type * as OnchainSupply from "../supplemental-assets/onchain-supply";
import type { PeggedAsset } from "../enrich-prices-shared";
import type { CoinGeckoMcapData } from "../supplemental-assets/shared";
import syzusd from "@shared/data/stablecoins/coins/syzusd-yuzu.json";
import yzusd from "@shared/data/stablecoins/coins/yzusd-yuzu.json";

const mocks = vi.hoisted(() => ({ resolveNav: vi.fn(), onChainMcap: vi.fn() }));

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: [syzusd, yzusd].map((meta) => ({ ...meta, flags: { ...meta.flags, pegCurrency: "USD" } })),
}));
vi.mock("../../../lib/fetch-retry", async (importOriginal) => ({
  ...(await importOriginal<typeof FetchRetry>()),
  fetchTextWithRetry: async () => ({ response: Response.json({ coins: {} }), body: '{"coins":{}}' }),
}));
vi.mock("../../../lib/authoritative-price-sources", () => ({
  getFreshSingleSourceNavParentId: (id: string) => id === "syzusd-yuzu" ? "yzusd-yuzu" : null,
  resolveVaultNavSupplyPrice: (...args: unknown[]) => mocks.resolveNav(...args),
}));
vi.mock("../supplemental-assets/onchain-supply", async (importOriginal) => ({
  ...(await importOriginal<typeof OnchainSupply>()),
  fetchCuratedAggregateOnChainMcap: async () => null,
  fetchOnChainMcap: (...args: unknown[]) => mocks.onChainMcap(...args),
}));

import { FIAT_CG_NAV_PARENT_METAS, fetchFiatCoinGeckoTokens } from "../supplemental-assets/fiat-cg";

const nowSec = () => Math.floor(Date.now() / 1000);
const parentQuote = (ageSec: number, usd = 1): CoinGeckoMcapData => ({
  "yuzu-usd": { usd, usd_market_cap: 50_000_000, last_updated_at: nowSec() - ageSec },
});
const parentPassed = () => (mocks.resolveNav.mock.calls[0]![1] as ReadonlyMap<string, PeggedAsset>);

describe("fiat-cg NAV supply valuation from an admitted same-run parent (K-033)", () => {
  beforeEach(() => {
    mocks.resolveNav.mockReset().mockImplementation(async (_id: string, parents: ReadonlyMap<string, PeggedAsset>) =>
      parents.has("yzusd-yuzu") ? { price: 1.05, source: "coingecko", confidence: "single-source" } : null);
    mocks.onChainMcap.mockReset().mockImplementation(async (_meta: unknown, price: number) => ({
      mcap: 1_000_000 * price, supplySource: "onchain-total-supply", observedAt: nowSec() - 30,
      chainCirculating: { Plasma: { chainId: "plasma", current: 1_000_000 * price } },
    }));
  });

  it("requests the DefiLlama-owned parent once", () => {
    expect(FIAT_CG_NAV_PARENT_METAS.map((meta) => [meta.id, meta.geckoId])).toEqual([["yzusd-yuzu", "yuzu-usd"]]);
  });

  it("admits syzUSD supply on a first run from a fresh direct CoinGecko parent", async () => {
    const [asset] = await fetchFiatCoinGeckoTokens(parentQuote(60));
    expect(parentPassed().get("yzusd-yuzu")).toEqual({
      id: "yzusd-yuzu", name: yzusd.name, symbol: yzusd.symbol, price: 1, priceSource: "coingecko",
      priceConfidence: "single-source", priceObservedAt: nowSec() - 60, priceObservedAtMode: "upstream",
      priceSyncedAt: expect.any(Number),
    });
    expect(asset).toMatchObject({ id: "syzusd-yuzu", circulating: { peggedUSD: 1_050_000 }, supplySource: "onchain-total-supply" });
    expect(asset!.price ?? null).toBeNull();
  });

  it("prefers the fresh current parent over a delayed previous row without mutating the previous map", async () => {
    const delayed: PeggedAsset = { id: "yzusd-yuzu", name: "Yuzu USD", symbol: "YZUSD", price: 0.99,
      priceSource: "coingecko", priceConfidence: "single-source", priceObservedAt: nowSec() - 1200 };
    const previous = new Map([["yzusd-yuzu", delayed]]);
    await fetchFiatCoinGeckoTokens(parentQuote(900), undefined, undefined, undefined, undefined, previous);
    expect(parentPassed()).not.toBe(previous);
    expect(parentPassed().get("yzusd-yuzu")).toMatchObject({ price: 1, priceObservedAt: nowSec() - 900 });
    expect(previous.get("yzusd-yuzu")).toBe(delayed);
    expect(previous.size).toBe(1);
  });

  it("passes the unchanged previous map when no current parent is admitted", async () => {
    const previous = new Map<string, PeggedAsset>();
    await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined, undefined, previous);
    expect(parentPassed()).toBe(previous);
  });

  it.each<[string, CoinGeckoMcapData]>([
    ["901-second-old", parentQuote(901)],
    ["future", parentQuote(-3600)],
    ["clockless", { "yuzu-usd": { usd: 1, usd_market_cap: 50_000_000 } }],
    ["invalid-clock", { "yuzu-usd": { usd: 1, last_updated_at: Number.NaN } }],
    ["non-positive", parentQuote(60, 0)],
    ["unreasonable", parentQuote(60, 5)],
  ])("keeps syzUSD supply unavailable for a %s parent quote", async (_label, cgData) => {
    expect(await fetchFiatCoinGeckoTokens(cgData)).toEqual([]);
    expect(parentPassed().has("yzusd-yuzu")).toBe(false);
    expect(mocks.onChainMcap).not.toHaveBeenCalled();
  });

  it("keeps supply unavailable when the parent is admitted but the NAV read fails", async () => {
    mocks.resolveNav.mockResolvedValue(null);
    expect(await fetchFiatCoinGeckoTokens(parentQuote(60))).toEqual([]);
    expect(mocks.onChainMcap).not.toHaveBeenCalled();
  });

  it("keeps supply unavailable when an on-chain supply leg is unreadable", async () => {
    mocks.onChainMcap.mockResolvedValue(null);
    expect(await fetchFiatCoinGeckoTokens(parentQuote(60))).toEqual([]);
  });

  it("does not consult the NAV route when the vault has its own market price", async () => {
    const cgData = { ...parentQuote(60), "staked-yuzu-usd": { usd: 1.04, last_updated_at: nowSec() - 60 } };
    const [asset] = await fetchFiatCoinGeckoTokens(cgData);
    expect(mocks.resolveNav).not.toHaveBeenCalled();
    expect(asset).toMatchObject({ price: 1.04, circulating: { peggedUSD: 1_040_000 } });
  });
});
