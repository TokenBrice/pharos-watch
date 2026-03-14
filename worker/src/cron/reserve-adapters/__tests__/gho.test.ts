import { describe, it, expect } from "vitest";
import { adaptGhoFacilitators, type GhoFacilitatorData } from "../gho";

const SAMPLE: GhoFacilitatorData = {
  facilitators: [
    { label: "Aave V3 Ethereum (overcollateralized)", bucketLevel: 100_000_000n, bucketCapacity: 200_000_000n },
  ],
  gsmUsdc: 30_000_000_000_000_000_000_000_000n, // 30M in 18 decimals
  gsmUsdt: 15_000_000_000_000_000_000_000_000n, // 15M in 18 decimals
};

describe("adaptGhoFacilitators", () => {
  it("produces slices from facilitators + GSM", () => {
    const result = adaptGhoFacilitators(SAMPLE);
    expect(result.slices.length).toBeGreaterThanOrEqual(2);
    const total = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
  });

  it("skips facilitators with zero bucket level", () => {
    const data: GhoFacilitatorData = {
      facilitators: [
        { label: "Zero Facilitator", bucketLevel: 0n, bucketCapacity: 10_000_000n },
      ],
      gsmUsdc: 30_000_000_000_000_000_000_000_000n,
      gsmUsdt: 15_000_000_000_000_000_000_000_000n,
    };
    const result = adaptGhoFacilitators(data);
    const zeroFac = result.slices.find((s) => s.name.includes("Zero"));
    expect(zeroFac).toBeUndefined();
  });

  it("includes GSM USDC and USDT slices with coinIds", () => {
    const result = adaptGhoFacilitators(SAMPLE);
    const gsmUsdc = result.slices.find((s) => s.name.includes("USDC") && s.name.includes("GSM"));
    expect(gsmUsdc?.coinId).toBe("usdc-circle");
    expect(gsmUsdc?.risk).toBe("low");
  });
});
