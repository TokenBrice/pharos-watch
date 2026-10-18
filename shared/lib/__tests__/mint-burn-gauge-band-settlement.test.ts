import { describe, expect, it } from "vitest";
import { assessGaugeBandSettlement } from "../mint-burn-gauge-bands";

describe("assessGaugeBandSettlement", () => {
  it("keeps the band when nothing is withheld, including payloads predating the count", () => {
    expect(assessGaugeBandSettlement({ score: -6, partialValuationInputs: 0 })).toEqual({ settled: true, interval: null });
    expect(assessGaugeBandSettlement({ score: -6 })).toEqual({ settled: true, interval: null });
  });

  it("keeps the band only when every full-cohort score stays in it", () => {
    const robust = assessGaugeBandSettlement({ score: -48, partialValuationInputs: 1, scoredMcapUsd: 99, partialValuationMcapUsd: 1 });
    expect(robust.settled).toBe(true);
    expect(robust.interval![0]).toBeCloseTo(-48.52, 2);
    expect(robust.interval![1]).toBeCloseTo(-46.52, 2);

    const crossing = assessGaugeBandSettlement({ score: -6, partialValuationInputs: 1, scoredMcapUsd: 50, partialValuationMcapUsd: 50 });
    expect(crossing).toEqual({ settled: false, interval: [-53, 47] });
  });

  it("treats a withheld count without published weights as unbounded, and no score as unsettled", () => {
    expect(assessGaugeBandSettlement({ score: -6, partialValuationInputs: 2 })).toEqual({ settled: false, interval: null });
    expect(assessGaugeBandSettlement({ score: null })).toEqual({ settled: false, interval: null });
  });
});
