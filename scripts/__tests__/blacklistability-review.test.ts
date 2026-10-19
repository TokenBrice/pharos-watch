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

const parentRelationships: Partial<StablecoinMeta>[] = [
  { variantOf: "parent" },
  {
    mintAuthority: {
      mintPath: "wrapped-or-variant-inherited",
      authorityPosture: "none-resolved",
      inheritedFrom: "parent",
      confidence: "verified",
      summary: "Fixture inherits its parent.",
      review: {
        sources: [{ label: "Parent docs", url: "https://example.com/parent" }],
        evidence: "Fixture inherited mint authority.",
        reviewer: "Fixture",
        reviewedAt: "2026-05-12",
      },
    },
  },
];

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

  describe.each(parentRelationships)("declared parent relationship %j", (relationship) => {
    it.each([true, "possible", "inherited"] as const)(
      "rejects a No child when its parent resolves to %s",
      (parentStatus) => {
        const parent = makeMeta("parent", { blacklistabilityReview: makeReview(parentStatus) });
        const child = makeMeta("child", { ...relationship, blacklistabilityReview: makeReview(false) });
        expect(findBlacklistabilityReviewIssues([child, parent])).toEqual([{
          id: "child",
          message: `blacklistabilityReview.reviewedStatus cannot be false while declared parent "parent" resolves to ${String(parentStatus)}`,
        }]);
      },
    );

    it.each([undefined, []])("rejects stale parent-only inheritance with reserves %j", (reserves) => {
      const parent = makeMeta("parent", { blacklistabilityReview: makeReview(false) });
      const child = makeMeta("child", {
        ...relationship,
        reserves,
        blacklistabilityReview: makeReview("inherited"),
      });
      expect(findBlacklistabilityReviewIssues([parent, child])).toEqual([{
        id: "child",
        message: "blacklistabilityReview.reviewedStatus inherited has only declared parent(s) resolving to false (parent) and no exposed or custodial reserve candidate",
      }]);
    });

    it("catches the sDOLA pattern even when the false parent is the entire reserve", () => {
      const parent = makeMeta("parent", { blacklistabilityReview: makeReview(false) });
      const child = makeMeta("child", {
        ...relationship,
        reserves: [{ name: "Parent claim", pct: 100, risk: "low", coinId: "parent" }],
        blacklistabilityReview: makeReview("inherited"),
      });
      expect(findBlacklistabilityReviewIssues([parent, child])).toEqual([
        expect.objectContaining({ id: "child", message: expect.stringContaining("only declared parent(s)") }),
      ]);
    });

    it.each([false, true, "possible", "inherited"] as const)(
      "accepts a child with reviewed status %s when the parent is exposed unless the child is No",
      (childStatus) => {
        const parent = makeMeta("parent", { blacklistabilityReview: makeReview(true) });
        const child = makeMeta("child", { ...relationship, blacklistabilityReview: makeReview(childStatus) });
        expect(findBlacklistabilityReviewIssues([parent, child])).toHaveLength(childStatus === false ? 1 : 0);
      },
    );

    it.each(["pre-launch", "frozen", "quarantined", "delisted"] as const)(
      "does not apply active consistency checks to %s children",
      (status) => {
        for (const reviewedStatus of [false, "inherited"] as const) {
          const parent = makeMeta("parent", {
            blacklistabilityReview: makeReview(reviewedStatus === false),
          });
          const child = makeMeta("child", {
            ...relationship,
            status,
            blacklistabilityReview: makeReview(reviewedStatus),
          });
          expect(findBlacklistabilityReviewIssues([parent, child])).toEqual([]);
        }
      },
    );
  });

  it.each([true, "possible", "inherited"] as const)(
    "keeps an exposed %s reserve candidate without recomputing the 50%% test",
    (reserveStatus) => {
      const parent = makeMeta("parent", { blacklistabilityReview: makeReview(false) });
      const reserve = makeMeta("reserve", { blacklistabilityReview: makeReview(reserveStatus) });
      const child = makeMeta("child", {
        variantOf: parent.id,
        blacklistabilityReview: makeReview("inherited"),
        reserves: [
          { name: "Parent", pct: 99, risk: "low", coinId: parent.id },
          { name: "Other reserve", pct: 1, risk: "low", coinId: reserve.id },
        ],
      });
      expect(findBlacklistabilityReviewIssues([parent, reserve, child])).toEqual([]);
    },
  );

  it.each([
    { blacklistable: true },
    { blacklistabilityExposure: "yes" },
    { blacklistabilityExposure: "upstream" },
    { blacklistabilityExposure: "possible" },
    { assetClass: "cash" },
    { assetClass: "bank-deposit" },
    { assetClass: "treasury-bill" },
    { assetClass: "government-security" },
    { assetClass: "repo" },
    { assetClass: "money-market-fund" },
    { assetClass: "private-credit" },
    { assetClass: "public-credit" },
    { assetClass: "tokenized-security" },
    { assetClass: "fund-share" },
    { assetClass: "commodity-allocated" },
  ] satisfies Partial<NonNullable<StablecoinMeta["reserves"]>[number]>[])(
    "preserves a structured reserve candidate %j",
    (reserveFields) => {
      const parent = makeMeta("parent", { blacklistabilityReview: makeReview(false) });
      const child = makeMeta("child", {
        variantOf: parent.id,
        blacklistabilityReview: makeReview("inherited"),
        reserves: [{ name: "Custodial or exposed reserve", pct: 100, risk: "low", ...reserveFields }],
      });
      expect(findBlacklistabilityReviewIssues([parent, child])).toEqual([]);
    },
  );

  it.each([
    { blacklistabilityExposure: "no" },
    { blacklistabilityExposure: "unknown" },
    { assetClass: "cryptoasset" },
    { assetClass: "protocol-position" },
    { coinId: "child" },
    { pct: 0, blacklistabilityExposure: "yes", sourceKey: "fixture:empty" },
  ] satisfies Partial<NonNullable<StablecoinMeta["reserves"]>[number]>[])(
    "does not rescue stale inheritance with a non-exposed reserve %j",
    (reserveFields) => {
      const parent = makeMeta("parent", { blacklistabilityReview: makeReview(false) });
      const child = makeMeta("child", {
        variantOf: parent.id,
        blacklistabilityReview: makeReview("inherited"),
        reserves: [{ name: "Non-exposed reserve", pct: 100, risk: "low", ...reserveFields }],
      });
      expect(findBlacklistabilityReviewIssues([parent, child])).toEqual([
        expect.objectContaining({ id: "child", message: expect.stringContaining("no exposed or custodial reserve candidate") }),
      ]);
    },
  );

  it("checks both parent declarations and deduplicates an identical parent", () => {
    const parent = makeMeta("parent", { blacklistabilityReview: makeReview(false) });
    const other = makeMeta("other", { blacklistabilityReview: makeReview("possible") });
    const child = makeMeta("child", {
      ...parentRelationships[1],
      variantOf: other.id,
      blacklistabilityReview: makeReview(false),
    });
    expect(findBlacklistabilityReviewIssues([parent, other, child])).toEqual([
      expect.objectContaining({ id: "child", message: expect.stringContaining('"other"') }),
    ]);
    expect(findBlacklistabilityReviewIssues([
      parent,
      other,
      { ...child, blacklistabilityReview: makeReview("inherited") },
    ])).toEqual([]);
    expect(findBlacklistabilityReviewIssues([
      { ...parent, blacklistabilityReview: makeReview(true) },
      { ...child, variantOf: parent.id },
    ])).toHaveLength(1);
  });

  it("accepts a No child of a No parent and does not invent a false status for missing reviews", () => {
    const parent = makeMeta("parent", { blacklistabilityReview: makeReview(false) });
    const child = makeMeta("child", { variantOf: parent.id, blacklistabilityReview: makeReview(false) });
    expect(findBlacklistabilityReviewIssues([parent, child])).toEqual([]);
    expect(findBlacklistabilityReviewIssues([
      makeMeta("parent"),
      { ...child, blacklistabilityReview: makeReview("inherited") },
    ])).toEqual([{ id: "parent", message: "stablecoin requires blacklistabilityReview" }]);
  });

  it("leaves reserve-based inheritance without a declared parent to evidence review", () => {
    const coin = makeMeta("reserve-based", { blacklistabilityReview: makeReview("inherited") });
    expect(findBlacklistabilityReviewIssues([coin])).toEqual([]);
  });
});
