import { describe, it, expect } from "vitest";
import { getLiquidityCoverageBadge } from "@/lib/liquidity-coverage";

describe("liquidity coverage", () => {
  it("distinguishes invalid evidence from genuinely unobserved coverage", () => {
    expect(getLiquidityCoverageBadge(null, "invalid-coverage-evidence").label).toBe("Unavailable");
    expect(getLiquidityCoverageBadge("unobserved").label).toBe("NR");
  });
});
