import { describe, expect, it } from "vitest";
import variants from "../logo-variants.generated.json";
import { resolveCompactLogoSrc, resolveCompactLogoSrcSet } from "../logo-variants";

const registry: Record<string, Partial<Record<32 | 56 | 100, string>>> = variants;

describe("resolveCompactLogoSrc", () => {
  it("selects small and header variants by rendered diameter, retaining originals for larger slots", () => {
    const [src, sizes] = Object.entries(registry).find(([src]) => src.startsWith("/logos/"))!;
    expect(resolveCompactLogoSrc(src, 24)).toBe(sizes[32]);
    expect(resolveCompactLogoSrc(src, 25)).toBe(sizes[100]);
    expect(resolveCompactLogoSrc(src, 50)).toBe(sizes[100]);
    expect(resolveCompactLogoSrc(src, 51)).toBe(src);
  });

  it("uses the 56px chain derivative through a 28px slot", () => {
    const [src, sizes] = Object.entries(registry).find(([src]) => src.startsWith("/chains/"))!;
    expect(resolveCompactLogoSrc(src, 20)).toBe(sizes[56]);
    expect(resolveCompactLogoSrc(src, 28)).toBe(sizes[56]);
    expect(resolveCompactLogoSrc(src, 29)).toBe(sizes[100]);
    expect(resolveCompactLogoSrc(src, 48)).toBe(sizes[100]);
    expect(resolveCompactLogoSrc(src, 51)).toBe(src);
  });

  it("preserves absent, vector and unregistered sources", () => {
    expect(resolveCompactLogoSrc(undefined, 20)).toBeUndefined();
    expect(resolveCompactLogoSrc("/logos/vector.svg", 20)).toBe("/logos/vector.svg");
    expect(resolveCompactLogoSrc("/logos/new.png", 20)).toBe("/logos/new.png");
  });
});

describe("resolveCompactLogoSrcSet", () => {
  it("keeps the 50 CSS-pixel header sharp at DPR 3 by retaining the original above 100 pixels", () => {
    const [src, sizes] = Object.entries(registry).find(([src]) => src.startsWith("/logos/"))!;
    expect(resolveCompactLogoSrcSet(src, 50)).toBe(`${sizes[100]} 1x, ${sizes[100]} 2x, ${src} 3x`);
  });

  it("selects each candidate from rendered size times density, including small logos", () => {
    const [src, sizes] = Object.entries(registry).find(([src]) => src.startsWith("/logos/"))!;
    expect(resolveCompactLogoSrcSet(src, 18)).toBe(`${sizes[32]} 1x, ${sizes[100]} 2x, ${sizes[100]} 3x`);
    expect(resolveCompactLogoSrcSet("/logos/vector.svg", 50)).toBeUndefined();
    expect(resolveCompactLogoSrcSet(undefined, 50)).toBeUndefined();
  });
});
