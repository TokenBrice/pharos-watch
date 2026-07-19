import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyProtocolPriceOverrides,
  createValidationContextResolver,
  type ProtocolPriceOverride,
} from "../pricing";
import { validatePrimaryPriceCandidate } from "../../../lib/price-publish-policy";
import type { PeggedAsset } from "../enrich-prices";

vi.mock("../../../lib/price-publish-policy", () => ({
  validatePrimaryPriceCandidate: vi.fn(),
  validatePublishedAssetPrice: vi.fn(),
}));

const validatePrimaryPriceCandidateMock = vi.mocked(validatePrimaryPriceCandidate);

function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return {
    id: "mkusd-prisma",
    name: "mkUSD",
    symbol: "mkUSD",
    pegType: "peggedUSD",
    price: 1.0,
    priceSource: "coingecko",
    priceConfidence: "single-source",
    priceObservedAt: 1_799_999_950,
    priceObservedAtMode: "upstream",
    priceUpdatedAt: 1_799_999_940,
    ...overrides,
  };
}

function makeOverride(overrides: Partial<ProtocolPriceOverride> = {}): ProtocolPriceOverride {
  return {
    price: 1.002,
    source: "protocol-redeem",
    confidence: "single-source",
    ...overrides,
  };
}

describe("applyProtocolPriceOverrides", () => {
  beforeEach(() => {
    validatePrimaryPriceCandidateMock.mockReset();
    validatePrimaryPriceCandidateMock.mockReturnValue({ accepted: true, reason: "ok" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies accepted override and updates asset price + source (no divergence warn)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const assets = [makeAsset({ price: 1.002 })];
    const overrides = new Map([["mkusd-prisma", makeOverride({ price: 1.002 })]]);

    const applied = applyProtocolPriceOverrides({
      assets,
      overrides,
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
    });

    expect(applied).toBe(1);
    expect(assets[0].price).toBe(1.002);
    expect(assets[0].priceSource).toBe("protocol-redeem");
    expect(assets[0].priceSelectedSource).toBe("protocol-redeem");
    expect(assets[0].priceObservedAtMode).toBe("local_fetch");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("applies accepted override with >100 bps divergence from current asset price and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Current consensus 1.0, override 1.02 → 200 bps divergence.
    const assets = [makeAsset({ price: 1.0 })];
    const overrides = new Map([["mkusd-prisma", makeOverride({ price: 1.02 })]]);

    const applied = applyProtocolPriceOverrides({
      assets,
      overrides,
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
    });

    expect(applied).toBe(1);
    expect(assets[0].price).toBe(1.02);
    expect(assets[0].priceSource).toBe("protocol-redeem");
    const divergenceWarn = warnSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("diverges"),
    );
    expect(divergenceWarn).toBeDefined();
  });

  it("leaves the asset untouched when the candidate validation rejects the override", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    validatePrimaryPriceCandidateMock.mockReturnValue({ accepted: false, reason: "bounds_exceeded" });
    const authoritativeOverrideStats = {
      budgetMs: 10_000,
      candidateCount: 0,
      attemptedCount: 0,
      successCount: 0,
      failedCount: 0,
      emptyCount: 0,
      skippedCircuitOpen: 0,
      skippedBudget: 0,
      cachedRateFallbacks: 0,
      timedOut: false,
      assetAttempts: [],
    };
    const assets = [
      makeAsset({
        price: 1.0,
        priceSource: "coingecko",
        priceSelectedSource: "coingecko",
        priceConfidence: "single-source",
      }),
    ];
    const overrides = new Map([["mkusd-prisma", makeOverride({ price: 3.5 })]]);

    const applied = applyProtocolPriceOverrides({
      assets,
      overrides,
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
      authoritativeOverrideStats,
    });

    expect(applied).toBe(0);
    expect(assets[0].price).toBe(1.0);
    expect(assets[0].priceSource).toBe("coingecko");
    expect(assets[0].priceSelectedSource).toBe("coingecko");
    const rejectWarn = warnSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Rejected protocol-backed override"),
    );
    expect(rejectWarn).toBeDefined();
    expect(authoritativeOverrideStats.assetAttempts).toEqual([
      expect.objectContaining({
        assetId: "mkusd-prisma",
        adapter: "protocol-redeem",
        source: "protocol-redeem",
        state: "attempted",
        result: "rejected",
        rejectionClass: "bounds_exceeded",
        candidateAt: 1_800_000_000,
      }),
    ]);
  });

  it("stamps accepted override with priceObservedAt = syncStartSec and priceObservedAtMode = 'local_fetch'", () => {
    const assets = [
      makeAsset({
        priceObservedAt: 1_799_999_950,
        priceObservedAtMode: "upstream",
      }),
    ];
    const overrides = new Map([["mkusd-prisma", makeOverride({ price: 1.001 })]]);

    const applied = applyProtocolPriceOverrides({
      assets,
      overrides,
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
    });

    expect(applied).toBe(1);
    // Override metadata carries observedAt=syncStartSec and mode=local_fetch (no upstream timestamp).
    expect(assets[0].priceObservedAt).toBe(1_800_000_000);
    expect(assets[0].priceObservedAtMode).toBe("local_fetch");
    expect(assets[0].priceSyncedAt).toBe(1_800_000_000);
  });

  it("preserves override observation metadata when supplied", () => {
    const assets = [makeAsset()];
    const overrides = new Map([
      [
        "mkusd-prisma",
        makeOverride({
          price: 1.001,
          observedAt: 1_799_999_940,
          observedAtMode: "upstream",
        }),
      ],
    ]);

    const applied = applyProtocolPriceOverrides({
      assets,
      overrides,
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
    });

    expect(applied).toBe(1);
    expect(assets[0].priceObservedAt).toBe(1_799_999_940);
    expect(assets[0].priceObservedAtMode).toBe("upstream");
    expect(assets[0].priceSyncedAt).toBe(1_800_000_000);
  });
});
