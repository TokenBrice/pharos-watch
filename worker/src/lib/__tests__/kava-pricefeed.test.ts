import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import fixture from "./fixtures/kava-pricefeed-usdx.json";

const fetchJsonWithRetryMock = vi.fn();

vi.mock("../fetch-retry", () => ({
  fetchJsonWithRetry: (...args: unknown[]) => fetchJsonWithRetryMock(...args),
}));

import { fetchKavaUsdxPrice, kavaUsdxPricefeedProvider } from "../authoritative-price-sources/kava-pricefeed";
import { fetchAuthoritativeLivePriceOverrides } from "../authoritative-price-sources";
import { validatePrimaryPriceCandidate } from "../price-publish-policy";
import { buildPriceValidationContext } from "../price-validation";

const NOW = new Date("2026-07-16T06:22:00.000Z");

function ok(body: unknown): { response: Response; body: unknown } {
  return { response: new Response(null, { status: 200 }), body };
}

function installFixtureResponses(
  overrides: {
    block?: unknown;
    markets?: unknown;
    aggregate?: unknown;
    raw?: unknown;
  } = {},
): void {
  fetchJsonWithRetryMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/blocks/latest")) return ok(overrides.block ?? structuredClone(fixture.block));
    if (url.endsWith("/markets")) return ok(overrides.markets ?? structuredClone(fixture.markets));
    if (url.endsWith("/prices/usdx:usd")) return ok(overrides.aggregate ?? structuredClone(fixture.aggregate));
    if (url.endsWith("/rawprices/usdx:usd")) return ok(overrides.raw ?? structuredClone(fixture.raw));
    throw new Error(`unexpected Kava URL: ${url}`);
  });
}

describe("Kava USDX pricefeed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchJsonWithRetryMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("accepts the exact USDX market with a fresh block and authorized unexpired raw oracle", async () => {
    installFixtureResponses();

    await expect(fetchKavaUsdxPrice()).resolves.toEqual({
      price: 0.66,
      observedAt: Math.floor(Date.parse(fixture.block.block.header.time) / 1_000),
      blockHeight: 21658182,
      activeOracleCount: 1,
      newestExpiry: Math.floor(Date.parse(fixture.raw.raw_prices[0]!.expiry) / 1_000),
      dispersionBps: 0,
    });

    expect(fetchJsonWithRetryMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.data.kava.io/cosmos/base/tendermint/v1beta1/blocks/latest",
      "https://api.data.kava.io/kava/pricefeed/v1beta1/markets",
      "https://api.data.kava.io/kava/pricefeed/v1beta1/prices/usdx:usd",
      "https://api.data.kava.io/kava/pricefeed/v1beta1/rawprices/usdx:usd",
    ]);
    for (const [, , retries, options] of fetchJsonWithRetryMock.mock.calls) {
      expect(retries).toBe(0);
      expect(options).toMatchObject({ timeoutMs: 2_200, maxResponseBytes: 256 * 1024 });
    }
  });

  it("returns a high-confidence upstream authoritative override for USDX", async () => {
    installFixtureResponses();

    const override = await kavaUsdxPricefeedProvider.fetchLivePrice?.(
      { id: "usdx-kava", name: "Kava USDX", symbol: "USDX" } as PeggedAsset,
      { assetsById: new Map() },
    );

    expect(kavaUsdxPricefeedProvider).toMatchObject({
      source: "kava-pricefeed",
      liveCircuitSource: "kava-pricefeed",
      recordNullLiveResultAsCircuitFailure: true,
    });
    expect(override).toMatchObject({
      price: 0.66,
      source: "kava-pricefeed",
      confidence: "high",
      observedAt: Math.floor(Date.parse(fixture.block.block.header.time) / 1_000),
      observedAtMode: "upstream",
      metadata: {
        kavaPricefeed: {
          marketId: "usdx:usd",
          blockHeight: 21658182,
          activeOracleCount: 1,
          dispersionBps: 0,
        },
      },
    });
    expect(kavaUsdxPricefeedProvider.matches("usdx-kava")).toBe(true);
    expect(kavaUsdxPricefeedProvider.matches("usdx-hex-trust")).toBe(false);
  });

  it("is wired into the authoritative provider registry for USDX", async () => {
    installFixtureResponses();

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "usdx-kava",
        name: "Kava USDX",
        symbol: "USDX",
        price: null,
      },
    ]);

    expect(overrides.get("usdx-kava")).toMatchObject({
      price: 0.66,
      source: "kava-pricefeed",
      confidence: "high",
    });
  });

  it("admits the current USDX downside through normal fixed-peg publication policy", () => {
    expect(
      validatePrimaryPriceCandidate({
        price: 0.66,
        source: "kava-pricefeed",
        confidence: "high",
        agreeSources: ["kava-pricefeed"],
        validationContext: buildPriceValidationContext({
          stablecoinId: "usdx-kava",
          pegType: "peggedUSD",
        }),
      }),
    ).toMatchObject({ accepted: true });
  });

  it("fails closed for a wrong aggregate or raw market identity", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installFixtureResponses({
      aggregate: {
        price: { market_id: "usdt:usd", price: "0.660000000000000000" },
      },
    });
    await expect(fetchKavaUsdxPrice()).resolves.toBeNull();

    fetchJsonWithRetryMock.mockReset();
    installFixtureResponses({
      raw: {
        raw_prices: [{ ...fixture.raw.raw_prices[0], market_id: "usdt:usd" }],
      },
    });
    await expect(fetchKavaUsdxPrice()).resolves.toBeNull();
  });

  it("fails closed when the Kava block is stale, from another chain, or malformed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const block of [
      { block: { header: { ...fixture.block.block.header, time: "2026-07-16T06:10:00Z" } } },
      { block: { header: { ...fixture.block.block.header, chain_id: "not-kava" } } },
      { block: { header: { ...fixture.block.block.header, height: "height-unknown" } } },
      { block: { header: { chain_id: "kava_2222-10" } } },
    ]) {
      fetchJsonWithRetryMock.mockReset();
      installFixtureResponses({ block });
      await expect(fetchKavaUsdxPrice()).resolves.toBeNull();
      expect(fetchJsonWithRetryMock).toHaveBeenCalledTimes(1);
    }
  });

  it("requires one raw observation from the active market's authorized oracle set", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installFixtureResponses({
      raw: {
        raw_prices: [
          {
            ...fixture.raw.raw_prices[0],
            oracle_address: "kava1unauthorized",
          },
        ],
      },
    });
    await expect(fetchKavaUsdxPrice()).resolves.toBeNull();

    fetchJsonWithRetryMock.mockReset();
    installFixtureResponses({
      markets: {
        markets: [{ ...fixture.markets.markets[0], active: false }],
      },
    });
    await expect(fetchKavaUsdxPrice()).resolves.toBeNull();
  });

  it("rejects raw observations that expire before the replay-safe cache window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installFixtureResponses({
      raw: {
        raw_prices: [
          {
            ...fixture.raw.raw_prices[0],
            expiry: "2026-07-16T06:30:00Z",
          },
        ],
      },
    });

    await expect(fetchKavaUsdxPrice()).resolves.toBeNull();
  });

  it("rejects excessive active-oracle dispersion and aggregate disagreement", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const secondOracle = fixture.markets.markets[0]!.oracles[1]!;
    installFixtureResponses({
      raw: {
        raw_prices: [
          fixture.raw.raw_prices[0],
          {
            ...fixture.raw.raw_prices[0],
            oracle_address: secondOracle,
            price: "1.100000000000000000",
          },
        ],
      },
    });
    await expect(fetchKavaUsdxPrice()).resolves.toBeNull();

    fetchJsonWithRetryMock.mockReset();
    installFixtureResponses({
      aggregate: { price: { market_id: "usdx:usd", price: "0.800000000000000000" } },
    });
    await expect(fetchKavaUsdxPrice()).resolves.toBeNull();
  });

  it("fails closed on endpoint schema drift and HTTP failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installFixtureResponses({ aggregate: { price: { market_id: "usdx:usd", price: 0.66 } } });
    await expect(fetchKavaUsdxPrice()).resolves.toBeNull();

    fetchJsonWithRetryMock.mockReset();
    fetchJsonWithRetryMock.mockResolvedValueOnce({
      response: new Response(null, { status: 503 }),
      body: null,
    });
    await expect(fetchKavaUsdxPrice()).resolves.toBeNull();
  });
});
