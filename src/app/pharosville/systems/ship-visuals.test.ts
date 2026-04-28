import { describe, expect, it } from "vitest";
import type { BackingType, GovernanceType, PegCurrency, StablecoinMeta } from "@shared/types";
import { makeAsset } from "../__fixtures__/pharosville-world";
import { resolveShipClass, resolveShipSizeTier, resolveShipVisual } from "./ship-visuals";

function makeMeta(input: {
  backing?: BackingType;
  governance?: GovernanceType;
  navToken?: boolean;
  pegCurrency?: PegCurrency;
  yieldBearing?: boolean;
}): StablecoinMeta {
  return {
    flags: {
      backing: input.backing ?? "rwa-backed",
      governance: input.governance,
      navToken: input.navToken ?? false,
      pegCurrency: input.pegCurrency ?? "USD",
      rwa: input.backing !== "crypto-backed",
      yieldBearing: input.yieldBearing ?? false,
    },
  } as StablecoinMeta;
}

describe("resolveShipVisual", () => {
  it("uses governance class for base ship models", () => {
    expect(resolveShipClass(makeMeta({ governance: "centralized" }))).toMatchObject({
      hull: "treasury-galleon",
      label: "CeFi",
      shipClass: "cefi",
    });
    expect(resolveShipClass(makeMeta({ governance: "centralized-dependent" }))).toMatchObject({
      hull: "chartered-brigantine",
      label: "CeFi-Dep",
      shipClass: "cefi-dependent",
    });
    expect(resolveShipClass(makeMeta({ governance: "decentralized" }))).toMatchObject({
      hull: "dao-schooner",
      label: "DeFi",
      shipClass: "defi",
    });
  });

  it("keeps algorithmic backing on the defensive legacy fallback", () => {
    expect(resolveShipClass(makeMeta({ backing: "algorithmic", governance: "centralized" }))).toMatchObject({
      hull: "algo-junk",
      label: "Legacy algorithmic",
      shipClass: "legacy-algo",
    });
  });

  it("maps market caps to compressed size tiers", () => {
    expect(resolveShipSizeTier(20_000_000_000)).toEqual({ label: "Flagship", scale: 3, tier: "flagship" });
    expect(resolveShipSizeTier(2_000_000_000)).toEqual({ label: "Major", scale: 1.8, tier: "major" });
    expect(resolveShipSizeTier(200_000_000)).toEqual({ label: "Regional", scale: 1.25, tier: "regional" });
    expect(resolveShipSizeTier(20_000_000)).toEqual({ label: "Local", scale: 0.95, tier: "local" });
    expect(resolveShipSizeTier(2_000_000)).toEqual({ label: "Skiff", scale: 0.78, tier: "skiff" });
    expect(resolveShipSizeTier(500_000)).toEqual({ label: "Micro", scale: 0.7, tier: "micro" });
    expect(resolveShipSizeTier(0)).toEqual({ label: "Unknown", scale: 0.7, tier: "unknown" });
    expect(resolveShipSizeTier(2_000_000_000).scale).toBeGreaterThan(1.5);
  });

  it("preserves peg, overlay, and compressed scale channels", () => {
    const meta = makeMeta({
      backing: "crypto-backed",
      governance: "centralized-dependent",
      navToken: true,
    });
    const visual = resolveShipVisual(makeAsset({
      id: "susde-ethena",
      symbol: "sUSDe",
      circulating: { peggedUSD: 11_000_000_000 },
    }), meta, null);

    expect(visual.hull).toBe("chartered-brigantine");
    expect(visual.shipClass).toBe("cefi-dependent");
    expect(visual.classLabel).toBe("CeFi-Dep");
    expect(visual.rigging).toBe("dependent-rig");
    expect(visual.pennant).toBe("emerald");
    expect(visual.overlay).toBe("nav");
    expect(visual.sizeTier).toBe("flagship");
    expect(visual.sizeLabel).toBe("Flagship");
    expect(visual.scale).toBe(3);
  });
});
