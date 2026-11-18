import { readJsonResponse } from "../../../src/test-helpers/__shared/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeApiUrl, stubCryptoForAuth } from "../../../src/test-helpers/__shared/auth";
import { makeNoopD1 } from "../../../src/test-helpers/noop-d1";
import { registerStablecoinParameterContract } from "../../../src/test-helpers/__shared/endpoint-contracts";
import { mockFetchRetry } from "../../../src/test-helpers/cron/mock-fetch-retry";
import { fetchJsonWithRetry } from "../../../src/lib/fetch-retry";
import { handleBackfillCgPricesTrusted } from "../backfill-cg-prices";

stubCryptoForAuth();

vi.mock("../../../src/lib/fetch-retry", () => mockFetchRetry({
  fetchWithRetry: vi.fn(async () => (
    new Response(
      JSON.stringify({
        prices: [[1_700_000_000_000, 1.001]],
        market_caps: [[1_700_000_000_000, 123_456_789]],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  )),
}));

describe("handleBackfillCgPrices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  registerStablecoinParameterContract({
    name: "CoinGecko price backfill",
    path: "/api/backfill-cg-prices",
    invoke: (db, url) => handleBackfillCgPricesTrusted({ db, url }),
    cases: [{ kind: "unknown", stablecoin: "missing", error: "Stablecoin not found" }],
  });

  it("fills NULL prices for existing supply rows", async () => {
    const snapshotDate = Math.floor(1_700_000_000 / 86400) * 86400;
    const db = mockD1([
      {
        match: "AS price FROM supply_history",
        rows: [{ snapshot_date: snapshotDate, price: null, circulating_usd: 100_000_000 }],
      },
      { match: "UPDATE supply_history", rows: [] },
    ]);
    const res = await handleBackfillCgPricesTrusted({ db, url: makeApiUrl("/api/backfill-cg-prices?stablecoin=usdt-tether") });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      totalPricesFilled: number;
      totalRowsInserted: number;
      errors?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.totalPricesFilled).toBe(1);
    expect(body.totalRowsInserted).toBe(0);
    expect(body.errors).toBeUndefined();
  });

  it("repairs a protected quote and reports only the committed write", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const observedAt = 1_700_000_000;
      const day = observedAt - observedAt % 86400;
      const id = "usdt-tether";
      const provenance = { supplySource: "defillama", supplyObservedAt: observedAt,
        supplyChainGuard: null, nativeQuantityUnavailable: true };
      sqlite.prepare(`INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, supply_provenance)
        VALUES (?, ?, 100000000, ?)`).run(id, day, JSON.stringify(provenance));
      const run = () => handleBackfillCgPricesTrusted({ db, url: makeApiUrl(`/api/backfill-cg-prices?stablecoin=${id}`) });

      expect(await readJsonResponse(await run(), 200)).toMatchObject({ totalPricesFilled: 1, coinDetails: [{ pricesFilled: 1 }] });
      expect(await readJsonResponse(await run(), 200)).toMatchObject({ totalPricesFilled: 0, coinDetails: [{ pricesFilled: 0 }] });
      expect(sqlite.prepare(`SELECT price, price_observed_at, circulating_native,
        json_extract(supply_provenance, '$.nativeQuantityUnavailable') AS refused,
        json_extract(supply_provenance, '$.marketQuote.price') AS market_price,
        json_extract(supply_provenance, '$.marketQuote.observedAt') AS market_clock FROM supply_history`).get())
        .toEqual({ price: null, price_observed_at: null, circulating_native: null,
          refused: 1, market_price: 1.001, market_clock: observedAt });
    } finally {
      sqlite.close();
    }
  });

  it("accepts PSI historical assets for price backfills", async () => {
    const snapshotDate = Math.floor(1_700_000_000 / 86400) * 86400;
    const db = mockD1([
      {
        match: "AS price FROM supply_history",
        rows: [{ snapshot_date: snapshotDate, price: null, circulating_usd: 15_000_000_000 }],
      },
      { match: "UPDATE supply_history", rows: [] },
    ]);
    const res = await handleBackfillCgPricesTrusted({ db, url: makeApiUrl("/api/backfill-cg-prices?stablecoin=ust-terra") });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      totalPricesFilled: number;
      totalRowsInserted: number;
      errors?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.totalPricesFilled).toBe(1);
    expect(body.totalRowsInserted).toBe(0);
    expect(body.errors).toBeUndefined();
  });

  it("inserts a CoinGecko market cap only for a CoinGecko-authority coin", async () => {
    const insertTables = [
      { match: "AS price FROM supply_history", rows: [] },
      { match: "INSERT OR IGNORE INTO supply_history", rows: [] },
    ];
    const cgAuthorityDb = mockD1(insertTables);
    const cgAuthority = await handleBackfillCgPricesTrusted({
      db: cgAuthorityDb,
      url: makeApiUrl("/api/backfill-cg-prices?stablecoin=jpyc-jpyc"),
    });
    const cgBody = (await readJsonResponse(cgAuthority, 200)) as {
      totalRowsInserted: number;
      totalSupplyRowsSkipped?: number;
      errors?: string[];
    };
    expect(cgBody.totalRowsInserted).toBe(1);
    expect(cgBody.totalSupplyRowsSkipped).toBeUndefined();
    expect(cgBody.errors).toBeUndefined();

    // feUSD's frozen 75.0M CoinGecko cap is another provider's circulating
    // snapshot; the DefiLlama detail history owns this coin's supply.
    const dlAuthorityDb = mockD1([insertTables[0]!]);
    const dlAuthority = await handleBackfillCgPricesTrusted({
      db: dlAuthorityDb,
      url: makeApiUrl("/api/backfill-cg-prices?stablecoin=feusd-felix"),
    });
    const dlBody = (await readJsonResponse(dlAuthority, 200)) as {
      totalRowsInserted: number;
      totalSupplyRowsSkipped?: number;
      coinDetails?: Array<{ supplyRowsSkipped?: number }>;
      errors?: string[];
    };
    expect(dlBody.totalRowsInserted).toBe(0);
    expect(dlBody.totalSupplyRowsSkipped).toBe(1);
    expect(dlBody.coinDetails?.[0]?.supplyRowsSkipped).toBe(1);
    expect(dlBody.errors).toBeUndefined();
    expect(dlAuthorityDb.getHistory().some(({ sql }) => sql.includes("INSERT OR IGNORE INTO supply_history"))).toBe(false);
  });
});

it("does not import recycled Solomon CG market caps or prices into either generation", async () => {
  vi.clearAllMocks();
  const v2 = await handleBackfillCgPricesTrusted({ db: makeNoopD1(), url: makeApiUrl("/api/backfill-cg-prices?stablecoin=usdv-solomon-v2") });
  const body = await readJsonResponse(v2, 200) as { coinsProcessed: number; totalRowsInserted: number; skipped: string[] };
  expect(body.coinsProcessed).toBe(0);
  expect(body.totalRowsInserted).toBe(0);
  expect(body.skipped.length).toBe(1);
  // The legacy mint is frozen (2026-10-29), so the backfill no longer admits it at all.
  const legacy = await handleBackfillCgPricesTrusted({ db: makeNoopD1(), url: makeApiUrl("/api/backfill-cg-prices?stablecoin=usdv-solomon") });
  expect(legacy.status).toBe(404);
  expect(fetchJsonWithRetry).not.toHaveBeenCalled();
});
