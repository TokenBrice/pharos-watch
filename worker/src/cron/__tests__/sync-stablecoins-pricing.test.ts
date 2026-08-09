import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyConsensusResults, createValidationContextResolver } from "../sync-stablecoins/pricing";
import { validatePrimaryPriceCandidate } from "../../lib/price-publish-policy";
import type { PrimaryPriceResult } from "../sync-stablecoins/enrich-prices";
import type { PeggedAsset } from "../sync-stablecoins/enrich-prices";

vi.mock("../../lib/price-publish-policy", () => ({
  validatePrimaryPriceCandidate: vi.fn(),
  validatePublishedAssetPrice: vi.fn(),
}));

const validatePrimaryPriceCandidateMock = vi.mocked(validatePrimaryPriceCandidate);

function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return {
    id: "usdt-tether",
    name: "Tether",
    symbol: "USDT",
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    ...overrides,
  };
}

function makePriceResult(overrides: Partial<PrimaryPriceResult> = {}): PrimaryPriceResult {
  return {
    price: 1.001,
    source: "coingecko",
    confidence: "high",
    selectedSource: "coingecko",
    dlPrice: null,
    cgPrice: null,
    candidateSources: ["coingecko"],
    agreeSources: ["coingecko"],
    observedAt: 1_700_000_000,
    observedAtMode: "upstream",
    ...overrides,
  };
}

describe("pricing application helpers", () => {
  beforeEach(() => {
    validatePrimaryPriceCandidateMock.mockReset();
    validatePrimaryPriceCandidateMock.mockReturnValue({
      accepted: true,
      reason: "ok",
    });
  });

  it("applies primary consensus candidate and stamps metadata", () => {
    const assets = [
      makeAsset({
        id: "usdt-tether",
        supplySource: undefined,
      }),
    ];
    const candidate = makePriceResult({
      price: 1.003,
      source: "coingecko",
    });
    applyConsensusResults({
      assets,
      primaryPriceResults: new Map([["usdt-tether", candidate]]),
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
      reason: "primary",
    });

    expect(assets[0].price).toBe(1.003);
    expect(assets[0].priceSource).toBe("coingecko");
    expect(assets[0].priceSelectedSource).toBe("coingecko");
    expect(assets[0].priceConfidence).toBe("high");
  });

  it("stamps existing valid price on missing primary result", () => {
    const assets = [
      makeAsset({
        price: 0.999,
        priceSource: "manual",
        priceObservedAt: 1_799_999_950,
        priceUpdatedAt: 1_799_999_940,
        priceConfidence: "single-source",
      }),
    ];

    applyConsensusResults({
      assets,
      primaryPriceResults: new Map<string, PrimaryPriceResult>(),
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
      reason: "primary",
    });

    expect(assets[0].price).toBe(0.999);
    expect(assets[0].priceSource).toBe("manual");
    expect(assets[0].priceSyncedAt).toBe(1_800_000_000);
  });

  it("stamps the existing price when the primary candidate is rejected", () => {
    const assets = [
      makeAsset({
        id: "usdt-tether",
        price: 1.001,
        priceSource: "coingecko",
        priceConfidence: "single-source",
      }),
    ];
    const candidate = makePriceResult({
      price: 1.08,
      source: "coingecko",
      confidence: "single-source",
    });

    validatePrimaryPriceCandidateMock.mockReturnValue({
      accepted: false,
      reason: "temporal-jump-quarantine",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    applyConsensusResults({
      assets,
      primaryPriceResults: new Map([["usdt-tether", candidate]]),
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
      reason: "primary",
    });

    // The rejected candidate is not applied — the pre-existing price stays and is re-stamped.
    expect(assets[0].price).toBe(1.001);
    expect(assets[0].priceSource).toBe("coingecko");
    expect(assets[0].priceSyncedAt).toBe(1_800_000_000);
    warnSpy.mockRestore();
  });

  it("primary pass defaults supply source", () => {
    const primaryOnly = [
      makeAsset({
        id: "usdt-tether",
      }),
    ];

    applyConsensusResults({
      assets: primaryOnly,
      primaryPriceResults: new Map([["usdt-tether", makePriceResult({ price: 1.0 })]]),
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
      reason: "primary",
    });

    expect(primaryOnly[0].supplySource).toBe("defillama");
  });
});
