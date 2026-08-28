import { afterEach, describe, expect, it } from "vitest";
import {
  staleObservedAtSec,
  dlQuote,
  cleanupEnrichMissingPricesTest,
  fixtureRunDexScreenerPass,
  fixtureRunDlContractPasses,
  makeFixtureMockD1 as fixtureMockD1,
  fixtureMockFetch,
  fixtureCIRCUIT_SOURCE,
  type PeggedAsset,
} from "./enrich-prices.test-support";
import { makePeggedAsset } from "../sync-stablecoins/__tests__/_fixtures";

import { DEXSCREENER_ROTATION_INTERVAL_MS } from "../sync-stablecoins/enrich-prices-dexscreener-pass";

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
      makePeggedAsset({
        id: "search-usd",
        name: "Search USD",
        symbol: "CHFAU",
        price: 0,
      }),
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
  });

  it("skips the DexScreener breaker check when nothing is missing", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 1,
      }),
    ];

    const db = fixtureMockD1([], { requireMatch: true });

    await expect(fixtureRunDexScreenerPass(assets, undefined, db)).resolves.toEqual({
      resolved: 0,
      failures: [],
    });
  });

  it("uses tracked metadata to select an exact DexScreener target", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "gusd-gemini",
        name: "Gemini Dollar",
        symbol: "GUSD",
        price: 0,
      }),
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
  });

  it("rotates the leading chain group on the next cycle", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "gusd-gemini",
        name: "Gemini Dollar",
        symbol: "GUSD",
        price: 0,
      }),
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

  it.each([
    ["stale timestamp", dlQuote(1.0, "USDT", { timestamp: staleObservedAtSec() })],
    ["low confidence", dlQuote(1.0, "USDT", { confidence: 0.2 })],
    ["wrong symbol", dlQuote(1.0, "USDC")],
  ])("skips DefiLlama contract quotes with %s", async (_caseName, quote) => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      }),
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
      makePeggedAsset({
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      }),
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
      makePeggedAsset({
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      }),
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
      makePeggedAsset({
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      }),
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
