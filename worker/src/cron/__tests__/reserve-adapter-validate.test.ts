import { describe, it, expect } from "vitest";
import { validateAdapterOutput } from "../reserve-adapters/validate";

describe("validateAdapterOutput", () => {
  it("accepts valid slices summing to 100", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: 60, risk: "low" },
        { name: "B", pct: 40, risk: "medium" },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns when slices sum deviates from 100 by more than 5 points", () => {
    const result = validateAdapterOutput({
      slices: [{ name: "A", pct: 80, risk: "low" }],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].code).toBe("pct-sum-deviation");
  });

  it("rejects slices with invalid risk enum values", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: 50, risk: "low" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { name: "B", pct: 50, risk: "bogus" as any },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects slices with negative pct", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: -10, risk: "low" },
        { name: "B", pct: 110, risk: "medium" },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects slices with NaN pct", () => {
    const result = validateAdapterOutput({
      slices: [{ name: "A", pct: NaN, risk: "low" }],
    });
    expect(result.valid).toBe(false);
  });

  it("accepts slices with sum deviation within tolerance", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: 51, risk: "low" },
        { name: "B", pct: 51, risk: "medium" },
      ],
    });
    expect(result.valid).toBe(true);
  });
});
