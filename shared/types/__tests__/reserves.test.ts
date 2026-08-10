import { describe, expect, it } from "vitest";
import {
  FullReserveCompositionSchema,
  PartialKnownExposureReserveCompositionSchema,
  RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT,
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

  it("uses the shared full-composition tolerance at the boundary", () => {
    expect(validateReserveCompositionTotal([
      { pct: 100 - RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT },
    ], "full")).toBe(true);
    expect(validateReserveCompositionTotal([
      { pct: 100 - RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT + 0.001 },
    ], "full")).toBe(true);
    expect(validateReserveCompositionTotal([
      { pct: 100 - RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT - 0.001 },
    ], "full")).toBe(false);
  });

  it("rejects full compositions with missing exposure", () => {
    const result = FullReserveCompositionSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it("keeps partial known-exposure mode available", () => {
    const result = PartialKnownExposureReserveCompositionSchema.safeParse(partial);
    expect(result.success).toBe(true);
  });

  it("accepts explicit reserve blacklistability exposure annotations", () => {
    const result = FullReserveCompositionSchema.safeParse([
      { name: "PSM stablecoins", pct: 40, risk: "low", blacklistabilityExposure: "yes" },
      { name: "RWA credit sleeve", pct: 20, risk: "medium", blacklistabilityExposure: "upstream" },
      { name: "ETH", pct: 40, risk: "very-low", blacklistabilityExposure: "no" },
    ]);

    expect(result.success).toBe(true);
  });

  it("rejects contradictory blacklistability exposure annotations", () => {
    const directNo = FullReserveCompositionSchema.safeParse([
      { name: "USDC", pct: 100, risk: "low", blacklistable: true, blacklistabilityExposure: "no" },
    ]);
    const directUnknown = FullReserveCompositionSchema.safeParse([
      { name: "USDC", pct: 100, risk: "low", blacklistable: true, blacklistabilityExposure: "unknown" },
    ]);

    expect(directNo.success).toBe(false);
    expect(directUnknown.success).toBe(false);
  });

  it("rejects partial known-exposure totals above 100 plus tolerance", () => {
    expect(validateReserveCompositionTotal([
      { pct: 100 + RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT },
    ], "partial-known-exposure")).toBe(true);
    expect(validateReserveCompositionTotal([
      { pct: 70 },
      { pct: 30 + RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT + 0.001 },
    ], "partial-known-exposure")).toBe(false);
  });
});
