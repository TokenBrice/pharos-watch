import { describe, expect, it } from "vitest";
import type { SourcePrice } from "../../../lib/price-consensus";
import {
  applyGtProbeMutation,
  buildGtProbeTargets,
} from "../enrich-prices-primary-gt-probe";
import { createValidationContextResolver } from "../pricing";
import type { PeggedAsset, PrimaryPriceResult } from "../enrich-prices";
import { makePeggedAsset } from "./_fixtures";

function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return makePeggedAsset({ circulating: { ethereum: 1_000_000 }, ...overrides });
}

function makePrimaryResult(overrides: Partial<PrimaryPriceResult> = {}): PrimaryPriceResult {
  return {
    price: 1.0,
    source: "coingecko",
    selectedSource: "coingecko",
    priceEstimator: "selected_source",
    confidence: "single-source",
    dlPrice: null,
    cgPrice: 1.0,
    candidateSources: ["coingecko"],
    agreeSources: ["coingecko"],
    disagreeSources: [],
    allPrices: { coingecko: 1.0 },
    observedAt: 1_700_000_000,
    observedAtMode: "upstream",
    observedAtBySource: { coingecko: 1_700_000_000 },
    observedAtModeBySource: { coingecko: "upstream" },
    ...overrides,
  };
}

describe("buildGtProbeTargets", () => {
  it("targets only soft single-source or low-confidence assets without hard authoritative sources", () => {
    const assets: PeggedAsset[] = [
      makeAsset({ id: "soft-single", circulating: { ethereum: 125_000 } }),
      makeAsset({ id: "hard-candidate", circulating: { ethereum: 999_000 } }),
      makeAsset({ id: "soft-low", circulating: { base: 50_000 } }),
    ];
    const primaryResults = new Map<string, PrimaryPriceResult>([
      [
        "soft-single",
        makePrimaryResult({
          candidateSources: ["coingecko"],
          agreeSources: ["coingecko"],
          confidence: "single-source",
        }),
      ],
      [
        "hard-candidate",
        makePrimaryResult({
          candidateSources: ["coingecko", "pyth"],
          agreeSources: ["coingecko"],
          confidence: "low",
          allPrices: { coingecko: 1.0, pyth: 0.998 },
        }),
      ],
      [
        "soft-low",
        makePrimaryResult({
          candidateSources: ["coingecko", "defillama-list"],
          agreeSources: ["coingecko"],
          confidence: "low",
          allPrices: { coingecko: 1.0, "defillama-list": 1.01 },
        }),
      ],
    ]);

    expect(buildGtProbeTargets(assets, primaryResults)).toEqual([
      { id: "soft-single", price: 1.0, priorityUsd: 125_000 },
      { id: "soft-low", price: 1.0, priorityUsd: 50_000 },
    ]);
  });
});

describe("applyGtProbeMutation", () => {
  it("re-runs consensus with GT evidence and mutates the primary result in place", () => {
    const asset = makeAsset();
    const primary = makePrimaryResult();
    const gtSource: SourcePrice = {
      source: "geckoterminal",
      price: 1.0002,
      weight: 1,
      observedAt: 1_699_999_900,
      observedAtMode: "local_fetch",
    };

    const updated = applyGtProbeMutation({
      asset,
      primary,
      gtSource,
      validationContexts: createValidationContextResolver(),
    });

    expect(updated).toBe(true);
    expect(primary.price).toBeCloseTo(1.0001, 8);
    expect(primary.source).toBe("coingecko+geckoterminal");
    expect(primary.selectedSource).toBe("coingecko");
    expect(primary.confidence).toBe("high");
    expect(primary.candidateSources).toEqual(["coingecko", "geckoterminal"]);
    expect(primary.agreeSources).toEqual(["coingecko", "geckoterminal"]);
    expect(primary.allPrices).toEqual({
      coingecko: 1.0,
      geckoterminal: 1.0002,
    });
    expect(primary.observedAt).toBe(1_699_999_900);
    expect(primary.observedAtMode).toBe("local_fetch");
    expect(primary.observedAtBySource).toEqual({
      coingecko: 1_700_000_000,
      geckoterminal: 1_699_999_900,
    });
  });
});
