import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import fixture from "./fixtures/kava-pricefeed-usdx.json";

const fetchJsonWithRetryMock = vi.fn();

vi.mock("../fetch-retry", () => ({
  DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES: 16 * 1024 * 1024,
  fetchJsonWithRetry: (...args: unknown[]) => fetchJsonWithRetryMock(...args),
}));

import { fetchKavaUsdxPrice, kavaUsdxPricefeedProvider } from "../authoritative-price-sources/kava-pricefeed";
import { fetchAuthoritativeLivePriceOverrides } from "../authoritative-price-sources";
import { validatePrimaryPriceCandidate } from "../price-publish-policy";
import { buildPriceValidationContext } from "../price-validation";

const NOW = new Date("2026-07-16T06:22:00.000Z");

const PRUNING_URLS = [
  "https://rpc.kava.io/header",
  "https://api.kava.io/kava/pricefeed/v1beta1/markets",
  "https://api.kava.io/kava/pricefeed/v1beta1/prices/usdx:usd",
  "https://api.kava.io/kava/pricefeed/v1beta1/rawprices/usdx:usd",
] as const;

const ARCHIVE_URLS = [
  "https://rpc.data.kava.io/header",
  "https://api.data.kava.io/kava/pricefeed/v1beta1/markets",
  "https://api.data.kava.io/kava/pricefeed/v1beta1/prices/usdx:usd",
  "https://api.data.kava.io/kava/pricefeed/v1beta1/rawprices/usdx:usd",
] as const;

interface FixtureOverrides {
  block?: unknown;
  markets?: unknown;
  aggregate?: unknown;
  raw?: unknown;
}

function ok(body: unknown): { response: Response; body: unknown } {
  return { response: new Response(null, { status: 200 }), body };
}

function fail(status: number): { response: Response; body: null } {
  return { response: new Response(null, { status }), body: null };
}

function responseForFamily(url: string, overrides: FixtureOverrides): { response: Response; body: unknown } {
  if (url.endsWith("/header")) return ok(overrides.block ?? { result: structuredClone(fixture.block.block) });
  if (url.endsWith("/markets")) return ok(overrides.markets ?? structuredClone(fixture.markets));
  if (url.endsWith("/prices/usdx:usd")) return ok(overrides.aggregate ?? structuredClone(fixture.aggregate));
  if (url.endsWith("/rawprices/usdx:usd")) return ok(overrides.raw ?? structuredClone(fixture.raw));
  throw new Error(`unexpected Kava URL: ${url}`);
}

function isPruningUrl(url: string): boolean {
  return url.startsWith("https://rpc.kava.io/") || url.startsWith("https://api.kava.io/");
}

function isArchiveUrl(url: string): boolean {
  return url.startsWith("https://rpc.data.kava.io/") || url.startsWith("https://api.data.kava.io/");
}

function installFixtureResponses(
  overrides: FixtureOverrides = {},
  perFamily?: {
    pruning?: FixtureOverrides;
    archive?: FixtureOverrides;
  },
): void {
  fetchJsonWithRetryMock.mockImplementation(async (url: string) => {
    if (isPruningUrl(url)) return responseForFamily(url, perFamily?.pruning ?? overrides);
    if (isArchiveUrl(url)) return responseForFamily(url, perFamily?.archive ?? overrides);
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

  it("accepts the exact USDX market from the pruning host family first", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    installFixtureResponses();

    await expect(fetchKavaUsdxPrice()).resolves.toEqual({
      price: 0.66,
      observedAt: Math.floor(Date.parse(fixture.block.block.header.time) / 1_000),
      blockHeight: 21658182,
      activeOracleCount: 1,
      newestExpiry: Math.floor(Date.parse(fixture.raw.raw_prices[0]!.expiry) / 1_000),
      dispersionBps: 0,
    });

    expect(fetchJsonWithRetryMock.mock.calls.map(([url]) => url)).toEqual([...PRUNING_URLS]);
    for (const [, , retries, options] of fetchJsonWithRetryMock.mock.calls) {
      expect(retries).toBe(0);
      expect(options).toMatchObject({ timeoutMs: 2_200, maxResponseBytes: 256 * 1024 });
    }
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(infoSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "kava_pricefeed_served",
      metadata: { hostFamily: "pruning", blockHeight: 21658182 },
    });
  });

  it("returns a high-confidence upstream authoritative override for USDX", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
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
    vi.spyOn(console, "info").mockImplementation(() => undefined);
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

  it("fails closed when the Kava block is stale, from another chain, or malformed on every family", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const block of [
      { result: { header: { ...fixture.block.block.header, time: "2026-07-16T06:10:00Z" } } },
      { result: { header: { ...fixture.block.block.header, chain_id: "not-kava" } } },
      { result: { header: { ...fixture.block.block.header, time: "2026-07-16T07:22:00Z" } } },
      { result: { header: { ...fixture.block.block.header, height: "height-unknown" } } },
      { result: { header: { chain_id: "kava_2222-10" } } },
    ]) {
      fetchJsonWithRetryMock.mockReset();
      installFixtureResponses({ block });
      await expect(fetchKavaUsdxPrice()).resolves.toBeNull();
      expect(fetchJsonWithRetryMock.mock.calls.map(([url]) => url)).toEqual([
        "https://rpc.kava.io/header",
        "https://rpc.data.kava.io/header",
      ]);
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

  it("fails closed on endpoint schema drift and HTTP failure across every family", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installFixtureResponses({ aggregate: { price: { market_id: "usdx:usd", price: 0.66 } } });
    await expect(fetchKavaUsdxPrice()).resolves.toBeNull();

    fetchJsonWithRetryMock.mockReset();
    fetchJsonWithRetryMock.mockResolvedValue(fail(503));
    await expect(fetchKavaUsdxPrice()).resolves.toBeNull();
    expect(fetchJsonWithRetryMock.mock.calls.map(([url]) => url)).toEqual([
      "https://rpc.kava.io/header",
      "https://rpc.data.kava.io/header",
    ]);
  });

  it.each(PRUNING_URLS.map((url, index) => [url, index] as const))(
    "fails over cleanly to the archive host family from /header when pruning %s returns HTTP 502 without mixing families",
    async (failedUrl, failIndex) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const archiveBlock = {
        result: { header: { ...fixture.block.block.header, height: "21658999" } },
      };
      const archiveAggregate = { price: { market_id: "usdx:usd", price: "0.670000000000000000" } };
      const archiveRaw = {
        raw_prices: [{ ...fixture.raw.raw_prices[0], price: "0.670000000000000000" }],
      };
      installFixtureResponses({}, {
        pruning: {},
        archive: { block: archiveBlock, aggregate: archiveAggregate, raw: archiveRaw },
      });
      const baseImpl = fetchJsonWithRetryMock.getMockImplementation()!;
      fetchJsonWithRetryMock.mockImplementation(async (url: string) =>
        url === failedUrl ? fail(502) : baseImpl(url),
      );

      await expect(fetchKavaUsdxPrice()).resolves.toMatchObject({
        price: 0.67,
        blockHeight: 21658999,
      });

      expect(fetchJsonWithRetryMock.mock.calls.map(([url]) => url)).toEqual([
        ...PRUNING_URLS.slice(0, failIndex + 1),
        ...ARCHIVE_URLS,
      ]);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(infoSpy.mock.calls[0]?.[0]))).toMatchObject({
        event: "kava_pricefeed_served",
        metadata: { hostFamily: "archive", blockHeight: 21658999 },
      });
    },
  );

  it("fails over to archive when pruning serves a stale block header and never mixes hosts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    installFixtureResponses({}, {
      pruning: {
        block: { result: { header: { ...fixture.block.block.header, time: "2026-07-16T06:10:00Z" } } },
      },
      archive: {},
    });

    await expect(fetchKavaUsdxPrice()).resolves.toMatchObject({
      price: 0.66,
      blockHeight: 21658182,
    });
    expect(fetchJsonWithRetryMock.mock.calls.map(([url]) => url)).toEqual([
      "https://rpc.kava.io/header",
      ...ARCHIVE_URLS,
    ]);
    expect(JSON.parse(String(infoSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "kava_pricefeed_served",
      metadata: { hostFamily: "archive" },
    });
  });

  it("fails closed returning null when both pruning and archive families return HTTP 502", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchJsonWithRetryMock.mockResolvedValue(fail(502));

    await expect(fetchKavaUsdxPrice()).resolves.toBeNull();
    expect(fetchJsonWithRetryMock.mock.calls.map(([url]) => url)).toEqual([
      "https://rpc.kava.io/header",
      "https://rpc.data.kava.io/header",
    ]);
  });
});
