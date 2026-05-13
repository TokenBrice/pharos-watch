import { describe, expect, it } from "vitest";
import routes from "../../public/_routes.json";

describe("Pages function routes", () => {
  it("routes document responses through middleware so nonce CSP is applied", () => {
    expect(routes.include).toContain("/*");
  });

  it("does not exclude static HTML route families from middleware nonce handling", () => {
    expect(routes.exclude).not.toEqual(
      expect.arrayContaining([
        "/chains/*",
        "/stablecoin/*",
        "/stablecoins/*",
        "/compare/*",
        "/docs/*",
        "/methodology/*",
      ]),
    );
  });

  it("keeps static asset prefixes out of function routing", () => {
    expect(routes.exclude).toEqual(
      expect.arrayContaining(["/_next/*", "/logos/*", "/dexes/*", "/featured/*"]),
    );
  });
});
