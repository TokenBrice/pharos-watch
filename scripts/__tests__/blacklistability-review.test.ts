import { describe, expect, it } from "vitest";
import { findBlacklistabilityReviewIssues } from "../lib/blacklistability-review";
import type { StablecoinMeta } from "@shared/types";

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
  it("requires review coverage", () => {
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
    const issues = findBlacklistabilityReviewIssues([direct, inherited, missing]);

    expect(issues).toEqual([
      {
        id: "missing",
        message: "stablecoin requires blacklistabilityReview",
      },
    ]);
  });

  it.each([undefined, []])("requires evidence when sources are %j and rationale is absent", (sources) => {
    const coin = makeMeta("unsupported", {
      blacklistabilityReview: { ...makeReview(false), sources, sourceFreeRationale: undefined },
    });
    expect(findBlacklistabilityReviewIssues([coin])).toEqual([{
      id: "unsupported",
      message: "blacklistabilityReview requires sources or sourceFreeRationale",
    }]);
  });

  it("accepts sourced evidence without a source-free rationale", () => {
    const coin = makeMeta("sourced", {
      blacklistabilityReview: {
        ...makeReview(false),
        sources: [{ label: "Token docs", url: "https://example.com/token" }],
        sourceFreeRationale: undefined,
      },
    });
    expect(findBlacklistabilityReviewIssues([coin])).toEqual([]);
  });
});
