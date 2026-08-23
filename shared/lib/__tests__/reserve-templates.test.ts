import { describe, expect, it } from "vitest";
import { getReserves, type ReserveTemplateCoinMeta } from "../reserve-templates";
import type { ReserveSlice, StablecoinFlags } from "../../types";

/**
 * `rwa-backed` + `centralized-dependent` resolves to the generic
 * "rwa-centralized-dependent" template, whose 50/35/15 split is an invented
 * illustration rather than sourced composition.
 */
const RWA_DEPENDENT_FLAGS: StablecoinFlags = {
  backing: "rwa-backed",
  pegCurrency: "USD",
  governance: "centralized-dependent",
  yieldBearing: false,
  rwa: true,
  navToken: false,
};

function coin(overrides: Partial<ReserveTemplateCoinMeta> = {}): ReserveTemplateCoinMeta {
  return { flags: RWA_DEPENDENT_FLAGS, ...overrides };
}

const CURATED: ReserveSlice[] = [{ name: "Sourced facility exposure", pct: 100, risk: "medium" }];

describe("getReserves template suppression", () => {
  it("publishes no composition for aa-falconx-mev-capital instead of a fabricated template", () => {
    // The asset has no curated reserves and no disclosed percentage split, so an
    // absence is correct where the generic 50/35/15 template would be a fiction.
    expect(getReserves(coin({ id: "aa-falconx-mev-capital" }))).toBeNull();
  });

  it("still prefers curated reserves for a suppressed asset", () => {
    // Suppression must not outrank curation: if a sourced composition is ever
    // added for this asset it has to win, otherwise the fix would silently
    // discard real data.
    const result = getReserves(coin({ id: "aa-falconx-mev-capital", reserves: CURATED }));

    expect(result).not.toBeNull();
    expect(result?.estimated).toBe(false);
    expect(result?.reserves).toEqual(CURATED);
  });

  it("keeps the shared template available to other assets with the same classification", () => {
    // Suppression is asset-scoped, not a removal of the template itself.
    const result = getReserves(coin({ id: "some-other-rwa-dependent-coin" }));

    expect(result).not.toBeNull();
    expect(result?.estimated).toBe(true);
    expect(result?.reserves.reduce((sum, slice) => sum + slice.pct, 0)).toBe(100);
  });
});
