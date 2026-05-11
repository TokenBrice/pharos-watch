import { describe, expect, it } from "vitest";
import { parseStablecoinMetaAssets } from "../schema";

const baseFlags = {
  pegCurrency: "USD",
  governance: "centralized",
  backing: "rwa-backed",
  yieldBearing: false,
  rwa: true,
  navToken: false,
};

describe("StablecoinMeta schema — frozen status", () => {
  it("accepts a well-formed frozen coin", () => {
    const json = [
      {
        id: "fixture-frozen",
        name: "Fixture Frozen",
        symbol: "FXT",
        flags: baseFlags,
        status: "frozen",
        frozenAt: "2026-04-27",
        obituary: {
          causeOfDeath: "abandoned",
          deathDate: "2026-04",
          epitaph: "Closed without ceremony.",
          obituary: "FXT was sunset by its issuer.",
          sourceUrl: "https://example.com/x",
          sourceLabel: "Issuer announcement",
        },
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("rejects a frozen coin missing the obituary block", () => {
    const json = [
      {
        id: "fixture-frozen-bad",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        status: "frozen",
        frozenAt: "2026-04-27",
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/obituary/);
  });

  it("rejects a frozen coin missing frozenAt", () => {
    const json = [
      {
        id: "fixture-frozen-bad-2",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        status: "frozen",
        obituary: {
          causeOfDeath: "abandoned",
          deathDate: "2026-04",
          epitaph: "x",
          obituary: "x",
          sourceUrl: "https://example.com/x",
          sourceLabel: "x",
        },
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/frozenAt/);
  });

  it("rejects an active coin with a stray obituary field", () => {
    const json = [
      {
        id: "fixture-active-bad",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        status: "active",
        obituary: {
          causeOfDeath: "abandoned",
          deathDate: "2026-04",
          epitaph: "x",
          obituary: "x",
          sourceUrl: "https://example.com/x",
          sourceLabel: "x",
        },
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/obituary is only allowed when status is frozen/);
  });
});

describe("StablecoinMeta schema — blacklistability review", () => {
  const explicitStatuses = [true, false, "possible", "dilutable"] as const;

  for (const status of explicitStatuses) {
    it(`rejects explicit canBeBlacklisted=${String(status)} without review evidence`, () => {
      const json = [
        {
          id: `fixture-blacklist-${String(status)}`,
          name: "Fixture",
          symbol: "FXT",
          flags: baseFlags,
          canBeBlacklisted: status,
          ...(status === "dilutable" ? {
            canBeBlacklistedSource: {
              label: "Source",
              url: "https://example.com/source",
            },
          } : {}),
        },
      ];
      expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/blacklistabilityReview/);
    });
  }

  it("rejects manual inherited blacklistability metadata", () => {
    const json = [
      {
        id: "fixture-blacklist-inherited",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        canBeBlacklisted: "inherited",
        blacklistabilityReview: {
          reviewedStatus: "inherited",
          sourceFreeRationale: "fixture",
          evidence: "Fixture evidence for inherited rejection.",
          reviewer: "Fixture",
          reviewedAt: "2026-05-12",
        },
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/canBeBlacklisted/);
  });

  it("requires review status to match the override and include a source or rationale", () => {
    const base = {
      id: "fixture-blacklist-review",
      name: "Fixture",
      symbol: "FXT",
      flags: baseFlags,
      canBeBlacklisted: true,
    };

    expect(() => parseStablecoinMetaAssets([{
      ...base,
      blacklistabilityReview: {
        reviewedStatus: false,
        sourceFreeRationale: "fixture",
        evidence: "Fixture evidence for mismatch.",
        reviewer: "Fixture",
        reviewedAt: "2026-05-12",
      },
    }], "fixture")).toThrow(/reviewedStatus/);

    expect(() => parseStablecoinMetaAssets([{
      ...base,
      blacklistabilityReview: {
        reviewedStatus: true,
        evidence: "Fixture evidence without source.",
        reviewer: "Fixture",
        reviewedAt: "2026-05-12",
      },
    }], "fixture")).toThrow(/sources/);
  });
});
