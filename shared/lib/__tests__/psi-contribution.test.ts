import { describe, expect, it } from "vitest";
import { computePsiDepegContribution } from "@shared/lib/psi-contribution";

describe("computePsiDepegContribution", () => {
  const billion = { bps: -100, mcapUsd: 1_000_000_000, totalMcapUsd: 2_000_000_000 };

  it("uses explicit severity and breadth weights for a half-market billion-dollar depeg", () => {
    // log2(2) and sqrt(1) are both 1; half share gives severity 30 and breadth 3.
    expect(computePsiDepegContribution({ ...billion, factor: 0.5 })).toEqual({ severity: 15, breadth: 1.5, total: 16.5 });
  });

  it("retains breadth when total market cap is zero", () => {
    expect(computePsiDepegContribution({ ...billion, totalMcapUsd: 0 })).toEqual({ severity: 0, breadth: 3, total: 3 });
  });

  it("contributes nothing for zero market cap", () => {
    expect(computePsiDepegContribution({ ...billion, mcapUsd: 0 })).toEqual({ severity: 0, breadth: 0, total: 0 });
  });

  it("treats opposite signs symmetrically with an omitted factor", () => {
    expect(computePsiDepegContribution(billion)).toEqual({ severity: 30, breadth: 3, total: 33 });
    expect(computePsiDepegContribution({ ...billion, bps: 100 })).toEqual({ severity: 30, breadth: 3, total: 33 });
  });

  it("suppresses both components with an explicit zero factor", () => {
    expect(computePsiDepegContribution({ ...billion, factor: 0 })).toEqual({ severity: 0, breadth: 0, total: 0 });
  });
});
