import { describe, expect, it } from "vitest";
import { API_PATHS } from "./paths";

describe("API_PATHS", () => {
  it("builds yield source decision paths with public alternatives opt-in", () => {
    expect(
      API_PATHS.yieldSourceDecisions({
        generationId: "yield-1772000000",
        stablecoin: "usdc-circle",
        state: "published",
        limit: 10,
        decisionLimit: 5,
        includePublicAlternatives: true,
      }),
    ).toBe(
      "/api/yield-source-decisions?generationId=yield-1772000000&stablecoin=usdc-circle&state=published&limit=10&decisionLimit=5&includePublicAlternatives=1",
    );
  });

  it("omits yield source decision public alternatives unless requested", () => {
    expect(
      API_PATHS.yieldSourceDecisions({
        stablecoin: "usdc-circle",
        includePublicAlternatives: false,
      }),
    ).toBe("/api/yield-source-decisions?stablecoin=usdc-circle");
  });
});
