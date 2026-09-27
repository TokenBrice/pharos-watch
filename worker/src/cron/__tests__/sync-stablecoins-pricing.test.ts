import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyConsensusResults, createValidationContextResolver } from "../sync-stablecoins/pricing";
import { validatePrimaryPriceCandidate } from "../../lib/price-publish-policy";
import type { PrimaryPriceResult } from "../sync-stablecoins/enrich-prices";
import type { PeggedAsset } from "../sync-stablecoins/enrich-prices";
import { makePeggedAsset } from "../sync-stablecoins/__tests__/_fixtures";
import { normalizeStablecoinsPayload } from "../sync-stablecoins/shared";

vi.mock("../../lib/price-publish-policy", () => ({
  validatePrimaryPriceCandidate: vi.fn(),
  validatePublishedAssetPrice: vi.fn(),
}));

const validatePrimaryPriceCandidateMock = vi.mocked(validatePrimaryPriceCandidate);

function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return makePeggedAsset({ pegMechanism: "fiat-backed", ...overrides });
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
      source: "coingecko+pyth",
      selectedSource: "pyth",
      candidateSources: ["coingecko", "pyth", "defillama-list"],
      agreeSources: ["coingecko", "pyth"],
    });
    applyConsensusResults({
      assets,
      primaryPriceResults: new Map([["usdt-tether", candidate]]),
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
      reason: "primary",
    });

    expect(assets[0].price).toBe(1.003);
    expect(assets[0].priceSource).toBe("coingecko+pyth");
    expect(assets[0].priceSelectedSource).toBe("pyth");
    expect(assets[0].consensusSources).toEqual(["coingecko", "pyth", "defillama-list"]);
    expect(assets[0].agreeSources).toEqual(["coingecko", "pyth"]);
    expect(assets[0].priceObservedAt).toBe(1_700_000_000);
    expect(assets[0].priceObservedAtMode).toBe("upstream");
    expect(assets[0].priceSyncedAt).toBe(1_800_000_000);
    expect(assets[0].priceConfidence).toBe("high");
  });

  it.each([900, 901])("bounds missing-candidate retention at the CG budget (age=%i)", (age) => {
    const assets = [
      makeAsset({
        price: 0.999,
        priceSource: "coingecko",
        priceObservedAt: 1_800_000_000 - age,
        priceUpdatedAt: 1_800_000_000 - age,
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

    expect(assets[0].price).toBe(age <= 900 ? 0.999 : null);
    expect(normalizeStablecoinsPayload({ peggedAssets: assets }).peggedAssets[0].priceSource)
      .toBe(age <= 900 ? "coingecko" : "missing");
    expect(assets[0].priceObservedAt).toBe(age <= 900 ? 1_800_000_000 - age : null);
  });

  it.each([900, 901])("bounds rejected-candidate retention at the CG budget (age=%i)", (age) => {
    const assets = [
      makeAsset({
        id: "usdt-tether",
        price: 1.001,
        priceSource: "coingecko",
        priceConfidence: "single-source",
        priceObservedAt: 1_800_000_000 - age,
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

    expect(assets[0].price).toBe(age <= 900 ? 1.001 : null);
    expect(normalizeStablecoinsPayload({ peggedAssets: assets }).peggedAssets[0].priceSource)
      .toBe(age <= 900 ? "coingecko" : "missing");
    expect(assets[0].priceObservedAt).toBe(age <= 900 ? 1_800_000_000 - age : null);
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
