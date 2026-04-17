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

  it("ignores GT probe when primary source is not geckoterminal", () => {
    const assets = [
      makeAsset(),
    ];
    const candidate = makePriceResult({
      source: "coingecko",
      candidateSources: ["coingecko"],
    });

    applyConsensusResults({
      assets,
      primaryPriceResults: new Map([["usdt-tether", candidate]]),
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
      reason: "gt-probe",
    });

    expect(assets[0].price).toBeUndefined();
  });

  it("applies GT probe candidate when geckoterminal contributed", () => {
    const assets = [
      makeAsset(),
    ];
    const candidate = makePriceResult({
      price: 0.997,
      source: "coingecko",
      candidateSources: ["coingecko", "geckoterminal"],
    });

    applyConsensusResults({
      assets,
      primaryPriceResults: new Map([["usdt-tether", candidate]]),
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
      reason: "gt-probe",
    });

    expect(assets[0].price).toBe(0.997);
    expect(assets[0].priceSource).toBe("coingecko");
  });

  it("downgrades pre-GT single-source asset to low confidence when GT-probe evidence is rejected", () => {
    // Pre-GT primary pass set this asset to "single-source" with a soft price.
    const assets = [
      makeAsset({
        id: "usdt-tether",
        price: 1.001,
        priceSource: "coingecko",
        priceConfidence: "single-source",
      }),
    ];
    // After runGtProbePass mutation: GT probe diverged, resulting consensus is still
    // single-source (GT did not join the sole cluster). validatePrimaryPriceCandidate
    // rejects the GT-enriched candidate (e.g., temporal-jump).
    const candidate = makePriceResult({
      price: 1.08,
      source: "coingecko",
      confidence: "single-source",
      candidateSources: ["coingecko", "geckoterminal"],
      agreeSources: ["coingecko"],
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
      reason: "gt-probe",
    });

    expect(assets[0].priceConfidence).toBe("low");
    // The GT-rejected price is not applied — pre-GT price stays.
    expect(assets[0].price).toBe(1.001);
    expect(assets[0].priceSource).toBe("coingecko");
    const warned = warnSpy.mock.calls.some((args) => {
      const msg = args.map((a) => String(a)).join(" ");
      return msg.includes("GT probe evidence rejected") && msg.includes("usdt-tether");
    });
    expect(warned).toBe(true);
    warnSpy.mockRestore();
  });

  it("only primary pass defaults supply source", () => {
    const primaryOnly = [
      makeAsset({
        id: "usdt-tether",
      }),
    ];
    const gtOnly = [
      makeAsset({
        id: "usdc-circle",
      }),
    ];

    applyConsensusResults({
      assets: primaryOnly,
      primaryPriceResults: new Map([["usdt-tether", makePriceResult({ price: 1.0 })]]),
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
      reason: "primary",
    });

    applyConsensusResults({
      assets: gtOnly,
      primaryPriceResults: new Map([["usdc-circle", makePriceResult({
        price: 1.0,
        candidateSources: ["coingecko", "geckoterminal"],
      })]]),
      validationContexts: createValidationContextResolver(),
      syncStartSec: 1_800_000_000,
      reason: "gt-probe",
    });

    expect(primaryOnly[0].supplySource).toBe("defillama");
    expect(gtOnly[0].supplySource).toBeUndefined();
  });
});
