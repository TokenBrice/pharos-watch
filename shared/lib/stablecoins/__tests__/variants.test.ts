import { describe, expect, it } from "vitest";
import { deriveEffectiveDependencies } from "../../dependency-derivation";
import { resolveBlacklistStatuses } from "../../report-card-blacklist-matchers";
import { makeStablecoinMeta } from "../../../test-utils/stablecoin";

describe("stablecoin variants", () => {
  it("preserves a direct reviewed blacklist status independently of upstream status", () => {
    const review = {
      sourceFreeRationale: "Synthetic reviewed fixture", evidence: "Explicit local authority review",
      reviewer: "test", reviewedAt: "2026-01-01",
    };
    const statuses = resolveBlacklistStatuses([
      makeStablecoinMeta({ id: "upstream", blacklistabilityReview: { ...review, reviewedStatus: "inherited" } }),
      makeStablecoinMeta({ id: "wrapper", variantOf: "upstream", blacklistabilityReview: { ...review, reviewedStatus: true } }),
    ]);
    expect(statuses.get("upstream")).toBe("inherited");
    expect(statuses.get("wrapper")).toBe(true);
  });

  it("normalizes the variant parent claim without discarding an independent manual mechanism", () => {
    expect(
      deriveEffectiveDependencies({
        variantOf: "usds-sky",
        dependencies: [
          { id: "usds-sky", weight: 0.5, type: "collateral" },
          { id: "usdc-circle", weight: 0.2, type: "mechanism" },
        ],
        reserves: undefined,
      }),
    ).toEqual([
      { id: "usds-sky", weight: 1, type: "wrapper" },
      { id: "usdc-circle", weight: 0.2, type: "mechanism" },
    ]);
  });
});
