import { describe, expect, it } from "vitest";
import { wrapperPenaltyForVariant } from "../report-card-wrapper-penalty";

describe("wrapperPenaltyForVariant", () => {
  it("keeps the legacy wrapper penalty for unknown variant kinds", () => {
    expect(wrapperPenaltyForVariant(null)).toBe(3);
    expect(wrapperPenaltyForVariant(undefined)).toBe(3);
  });

  it("uses the calibrated penalty by tracked variant kind", () => {
    expect(wrapperPenaltyForVariant("savings-passthrough")).toBe(3);
    expect(wrapperPenaltyForVariant("strategy-vault")).toBe(5);
    expect(wrapperPenaltyForVariant("risk-absorption")).toBe(5);
    expect(wrapperPenaltyForVariant("bond-maturity")).toBe(8);
  });
});
