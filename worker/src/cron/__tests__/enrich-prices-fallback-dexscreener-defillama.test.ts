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
  fixtureMockD1 as createFixtureMockD1,
  fixtureMockFetch,
  fixtureCIRCUIT_SOURCE,
  type PeggedAsset,
} from "./enrich-prices.test-support";
import { selectRotatedCmcCandidates } from "../sync-stablecoins/enrich-prices-cmc-pass";
import { DEXSCREENER_ROTATION_INTERVAL_MS } from "../sync-stablecoins/enrich-prices-dexscreener-pass";

function installFetch(implementation: (url: string) => Response | Promise<Response>) {
  return fixtureMockFetch([{ match: () => true, respond: (request) => implementation(request.url) }]);
}

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

    const fetchSpy = fixtureMockFetch([], { requireMatch: true });

    // GUSD is registered on ethereum and (since the P-wave) near, and the pass
    // rotates which chain leads each quarter-hour. Pinning the rotation clock
    // makes the pick reproducible: cycle 0 selects the alphabetically first
    // chain group, so the canonical ethereum deployment leads.
    const result = await fixtureRunDexScreenerPass(assets, undefined, db, undefined, undefined, 0);

    expect(result.resolved).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain(
      "api.dexscreener.com/tokens/v1/ethereum/0x056fd409e1d7a124bd7017459dfea2f387b6d5cd",
    );
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("latest/dex/search"))).toBe(false);
  });

  it("rotates the leading chain group on the next cycle", async () => {
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

    const fetchSpy = fixtureMockFetch([], { requireMatch: true });

    // One rotation interval later the bridged NEAR deployment takes its turn.
    // The rotation is the point — a persistent gap on one network must not
    // starve the other — so this pins the behaviour rather than the accident.
    await fixtureRunDexScreenerPass(assets, undefined, db, undefined, undefined, DEXSCREENER_ROTATION_INTERVAL_MS);

    expect(fetchSpy.mock.calls[0]?.[0]).toContain(
      "api.dexscreener.com/tokens/v1/near/056fd409e1d7a124bd7017459dfea2f387b6d5cd.factory.bridge.near",
    );
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
    const fetchSpy = fixtureMockFetch([], { requireMatch: true });

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

    installFetch(async () => new Response(
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
          ));

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

    installFetch(async () => new Response(
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
          ));

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

    const fetchSpy = fixtureMockFetch([], { requireMatch: true });

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

    const fetchSpy = fixtureMockFetch([{ match: () => true, body: "upstream error", status: 500 }]);

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
