import { describe, expect, it } from "vitest";
import { findBlacklistabilityReviewIssues } from "../lib/blacklistability-review";
import type { StablecoinMeta } from "../../shared/types";

const baseFlags = {
  backing: "crypto-backed",
  pegCurrency: "USD",
  governance: "decentralized",
  yieldBearing: false,
  rwa: false,
  navToken: false,
} as const;

function makeReview(reviewedStatus: NonNullable<StablecoinMeta["blacklistabilityReview"]>["reviewedStatus"]) {
  return {
    reviewedStatus,
    sourceFreeRationale: "Fixture local metadata rationale.",
    evidence: "Fixture evidence for blacklistability review coverage.",
    reviewer: "Fixture",
    reviewedAt: "2026-05-12",
  };
}

function makeMeta(id: string, overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    flags: baseFlags,
    ...overrides,
  };
}

describe("blacklistability review data checks", () => {
  it("requires inferred review coverage and matches resolved statuses", () => {
    const direct = makeMeta("direct", {
      flags: {
        ...baseFlags,
        governance: "centralized",
      },
      blacklistabilityReview: makeReview(true),
    });
    const inherited = makeMeta("inherited", {
      reserves: [{ name: "Direct reserve", pct: 100, risk: "low", coinId: "direct" }],
      blacklistabilityReview: makeReview("inherited"),
    });
    const missing = makeMeta("missing");
    const mismatch = makeMeta("mismatch", {
      flags: {
        ...baseFlags,
        governance: "centralized",
      },
      canBeBlacklisted: true,
      blacklistabilityReview: makeReview(false),
    });

    const issues = findBlacklistabilityReviewIssues([direct, inherited, missing, mismatch]);

    expect(issues).toEqual([
      {
        id: "missing",
        message: "stablecoin requires blacklistabilityReview",
      },
      {
        id: "mismatch",
        message: "blacklistabilityReview.reviewedStatus must match resolved canBeBlacklisted status",
      },
    ]);
  });
});
