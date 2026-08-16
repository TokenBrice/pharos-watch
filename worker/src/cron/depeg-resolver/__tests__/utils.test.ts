import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import {
  clearV9DependencyImpairment,
  fallbackStructural,
  hydrateV9DependencyImpairment,
  toStructural,
} from "../utils";

describe("peg taxonomy projection", () => {
  it("projects the canonical BRL currency for DefiLlama's peggedREAL type", () => {
    expect(fallbackStructural("brz-transfero", "BRZ", "peggedREAL").pegCurrency).toBe("BRL");
  });
});

function fixtureMeta(id: string, dependencyWeight: number): StablecoinMeta {
  const [upstreamAssetId] = [...FROZEN_IDS];
  if (!upstreamAssetId) throw new Error("The registry fixture requires a frozen upstream asset");
  return {
    id,
    symbol: "WRAP",
    name: "Wrapper fixture",
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    dependencies: [{ id: upstreamAssetId, weight: dependencyWeight }],
  } as StablecoinMeta;
}

describe("V9 dependency impairment", () => {
  it("marks a wrapper impaired when its serial parent is frozen", () => {
    const [upstreamAssetId] = [...FROZEN_IDS];
    if (!upstreamAssetId) throw new Error("The registry fixture requires a frozen upstream asset");

    hydrateV9DependencyImpairment([
      {
        id: "wrapper-fixture",
        dependencies: { serial: [{ upstreamAssetId }] },
      },
    ]);

    expect(toStructural(fixtureMeta("wrapper-fixture", 0.1)).dependencyImpaired).toBe(true);

    clearV9DependencyImpairment();
  });

  it("keeps the legacy registry dependency check only when V9 is unavailable", () => {
    expect(toStructural(fixtureMeta("legacy-wrapper", 0.1)).dependencyImpaired).toBe(false);
    expect(toStructural(fixtureMeta("legacy-wrapper", 0.3)).dependencyImpaired).toBe(true);
  });

  it("does not propagate current depeg state through a healthy serial parent", () => {
    hydrateV9DependencyImpairment([
      {
        id: "wrapper-fixture",
        dependencies: { serial: [{ upstreamAssetId: "usdc-circle" }] },
      },
    ]);

    expect(toStructural(fixtureMeta("wrapper-fixture", 1)).dependencyImpaired).toBe(false);

    clearV9DependencyImpairment();
  });
});
