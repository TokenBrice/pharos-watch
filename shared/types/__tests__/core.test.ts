import { describe, expect, it } from "vitest";
import { getFilterTags } from "../core";
import type { StablecoinMeta } from "../core";

function makeCoin(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "test-coin",
    name: "Test Coin",
    symbol: "TEST",
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: true,
      navToken: false,
    },
    ...overrides,
  } as StablecoinMeta;
}

describe("getFilterTags — infrastructures", () => {
  it("emits no infrastructure tag when infrastructures is unset", () => {
    const tags = getFilterTags(makeCoin());
    expect(tags.some((t) => t.startsWith("infrastructure-"))).toBe(false);
  });

  it("emits no infrastructure tag for an empty infrastructures array", () => {
    const tags = getFilterTags(makeCoin({ infrastructures: [] }));
    expect(tags.some((t) => t.startsWith("infrastructure-"))).toBe(false);
  });

  it("emits infrastructure-liquity-v1 for a single-element liquity-v1 array", () => {
    const tags = getFilterTags(makeCoin({ infrastructures: ["liquity-v1"] }));
    expect(tags).toContain("infrastructure-liquity-v1");
    expect(tags).not.toContain("infrastructure-liquity-v2");
    expect(tags).not.toContain("infrastructure-m0");
  });

  it("emits infrastructure-m0 for a single-element m0 array", () => {
    const tags = getFilterTags(makeCoin({ infrastructures: ["m0"] }));
    expect(tags).toContain("infrastructure-m0");
  });

  it("emits one tag per element for a multi-element array", () => {
    const tags = getFilterTags(makeCoin({ infrastructures: ["liquity-v2", "m0"] }));
    expect(tags).toContain("infrastructure-liquity-v2");
    expect(tags).toContain("infrastructure-m0");
  });
});
