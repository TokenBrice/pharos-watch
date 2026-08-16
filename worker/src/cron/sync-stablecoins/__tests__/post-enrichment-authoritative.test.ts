import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 as createMockD1, type MockTableConfig } from "../../../test-helpers/__shared/mock-d1";
import { createValidationContextResolver } from "../pricing";
import { runSharedPriceCompletion } from "../post-enrichment";
import type { PeggedAsset } from "../enrich-prices";

const DEFAULT_POST_ENRICHMENT_D1_TABLES: MockTableConfig[] = [
  { match: "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache", rows: [] },
];

function mockD1(tables: MockTableConfig[] = []) {
  return createMockD1([...tables, ...DEFAULT_POST_ENRICHMENT_D1_TABLES]);
}

const authoritativeMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("../../../lib/authoritative-price-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/authoritative-price-sources")>();
  return {
    ...actual,
    fetchAuthoritativeLivePriceOverrides: authoritativeMocks.fetch,
  };
});

vi.mock("../../../lib/native-peg-implied-prices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/native-peg-implied-prices")>();
  return {
    ...actual,
    fetchCurrentNativePegImpliedUsdQuotes: vi.fn(async () => new Map()),
  };
});

describe("runSharedPriceCompletion authoritative repair", () => {
  beforeEach(() => {
    authoritativeMocks.fetch.mockReset().mockResolvedValue(new Map());
  });

  it("re-resolves local authoritative dependencies after fallback without repeating RPC providers", async () => {
    authoritativeMocks.fetch.mockResolvedValueOnce(
      new Map([
        [
          "usdn-noble",
          {
            price: 0.9998,
            source: "protocol-redeem",
            confidence: "high",
            observedAt: 1_800_000_000,
            observedAtMode: "local_fetch",
          },
        ],
      ]),
    );
    const asset: PeggedAsset = {
      id: "usdn-noble",
      name: "Noble Dollar",
      symbol: "USDN",
      pegType: "peggedUSD",
      price: null,
    };

    const result = await runSharedPriceCompletion(
      {
        assets: [asset],
        missingBefore: new Set([asset.id]),
        db: mockD1([]),
        syncStartSec: 1_800_000_000,
        validationContexts: createValidationContextResolver(),
        authoritativeOverrides: new Map(),
        returnIfAborted: () => null,
        abortResult: () => ({ status: "degraded", itemCount: 0, metadata: "aborted" }),
      },
      "",
    );

    expect(authoritativeMocks.fetch).toHaveBeenCalledOnce();
    expect(authoritativeMocks.fetch).toHaveBeenCalledWith(
      [asset],
      undefined,
      undefined,
      expect.objectContaining({ maxProviderLivePriority: 0 }),
    );
    expect(asset).toMatchObject({
      price: 0.9998,
      priceSource: "protocol-redeem",
      priceConfidence: "high",
    });
    expect(result).toMatchObject({ authoritativeOverrideCount: 1 });
  });

  it("withholds an uncorroborated AZND Curve exact-pool override", async () => {
    const asset: PeggedAsset = {
      id: "aznd-mu-digital",
      name: "Anzen USDz NZD",
      symbol: "AZND",
      pegType: "peggedUSD",
      price: null,
    };

    const result = await runSharedPriceCompletion(
      {
        assets: [asset],
        missingBefore: new Set([asset.id]),
        db: mockD1([]),
        syncStartSec: 1_800_000_000,
        validationContexts: createValidationContextResolver(),
        authoritativeOverrides: new Map([
          [
            asset.id,
            {
              price: 0.194,
              source: "curve-thin-onchain",
              confidence: "fallback",
              observedAt: 1_799_999_940,
              observedAtMode: "upstream",
            },
          ],
        ]),
        previousTrustedPrices: new Map([
          [
            asset.id,
            {
              price: 1,
              source: "pyth",
              confidence: "high",
              observedAt: 1_799_000_000,
              agreeSources: ["pyth"],
            },
          ],
        ]),
        returnIfAborted: () => null,
        abortResult: () => ({ status: "degraded", itemCount: 0, metadata: "aborted" }),
      },
      "",
    );

    expect("authoritativeOverrideStats" in result).toBe(true);
    if (!("authoritativeOverrideStats" in result)) {
      throw new Error("Expected shared price completion result");
    }
    expect(result).toMatchObject({ authoritativeOverrideCount: 0, rejectedCount: 0 });
    expect(result.authoritativeOverrideStats.assetAttempts).toEqual([
      expect.objectContaining({
        assetId: asset.id,
        adapter: "curve-thin-onchain",
        source: "curve-thin-onchain",
        state: "attempted",
        result: "rejected",
        rejectionClass: "severe_downside_requires_corroboration",
      }),
    ]);
    expect(asset.price).toBeNull();
    expect(asset.priceSource).toBeUndefined();
  });
});
