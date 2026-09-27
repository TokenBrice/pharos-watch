import { describe, expect, it } from "vitest";
import {
  provenNetFlowDirection24h,
  resolveMintBurnValuation,
  summarizeMintBurnValuation,
  tallyMintBurnHourlyBucket,
} from "../mint-burn-valuation";

const tally = (overrides: Partial<Parameters<typeof summarizeMintBurnValuation>[0]> = {}) =>
  summarizeMintBurnValuation({ unpricedMintEventCount: 0, unpricedBurnEventCount: 0, unknownMintHours: 0, unknownBurnHours: 0, ...overrides });

describe("mint/burn valuation completeness", () => {
  it("reads legacy buckets as unknown only on sides that counted events", () => {
    expect(tallyMintBurnHourlyBucket({ mintCount: 3, burnCount: 0, unpricedMintEventCount: null, unpricedBurnEventCount: null }))
      .toEqual({ unpricedMintEventCount: 0, unpricedBurnEventCount: 0, unknownMintHours: 1, unknownBurnHours: 0 });
    expect(summarizeMintBurnValuation(tallyMintBurnHourlyBucket({
      mintCount: 0, burnCount: 0, unpricedMintEventCount: null, unpricedBurnEventCount: null,
    })).completeness).toBe("complete");
  });

  it("ranks partial over unknown over complete", () => {
    expect(tally({ unpricedBurnEventCount: 1, unknownMintHours: 4 })).toMatchObject({
      completeness: "partial", mintCompleteness: "unknown", burnCompleteness: "partial",
    });
    expect(tally({ unknownBurnHours: 1 }).completeness).toBe("unknown");
    expect(tally().completeness).toBe("complete");
  });

  it("keeps only directions missing valuation cannot alter", () => {
    const direction = (knownNetUsd: number, has24hActivity: boolean, valuation = tally()) =>
      provenNetFlowDirection24h({ knownNetUsd, has24hActivity, valuation });
    // Genuine empty activity stays inactive; complete zero net with activity is flat.
    expect(direction(0, false)).toBe("inactive");
    expect(direction(0, true)).toBe("flat");
    // All-unpriced activity is never flat.
    expect(direction(0, true, tally({ unpricedBurnEventCount: 1 }))).toBeNull();
    // Unknown mint plus a priced $1M burn is not a proven outflow.
    expect(direction(-1_000_000, true, tally({ unpricedMintEventCount: 1 }))).toBeNull();
    // Unpriced mints can only raise a positive known net; unpriced burns only lower a negative one.
    expect(direction(1_000_000, true, tally({ unpricedMintEventCount: 1 }))).toBe("minting");
    expect(direction(-1_000_000, true, tally({ unpricedBurnEventCount: 1 }))).toBe("burning");
    expect(direction(1_000_000, true, tally({ unpricedBurnEventCount: 1 }))).toBeNull();
    expect(direction(5, true, tally({ unknownMintHours: 1, unknownBurnHours: 1 }))).toBeNull();
  });

  it("never resolves an absent published valuation as complete", () => {
    expect(resolveMintBurnValuation(undefined)).toMatchObject({ completeness: "unknown" });
  });
});
