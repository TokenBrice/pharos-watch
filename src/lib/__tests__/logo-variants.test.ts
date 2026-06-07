import { describe, expect, it } from "vitest";

import { resolveCompactLogoSrc } from "@/lib/logo-variants";

describe("resolveCompactLogoSrc", () => {
  it("uses compact WebP assets only for small known logo renders", () => {
    expect(resolveCompactLogoSrc("/logos/zarm-mento.png", 16)).toBe("/logos/compact/zarm-mento.webp");
    expect(resolveCompactLogoSrc("/logos/zarm-mento.png", 48)).toBe("/logos/zarm-mento.png");
  });

  it("leaves unknown and missing logos unchanged", () => {
    expect(resolveCompactLogoSrc("/logos/usdt-tether.png", 16)).toBe("/logos/usdt-tether.png");
    expect(resolveCompactLogoSrc(undefined, 16)).toBeUndefined();
  });
});
