import { afterEach, describe, expect, it } from "vitest";
import {
  staleIsoTimestamp,
  cmcUsdQuote,
  cmcCategory,
  cleanupEnrichMissingPricesTest,
  fixtureEnrichMissingPrices,
  fixtureRunCmcPass,
  makeFixtureMockD1 as fixtureMockD1,
  fixtureMockFetch,
  fixtureCIRCUIT_SOURCE,
  installFetch,
  type PeggedAsset,
} from "./enrich-prices.test-support";
import { selectRotatedCmcCandidates } from "../sync-stablecoins/enrich-prices-cmc-pass";
import { makePeggedAsset } from "../sync-stablecoins/__tests__/_fixtures";
describe("enrichMissingPrices", () => {
  afterEach(cleanupEnrichMissingPricesTest);
  it("prefers cmcSlug-based matching over symbol for CMC fallback (BUG-1)", async () => {
    // Two coins share symbol "GUSD" — slug-based matching should pick the right price
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "gusd-gemini",
        name: "Gemini Dollar",
        symbol: "GUSD",
        price: 0,
        cmcSlug: "gemini-dollar",
      }),
      makePeggedAsset({
        id: "gusd-gate",
        name: "Gate USD",
        symbol: "GUSD",
        price: 0,
        cmcSlug: "gatechain-token",
      }),
    ];

    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["cmc_last_fetch"],
        rows: [],
        first: null,
      },
      { match: "circuit", rows: [] },
    ]);

    fixtureMockFetch([
      {
        match: "pro-api.coinmarketcap.com",
        body: cmcCategory([
          { slug: "gemini-dollar", symbol: "GUSD", quote: { USD: cmcUsdQuote(1.0001) } },
          { slug: "gatechain-token", symbol: "GUSD", quote: { USD: cmcUsdQuote(0.998) } },
        ]),
      },
    ]);

    const stats = await fixtureEnrichMissingPrices(assets, "test-cmc-key", db);

    // Both should be priced correctly via slug, not clobbered by symbol collision
    expect(assets[0].price).toBe(1.0001);
    expect(assets[0].priceSource).toBe("coinmarketcap");
    expect(assets[1].price).toBe(0.998);
    expect(assets[1].priceSource).toBe("coinmarketcap");
    expect(stats.passCmc).toBe(2);
  });

  it("closes a stale CMC circuit when no fallback candidates remain", async () => {
    const openedAt = Math.floor(Date.now() / 1000) - 3600;
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.CMC_PRICES}`],
        rows: [
          {
            key: `circuit:${fixtureCIRCUIT_SOURCE.CMC_PRICES}`,
            value: JSON.stringify({
              state: "open",
              consecutiveFailures: 3,
              lastFailureAt: openedAt,
              lastSuccessAt: null,
              openedAt,
            }),
            updated_at: openedAt,
          },
        ],
      },
    ]);
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "usbd-bima",
        name: "USBD",
        symbol: "USBD",
        price: 1,
      }),
    ];

    const fetchSpy = fixtureMockFetch();

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(0);
    expect(result.diagnostics?.[0]).toMatchObject({
      source: "coinmarketcap",
      stage: "no-candidates",
      status: null,
      ok: true,
      success: true,
      candidateCount: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const circuitWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === `circuit:${fixtureCIRCUIT_SOURCE.CMC_PRICES}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("skips the CMC breaker check when no assets are missing", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 1,
      }),
    ];

    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.CMC_PRICES}`],
        rows: [
          {
            key: `circuit:${fixtureCIRCUIT_SOURCE.CMC_PRICES}`,
            value: JSON.stringify({
              state: "closed",
              consecutiveFailures: 0,
              lastFailureAt: null,
              lastSuccessAt: now,
              openedAt: null,
            }),
            updated_at: now,
          },
        ],
      },
    ]);

    await expect(fixtureRunCmcPass(assets, "test-cmc-key", undefined, db)).resolves.toEqual({
      resolved: 0,
      failures: [],
    });
  });

  it("skips ambiguous tracked symbols without a slug in CMC fallback", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "gusd-gemini",
        name: "Gemini Dollar",
        symbol: "GUSD",
        price: 0,
      }),
    ];

    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["cmc_last_fetch"],
        rows: [],
        first: null,
      },
      { match: "circuit", rows: [] },
    ]);

    fixtureMockFetch([
      {
        match: "pro-api.coinmarketcap.com",
        body: cmcCategory([{ slug: "gemini-dollar", symbol: "GUSD", quote: { USD: cmcUsdQuote(1.0001) } }]),
      },
    ]);

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
  });

  it("reports CMC fallback diagnostics on successful slug matches", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "test-dollar",
        name: "Test Dollar",
        symbol: "TUSD",
        price: 0,
        cmcSlug: "test-dollar",
      }),
    ];
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["cmc_last_fetch"],
        rows: [],
        first: null,
      },
      { match: "circuit", rows: [] },
    ]);

    fixtureMockFetch([
      {
        match: "pro-api.coinmarketcap.com",
        body: cmcCategory([{ slug: "test-dollar", symbol: "TUSD", quote: { USD: cmcUsdQuote(1.0001) } }]),
      },
    ]);

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(1);
    expect(assets[0].priceSource).toBe("coinmarketcap");
    expect(result.diagnostics?.[0]).toMatchObject({
      source: "coinmarketcap",
      stage: "fallback",
      ok: true,
      success: true,
      responseRowCount: 1,
      resolvedCount: 1,
    });
  });

  it("retrieves an exact slug through targeted quotes when the category page is truncated", async () => {
    const assets: PeggedAsset[] = [makePeggedAsset({
      id: "test-dollar",
      name: "Test Dollar",
      symbol: "TUSD",
      price: 0,
      cmcSlug: "test-dollar",
      contracts: [{
        chain: "ethereum",
        address: "0x1111111111111111111111111111111111111111",
        decimals: 18,
      }],
    })];
    const fetchSpy = fixtureMockFetch([
      { match: "/v1/cryptocurrency/category", body: cmcCategory([], 301) },
      {
        match: "/v3/cryptocurrency/quotes/latest",
        body: { data: [{
          id: 123,
          slug: "test-dollar",
          symbol: "TUSD",
          is_active: 1,
          platform: {
            slug: "ethereum",
            token_address: "0x1111111111111111111111111111111111111111",
          },
          quote: [{ symbol: "USD", ...cmcUsdQuote(0.9998), volume_24h: 143_000 }],
        }] },
      },
    ]);

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, undefined);

    expect(result.resolved).toBe(1);
    expect(assets[0].price).toBe(0.9998);
    expect(assets[0].priceSource).toBe("coinmarketcap");
    expect(fetchSpy.getHistory().map((entry) => entry.url)).toEqual([
      expect.stringContaining("/v1/cryptocurrency/category"),
      expect.stringContaining("/v3/cryptocurrency/quotes/latest?slug=test-dollar&convert=USD"),
    ]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        endpoint: "pro-api.coinmarketcap.com/v1/cryptocurrency/category",
        success: true,
        errorClass: "truncated-response",
      }),
      expect.objectContaining({
        endpoint: "pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest",
        success: true,
        matchedCount: 1,
        resolvedCount: 1,
        assetAttempts: [expect.objectContaining({
          assetId: "test-dollar",
          adapter: "coinmarketcap",
          chain: "ethereum",
          target: "0x1111111111111111111111111111111111111111",
          state: "attempted",
          result: "resolved",
          replaySafe: false,
        })],
      }),
    ]));
  });

  it("does not let truncated category rows bypass targeted CMC quote validation", async () => {
    const assets: PeggedAsset[] = [makePeggedAsset({
      id: "mnee-mnee",
      name: "MNEE USD",
      symbol: "MNEE",
      price: 0,
      cmcSlug: "mnee",
      contracts: [{
        chain: "ethereum",
        address: "0x8ccedbae4916b79da7f3f612efb2eb93a2bfd6cf",
        decimals: 18,
      }],
    })];
    const fetchSpy = fixtureMockFetch([
      {
        match: "/v1/cryptocurrency/category",
        body: cmcCategory([{ slug: "mnee", symbol: "MNEE", quote: { USD: cmcUsdQuote(1.18) } }], 301),
      },
      {
        match: "/v3/cryptocurrency/quotes/latest",
        body: { data: [{
          id: 32878,
          slug: "mnee",
          symbol: "MNEE",
          is_active: 0,
          quote: [{ symbol: "USD", ...cmcUsdQuote(1.18), volume_24h: 143_000 }],
        }] },
      },
    ]);

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, undefined);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
    expect(fetchSpy.getHistory().map((entry) => entry.url)).toEqual([
      expect.stringContaining("/v1/cryptocurrency/category"),
      expect.stringContaining("/v3/cryptocurrency/quotes/latest?slug=mnee&convert=USD"),
    ]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        endpoint: "pro-api.coinmarketcap.com/v1/cryptocurrency/category",
        success: true,
        errorClass: "truncated-response",
        resolvedCount: 0,
      }),
      expect.objectContaining({
        endpoint: "pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest",
        success: true,
        matchedCount: 0,
        resolvedCount: 0,
        rejectionReasonCounts: { "unsupported-quote": 1 },
      }),
    ]));
  });

  it("replays an identity-verified targeted quote across the next three cooldown generations", async () => {
    const makeAsset = () => makePeggedAsset({
      id: "test-dollar",
      name: "Test Dollar",
      symbol: "TUSD",
      price: 0,
      cmcSlug: "test-dollar",
      contracts: [{
        chain: "ethereum",
        address: "0x1111111111111111111111111111111111111111",
        decimals: 18,
      }],
    });
    const initialDb = fixtureMockD1([
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      { match: "circuit", rows: [] },
    ]);
    fixtureMockFetch([
      { match: "/v1/cryptocurrency/category", body: cmcCategory([], 301) },
      {
        match: "/v3/cryptocurrency/quotes/latest",
        body: { data: [{
          id: 123,
          slug: "test-dollar",
          symbol: "TUSD",
          is_active: 1,
          platform: {
            slug: "ethereum",
            token_address: "0x1111111111111111111111111111111111111111",
          },
          quote: { USD: { ...cmcUsdQuote(1.0002), volume_24h: 50_000 } },
        }] },
      },
    ]);

    const firstAssets = [makeAsset()];
    await expect(fixtureRunCmcPass(firstAssets, "test-cmc-key", undefined, initialDb))
      .resolves.toMatchObject({ resolved: 1 });
    const verifiedCacheWrite = initialDb.getHistory().find(
      (entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") &&
        entry.binds[0] === "cmc_verified_targeted_quotes:v1",
    );
    expect(verifiedCacheWrite).toBeDefined();

    const nowSec = Math.floor(Date.now() / 1_000);
    const replayDb = fixtureMockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [
        {
          key: "cmc_verified_targeted_quotes:v1",
          value: String(verifiedCacheWrite?.binds[1]),
          updated_at: nowSec,
        },
        { key: "cmc_last_fetch", value: "1", updated_at: nowSec },
      ],
    }]);
    const fetchSpy = fixtureMockFetch();

    for (let generation = 2; generation <= 4; generation += 1) {
      const assets = [makeAsset()];
      const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, replayDb);
      expect(result.resolved, `generation ${generation}`).toBe(1);
      expect(assets[0]).toMatchObject({
        price: 1.0002,
        priceSource: "coinmarketcap",
        priceConfidence: "fallback",
        priceObservedAtMode: "upstream",
      });
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          endpoint: "coinmarketcap:verified-targeted-cache",
          resolvedCount: 1,
          assetAttempts: [expect.objectContaining({
            adapter: "coinmarketcap-verified-cache",
            result: "resolved",
            replaySafe: true,
          })],
        }),
      ]));
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["stale observation", Math.floor(Date.now() / 1_000) - 3_601, "0x1111111111111111111111111111111111111111"],
    ["wrong contract", Math.floor(Date.now() / 1_000) - 60, "0x2222222222222222222222222222222222222222"],
  ])("rejects a verified CMC cache entry with a %s", async (_reason, observedAt, providerAddress) => {
    const nowSec = Math.floor(Date.now() / 1_000);
    const db = fixtureMockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [
        {
          key: "cmc_verified_targeted_quotes:v1",
          value: JSON.stringify([{
            assetId: "test-dollar",
            slug: "test-dollar",
            symbol: "TUSD",
            price: 1.0002,
            volume24h: 50_000,
            observedAt,
            providerAddress,
            chain: "ethereum",
            active: true,
          }]),
          updated_at: nowSec,
        },
        { key: "cmc_last_fetch", value: "1", updated_at: nowSec },
      ],
    }]);
    const fetchSpy = fixtureMockFetch();
    const assets: PeggedAsset[] = [makePeggedAsset({
      id: "test-dollar",
      name: "Test Dollar",
      symbol: "TUSD",
      price: 0,
      cmcSlug: "test-dollar",
      contracts: [{
        chain: "ethereum",
        address: "0x1111111111111111111111111111111111111111",
        decimals: 18,
      }],
    })];

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rotates targeted candidates at the hourly quota boundary", () => {
    const candidates = Array.from({ length: 26 }, (_, index) => ({
      index,
      asset: makePeggedAsset({
        id: `coin-${index}`,
        symbol: `C${index}`,
        cmcSlug: `coin-${index}`,
      }),
    }));

    const first = selectRotatedCmcCandidates(candidates, 0).map((entry) => entry.asset.id);
    const second = selectRotatedCmcCandidates(candidates, 3_600).map((entry) => entry.asset.id);

    expect(first).toHaveLength(25);
    expect(second).toHaveLength(25);
    expect(first).not.toEqual(second);
    expect(new Set([...first, ...second])).toHaveProperty("size", 26);
  });

  it.each([
    ["wrong contract", "TUSD", "0x0000000000000000000000000000000000000001", undefined, 1, 143_000],
    ["missing contract", "TUSD", null, undefined, 1, 143_000],
    ["symbol collision", "TUSD2", "0x1111111111111111111111111111111111111111", undefined, 1, 143_000],
    ["stale quote", "TUSD", "0x1111111111111111111111111111111111111111", staleIsoTimestamp(), 1, 143_000],
    ["inactive quote", "TUSD", "0x1111111111111111111111111111111111111111", undefined, 0, 143_000],
    ["zero-volume quote", "TUSD", "0x1111111111111111111111111111111111111111", undefined, 1, 0],
  ])("rejects a targeted CMC %s", async (_name, symbol, tokenAddress, lastUpdated, isActive, volume24h) => {
    const assets: PeggedAsset[] = [makePeggedAsset({
      id: "test-dollar",
      name: "Test Dollar",
      symbol: "TUSD",
      price: 0,
      cmcSlug: "test-dollar",
      contracts: [{
        chain: "ethereum",
        address: "0x1111111111111111111111111111111111111111",
        decimals: 18,
      }],
    })];
    fixtureMockFetch([
      { match: "/v1/cryptocurrency/category", body: cmcCategory([]) },
      {
        match: "/v3/cryptocurrency/quotes/latest",
        body: { data: [{
          id: 123,
          slug: "test-dollar",
          symbol,
          is_active: isActive,
          platform: tokenAddress == null ? null : { slug: "ethereum", token_address: tokenAddress },
          quote: { USD: { ...cmcUsdQuote(0.9998, lastUpdated), volume_24h: volume24h } },
        }] },
      },
    ]);

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, undefined);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
  });

  it("skips CMC quotes with stale quote timestamps", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "test-dollar",
        name: "Test Dollar",
        symbol: "TUSD",
        price: 0,
        cmcSlug: "test-dollar",
      }),
    ];
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["cmc_last_fetch"],
        rows: [],
        first: null,
      },
      { match: "circuit", rows: [] },
    ]);

    fixtureMockFetch([
      {
        match: "pro-api.coinmarketcap.com",
        body: cmcCategory([
          { slug: "test-dollar", symbol: "TUSD", quote: { USD: cmcUsdQuote(1.0001, staleIsoTimestamp()) } },
        ]),
      },
    ]);

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
  });

  it("records a CMC breaker failure when an OK response has a malformed payload", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "test-dollar",
        name: "Test Dollar",
        symbol: "TUSD",
        price: 0,
        cmcSlug: "test-dollar",
      }),
    ];
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["cmc_last_fetch"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.CMC_PRICES}`],
        rows: [],
        first: null,
      },
    ]);

    fixtureMockFetch([
      {
        match: "pro-api.coinmarketcap.com",
        body: { data: { coins: [] } },
      },
    ]);

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(0);
    expect(result.diagnostics?.[0]).toMatchObject({
      source: "coinmarketcap",
      success: false,
      errorClass: "invalid-shape",
    });
    const circuitWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === `circuit:${fixtureCIRCUIT_SOURCE.CMC_PRICES}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      consecutiveFailures: 1,
    });
  });

  it("ignores truncated category rows while reporting an unseen tail", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "test-dollar",
        name: "Test Dollar",
        symbol: "TUSD",
        price: 0,
      }),
    ];
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["cmc_last_fetch"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.CMC_PRICES}`],
        rows: [],
        first: null,
      },
    ]);

    fixtureMockFetch([
      {
        match: "pro-api.coinmarketcap.com",
        body: cmcCategory([{ slug: "test-dollar", symbol: "TUSD", quote: { USD: cmcUsdQuote(1.0001) } }], 301),
      },
    ]);

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
    expect(result.diagnostics?.[0]).toMatchObject({
      success: true,
      errorClass: "truncated-response",
      resolvedCount: 0,
    });
    expect(result.diagnostics?.[0]?.errorMessage).toContain("category rows were ignored");
    const circuitWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === `circuit:${fixtureCIRCUIT_SOURCE.CMC_PRICES}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("drains CMC non-OK response bodies before recording failure", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "test-dollar",
        name: "Test Dollar",
        symbol: "TUSD",
        price: 0,
        cmcSlug: "test-dollar",
      }),
    ];
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["cmc_last_fetch"],
        rows: [],
        first: null,
      },
      { match: "circuit", rows: [] },
    ]);
    const response = new Response("blocked", { status: 500 });
    installFetch(async () => response);

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(0);
    expect(response.bodyUsed).toBe(true);
  });

  it("writes the CMC local cooldown when the category endpoint returns 429", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "test-dollar",
        name: "Test Dollar",
        symbol: "TUSD",
        price: 0,
        cmcSlug: "test-dollar",
      }),
    ];
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["cmc_last_fetch"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.CMC_PRICES}`],
        rows: [],
        first: null,
      },
    ]);
    installFetch(async () => new Response(JSON.stringify({ status: { error_message: "rate limited" } }), {
      status: 429,
      headers: { "Retry-After": "1" },
    }));

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(0);
    expect(result.diagnostics?.[0]).toMatchObject({
      source: "coinmarketcap",
      status: 429,
      success: false,
    });
    const cacheWrite = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === "cmc_last_fetch");
    expect(cacheWrite?.binds[1]).toBe("1");
  });
});
