import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";

vi.mock("../../lib/mint-burn-historical-price-repair", () => ({
  DEFAULT_HISTORICAL_MINT_PRICE_REPAIR_LIMIT: 100,
  MAX_HISTORICAL_MINT_PRICE_REPAIR_LIMIT: 500,
  repairHistoricalMintBurnPrices: vi.fn(),
}));

import { repairHistoricalMintBurnPrices } from "../../lib/mint-burn-historical-price-repair";
import { handleBackfillMintBurnPrices } from "../backfill-mint-burn-prices";

stubCryptoForAuth();

const EMPTY_RESULT = {
  dryRun: true,
  limit: 100,
  selected: 0,
  recovered: 0,
  classifiedIrreducible: 0,
  deferredForRetry: 0,
  aggregateCoinsRebuilt: [],
  aggregateVerificationPassed: null,
  dispositions: [],
  backlog: { unclassified: 0, irreducible: 0, pendingAggregate: 0, totalNullUsd: 0 },
};

const db = {} as D1Database;

describe("handleBackfillMintBurnPrices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(repairHistoricalMintBurnPrices).mockResolvedValue(EMPTY_RESULT);
  });

  it("defaults to a bounded read-only preview and forwards historical provider configuration", async () => {
    const sourceLoader = {
      loadCoinGecko: vi.fn(),
      loadDefiLlama: vi.fn(),
    };
    const request = makeApiRequest("/api/backfill-mint-burn-prices?limit=25&stablecoin=ustb-superstate", {
      adminKey: "secret",
    });
    const response = await handleBackfillMintBurnPrices(
      db,
      makeApiUrl("/api/backfill-mint-burn-prices?limit=25&stablecoin=ustb-superstate"),
      true,
      request,
      { coingeckoApiKey: "cg-key", sourceLoader, nowSec: 123 },
    );

    expect(response.status).toBe(200);
    expect(repairHistoricalMintBurnPrices).toHaveBeenCalledWith(db, {
      dryRun: true,
      limit: 25,
      stablecoinId: "ustb-superstate",
      retryIrreducible: false,
      coingeckoApiKey: "cg-key",
      operatorRunId: null,
      timeTravelBookmark: null,
      sourceLoader,
      nowSec: 123,
    });
  });

  it("requires an explicit confirmation token before mutation", async () => {
    const path = "/api/backfill-mint-burn-prices?dry-run=false";
    const response = await handleBackfillMintBurnPrices(
      db,
      makeApiUrl(path),
      true,
      makeApiRequest(path, { adminKey: "secret" }),
    );

    expect(response.status).toBe(400);
    expect(repairHistoricalMintBurnPrices).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("confirm=historical-mint-prices"),
    });
  });

  it("executes only after explicit confirmation and can revisit irreducible rows", async () => {
    const path =
      "/api/backfill-mint-burn-prices?dry-run=false&confirm=historical-mint-prices&bookmark=bookmark-123&retry-irreducible=true&limit=500";
    const response = await handleBackfillMintBurnPrices(
      db,
      makeApiUrl(path),
      true,
      makeApiRequest(path, { adminKey: "secret", headers: { "Idempotency-Key": "repair-run-1" } }),
    );

    expect(response.status).toBe(200);
    expect(repairHistoricalMintBurnPrices).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        dryRun: false,
        retryIrreducible: true,
        limit: 500,
        operatorRunId: "repair-run-1",
        timeTravelBookmark: "bookmark-123",
      }),
    );
  });

  it("rejects an unbounded limit", async () => {
    const path = "/api/backfill-mint-burn-prices?limit=501";
    const response = await handleBackfillMintBurnPrices(
      db,
      makeApiUrl(path),
      true,
      makeApiRequest(path, { adminKey: "secret" }),
    );

    expect(response.status).toBe(400);
    expect(repairHistoricalMintBurnPrices).not.toHaveBeenCalled();
  });

  it("requires admin auth", async () => {
    const response = await handleBackfillMintBurnPrices(
      db,
      makeApiUrl("/api/backfill-mint-burn-prices"),
      undefined,
      makeApiRequest("/api/backfill-mint-burn-prices"),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
});
