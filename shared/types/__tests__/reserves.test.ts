import { describe, expect, it } from "vitest";
import {
  FullReserveCompositionSchema,
  PartialKnownExposureReserveCompositionSchema,
  validateReserveCompositionTotal,
} from "../reserves";

describe("reserve composition validation", () => {
  const partial = [
    { name: "USDC", pct: 40, risk: "low" as const },
    { name: "T-bills", pct: 20, risk: "very-low" as const },
  ];

  it("accepts full compositions that sum to 100 within tolerance", () => {
    expect(FullReserveCompositionSchema.safeParse([
      { name: "Cash", pct: 49.75, risk: "very-low" },
      { name: "Treasuries", pct: 50, risk: "very-low" },
    ]).success).toBe(true);
  });

  it("rejects full compositions with missing exposure", () => {
    const result = FullReserveCompositionSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it("keeps partial known-exposure mode available", () => {
    const result = PartialKnownExposureReserveCompositionSchema.safeParse(partial);
    expect(result.success).toBe(true);
  });

  it("rejects partial known-exposure totals above 100 plus tolerance", () => {
    expect(validateReserveCompositionTotal([
      { pct: 70 },
      { pct: 31 },
    ], "partial-known-exposure")).toBe(false);
  });
});
