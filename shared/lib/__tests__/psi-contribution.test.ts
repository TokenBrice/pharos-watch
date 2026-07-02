import { describe, expect, it } from "vitest";
import {
  PSI_DEPEG_BREADTH_SCALE,
  PSI_DEPEG_SEVERITY_WEIGHT,
  computePsiDepegContribution,
} from "../psi-contribution";

describe("computePsiDepegContribution", () => {
  it("returns the shared PSI severity and breadth components", () => {
    const result = computePsiDepegContribution({
      bps: -120,
      mcapUsd: 60_000_000_000,
      totalMcapUsd: 63_000_000_000,
      factor: 0.75,
    });

    const expectedSeverity =
      (120 / 100) *
      (60_000_000_000 / 63_000_000_000) *
      Math.log2(1 + 60_000_000_000 / 1e9) *
      PSI_DEPEG_SEVERITY_WEIGHT *
      0.75;
    const expectedBreadth = Math.sqrt(60_000_000_000 / 1e9) * PSI_DEPEG_BREADTH_SCALE * 0.75;

    expect(result).toEqual({
      severity: expectedSeverity,
      breadth: expectedBreadth,
      total: expectedSeverity + expectedBreadth,
    });
  });
});
