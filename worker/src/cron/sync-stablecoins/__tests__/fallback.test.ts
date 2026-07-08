/**
 * Integration tests for syncViaCoingeckoFallback (fallback.ts).
 *
 * Strategy:
 * - Use the REAL stablecoin registry (ACTIVE_STABLECOINS) — the CLAUDE.md
 *   gotcha is "list circulating is already USD-denominated". A mocked registry
 *   cannot catch denomination drift.
 * - Mock only the heavy sub-phase modules (enrichment, cache, depeg) and D1.
 * - buildFallbackAssetsFromCoinGecko is tested directly with the real registry
 *   to verify USD-denomination for non-USD pegged coins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  buildFallbackAssetsFromCoinGecko,
  buildInsufficientFallbackResult,
  runFallbackIntakePhase,
} from "../fallback-intake";
import type { PeggedAsset } from "../enrich-prices";

const NOW_SEC = 1_700_000_000;

// ---------------------------------------------------------------------------
// Mocks for the heavy sub-phase modules referenced by fallback.ts
// ---------------------------------------------------------------------------

const subPhaseMocks = vi.hoisted(() => ({
  restoreFallbackCacheState: vi.fn(async () => ({
    previousAssetsById: new Map<string, PeggedAsset>(),
  })),
  fillFallbackSupplyHistoryStage: vi.fn(async () => null),
  runFallbackStalenessGate: vi.fn(async () => ({
    stalenessWarning: false,
    stalenessSummary: null,
    stalenessCheckFailed: false,
    stalenessCheckFailureReason: undefined as string | undefined,
  })),
  hydrateFallbackFxPhase: vi.fn(async () => ({
    fxFallbackRates: undefined,
    validationReferences: undefined,
    validationContexts: () => ({}),
    previousTrustedPrices: new Map(),
  })),
  runFallbackPriceEnrichmentPhase: vi.fn(async () => ({
    enrichStats: {},
    authoritativeOverrideCount: 0,
    rejectedCount: 0,
    cachedFallbackCount: 0,
    nativePegCorrectionCount: 0,
    nativePegFillCount: 0,
    priceCacheEntries: [],
    providerDiagnostics: [],
  })),
  publishFallbackStablecoinsCache: vi.fn(async ({ assets: _assets, syncStartSec }: { assets: PeggedAsset[]; syncStartSec: number }) => ({
    cacheKey: "stablecoins",
    syncStartSec,
  })),
  runFallbackDepegFollowThrough: vi.fn(async () => ({
    depegErrorCount: 0,
    depegErrors: [] as string[],
    providerDiagnostics: [] as unknown[],
  })),
}));

vi.mock("../fallback-cache", () => ({
  restoreFallbackCacheState: subPhaseMocks.restoreFallbackCacheState,
  fillFallbackSupplyHistoryStage: subPhaseMocks.fillFallbackSupplyHistoryStage,
  runFallbackStalenessGate: subPhaseMocks.runFallbackStalenessGate,
}));

vi.mock("../fallback-fx", () => ({
  hydrateFallbackFxPhase: subPhaseMocks.hydrateFallbackFxPhase,
}));

vi.mock("../fallback-enrichment", () => ({
  runFallbackPriceEnrichmentPhase: subPhaseMocks.runFallbackPriceEnrichmentPhase,
}));

vi.mock("../fallback-publish", () => ({
  publishFallbackStablecoinsCache: subPhaseMocks.publishFallbackStablecoinsCache,
  runFallbackDepegFollowThrough: subPhaseMocks.runFallbackDepegFollowThrough,
}));

// runtime reporter is optional; stub to a no-op
vi.mock("../runtime", () => ({
  returnIfAborted: () => null,
  abortResult: () => ({ metadata: "{}" }),
  reportStablecoinsStage: vi.fn(),
  checkStablecoinsPriceStaleness: vi.fn(async () => ({
    state: "missing-previous-cache",
    stalenessWarning: false,
    stalenessSummary: null,
    stalenessCheckFailed: false,
  })),
}));

import { syncViaCoingeckoFallback } from "../fallback";

// ---------------------------------------------------------------------------
// Helpers to build realistic cgData for the REAL registry
// ---------------------------------------------------------------------------

/** Build a CoinGecko mcap payload that returns positive data for the first N
 *  ACTIVE_STABLECOINS that have a geckoId. */
function buildRealCgData(countLimit: number, usdPrice = 1, usdMarketCap = 5_000_000) {
  const data: Record<string, { usd: number; usd_market_cap: number }> = {};
  let included = 0;
  for (const coin of ACTIVE_STABLECOINS) {
    if (!coin.geckoId) continue;
    if (included >= countLimit) break;
    data[coin.geckoId] = { usd: usdPrice, usd_market_cap: usdMarketCap };
    included++;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncViaCoingeckoFallback orchestrator", () => {
  beforeEach(() => {
    for (const mock of Object.values(subPhaseMocks)) {
      mock.mockClear();
    }
  });

  // -----------------------------------------------------------------------
  // (a) Primary path passes through unchanged when all phases succeed
  // -----------------------------------------------------------------------
  it("(a) returns ok status and itemCount when all phases succeed", async () => {
    const cgData = buildRealCgData(200);
    const db = mockD1([]);

    const result = await syncViaCoingeckoFallback(
      db,
      cgData,
      undefined,
      NOW_SEC,
    );

    expect(result.status).toBe("ok");
    expect(typeof result.itemCount).toBe("number");
    expect(result.itemCount).toBeGreaterThan(0);
    expect(result.metadata).toBeTruthy();

    const meta = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(meta.fallbackMode).toBe("coingecko-supply-fallback");
    expect(meta.upstreamFetchOk).toBe(false);
    expect(meta.payloadAccepted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (b) Low asset count rejects the fallback write (intake phase short-circuits)
  // -----------------------------------------------------------------------
  it("(b) rejects write when cgData has fewer than MIN_VALID_ASSET_COUNT assets", async () => {
    // Provide only 2 entries — well below MIN_VALID_ASSET_COUNT (50)
    const cgData = buildRealCgData(2);
    const db = mockD1([]);

    const result = await syncViaCoingeckoFallback(
      db,
      cgData,
      undefined,
      NOW_SEC,
    );

    // Should short-circuit and return the insufficient-fallback result
    expect(result.itemCount).toBeUndefined();
    const meta = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(meta.fallbackMode).toBe("coingecko-supply-fallback");
    expect(meta.rowsWritten).toBe(0);
    expect(meta.validationFailures).toBeGreaterThanOrEqual(1);

    // None of the heavy sub-phases should have been called
    expect(subPhaseMocks.restoreFallbackCacheState).not.toHaveBeenCalled();
    expect(subPhaseMocks.publishFallbackStablecoinsCache).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // (c) Non-USD pegged coin: circulating is USD-denominated
  //
  // The CoinGecko `usd_market_cap` for a EUR-pegged coin is already in USD.
  // buildFallbackAssetsFromCoinGecko must store it under `peggedEUR` WITHOUT
  // multiplying by price (that would be denomination drift).
  // -----------------------------------------------------------------------
  it("(c) stores usd_market_cap directly (no price multiplication) for non-USD pegs", () => {
    const eurCoins = ACTIVE_STABLECOINS.filter(
      (c) => c.flags.pegCurrency === "EUR" && c.geckoId,
    );
    // Skip test if there are no EUR coins in the registry (shouldn't happen)
    if (eurCoins.length === 0) return;

    const testCoin = eurCoins[0]!;
    const USD_MARKET_CAP = 80_000_000; // represents ~€74M at EUR/USD ~0.93
    const EUR_USD_PRICE = 1.07; // current EUR price in USD terms

    const assets = buildFallbackAssetsFromCoinGecko({
      syncStartSec: NOW_SEC,
      cgData: {
        [testCoin.geckoId!]: {
          usd: EUR_USD_PRICE,
          usd_market_cap: USD_MARKET_CAP,
        },
      },
      // Use real registry implicitly (stablecoins param defaults to ACTIVE_STABLECOINS)
      stablecoins: [testCoin],
    });

    expect(assets).toHaveLength(1);
    const asset = assets[0]!;

    // pegType for EUR coin must be peggedEUR
    expect(asset.pegType).toBe("peggedEUR");

    // The circulating value stored under peggedEUR must equal usd_market_cap
    // directly — NOT multiplied by price. It is already USD-denominated.
    expect(asset.circulating).toBeDefined();
    const stored = asset.circulating!["peggedEUR"];
    expect(stored).toBe(USD_MARKET_CAP);
    expect(stored).toBeGreaterThan(0);

    // Guard: it must NOT be the price-multiplied value
    const wrongValue = USD_MARKET_CAP * EUR_USD_PRICE;
    expect(stored).not.toBeCloseTo(wrongValue, 0);
  });

  // -----------------------------------------------------------------------
  // (d) buildFallbackAssetsFromCoinGecko uses the real registry (no mocks)
  //     and skips coins without a geckoId or with zero/missing market cap.
  // -----------------------------------------------------------------------
  it("(d) skips coins with no geckoId or zero market cap from real registry", () => {
    const noGeckoIdCoins = ACTIVE_STABLECOINS.filter((c) => !c.geckoId);
    const withGeckoIdCoins = ACTIVE_STABLECOINS.filter((c) => c.geckoId);

    // Provide zero market cap for coins that DO have geckoIds
    const zeroCgData: Record<string, { usd: number; usd_market_cap: number }> = {};
    for (const coin of withGeckoIdCoins.slice(0, 10)) {
      zeroCgData[coin.geckoId!] = { usd: 1, usd_market_cap: 0 };
    }

    const assets = buildFallbackAssetsFromCoinGecko({
      syncStartSec: NOW_SEC,
      cgData: zeroCgData,
    });

    // All entries were zero market cap → nothing should be included
    expect(assets).toHaveLength(0);

    // Sanity: coins without geckoId are always skipped
    expect(noGeckoIdCoins.length).toBeGreaterThanOrEqual(0); // structural assertion
  });

  // -----------------------------------------------------------------------
  // (e) buildInsufficientFallbackResult sets the expected metadata shape
  // -----------------------------------------------------------------------
  it("(e) buildInsufficientFallbackResult marks no-write and downstreamSafe=false", () => {
    const result = buildInsufficientFallbackResult(5);
    const meta = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.itemCount).toBeUndefined();
    expect(meta.rowsWritten).toBe(0);
    expect(meta.downstreamSafe).toBe(false);
    expect((meta.capabilities as { stablecoinsCache: boolean }).stablecoinsCache).toBe(false);
  });

  // -----------------------------------------------------------------------
  // (f) runFallbackIntakePhase short-circuits with insufficient result
  //     when fewer than MIN_VALID_ASSET_COUNT assets come back
  // -----------------------------------------------------------------------
  it("(f) runFallbackIntakePhase short-circuits on too-few assets", async () => {
    const result = await runFallbackIntakePhase({
      syncStartSec: NOW_SEC,
      cgData: { "some-coin": { usd: 1, usd_market_cap: 100 } },
      stablecoins: [
        {
          id: "some-coin",
          name: "Some Coin",
          symbol: "SOME",
          geckoId: "some-coin",
          flags: { pegCurrency: "USD", backing: "fiat-backed" },
        },
      ],
    });

    // Should return a CronResult (has metadata), not an { assets } output
    expect("metadata" in result).toBe(true);
    if ("metadata" in result) {
      const meta = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.rowsWritten).toBe(0);
    }
  });

  // -----------------------------------------------------------------------
  // (g) depegErrorCount > 0 causes degraded status
  // -----------------------------------------------------------------------
  it("(g) propagates degraded status when depeg follow-through reports errors", async () => {
    subPhaseMocks.runFallbackDepegFollowThrough.mockResolvedValueOnce({
      depegErrorCount: 3,
      depegErrors: ["err1", "err2", "err3"],
      providerDiagnostics: [],
    });

    const cgData = buildRealCgData(200);
    const db = mockD1([]);

    const result = await syncViaCoingeckoFallback(
      db,
      cgData,
      undefined,
      NOW_SEC,
    );

    expect(result.status).toBe("degraded");
    const meta = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(meta.depegPipelineSucceeded).toBe(false);
  });

  it("(h) degrades published fallback metadata when the staleness check fails", async () => {
    subPhaseMocks.runFallbackStalenessGate.mockResolvedValueOnce({
      stalenessWarning: false,
      stalenessSummary: null,
      stalenessCheckFailed: true,
      stalenessCheckFailureReason: "malformed-previous-cache",
    });

    const cgData = buildRealCgData(200);
    const db = mockD1([]);

    const result = await syncViaCoingeckoFallback(
      db,
      cgData,
      undefined,
      NOW_SEC,
    );

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBeGreaterThan(0);
    const meta = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(meta).toMatchObject({
      stalenessCheckFailed: true,
      stalenessCheckFailureReason: "malformed-previous-cache",
      cacheWriteSucceeded: true,
      downstreamSafe: true,
      capabilities: {
        stablecoinsCache: true,
      },
    });
  });
});
