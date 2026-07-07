import { describe, expect, it } from "vitest";
import { getTrackedAlgorithmicBackingIssue } from "../lib/stablecoin-data-gate-issues";

describe("stablecoin data gate issues", () => {
  it("blocks tracked stablecoin rows with legacy algorithmic backing", () => {
    expect(getTrackedAlgorithmicBackingIssue({
      flags: {
        backing: "algorithmic",
        governance: "decentralized",
        navToken: false,
        pegCurrency: "USD",
        rwa: false,
        yieldBearing: false,
      },
    })).toContain("flags.backing=algorithmic");
  });

  it("allows tracked rows classified by current backing families", () => {
    expect(getTrackedAlgorithmicBackingIssue({
      flags: {
        backing: "crypto-backed",
        governance: "decentralized",
        navToken: false,
        pegCurrency: "USD",
        rwa: false,
        yieldBearing: false,
      },
    })).toBeNull();
  });
});
