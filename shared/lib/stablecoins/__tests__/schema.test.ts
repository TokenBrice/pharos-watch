import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("accepts inferred blacklistability review metadata without an override", () => {
    const json = [
      {
        id: "fixture-blacklist-inferred",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        blacklistabilityReview: {
          reviewedStatus: "inherited",
          sourceFreeRationale: "Resolved from Pharos stablecoin metadata.",
          evidence: "Fixture evidence for inferred upstream exposure.",
          reviewer: "Fixture",
          reviewedAt: "2026-05-12",
        },
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
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

describe("StablecoinMeta schema — variantOf / pegReferenceId coherence (Rule 1)", () => {
  it("accepts a coin with matching variantOf and pegReferenceId", () => {
    const json = [
      {
        id: "fixture-variant-ok",
        name: "Fixture Variant",
        symbol: "FVT",
        flags: baseFlags,
        variantOf: "usdt-tether",
        variantKind: "savings-passthrough",
        pegReferenceId: "usdt-tether",
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("accepts a coin with variantOf only (no pegReferenceId)", () => {
    const json = [
      {
        id: "fixture-variant-no-peg",
        name: "Fixture Variant No Peg",
        symbol: "FVP",
        flags: baseFlags,
        variantOf: "usdt-tether",
        variantKind: "savings-passthrough",
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("accepts a coin with pegReferenceId only (no variantOf)", () => {
    const json = [
      {
        id: "fixture-peg-only",
        name: "Fixture Peg Only",
        symbol: "FPG",
        flags: baseFlags,
        pegReferenceId: "usdt-tether",
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("rejects a coin where variantOf and pegReferenceId disagree", () => {
    const json = [
      {
        id: "fixture-variant-mismatch",
        name: "Fixture Mismatch",
        symbol: "FMM",
        flags: baseFlags,
        variantOf: "usdt-tether",
        variantKind: "savings-passthrough",
        pegReferenceId: "usdc-circle",
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/pegReferenceId/);
  });
});

// Rule 2 (reserves wrapper depType requires coinId) is NOT enforced in the schema because
// srusd-reservoir has depType "wrapper" without coinId — its wrapped parent (rusd-reservoir)
// is not a tracked coin. Curator fix needed before this invariant can be added.
// See: shared/data/stablecoins/coins/srusd-reservoir.json reserves[0]
describe("StablecoinMeta schema — reserves depType valid cases", () => {
  it("accepts a reserves entry with depType 'wrapper' and coinId set", () => {
    const json = [
      {
        id: "fixture-wrapper-ok",
        name: "Fixture Wrapper OK",
        symbol: "FWO",
        flags: baseFlags,
        reserves: [
          { name: "Parent token shares", pct: 100, risk: "low", coinId: "usdt-tether", depType: "wrapper" },
        ],
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("accepts a reserves entry with depType 'collateral' and no coinId (real-world asset)", () => {
    const json = [
      {
        id: "fixture-collateral-no-coinid",
        name: "Fixture Collateral",
        symbol: "FCC",
        flags: baseFlags,
        reserves: [
          { name: "Tokenized Treasury Bonds", pct: 100, risk: "low", depType: "collateral" },
        ],
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("rejects curated reserves that do not describe a full composition", () => {
    const json = [
      {
        id: "fixture-reserves-partial",
        name: "Fixture Partial Reserves",
        symbol: "FPR",
        flags: baseFlags,
        reserves: [
          { name: "USDC", pct: 40, risk: "low" },
          { name: "Treasuries", pct: 20, risk: "very-low" },
        ],
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/Reserve composition must sum to 100%/);
  });
});

describe("StablecoinMeta schema — real fixture smoke tests", () => {
  const fixtures = [
    "usdt-tether",
    "asusdf-astherus",
    "susds-sky",
    "stusd-stoneyield",
  ];

  for (const fixture of fixtures) {
    it(`parses ${fixture}.json without error`, () => {
      const path = join(__dirname, "../../../../shared/data/stablecoins/coins", `${fixture}.json`);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test reads fixed fixture IDs from the local whitelist.
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      expect(() => parseStablecoinMetaAssets([raw], fixture)).not.toThrow();
    });
  }
});
