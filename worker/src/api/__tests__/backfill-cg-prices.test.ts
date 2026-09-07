import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { mockFetchRetry } from "../../test-helpers/cron/mock-fetch-retry";
import { handleBackfillCgPricesTrusted } from "../backfill-cg-prices";

stubCryptoForAuth();

vi.mock("../../lib/fetch-retry", () => mockFetchRetry({
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

  it("returns no-op response for out-of-range batches", async () => {
    const res = await handleBackfillCgPricesTrusted({ db: makeNoopD1(), url: makeApiUrl("/api/backfill-cg-prices?batch=999999&batchSize=100") });
    expect(await readJsonResponse(res, 200)).toEqual({ message: "No coins in this batch" });
  });

  it("fills NULL prices for existing supply rows", async () => {
    const snapshotDate = Math.floor(1_700_000_000 / 86400) * 86400;
    const db = mockD1([
      {
        match: "SELECT snapshot_date, price, circulating_usd FROM supply_history",
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

  it("accepts PSI-only shadow assets for price backfills", async () => {
    const snapshotDate = Math.floor(1_700_000_000 / 86400) * 86400;
    const db = mockD1([
      {
        match: "SELECT snapshot_date, price, circulating_usd FROM supply_history",
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
});
