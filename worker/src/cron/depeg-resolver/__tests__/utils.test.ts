import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import {
  fallbackStructural,
  buildDdrStructuralContext,
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

    const projection = buildDdrStructuralContext([
      {
        id: "wrapper-fixture",
        dependencies: { serial: [{ upstreamAssetId }] },
      },
    ]);

    expect(toStructural(fixtureMeta("wrapper-fixture", 0.1), projection).dependencyImpaired).toBe(true);

  });

  it("keeps the legacy registry dependency check only when V9 is unavailable", () => {
    expect(toStructural(fixtureMeta("legacy-wrapper", 0.1), null).dependencyImpaired).toBe(false);
    expect(toStructural(fixtureMeta("legacy-wrapper", 0.3), null).dependencyImpaired).toBe(true);
  });

  it("does not propagate current depeg state through a healthy serial parent", () => {
    const projection = buildDdrStructuralContext([
      {
        id: "wrapper-fixture",
        dependencies: { serial: [{ upstreamAssetId: "usdc-circle" }] },
      },
    ]);

    expect(toStructural(fixtureMeta("wrapper-fixture", 1), projection).dependencyImpaired).toBe(false);

  });

  it("keeps interleaved runs independent, including unavailable publication fallback", () => {
    const [upstreamAssetId] = [...FROZEN_IDS];
    if (!upstreamAssetId) throw new Error("The registry fixture requires a frozen upstream asset");
    const impaired = buildDdrStructuralContext([{
      id: "wrapper-fixture", dependencies: { serial: [{ upstreamAssetId }] },
      breakdowns: { control: { components: [{ kind: "mint", posture: "unbounded-adverse" }] } },
    }]);
    const healthy = buildDdrStructuralContext([{
      id: "wrapper-fixture", dependencies: { serial: [] },
      breakdowns: { control: { components: [{ kind: "mint", posture: "bounded-admin" }] } },
    }]);
    const meta = fixtureMeta("wrapper-fixture", 0.1);
    expect(toStructural(meta, impaired)).toMatchObject({ dependencyImpaired: true, authorityPosture: "unbounded-adverse" });
    expect(toStructural(meta, healthy)).toMatchObject({ dependencyImpaired: false, authorityPosture: "bounded-admin" });
    expect(toStructural(meta, null).dependencyImpaired).toBe(false);
    expect(toStructural(meta, impaired)).toMatchObject({ dependencyImpaired: true, authorityPosture: "unbounded-adverse" });
  });
});
