import { describe, expect, it } from "vitest";
import { buildLegacyStablecoinRedirects } from "../maintenance/generate-legacy-stablecoin-redirects";

describe("legacy stablecoin redirect generation", () => {
  it("preserves historical identities after provider removal and imports retirement policy", () => {
    expect(buildLegacyStablecoinRedirects(
      [{ id: "usdc-circle" }, { id: "usdt-tether", llamaId: "1" }],
      { "2": "/stablecoin/usdc-circle/", "cg-usdc": "/stablecoin/usdc-circle/" },
      "/stablecoin/retired-coin/* /coverage/ 301\n/stablecoin/retired-coin /coverage/ 301\n",
    )).toEqual({
      "1": "/stablecoin/usdt-tether/",
      "2": "/stablecoin/usdc-circle/",
      "cg-usdc": "/stablecoin/usdc-circle/",
      "retired-coin": "/coverage/",
    });
  });

  it("fails closed for conflicting identities, dead targets, unsafe paths and current aliases", () => {
    const source = [{ id: "usdc-circle", llamaId: "2" }, { id: "usdt-tether" }];
    expect(() => buildLegacyStablecoinRedirects(source, { "2": "/stablecoin/usdt-tether/" }, ""))
      .toThrow("Conflicting");
    const invalidHistories: Record<string, string>[] = [
      { "9": "/stablecoin/not-tracked/" },
      { "9": "https://evil.example/" },
      { "../admin": "/coverage/" },
      { "usdc-circle": "/coverage/" },
    ];
    for (const historical of invalidHistories) {
      expect(() => buildLegacyStablecoinRedirects(source, historical, "")).toThrow("Invalid");
    }
  });
});
