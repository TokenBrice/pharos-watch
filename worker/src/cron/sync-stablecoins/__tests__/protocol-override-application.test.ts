import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyProtocolPriceOverrides,
  createValidationContextResolver,
  type ProtocolPriceOverride,
} from "../pricing";
import { validatePrimaryPriceCandidate } from "../../../lib/price-publish-policy";
import type { PeggedAsset } from "../enrich-prices";
import { makePeggedAsset } from "./_fixtures";
import { clearPriceMetadata, normalizeStablecoinsPayload, stampPriceMetadata } from "../shared";

vi.mock("../../../lib/price-publish-policy", () => ({
  validatePrimaryPriceCandidate: vi.fn(),
  validatePublishedAssetPrice: vi.fn(),
}));

const validatePrimaryPriceCandidateMock = vi.mocked(validatePrimaryPriceCandidate);

function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return makePeggedAsset({
    id: "mkusd-prisma",
    name: "mkUSD",
    symbol: "mkUSD",
    price: 1.0,
    priceSource: "coingecko",
    priceConfidence: "single-source",
    priceObservedAt: 1_799_999_950,
    priceObservedAtMode: "upstream",
    priceUpdatedAt: 1_799_999_940,
    ...overrides,
  });
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

  describe("parent derivation provenance (K-207)", () => {
    const parentMetadata = {
      inheritedFrom: "pathusd-bridge", parentSource: "coingecko", parentConfidence: "single-source" as const,
      parentObservedAt: 1_799_999_900, parentObservedAtMode: "upstream" as const, parentReplaySafe: true,
      navMethod: "convertToAssets" as const,
    };
    const derived = () => makeOverride({
      price: 2.01, source: "coingecko", confidence: "single-source", observedAt: 1_799_999_900,
      observedAtMode: "upstream",
      metadata: { ...parentMetadata, kavaPricefeed: { marketId: "x", blockHeight: 1, activeOracleCount: 1, newestExpiry: 1, dispersionBps: 0 } },
    });
    const apply = (assets: PeggedAsset[], override: ProtocolPriceOverride) => applyProtocolPriceOverrides({
      assets, overrides: new Map([["senpathusd-sentora", override]]),
      validationContexts: createValidationContextResolver(), syncStartSec: 1_800_000_000,
    });

    it("publishes the parent derivation with the winning quote without changing trust or clocks", () => {
      const assets = [makeAsset({ id: "senpathusd-sentora", price: null })];
      expect(apply(assets, derived())).toBe(1);
      expect(assets[0]).toMatchObject({ price: 2.01, priceSource: "coingecko", priceConfidence: "single-source",
        priceObservedAt: 1_799_999_900, priceDerivation: parentMetadata });
      expect(assets[0].priceDerivation).not.toHaveProperty("kavaPricefeed");
      const [published] = normalizeStablecoinsPayload({ peggedAssets: assets }).peggedAssets;
      expect(published.priceDerivation).toEqual(parentMetadata);
    });

    it("keeps the incumbent's direct provenance when the derived override is rejected", () => {
      validatePrimaryPriceCandidateMock.mockReturnValue({ accepted: false, reason: "bounds_exceeded" });
      const assets = [makeAsset({ id: "senpathusd-sentora" })];
      apply(assets, derived());
      expect(assets[0].priceSource).toBe("coingecko");
      expect(assets[0]).not.toHaveProperty("priceDerivation");
    });

    it("clears derivation on direct replacement, nominal publication, clearing and unusable publication", () => {
      const assets = [makeAsset({ id: "senpathusd-sentora", price: null })];
      apply(assets, derived());
      apply(assets, makeOverride({ price: 2.02, source: "protocol-redeem" }));
      expect(assets[0]).not.toHaveProperty("priceDerivation");

      apply(assets, derived());
      stampPriceMetadata(assets[0], "coingecko", "single-source", 1_799_999_990, "upstream");
      expect(assets[0]).not.toHaveProperty("priceDerivation");

      apply(assets, derived());
      assets[0].priceSource = "missing";
      apply(assets, makeOverride({ price: 1, source: "protocol-par", confidence: null, observedAtMode: "nominal_reference" }));
      expect(assets[0].priceObservedAtMode).toBe("nominal_reference");
      expect(assets[0]).not.toHaveProperty("priceDerivation");

      apply(assets, derived());
      clearPriceMetadata(assets[0]);
      expect(assets[0]).not.toHaveProperty("priceDerivation");

      const stale = { ...makeAsset({ id: "senpathusd-sentora", price: null }), priceDerivation: parentMetadata };
      expect(normalizeStablecoinsPayload({ peggedAssets: [stale] }).peggedAssets[0]).not.toHaveProperty("priceDerivation");
      const invalid = { ...makeAsset({ id: "senpathusd-sentora" }), priceDerivation: { ...parentMetadata, inheritedFrom: "" } };
      expect(normalizeStablecoinsPayload({ peggedAssets: [invalid] }).peggedAssets[0]).not.toHaveProperty("priceDerivation");
    });

    it("omits derivation for overrides without parent evidence", () => {
      const assets = [makeAsset({ id: "senpathusd-sentora" })];
      apply(assets, makeOverride({ metadata: { kavaPricefeed: { marketId: "x", blockHeight: 1, activeOracleCount: 1, newestExpiry: 1, dispersionBps: 0 } } }));
      expect(assets[0]).not.toHaveProperty("priceDerivation");
    });
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
    expect(warnSpy).toHaveBeenCalled();
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
