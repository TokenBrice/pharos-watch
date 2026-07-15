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
    authoritativeMocks.fetch.mockReset();
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
});
