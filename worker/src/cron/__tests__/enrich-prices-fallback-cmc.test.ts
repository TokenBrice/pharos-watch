import { afterEach, describe, expect, it, vi } from "vitest";
import {
  staleIsoTimestamp,
  cmcUsdQuote,
  cmcCategory,
  cleanupEnrichMissingPricesTest,
  makeEnrichPricesDb,
  installFetch,
} from "./enrich-prices.test-support";
import { enrichMissingPrices, type PeggedAsset } from "../sync-stablecoins/enrich-prices";
import { runCmcPass } from "../sync-stablecoins/enrich-prices-cmc-pass";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { selectRotatedCmcCandidates } from "../sync-stablecoins/enrich-prices-cmc-pass";
import { makePeggedAsset } from "../sync-stablecoins/__tests__/_fixtures";

function emptyCmcLastFetchCache() {
  return {
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: ["cmc_last_fetch"],
    rows: [],
    first: null,
  };
}
describe("enrichMissingPrices", () => {
  afterEach(cleanupEnrichMissingPricesTest);
  afterEach(() => vi.useRealTimers());
  it.each([
    ["next success hour despite completion jitter", { version: 1, kind: "success" }, "2026-09-22T20:10:18Z", "2026-09-22T21:09:30Z", true],
    ["same success hour", { version: 1, kind: "success" }, "2026-09-22T21:10:18Z", "2026-09-22T21:59:59Z", false],
    ["429 across an hour boundary", { version: 1, kind: "rate-limited" }, "2026-09-22T20:10:18Z", "2026-09-22T21:09:30Z", false],
    ["429 after its entire backoff", { version: 1, kind: "rate-limited" }, "2026-09-22T20:10:18Z", "2026-09-22T21:10:18Z", true],
    ["legacy rolling marker", 1, "2026-09-22T20:10:18Z", "2026-09-22T21:09:30Z", false],
    ["expired legacy marker", 1, "2026-09-22T20:10:18Z", "2026-09-22T21:10:18Z", true],
    ["unknown marker", { version: 2, kind: "success" }, "2026-09-22T20:10:18Z", "2026-09-22T21:09:30Z", false],
    ["future success timestamp", { version: 1, kind: "success" }, "2026-09-22T22:10:18Z", "2026-09-22T21:09:30Z", false],
  ])("enforces the CMC quota for %s", async (_label, marker, updatedAt, now, admitted) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    const db = makeEnrichPricesDb([
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: ["cmc_last_fetch"],
        rows: [{ value: JSON.stringify(marker), updated_at: Date.parse(updatedAt) / 1000 }] },
      { match: "circuit", rows: [], allowUnused: true },
    ]);
    const assets = [makePeggedAsset({ id: "test-dollar", symbol: "TUSD", price: 0, cmcSlug: "test-dollar" })];
    const fetchSpy = mockFetch([{ match: "pro-api.coinmarketcap.com", body: cmcCategory([
      { slug: "test-dollar", symbol: "TUSD", quote: { USD: cmcUsdQuote(1) } },
    ]) }]);
    const result = await runCmcPass(assets, "test-cmc-key", undefined, db);
    if (admitted) {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.resolved).toBe(1);
      const write = db.getHistory().find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === "cmc_last_fetch");
      expect(JSON.parse(String(write?.binds[1]))).toEqual({ version: 1, kind: "success" });
      expect(write?.binds[2]).toBe(Date.parse(now) / 1000); // actual completion time, never bucket time
    } else {
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ errorClass: "cooldown" })]));
    }
  });
  it("keeps targeted 429 backoff when the category request succeeded", async () => {
    const db = makeEnrichPricesDb([emptyCmcLastFetchCache(), { match: "circuit", rows: [], allowUnused: true }]);
    const assets = [makePeggedAsset({ id: "test-dollar", symbol: "TUSD", price: 0, cmcSlug: "test-dollar" })];
    mockFetch([
      { match: "/v1/cryptocurrency/category", body: cmcCategory([], 301) },
      { match: "/v3/cryptocurrency/quotes/latest", status: 429, body: { status: { error_message: "rate limited" } } },
    ]);
    const result = await runCmcPass(assets, "test-cmc-key", undefined, db);
    expect(result.resolved).toBe(0);
    const writes = db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === "cmc_last_fetch");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0].binds[1]))).toEqual({ version: 1, kind: "rate-limited" });
  });
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

    const db = makeEnrichPricesDb([
      emptyCmcLastFetchCache(),
      { match: "circuit", rows: [], allowUnused: true },
    ]);

    mockFetch([
      {
        match: "pro-api.coinmarketcap.com",
        body: cmcCategory([
          { slug: "gemini-dollar", symbol: "GUSD", quote: { USD: cmcUsdQuote(1.0001) } },
          { slug: "gatechain-token", symbol: "GUSD", quote: { USD: cmcUsdQuote(0.998) } },
        ]),
      },
    ]);

    const stats = await enrichMissingPrices(assets, "test-cmc-key", db);

    // Both should be priced correctly via slug, not clobbered by symbol collision
    expect(assets[0].price).toBe(1.0001);
    expect(assets[0].priceSource).toBe("coinmarketcap");
    expect(assets[1].price).toBe(0.998);
    expect(assets[1].priceSource).toBe("coinmarketcap");
    expect(stats.passCmc).toBe(2);
  });

  it("closes a stale CMC circuit when no fallback candidates remain", async () => {
    const openedAt = Math.floor(Date.now() / 1000) - 3600;
    const db = makeEnrichPricesDb([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.CMC_PRICES}`],
        rows: [
          {
            key: `circuit:${CIRCUIT_SOURCE.CMC_PRICES}`,
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

    const fetchSpy = mockFetch();

    const result = await runCmcPass(assets, "test-cmc-key", undefined, db);

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
          entry.binds[0] === `circuit:${CIRCUIT_SOURCE.CMC_PRICES}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("preserves priced assets without requesting CMC quotes", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 1,
      }),
    ];

    const now = Math.floor(Date.now() / 1000);
    const db = makeEnrichPricesDb([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.CMC_PRICES}`],
        rows: [
          {
            key: `circuit:${CIRCUIT_SOURCE.CMC_PRICES}`,
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

    const fetchSpy = mockFetch();
    await expect(runCmcPass(assets, "test-cmc-key", undefined, db)).resolves.toEqual({
      resolved: 0,
      failures: [],
    });
    expect(assets[0].price).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
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

    const db = makeEnrichPricesDb([
      emptyCmcLastFetchCache(),
      { match: "circuit", rows: [], allowUnused: true },
    ]);

    mockFetch([
      {
        match: "pro-api.coinmarketcap.com",
        body: cmcCategory([{ slug: "gemini-dollar", symbol: "GUSD", quote: { USD: cmcUsdQuote(1.0001) } }]),
      },
    ]);

    const result = await runCmcPass(assets, "test-cmc-key", undefined, db);

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
    const db = makeEnrichPricesDb([
      emptyCmcLastFetchCache(),
      { match: "circuit", rows: [], allowUnused: true },
    ]);

    mockFetch([
      {
        match: "pro-api.coinmarketcap.com",
        body: cmcCategory([{ slug: "test-dollar", symbol: "TUSD", quote: { USD: cmcUsdQuote(1.0001) } }]),
      },
    ]);

    const result = await runCmcPass(assets, "test-cmc-key", undefined, db);

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

  it("retrieves valid targeted quotes while an unrecognized slug remains unpriced", async () => {
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
    assets.push(makePeggedAsset({ id: "unknown-dollar", symbol: "UNKNOWN", price: 0, cmcSlug: "unknown-dollar" }));
    const fetchSpy = mockFetch([
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

    const result = await runCmcPass(assets, "test-cmc-key", undefined, undefined);

    expect(result.resolved).toBe(1);
    expect(assets[0].price).toBe(0.9998);
    expect(assets[0].priceSource).toBe("coinmarketcap");
    expect(assets[1].price).toBe(0);
    expect(fetchSpy.getHistory().map((entry) => entry.url)).toEqual([
      expect.stringContaining("/v1/cryptocurrency/category"),
      expect.stringContaining("/v3/cryptocurrency/quotes/latest?slug=test-dollar%2Cunknown-dollar&convert=USD&skip_invalid=true"),
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
        }), expect.objectContaining({
          assetId: "unknown-dollar",
          result: "rejected",
          rejectionClass: "missing-quote",
        })],
      }),
    ]));
  });

  it.each([
    ["named requested slug", "Invalid value for 'slug': 'cap-cusd'", false, 1, 3],
    ["unrequested slug", "Invalid value for 'slug': 'not-requested'", false, 0, 2],
    ["unknown error", "Invalid query", false, 0, 2],
    ["second invalid slug", "Invalid value for 'slug': 'cap-cusd'", true, 0, 3],
  ] as const)("isolates one invalid CMC slug without broadening retries: %s", async (_label, message, retryFails, resolved, requests) => {
    const assets = [makePeggedAsset({ id: "usdn-smardex", symbol: "USDN", price: 0,
      cmcSlug: "smardex-usdn", contracts: [{chain: "ethereum", address: "0xde17a000ba631c5d7c2bd9fb692efea52d90dee2", decimals: 18}] }),
      makePeggedAsset({id: "cusd-cap", symbol: "CUSD", price: 0, cmcSlug: "cap-cusd"})];
    const fetchSpy = mockFetch([
      {match: "/v1/cryptocurrency/category", body: cmcCategory([], 313)},
      {match: "/v3/cryptocurrency/quotes/latest", outcomes: [
        {status: 400, body: {status: {error_code: "400", error_message: message}}},
        ...(requests === 3 ? [retryFails
          ? {status: 400, body: {status: {error_message: "Invalid value for 'slug': 'smardex-usdn'"}}}
          : {body: {data: [{id: 35672, slug: "smardex-usdn", symbol: "USDN", is_active: 1,
            platform: {slug: "ethereum", token_address: "0xde17a000ba631c5d7c2bd9fb692efea52d90dee2"},
            quote: [{symbol: "USD", ...cmcUsdQuote(1.0027), volume_24h: 3352.55}]}]}}] : []),
      ]},
    ]);
    const result = await runCmcPass(assets, "test-cmc-key", undefined, undefined);
    expect(result.resolved).toBe(resolved);
    expect(assets[0].price).toBe(resolved ? 1.0027 : 0);
    expect(assets[1].price).toBe(0);
    expect(fetchSpy.getHistory()).toHaveLength(requests);
    if (requests === 3) expect(fetchSpy.getHistory()[2].url).toContain("?slug=smardex-usdn&");
    if (resolved) expect(result.diagnostics?.flatMap((d) => d.assetAttempts ?? [])).toEqual(expect.arrayContaining([
      expect.objectContaining({assetId: "cusd-cap", result: "rejected", rejectionClass: "unsupported-quote"}),
    ]));
  });

  it.each([
    ["two invalid optional slugs", ["usdn-smardex"], "pax-dollar", "smardex-usdn", false],
    ["invalid missing slug", ["usdn-smardex"], "smardex-usdn", "pax-dollar,plume-usd", true],
    ["no priority group", [], "pax-dollar", "smardex-usdn,plume-usd", true],
  ] as const)("bounds the invalid-slug retry while prioritizing price gaps: %s", async (_label, missing, invalid, retrySlugs, retryFails) => {
    const assets = [
      makePeggedAsset({ id: "usdn-smardex", symbol: "USDN", price: 0, cmcSlug: "smardex-usdn",
        contracts: [{ chain: "ethereum", address: "0xde17a000ba631c5d7c2bd9fb692efea52d90dee2", decimals: 18 }] }),
      makePeggedAsset({ id: "usdp-paxos", symbol: "USDP", price: 0, cmcSlug: "pax-dollar" }),
      makePeggedAsset({ id: "pusd-plume", symbol: "PUSD", price: 0, cmcSlug: "plume-usd" }),
    ];
    const fetchSpy = mockFetch([
      { match: "/v1/cryptocurrency/category", body: cmcCategory([], 313) },
      { match: "/v3/cryptocurrency/quotes/latest", outcomes: [
        { status: 400, body: { status: { error_message: `Invalid value for 'slug': '${invalid}'` } } },
        retryFails
          ? { status: 400, body: { status: { error_message: "Invalid value for 'slug': 'plume-usd'" } } }
          : { body: { data: [{ id: 35672, slug: "smardex-usdn", symbol: "USDN", is_active: 1,
            platform: { slug: "ethereum", token_address: "0xde17a000ba631c5d7c2bd9fb692efea52d90dee2" },
            quote: [{ symbol: "USD", ...cmcUsdQuote(1.0027), volume_24h: 3352.55 }] }] } },
      ] },
    ]);
    const result = await runCmcPass(assets, "test-cmc-key", undefined, undefined, undefined, new Set(missing));
    expect(fetchSpy.getHistory()).toHaveLength(3);
    expect(new URL(fetchSpy.getHistory()[2].url).searchParams.get("slug")).toBe(retrySlugs);
    expect(result.resolved).toBe(retryFails ? 0 : 1);
    expect(assets[0].price).toBe(retryFails ? 0 : 1.0027);
    const attempts = result.diagnostics?.flatMap((d) => d.assetAttempts ?? []);
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: `slug:${invalid}`, result: "rejected", rejectionClass: "unsupported-quote" }),
    ]));
    if (!retryFails) {
      expect(attempts).toEqual(expect.arrayContaining([
        expect.objectContaining({ assetId: "pusd-plume", state: "skipped", skipReason: "request-cap", rejectionClass: "retry-priority-deferred" }),
      ]));
      expect(result.diagnostics?.flatMap((d) => Object.keys(d.rejectionReasonCounts ?? {}))).not.toContain("missing-quote");
    }
  });

  it("does not retry malformed CMC 400 response bodies", async () => {
    const assets = [makePeggedAsset({id: "usdn-smardex", symbol: "USDN", price: 0, cmcSlug: "smardex-usdn"}),
      makePeggedAsset({id: "cusd-cap", symbol: "CUSD", price: 0, cmcSlug: "cap-cusd"})];
    const fetchSpy = mockFetch([
      {match: "/v1/cryptocurrency/category", body: cmcCategory([], 313)},
      {match: "/v3/cryptocurrency/quotes/latest", outcomes: [{response: new Response("not-json", {status: 400})}]},
    ]);
    expect((await runCmcPass(assets, "test-cmc-key", undefined, undefined)).resolved).toBe(0);
    expect(fetchSpy.getHistory()).toHaveLength(2);
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
    const fetchSpy = mockFetch([
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

    const result = await runCmcPass(assets, "test-cmc-key", undefined, undefined);

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
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-25T12:00:00Z"));
    const initialTime = Date.now();
    const observedAt = initialTime / 1000 - 60;
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
    const initialDb = makeEnrichPricesDb([
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      { match: "circuit", rows: [], allowUnused: true },
    ]);
    mockFetch([
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
    await expect(runCmcPass(firstAssets, "test-cmc-key", undefined, initialDb))
      .resolves.toMatchObject({ resolved: 1 });
    const verifiedCacheWrite = initialDb.getHistory().find(
      (entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") &&
        entry.binds[0] === "cmc_verified_targeted_quotes:v1",
    );
    expect(verifiedCacheWrite).toBeDefined();

    const nowSec = Math.floor(Date.now() / 1_000);
    const replayDb = makeEnrichPricesDb([{
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
    const fetchSpy = mockFetch();

    for (let generation = 2; generation <= 4; generation += 1) {
      vi.setSystemTime(initialTime + (generation - 1) * 15 * 60 * 1000);
      const assets = [makeAsset()];
      const result = await runCmcPass(assets, "test-cmc-key", undefined, replayDb);
      expect(result.resolved, `generation ${generation}`).toBe(1);
      expect(assets[0]).toMatchObject({
        price: 1.0002,
        priceSource: "coinmarketcap",
        priceConfidence: "fallback",
        priceObservedAt: observedAt,
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
    vi.setSystemTime(initialTime + (2 * 60 + 6) * 60 * 1000);
    const expiredAssets = [makeAsset()];
    const expired = await runCmcPass(expiredAssets, "test-cmc-key", undefined, replayDb);
    expect(expired.resolved).toBe(0);
    expect(expiredAssets[0].price).toBe(0);
    expect(fetchSpy.getHistory().map(({ url }) => url)).toContainEqual(
      expect.stringContaining("/v1/cryptocurrency/category"),
    );
  });

  it("keeps a targeted quote that missed exactly one hourly CMC roll", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The hourly consumer fetches right after CMC's roll boundary (02:07:59 →
    // 02:09:31); a slug whose quote last rolled one cadence earlier at 01:07:59
    // is 3692s old at fetch time and must still be admissible.
    vi.setSystemTime(new Date("2026-09-23T02:09:31Z"));
    const missedRollSec = Math.floor(Date.parse("2026-09-23T01:07:59Z") / 1000);
    const db = makeEnrichPricesDb([
      emptyCmcLastFetchCache(),
      { match: "circuit", rows: [], allowUnused: true },
    ]);
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
    mockFetch([
      { match: "/v1/cryptocurrency/category", body: cmcCategory([]) },
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
          quote: {
            USD: {
              ...cmcUsdQuote(1.0002, new Date(missedRollSec * 1000).toISOString()),
              volume_24h: 50_000,
            },
          },
        }] },
      },
    ]);

    const result = await runCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(1);
    expect(assets[0]).toMatchObject({
      price: 1.0002,
      priceSource: "coinmarketcap",
      priceConfidence: "fallback",
      priceObservedAt: missedRollSec,
      priceObservedAtMode: "upstream",
    });
  });

  it("bridges a rotation-skipped fetch hour from the verified cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
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
    const rolledSec = Math.floor(Date.parse("2026-09-23T01:07:59Z") / 1000);
    // The 01:09 fetch admitted the 01:07:59 roll; this slug is outside the
    // 25-slug rotation window at 02:09 and returns at 03:09, so 03:09:31 must
    // still replay the two-cadence-old verified quote (another run consumed
    // the hour's fetch quota at 03:00).
    const db = makeEnrichPricesDb([{
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
            observedAt: rolledSec,
            providerAddress: "0x1111111111111111111111111111111111111111",
            chain: "ethereum",
            active: true,
          }]),
          updated_at: Math.floor(Date.parse("2026-09-23T01:09:31Z") / 1000),
        },
        {
          key: "cmc_last_fetch",
          value: JSON.stringify({ version: 1, kind: "success" }),
          updated_at: Math.floor(Date.parse("2026-09-23T03:00:41Z") / 1000),
        },
      ],
    }]);
    const fetchSpy = mockFetch();

    vi.setSystemTime(new Date("2026-09-23T03:09:31Z"));
    const bridgedAssets = [makeAsset()];
    const bridged = await runCmcPass(bridgedAssets, "test-cmc-key", undefined, db);
    expect(bridged.resolved).toBe(1);
    expect(bridgedAssets[0]).toMatchObject({
      price: 1.0002,
      priceSource: "coinmarketcap",
      priceConfidence: "fallback",
      priceObservedAt: rolledSec,
      priceObservedAtMode: "upstream",
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    // Past two fetch cadences plus grace the quote is deliberately dropped.
    vi.setSystemTime(new Date("2026-09-23T03:13:21Z"));
    const expiredAssets = [makeAsset()];
    const expired = await runCmcPass(expiredAssets, "test-cmc-key", undefined, db);
    expect(expired.resolved).toBe(0);
    expect(expiredAssets[0].price).toBe(0);
  });

  it.each([
    ["stale observation", Math.floor(Date.now() / 1_000) - 7_501, "0x1111111111111111111111111111111111111111"],
    ["wrong contract", Math.floor(Date.now() / 1_000) - 60, "0x2222222222222222222222222222222222222222"],
  ])("rejects a verified CMC cache entry with a %s", async (_reason, observedAt, providerAddress) => {
    const nowSec = Math.floor(Date.now() / 1_000);
    const db = makeEnrichPricesDb([{
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
    const fetchSpy = mockFetch();
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

    const result = await runCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("prioritizes original missing prices while rotating spare CMC capacity", () => {
    const candidates = Array.from({ length: 50 }, (_, index) => ({
      index,
      asset: makePeggedAsset({ id: `coin-${index}`, cmcSlug: `coin-${index}`, price: null }),
    }));
    const missing = new Set(["coin-49"]);
    const first = selectRotatedCmcCandidates(candidates, 0, missing).map(({ asset }) => asset.id);
    const second = selectRotatedCmcCandidates(candidates, 3_600, missing).map(({ asset }) => asset.id);
    const third = selectRotatedCmcCandidates(candidates, 7_200, missing).map(({ asset }) => asset.id);
    expect(first).toHaveLength(25);
    expect(first[0]).toBe("coin-49");
    expect(second[0]).toBe("coin-49");
    expect(new Set([...first, ...second, ...third]).size).toBe(50);

    const manyMissing = new Set(candidates.slice(20).map(({ asset }) => asset.id));
    const missingFirst = selectRotatedCmcCandidates(candidates, 0, manyMissing);
    const missingNext = selectRotatedCmcCandidates(candidates, 3_600, manyMissing);
    expect(missingFirst).toHaveLength(25);
    expect([...missingFirst, ...missingNext].every(({ asset }) => manyMissing.has(asset.id))).toBe(true);
    expect(new Set([...missingFirst, ...missingNext].map(({ asset }) => asset.id)).size).toBe(30);
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
    mockFetch([
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

    const result = await runCmcPass(assets, "test-cmc-key", undefined, undefined);

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
    const db = makeEnrichPricesDb([
      emptyCmcLastFetchCache(),
      { match: "circuit", rows: [], allowUnused: true },
    ]);

    mockFetch([
      {
        match: "pro-api.coinmarketcap.com",
        body: cmcCategory([
          { slug: "test-dollar", symbol: "TUSD", quote: { USD: cmcUsdQuote(1.0001, staleIsoTimestamp()) } },
        ]),
      },
    ]);

    const result = await runCmcPass(assets, "test-cmc-key", undefined, db);

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
    const db = makeEnrichPricesDb([
      emptyCmcLastFetchCache(),
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.CMC_PRICES}`],
        rows: [],
        first: null,
      },
    ]);

    mockFetch([
      {
        match: "pro-api.coinmarketcap.com",
        body: { data: { coins: [] } },
      },
    ]);

    const result = await runCmcPass(assets, "test-cmc-key", undefined, db);

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
          entry.binds[0] === `circuit:${CIRCUIT_SOURCE.CMC_PRICES}`,
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
    const db = makeEnrichPricesDb([
      emptyCmcLastFetchCache(),
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.CMC_PRICES}`],
        rows: [],
        first: null,
      },
    ]);

    mockFetch([
      {
        match: "pro-api.coinmarketcap.com",
        body: cmcCategory([{ slug: "test-dollar", symbol: "TUSD", quote: { USD: cmcUsdQuote(1.0001) } }], 301),
      },
    ]);

    const result = await runCmcPass(assets, "test-cmc-key", undefined, db);

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
          entry.binds[0] === `circuit:${CIRCUIT_SOURCE.CMC_PRICES}`,
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
    const db = makeEnrichPricesDb([
      emptyCmcLastFetchCache(),
      { match: "circuit", rows: [], allowUnused: true },
    ]);
    const response = new Response("blocked", { status: 500 });
    installFetch(async () => response);

    const result = await runCmcPass(assets, "test-cmc-key", undefined, db);

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
    const db = makeEnrichPricesDb([
      emptyCmcLastFetchCache(),
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.CMC_PRICES}`],
        rows: [],
        first: null,
      },
    ]);
    installFetch(async () => new Response(JSON.stringify({ status: { error_message: "rate limited" } }), {
      status: 429,
      headers: { "Retry-After": "1" },
    }));

    const result = await runCmcPass(assets, "test-cmc-key", undefined, db);

    expect(result.resolved).toBe(0);
    expect(result.diagnostics?.[0]).toMatchObject({
      source: "coinmarketcap",
      status: 429,
      success: false,
    });
    const cacheWrite = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === "cmc_last_fetch");
    expect(JSON.parse(String(cacheWrite?.binds[1]))).toEqual({ version: 1, kind: "rate-limited" });
  });
});
