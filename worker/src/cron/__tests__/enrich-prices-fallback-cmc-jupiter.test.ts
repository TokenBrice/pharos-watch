import { afterEach, describe, expect, it } from "vitest";
import {
  solanaSlotResponse,
  cleanupEnrichMissingPricesTest,
  fixtureEnrichMissingPrices,
  fixtureRunJupiterPass,
  fixtureMockD1 as createFixtureMockD1,
  fixtureMockFetch,
  fixtureCIRCUIT_SOURCE,
  type PeggedAsset,
} from "./enrich-prices.test-support";





function fixtureMockD1(
  tables: Parameters<typeof createFixtureMockD1>[0] = [],
  options?: Parameters<typeof createFixtureMockD1>[1],
) {
  return createFixtureMockD1(
    [
      ...tables,
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ],
    options,
  );
}

describe("enrichMissingPrices", () => {
  afterEach(cleanupEnrichMissingPricesTest);
  it("fills missing Solana prices from documented Jupiter V3 payloads without liquidity", async () => {
    const currentSlot = 418_913_760;
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    fixtureMockFetch([
      { match: "coins.llama.fi", body: { coins: {} } },
      { match: "api.mainnet-beta.solana.com", body: solanaSlotResponse(currentSlot) },
      {
        match: "api.jup.ag/price/v3",
        body: {
          "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
            usdPrice: 1.0002,
            decimals: 6,
            blockId: currentSlot - 20,
            priceChange24h: 0.01,
          },
        },
      },
    ]);

    const stats = await fixtureEnrichMissingPrices(assets);

    expect(stats.passJupiter).toBe(1);
    expect(assets[0].price).toBe(1.0002);
    expect(assets[0].priceSource).toBe("jupiter");
    expect(stats.finalMissing).toBe(0);
  });

  it("falls back to the next bounded Solana RPC when the primary slot endpoint returns 403", async () => {
    const currentSlot = 418_913_760;
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const fetchSpy = fixtureMockFetch([
      { match: "api.mainnet-beta.solana.com", status: 403, body: "blocked" },
      { match: "api.mainnet.solana.com", body: solanaSlotResponse(currentSlot) },
      {
        match: "api.jup.ag/price/v3",
        body: {
          "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
            usdPrice: 1.0002,
            decimals: 6,
            blockId: currentSlot - 20,
          },
        },
      },
    ]);

    const result = await fixtureRunJupiterPass(assets, undefined, undefined);

    expect(result.resolved).toBe(1);
    expect(assets[0].price).toBe(1.0002);
    expect(
      fetchSpy
        .getHistory()
        .filter((entry) => entry.body?.includes('"method":"getSlot"'))
        .map((entry) => entry.url),
    ).toEqual(["https://api.mainnet-beta.solana.com/", "https://api.mainnet.solana.com/"]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint: "api.mainnet-beta.solana.com/",
          status: 403,
          success: false,
          errorClass: "upstream-error",
        }),
      ]),
    );
  });

  it("fails Jupiter freshness closed after every bounded Solana slot RPC fails", async () => {
    const currentSlot = 418_913_760;
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const fetchSpy = fixtureMockFetch([
      { match: "api.mainnet-beta.solana.com", status: 403, body: "blocked" },
      { match: "api.mainnet.solana.com", status: 503, body: "unavailable" },
      { match: "solana-rpc.publicnode.com", status: 429, body: "rate limited" },
      {
        match: "api.jup.ag/price/v3",
        body: {
          "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
            usdPrice: 1.0002,
            decimals: 6,
            blockId: currentSlot - 20,
          },
        },
      },
    ]);

    const result = await fixtureRunJupiterPass(assets, undefined, undefined);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
    expect(
      fetchSpy
        .getHistory()
        .filter((entry) => entry.body?.includes('"method":"getSlot"'))
        .map((entry) => entry.url),
    ).toEqual([
      "https://api.mainnet-beta.solana.com/",
      "https://api.mainnet.solana.com/",
      "https://solana-rpc.publicnode.com/",
    ]);
  });

  it("sends the configured Jupiter API key on V3 price requests", async () => {
    const currentSlot = 418_913_760;
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const fetchSpy = fixtureMockFetch([
      { match: "api.mainnet-beta.solana.com", body: solanaSlotResponse(currentSlot) },
      {
        match: "api.jup.ag/price/v3",
        body: {
          "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
            usdPrice: 1.0002,
            decimals: 6,
            blockId: currentSlot - 20,
          },
        },
      },
    ]);

    await fixtureRunJupiterPass(assets, undefined, undefined, undefined, "jup-test-key");

    const jupiterCall = fetchSpy.mock.calls.find(([input]) => String(input).includes("api.jup.ag/price/v3"));
    expect(jupiterCall?.[1]).toMatchObject({
      headers: expect.objectContaining({ "x-api-key": "jup-test-key" }),
    });
  });

  it("does not reject Jupiter V3 quotes solely because createdAt is old", async () => {
    const currentSlot = 418_913_760;
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    fixtureMockFetch([
      { match: "coins.llama.fi", body: { coins: {} } },
      { match: "api.mainnet-beta.solana.com", body: solanaSlotResponse(currentSlot) },
      {
        match: "api.jup.ag/price/v3",
        body: {
          "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
            usdPrice: 0.9998,
            liquidity: 250_000,
            decimals: 6,
            blockId: currentSlot - 20,
            priceChange24h: 0.01,
            createdAt: "2025-01-06T18:38:31Z",
          },
        },
      },
    ]);

    const stats = await fixtureEnrichMissingPrices(assets);

    expect(stats.passJupiter).toBe(1);
    expect(assets[0].price).toBe(0.9998);
    expect(assets[0].priceSource).toBe("jupiter");
    expect(stats.finalMissing).toBe(0);
  });

  it("adds bounded Jupiter evidence to low-depth Solana primary prices without replacing the primary source", async () => {
    const currentSlot = 418_913_760;
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 1.0001,
        priceSource: "coingecko",
        priceConfidence: "single-source",
        consensusSources: ["coingecko"],
        agreeSources: ["coingecko"],
        pegType: "peggedUSD",
        circulating: { solana: 10_000_000 },
      },
    ];

    fixtureMockFetch([
      { match: "api.mainnet-beta.solana.com", body: solanaSlotResponse(currentSlot) },
      {
        match: "api.jup.ag/price/v3",
        body: {
          "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
            usdPrice: 1.0002,
            liquidity: 250_000,
            decimals: 6,
            blockId: currentSlot - 20,
          },
        },
      },
    ]);

    const result = await fixtureRunJupiterPass(assets, undefined, undefined);

    expect(result.resolved).toBe(1);
    expect(result.diagnostics?.[0]).toMatchObject({
      source: "jupiter",
      stage: "primary",
      candidateCount: 1,
      success: true,
    });
    expect(assets[0]).toMatchObject({
      price: 1.0001,
      priceSource: "coingecko",
      consensusSources: ["coingecko", "jupiter"],
      agreeSources: ["coingecko"],
    });
  });

  it("does not add Jupiter primary evidence when the quote diverges from the current primary price", async () => {
    const currentSlot = 418_913_760;
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 0.97,
        priceSource: "coingecko",
        priceConfidence: "single-source",
        consensusSources: ["coingecko"],
        agreeSources: ["coingecko"],
        pegType: "peggedUSD",
        circulating: { solana: 10_000_000 },
      },
    ];

    fixtureMockFetch([
      { match: "api.mainnet-beta.solana.com", body: solanaSlotResponse(currentSlot) },
      {
        match: "api.jup.ag/price/v3",
        body: {
          "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
            usdPrice: 1.0002,
            liquidity: 250_000,
            decimals: 6,
            blockId: currentSlot - 20,
          },
        },
      },
    ]);

    const result = await fixtureRunJupiterPass(assets, undefined, undefined);

    expect(result.resolved).toBe(0);
    expect(assets[0].consensusSources).toEqual(["coingecko"]);
    expect(assets[0].agreeSources).toEqual(["coingecko"]);
  });

  it("rejects Jupiter quotes with stale block ids", async () => {
    const currentSlot = 418_913_760;
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    fixtureMockFetch([
      { match: "api.mainnet-beta.solana.com", body: solanaSlotResponse(currentSlot) },
      {
        match: "api.jup.ag/price/v3",
        body: {
          "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
            usdPrice: 1.0002,
            decimals: 6,
            blockId: currentSlot - 3_000,
            priceChange24h: 0.01,
          },
        },
      },
    ]);

    const result = await fixtureRunJupiterPass(assets, undefined, undefined);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
  });

  it("records a Jupiter breaker failure when an OK response has a malformed V3 payload", async () => {
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.JUPITER_PRICES}`],
        rows: [],
        first: null,
      },
    ]);
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    fixtureMockFetch([
      {
        match: "api.jup.ag/price/v3",
        body: {
          "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
            price: 1.0002,
            blockId: 418_913_700,
          },
        },
      },
    ]);

    const result = await fixtureRunJupiterPass(assets, undefined, db);

    expect(result.resolved).toBe(0);
    expect(result.diagnostics?.[0]).toMatchObject({
      source: "jupiter",
      success: false,
      errorClass: "invalid-shape",
    });
    const circuitWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === `circuit:${fixtureCIRCUIT_SOURCE.JUPITER_PRICES}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      consecutiveFailures: 1,
    });
  });

  it("does not open the Jupiter breaker for sparse no-quote V3 rows", async () => {
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.JUPITER_PRICES}`],
        rows: [],
        first: null,
      },
    ]);
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    fixtureMockFetch([
      {
        match: "api.jup.ag/price/v3",
        body: {
          "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
            decimals: 6,
            createdAt: "2026-02-18T15:12:44Z",
          },
        },
      },
    ]);

    const result = await fixtureRunJupiterPass(assets, undefined, db);

    expect(result.resolved).toBe(0);
    expect(result.diagnostics?.[0]).toMatchObject({
      source: "jupiter",
      success: true,
      responseRowCount: 1,
      rejectionReasonCounts: { "missing-quote": 1 },
    });
    const circuitWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === `circuit:${fixtureCIRCUIT_SOURCE.JUPITER_PRICES}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("reports Jupiter non-OK responses in pass diagnostics", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];
    const db = fixtureMockD1([{ match: "cache", rows: [], first: null }]);

    fixtureMockFetch([
      {
        match: "api.jup.ag/price/v3",
        status: 403,
        body: "blocked",
      },
    ]);

    const result = await fixtureRunJupiterPass(assets, undefined, db);

    expect(result.resolved).toBe(0);
    expect(result.diagnostics?.[0]).toMatchObject({
      source: "jupiter",
      stage: "fallback",
      status: 403,
      ok: false,
      success: false,
      candidateCount: 1,
      snippet: "blocked",
    });
  });

  it("closes a stale Jupiter circuit when no fallback candidates remain", async () => {
    const openedAt = Math.floor(Date.now() / 1000) - 3600;
    const db = fixtureMockD1([
      {
        match: "cache",
        rows: [],
        first: {
          value: JSON.stringify({
            state: "open",
            consecutiveFailures: 3,
            lastFailureAt: openedAt,
            lastSuccessAt: null,
            openedAt,
          }),
          updated_at: openedAt,
        },
      },
    ]);
    const assets: PeggedAsset[] = [
      {
        id: "usbd-bima",
        name: "USBD",
        symbol: "USBD",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const fetchSpy = fixtureMockFetch();

    const result = await fixtureRunJupiterPass(assets, undefined, db);

    expect(result.resolved).toBe(0);
    expect(result.diagnostics?.[0]).toMatchObject({
      source: "jupiter",
      stage: "no-candidates",
      status: null,
      ok: true,
      success: true,
      candidateCount: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips Jupiter fetches when there are no Solana fallback candidates and the circuit is closed", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usbd-bima",
        name: "USBD",
        symbol: "USBD",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const db = fixtureMockD1([{ match: "cache", rows: [], first: null }], { requireMatch: true });

    await expect(fixtureRunJupiterPass(assets, undefined, db)).resolves.toEqual({
      resolved: 0,
      failures: [],
      diagnostics: [],
    });
  });
});
