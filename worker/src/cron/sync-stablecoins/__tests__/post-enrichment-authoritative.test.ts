import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { createValidationContextResolver } from "../pricing";
import { runSharedPriceCompletion } from "../post-enrichment";
import type { PeggedAsset } from "../enrich-prices";

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

  it("keeps a reviewed AZND Curve exact-pool override through final publication validation", async () => {
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

    expect(result).toMatchObject({ authoritativeOverrideCount: 1, rejectedCount: 0 });
    expect(asset).toMatchObject({
      price: 0.194,
      priceSource: "curve-thin-onchain",
      priceConfidence: "fallback",
      priceObservedAt: 1_799_999_940,
      priceObservedAtMode: "upstream",
    });
  });
});
