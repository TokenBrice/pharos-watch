import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { buildPriceValidationContext } from "../../../lib/price-validation";
import { runFallbackPriceEnrichmentPhase } from "../fallback-enrichment";
import type { PeggedAsset } from "../enrich-prices";
import { makePeggedAsset } from "./_fixtures";

const phaseMocks = vi.hoisted(() => ({
  authoritativeOverrideStats: { applied: 0 },
  createAuthoritativeLivePriceOverrideStats: vi.fn(() => ({ applied: 0 })),
  fetchAuthoritativeLivePriceOverrides: vi.fn(async () => new Map()),
  applyProtocolPriceOverrides: vi.fn(() => 0),
  prevalidatePrices: vi.fn(),
  reportStablecoinsStage: vi.fn(async () => undefined),
  runMissingPriceEnrichmentPhase: vi.fn(async () => ({
    missingBefore: new Set(["fallback-usd"]),
    enrichStats: { providerDiagnostics: [] },
  })),
  runSharedPriceCompletion: vi.fn(async () => ({
    authoritativeOverrideCount: 0,
    rejectedCount: 0,
    cachedFallbackCount: 0,
    nativePegCorrectionCount: 0,
    nativePegFillCount: 0,
    priceCacheEntries: [],
    providerDiagnostics: [],
  })),
}));

vi.mock("../../../lib/authoritative-price-sources", () => ({
  createAuthoritativeLivePriceOverrideStats: phaseMocks.createAuthoritativeLivePriceOverrideStats,
  fetchAuthoritativeLivePriceOverrides: phaseMocks.fetchAuthoritativeLivePriceOverrides,
}));

vi.mock("../pricing", () => ({
  applyProtocolPriceOverrides: phaseMocks.applyProtocolPriceOverrides,
  prevalidatePrices: phaseMocks.prevalidatePrices,
}));

vi.mock("../runtime", () => ({
  reportStablecoinsStage: phaseMocks.reportStablecoinsStage,
}));

vi.mock("../post-enrichment", () => ({
  isAbortResult: (value: unknown) => typeof value === "object" && value !== null && "status" in value,
  runMissingPriceEnrichmentPhase: phaseMocks.runMissingPriceEnrichmentPhase,
  runSharedPriceCompletion: phaseMocks.runSharedPriceCompletion,
}));

const NOW_SEC = 1_700_000_000;

function makeAsset(): PeggedAsset {
  return makePeggedAsset({
    id: "fallback-usd",
    name: "Fallback USD",
    symbol: "FUSD",
    geckoId: "fallback-usd",
    pegMechanism: "fiat-backed",
    price: null,
    circulating: { peggedUSD: 1_000_000 },
    chainCirculating: {},
    chains: [],
  });
}

describe("runFallbackPriceEnrichmentPhase", () => {
  beforeEach(() => {
    for (const mock of Object.values(phaseMocks)) {
      if (typeof mock === "function" && "mockClear" in mock) {
        mock.mockClear();
      }
    }
  });

  it("passes the CoinGecko API key into missing-price enrichment", async () => {
    const db = mockD1([]);
    const asset = makeAsset();

    await runFallbackPriceEnrichmentPhase({
      assets: [asset],
      db,
      syncStartSec: NOW_SEC,
      cmcApiKey: "cmc-key",
      jupiterApiKey: "jupiter-key",
      coingeckoApiKey: "cg-key",
      validationContexts: {
        get: () => buildPriceValidationContext({ stablecoinId: "fallback-usd", pegType: "peggedUSD" }),
      },
      previousTrustedPrices: new Map(),
      returnIfAborted: () => null,
      abortResult: () => ({ status: "degraded", metadata: "{}" }),
    });

    expect(phaseMocks.runMissingPriceEnrichmentPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        assets: [asset],
        db,
        syncStartSec: NOW_SEC,
        cmcApiKey: "cmc-key",
        jupiterApiKey: "jupiter-key",
        coingeckoApiKey: "cg-key",
      }),
      "fallback-",
    );
  });
});
