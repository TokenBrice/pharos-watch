import { afterEach, describe, expect, it, vi } from "vitest";
import {
  staleObservedAtSec,
  staleIsoTimestamp,
  maturePairCreatedAt,
  dlQuote,
  cmcUsdQuote,
  cmcCategory,
  solanaSlotResponse,
  cleanupEnrichMissingPricesTest,
  fixtureEnrichMissingPrices,
  fixtureRunCmcPass,
  fixtureRunDexScreenerPass,
  fixtureRunDlContractPasses,
  fixtureRunJupiterPass,
  fixtureMockD1,
  fixtureMockFetch,
  fixtureCIRCUIT_SOURCE,
  type PeggedAsset,
} from "./enrich-prices.test-support";
import { selectRotatedCmcCandidates } from "../sync-stablecoins/enrich-prices-cmc-pass";

describe("enrichMissingPrices", () => {
  afterEach(cleanupEnrichMissingPricesTest);
  it("prefers cmcSlug-based matching over symbol for CMC fallback (BUG-1)", async () => {
    // Two coins share symbol "GUSD" — slug-based matching should pick the right price
    const assets: PeggedAsset[] = [
      {
        id: "gusd-gemini",
        name: "Gemini Dollar",
        symbol: "GUSD",
        price: 0,
        cmcSlug: "gemini-dollar",
        pegType: "peggedUSD",
        circulating: {},
      },
      {
        id: "gusd-gate",
        name: "Gate USD",
        symbol: "GUSD",
        price: 0,
        cmcSlug: "gatechain-token",
        pegType: "peggedUSD",
        circulating: {},
      },
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
      {
        id: "usbd-bima",
        name: "USBD",
        symbol: "USBD",
        price: 1,
        pegType: "peggedUSD",
        circulating: {},
      },
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

  it("closes the stale DexScreener exact circuit when no exact candidates remain", async () => {
    const openedAt = Math.floor(Date.now() / 1000) - 3600;
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [
          {
            key: `circuit:${fixtureCIRCUIT_SOURCE.DEXSCREENER_PRICES}`,
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
      {
        id: "search-usd",
        name: "Search USD",
        symbol: "CHFAU",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const fetchSpy = fixtureMockFetch();
    const result = await fixtureRunDexScreenerPass(assets, undefined, db);

    expect(result.resolved).toBe(0);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "dexscreener-exact",
          stage: "no-candidates",
          status: null,
          ok: true,
          success: true,
          candidateCount: 0,
        }),
      ]),
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    const exactWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === `circuit:${fixtureCIRCUIT_SOURCE.DEXSCREENER_PRICES}`,
      );
    expect(JSON.parse(String(exactWrite?.binds[1]))).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
    expect(
      db.getHistory().some((entry) => entry.binds.includes(`circuit:${fixtureCIRCUIT_SOURCE.DEXSCREENER_SEARCH}`)),
    ).toBe(false);
  });

  it("skips the CMC breaker check when no assets are missing", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 1,
        pegType: "peggedUSD",
        circulating: {},
      },
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
      {
        id: "gusd-gemini",
        name: "Gemini Dollar",
        symbol: "GUSD",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
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
      {
        id: "test-dollar",
        name: "Test Dollar",
        symbol: "TUSD",
        price: 0,
        cmcSlug: "test-dollar",
        pegType: "peggedUSD",
        circulating: {},
      },
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
    const assets: PeggedAsset[] = [{
      id: "test-dollar",
      name: "Test Dollar",
      symbol: "TUSD",
      price: 0,
      cmcSlug: "test-dollar",
      pegType: "peggedUSD",
      contracts: [{
        chain: "ethereum",
        address: "0x1111111111111111111111111111111111111111",
        decimals: 18,
      }],
      circulating: {},
    }];
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

  it("replays an identity-verified targeted quote across the next three cooldown generations", async () => {
    const makeAsset = (): PeggedAsset => ({
      id: "test-dollar",
      name: "Test Dollar",
      symbol: "TUSD",
      price: 0,
      cmcSlug: "test-dollar",
      pegType: "peggedUSD",
      contracts: [{
        chain: "ethereum",
        address: "0x1111111111111111111111111111111111111111",
        decimals: 18,
      }],
      circulating: {},
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
    const assets: PeggedAsset[] = [{
      id: "test-dollar",
      name: "Test Dollar",
      symbol: "TUSD",
      price: 0,
      cmcSlug: "test-dollar",
      pegType: "peggedUSD",
      contracts: [{
        chain: "ethereum",
        address: "0x1111111111111111111111111111111111111111",
        decimals: 18,
      }],
      circulating: {},
    }];

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rotates targeted candidates at the hourly quota boundary", () => {
    const candidates = Array.from({ length: 26 }, (_, index) => ({
      index,
      asset: {
        id: `coin-${index}`,
        symbol: `C${index}`,
        cmcSlug: `coin-${index}`,
      } as PeggedAsset,
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
    const assets: PeggedAsset[] = [{
      id: "test-dollar",
      name: "Test Dollar",
      symbol: "TUSD",
      price: 0,
      cmcSlug: "test-dollar",
      pegType: "peggedUSD",
      contracts: [{
        chain: "ethereum",
        address: "0x1111111111111111111111111111111111111111",
        decimals: 18,
      }],
      circulating: {},
    }];
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
      {
        id: "test-dollar",
        name: "Test Dollar",
        symbol: "TUSD",
        price: 0,
        cmcSlug: "test-dollar",
        pegType: "peggedUSD",
        circulating: {},
      },
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
      {
        id: "test-dollar",
        name: "Test Dollar",
        symbol: "TUSD",
        price: 0,
        cmcSlug: "test-dollar",
        pegType: "peggedUSD",
        circulating: {},
      },
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

  it("retains usable category rows while reporting an unseen truncated tail", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "test-dollar",
        name: "Test Dollar",
        symbol: "TUSD",
        price: 0,
        cmcSlug: "test-dollar",
        pegType: "peggedUSD",
        circulating: {},
      },
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

    expect(result.resolved).toBe(1);
    expect(assets[0].price).toBe(1.0001);
    expect(result.diagnostics?.[0]).toMatchObject({
      success: true,
      errorClass: "truncated-response",
      resolvedCount: 1,
    });
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
      {
        id: "test-dollar",
        name: "Test Dollar",
        symbol: "TUSD",
        price: 0,
        cmcSlug: "test-dollar",
        pegType: "peggedUSD",
        circulating: {},
      },
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const result = await fixtureRunCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(0);
    expect(response.bodyUsed).toBe(true);
  });

  it("writes the CMC local cooldown when the category endpoint returns 429", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "test-dollar",
        name: "Test Dollar",
        symbol: "TUSD",
        price: 0,
        cmcSlug: "test-dollar",
        pegType: "peggedUSD",
        circulating: {},
      },
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
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: { error_message: "rate limited" } }), {
            status: 429,
            headers: { "Retry-After": "1" },
          }),
      ),
    );

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

  it("skips the DexScreener breaker check when nothing is missing", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 1,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const db = fixtureMockD1([], { requireMatch: true });

    await expect(fixtureRunDexScreenerPass(assets, undefined, db)).resolves.toEqual({
      resolved: 0,
      failures: [],
    });
  });

  it("skips DexScreener symbol search for ambiguous tracked symbols without an address", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "gusd-gemini",
        name: "Gemini Dollar",
        symbol: "GUSD",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const db = fixtureMockD1(
      [
        { match: "circuit", rows: [] },
        { match: "cache", rows: [] },
      ],
      { requireMatch: true },
    );

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fixtureRunDexScreenerPass(assets, undefined, db);

    expect(result.resolved).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain(
      "api.dexscreener.com/tokens/v1/ethereum/0x056fd409e1d7a124bd7017459dfea2f387b6d5cd",
    );
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("latest/dex/search"))).toBe(false);
  });

  it("skips DexScreener symbol search for addressless assets without configured chains", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "search-usd",
        name: "Search USD",
        symbol: "CHFAU",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const db = fixtureMockD1(
      [
        { match: "circuit", rows: [] },
        { match: "cache", rows: [] },
      ],
      { requireMatch: true },
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fixtureRunDexScreenerPass(assets, undefined, db);

    expect(result.resolved).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects DexScreener symbol search pairs outside the configured chain allowlist", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "search-usd",
        name: "Search USD",
        symbol: "CHFAU",
        price: 0,
        pegType: "peggedUSD",
        chains: ["Ethereum"],
        circulating: {},
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              pairs: [
                {
                  baseToken: { symbol: "CHFAU" },
                  quoteToken: { symbol: "USDC" },
                  priceUsd: "1.0001",
                  liquidity: { usd: 250_000 },
                  volume: { h24: 25_000 },
                  pairCreatedAt: maturePairCreatedAt(),
                  chainId: "bsc",
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await fixtureRunDexScreenerPass(assets, undefined, undefined);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
  });

  it("rejects DexScreener symbol search pairs without quote, volume, and age quality", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "search-usd",
        name: "Search USD",
        symbol: "CHFAU",
        price: 0,
        pegType: "peggedUSD",
        chains: ["Ethereum"],
        circulating: {},
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              pairs: [
                {
                  baseToken: { symbol: "CHFAU" },
                  quoteToken: { symbol: "WETH" },
                  priceUsd: "1.0001",
                  liquidity: { usd: 250_000 },
                  volume: { h24: 25_000 },
                  pairCreatedAt: maturePairCreatedAt(),
                  chainId: "ethereum",
                },
                {
                  baseToken: { symbol: "CHFAU" },
                  quoteToken: { symbol: "USDC" },
                  priceUsd: "1.0001",
                  liquidity: { usd: 250_000 },
                  volume: { h24: 100 },
                  pairCreatedAt: maturePairCreatedAt(),
                  chainId: "ethereum",
                },
                {
                  baseToken: { symbol: "CHFAU" },
                  quoteToken: { symbol: "USDC" },
                  priceUsd: "1.0001",
                  liquidity: { usd: 250_000 },
                  volume: { h24: 25_000 },
                  pairCreatedAt: Date.now(),
                  chainId: "ethereum",
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await fixtureRunDexScreenerPass(assets, undefined, undefined);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
  });

  it.each([
    ["stale timestamp", dlQuote(1.0, "USDT", { timestamp: staleObservedAtSec() })],
    ["low confidence", dlQuote(1.0, "USDT", { confidence: 0.2 })],
    ["wrong symbol", dlQuote(1.0, "USDC")],
  ])("skips DefiLlama contract quotes with %s", async (_caseName, quote) => {
    const assets: PeggedAsset[] = [
      {
        id: "usdt-tether",
        name: "Tether",
        symbol: "USDT",
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    fixtureMockFetch([
      {
        match: "coins.llama.fi/prices",
        body: {
          coins: {
            "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7": quote,
          },
        },
      },
    ]);

    const result = await fixtureRunDlContractPasses(assets, undefined);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
  });

  it("records a defillama-coins breaker failure when DL /coins OK response is malformed", async () => {
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.DL_COINS}`],
        rows: [],
        first: null,
      },
    ]);
    const assets: PeggedAsset[] = [
      {
        id: "usdt-tether",
        name: "Tether",
        symbol: "USDT",
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    fixtureMockFetch([
      {
        match: "coins.llama.fi/prices",
        body: {
          coins: {
            "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7": { price: "1.0" },
          },
        },
      },
    ]);

    const result = await fixtureRunDlContractPasses(assets, undefined, undefined, db);

    expect(result.resolved).toBe(0);
    expect(result.failures).toEqual(["dl-contracts"]);
    const circuitWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === `circuit:${fixtureCIRCUIT_SOURCE.DL_COINS}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      consecutiveFailures: 1,
    });
  });

  it("skips DL /coins fetch when the defillama-coins breaker is open", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.DL_COINS}`],
        rows: [],
        first: {
          value: JSON.stringify({
            state: "open",
            consecutiveFailures: 3,
            lastFailureAt: nowSec - 60,
            lastSuccessAt: null,
            openedAt: nowSec - 60,
          }),
          updated_at: nowSec - 60,
        },
      },
    ]);

    const assets: PeggedAsset[] = [
      {
        id: "usdt-tether",
        name: "Tether",
        symbol: "USDT",
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fixtureRunDlContractPasses(assets, undefined, undefined, db);

    expect(result.resolved).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records a defillama-coins breaker failure when DL /coins returns 500", { timeout: 15_000 }, async () => {
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.DL_COINS}`],
        rows: [],
        first: null,
      },
    ]);

    const assets: PeggedAsset[] = [
      {
        id: "usdt-tether",
        name: "Tether",
        symbol: "USDT",
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const fetchSpy = vi.fn(async () => new Response("upstream error", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fixtureRunDlContractPasses(assets, undefined, undefined, db);

    expect(result.resolved).toBe(0);
    expect(fetchSpy).toHaveBeenCalled();

    const circuitWrites = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))
      .filter((entry) => String(entry.binds[0]) === `circuit:${fixtureCIRCUIT_SOURCE.DL_COINS}`);

    expect(circuitWrites.length).toBeGreaterThan(0);
    const lastWrite = circuitWrites[circuitWrites.length - 1];
    const record = JSON.parse(String(lastWrite.binds[1]));
    expect(record.consecutiveFailures).toBeGreaterThan(0);
    expect(record.lastFailureAt).not.toBeNull();
  });
});
