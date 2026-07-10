import { describe, expect, it } from "vitest";
import { publishedPysRecomputesExactly, recomputePublishedPys } from "../yield-history-reproducibility";

describe("yield history reproducibility", () => {
  const inputs = {
    schemaVersion: 1 as const,
    methodologyVersion: "8.31",
    apy30d: 7.2,
    safetyScore: 82,
    varianceScore: 0.18,
    benchmarkRate: 4.2,
    sourceRiskPenalty: 1.15,
    scalingFactor: 16,
    scoreQualification: "rated" as const,
    benchmarkKey: "USD" as const,
    evidenceClass: "direct-onchain" as const,
  };

  it("recomputes the publication score from the persisted inputs", () => {
    const score = recomputePublishedPys(inputs);

    expect(score).toBeGreaterThan(0);
    expect(publishedPysRecomputesExactly(inputs, score)).toBe(true);
    expect(publishedPysRecomputesExactly(inputs, score + 0.000001)).toBe(false);
  });
});
