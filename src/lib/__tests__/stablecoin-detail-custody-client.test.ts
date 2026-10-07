// src/lib/__tests__/stablecoin-detail-custody-client.test.ts
import { describe, expect, it } from "vitest";
import type { CustodyProfile, StablecoinMeta } from "@shared/types";
import { findSummaryBudgetViolations } from "@shared/lib/summary-budget";
import {
  formatCustodySharePct,
  isCustodyStructureUndisclosed,
  projectCustodyClientSummary,
  shouldDisplayCustodyModule,
  type CustodyClientSummary,
} from "../stablecoin-detail-custody-client";

function coinWith(custodyProfile: unknown): StablecoinMeta {
  return { id: "test-coin", custodyProfile } as unknown as StablecoinMeta;
}

function project(profile: CustodyProfile): CustodyClientSummary {
  const summary = projectCustodyClientSummary(coinWith(profile));
  expect(summary).not.toBeNull();
  return summary!;
}

const USDC_LIKE_PROFILE: CustodyProfile = {
  providers: [
    { name: "The Bank of New York Mellon", role: "custodian", sharePct: 88, jurisdiction: "United States" },
    { name: "Systemically important and other regulated banks (not individually disclosed)", role: "bank" },
  ],
  segregation: "segregated",
  bankruptcyRemoteness: "contractual-only",
  rehypothecation: "prohibited",
  reviewedAt: "2026-07-17",
  reviewer: "Kimi FIAT-CTRL shard-11",
  confidence: "verified",
  sources: [{ label: "Circle 10-K", url: "https://example.com/10k" }],
  uncertainty: "Bank-level split beyond BNY is not individually disclosed.",
};

/** mTBILL shape: two named custodians, no shares, a reviewed 100 % unknown split. */
const NAMED_WITHOUT_SHARES_PROFILE: CustodyProfile = {
  ...USDC_LIKE_PROFILE,
  providers: [
    { name: "Maerki Baumann & Co. AG", role: "custodian", jurisdiction: "Switzerland" },
    { name: "Ankura Trust Company LLC", role: "other", jurisdiction: "United States" },
  ],
  bankruptcyRemoteness: "structured",
  rehypothecation: "unknown",
  knownUnknownExposurePct: 100,
};

/** USDT shape: one placeholder provider and no established structure fact. */
const USDT_LIKE_PROFILE: CustodyProfile = {
  ...USDC_LIKE_PROFILE,
  providers: [{ name: "Reserve custodians and counterparties (not publicly identified)", role: "other" }],
  segregation: "unknown",
  bankruptcyRemoteness: "unknown",
  rehypothecation: "unknown",
  confidence: "manual-review",
  knownUnknownExposurePct: 100,
};

/** USDe shape: five named custodians, omnibus, contractual-only, rehypothecation unknown. */
const USDE_LIKE_PROFILE: CustodyProfile = {
  ...USDC_LIKE_PROFILE,
  providers: ["Copper", "Ceffu", "Fireblocks", "Anchorage Digital Bank", "Kraken Custody"].map((name) => ({
    name,
    role: "custodian" as const,
  })),
  segregation: "omnibus",
  rehypothecation: "unknown",
};

describe("projectCustodyClientSummary", () => {
  it("returns null without a custody profile or with a malformed providers field", () => {
    expect(projectCustodyClientSummary(coinWith(undefined))).toBeNull();
    expect(projectCustodyClientSummary(coinWith({ sentinel: true }))).toBeNull();
  });

  it("projects named providers with disclosed shares first and keeps placeholders out of the roster", () => {
    const summary = project({ ...USDC_LIKE_PROFILE, providers: [...USDC_LIKE_PROFILE.providers].reverse() });
    expect(summary.providers).toHaveLength(1);
    expect(summary.providers[0]).toMatchObject({
      name: "The Bank of New York Mellon",
      sharePct: 88,
      jurisdiction: "United States",
    });
    expect(summary.unnamedHolders.map((holder) => holder.description)).toEqual([USDC_LIKE_PROFILE.providers[1]!.name]);
    expect(summary.sharesDisclosed).toBe(true);
    expect(summary.confidenceVerified).toBe(true);
    expect(summary.reviewedAt).toBe("2026-07-17");
  });

  it("tells reviewed placeholders apart from named providers with an undisclosed allocation", () => {
    const unnamed = [
      "Reserve custodians and counterparties (not publicly identified)",
      "Custodian(s) not publicly named in the June 2026 report",
      "Undisclosed Australian bank",
      "One or more undisclosed FDIC-insured reserve banks",
      "BlackOpal LiquidStone II FIDC custodian and administrator (unnamed)",
    ];
    const named = [
      "BitGo Trust Company, Inc. (IAUon Final Terms custodian; crypto/fiat custody, allocation undisclosed)",
      "Westpac Banking Corporation",
    ];
    const summary = project({
      ...USDC_LIKE_PROFILE,
      providers: [...unnamed, ...named].map((name) => ({ name, role: "custodian" as const })),
    });
    expect(summary.providers.map((provider) => provider.name)).toEqual(named);
    expect(summary.unnamedHolders.map((holder) => holder.description)).toEqual(unnamed);
  });

  it("keeps raw addresses and trailing qualifiers out of chip names without ever emptying them", () => {
    const summary = project({
      ...USDC_LIKE_PROFILE,
      providers: [
        { name: "Noon sUSN staking vault 0xE24a3DC8896216e9AeE1b8C2d4f2A7d13b5a1c2F", role: "other" },
        { name: "BitGo Trust Company, Inc. (IAUon Final Terms custodian; allocation undisclosed)", role: "custodian" },
        { name: "Undisclosed reserve wallet 0xE24a3DC8896216e9AeE1b8C2d4f2A7d13b5a1c2F (not publicly identified)", role: "other" },
        { name: "(Unnamed)", role: "other" },
      ],
    });
    for (const provider of summary.providers) {
      expect(provider.shortName.length).toBeGreaterThan(0);
      expect(provider.name.startsWith(provider.shortName) || provider.shortName === provider.name).toBe(true);
      expect(provider.shortName).not.toMatch(/0x[0-9a-fA-F]{6,}/);
    }
    expect(summary.providers[1]!.shortName.length).toBeLessThan(summary.providers[1]!.name.length);
    // Unnamed descriptions keep their qualifier (it is the information) but never an address.
    expect(summary.unnamedHolders.map((holder) => holder.description)).toEqual([
      "Undisclosed reserve wallet (not publicly identified)",
      "(Unnamed)",
    ]);
  });

  it("treats named providers without shares as undisclosed shares, not a 100 % undisclosed exposure", () => {
    for (const profile of [NAMED_WITHOUT_SHARES_PROFILE, USDT_LIKE_PROFILE]) {
      const summary = project(profile);
      expect(summary.sharesDisclosed).toBe(false);
      expect(summary.undisclosedSharePct).toBeNull();
      expect(summary.shareSegments).toBeNull();
    }
  });

  it("builds share segments that cover the whole when shares exist, with the undisclosed share last", () => {
    const summary = project({
      ...USDC_LIKE_PROFILE,
      providers: [
        { name: "UMB Bank, N.A.", role: "bank", sharePct: 97.9 },
        { name: "DEKA Bank", role: "bank" },
      ],
      knownUnknownExposurePct: 2.1,
    });
    expect(summary.undisclosedSharePct).toBe(2.1);
    const segments = summary.shareSegments!;
    expect(segments.map((segment) => segment.kind)).toEqual(["provider", "undisclosed"]);
    expect(segments.reduce((total, segment) => total + segment.pct, 0)).toBeCloseTo(100, 6);
  });

  it("quantifies a partial undisclosed share against named providers whose split is not disclosed", () => {
    const summary = project({ ...USDE_LIKE_PROFILE, knownUnknownExposurePct: 69.2 });
    expect(summary.undisclosedSharePct).toBe(69.2);
    const segments = summary.shareSegments!;
    expect(segments.map((segment) => segment.kind)).toEqual(["unsplit", "undisclosed"]);
    expect(segments[0]!.providerKeys).toHaveLength(USDE_LIKE_PROFILE.providers.length);
    expect(segments.reduce((total, segment) => total + segment.pct, 0)).toBeCloseTo(100, 6);
  });

  it("never draws a single segment, and merges providers past the fourth into one segment", () => {
    // A lone provider short of 100 % still has a second, unattributed segment.
    expect(
      project({ ...USDC_LIKE_PROFILE, providers: [USDC_LIKE_PROFILE.providers[0]!] }).shareSegments?.map(
        (segment) => segment.kind,
      ),
    ).toEqual(["provider", "unattributed"]);
    expect(
      project({ ...USDC_LIKE_PROFILE, providers: [{ name: "Westpac Banking Corporation", role: "bank", sharePct: 100 }] })
        .shareSegments,
    ).toBeNull();

    const shares = [40, 20, 15, 10, 8, 7];
    const summary = project({
      ...USDC_LIKE_PROFILE,
      providers: shares.map((sharePct, index) => ({ name: `Bank ${index + 1}`, role: "bank" as const, sharePct })),
    });
    const segments = summary.shareSegments!;
    expect(segments).toHaveLength(5);
    expect(segments.flatMap((segment) => segment.providerKeys).toSorted()).toEqual(
      summary.providers.map((provider) => provider.key).toSorted(),
    );
    expect(segments.reduce((total, segment) => total + segment.pct, 0)).toBeCloseTo(100, 6);
  });

  it("reads the three protection rungs in order, with unknown never drawn as failed", () => {
    expect(project(USDC_LIKE_PROFILE).protection.map((rung) => [rung.key, rung.state])).toEqual([
      ["segregation", "met"],
      ["bankruptcy-remoteness", "partial"],
      ["rehypothecation", "met"],
    ]);
    expect(project(USDE_LIKE_PROFILE).protection.map((rung) => rung.state)).toEqual(["failed", "partial", "unknown"]);
    expect(
      project({ ...USDC_LIKE_PROFILE, segregation: "mixed", bankruptcyRemoteness: "none", rehypothecation: "permitted" })
        .protection.map((rung) => rung.state),
    ).toEqual(["partial", "failed", "failed"]);
  });

  it("reads the header chip off the meter, so it never contradicts a lit rung or a named custodian", () => {
    const postureOf = (overrides: Partial<CustodyProfile>) => project({ ...USDC_LIKE_PROFILE, ...overrides }).postureKey;
    expect(postureOf({})).toBe("segregated");
    expect(postureOf({ bankruptcyRemoteness: "structured" })).toBe("segregated-remote");
    expect(postureOf({ segregation: "mixed" })).toBe("mixed");
    expect(project(USDE_LIKE_PROFILE).postureKey).toBe("omnibus");
    // USTB shape: a named custodian and one established rung.
    expect(
      postureOf({
        providers: [{ name: "The Bank of New York Mellon", role: "custodian" }],
        segregation: "unknown",
        bankruptcyRemoteness: "structured",
        rehypothecation: "unknown",
      }),
    ).toBe("partly-disclosed");
    expect(postureOf({ segregation: "unknown", bankruptcyRemoteness: "unknown", rehypothecation: "unknown" })).toBe(
      "structure-undisclosed",
    );
    expect(project(USDT_LIKE_PROFILE).postureKey).toBe("undisclosed");

    const everyCombination = (["segregated", "mixed", "omnibus", "unknown"] as const).flatMap((segregation) =>
      (["structured", "contractual-only", "none", "unknown"] as const).map((bankruptcyRemoteness) =>
        project({ ...USDC_LIKE_PROFILE, segregation, bankruptcyRemoteness, rehypothecation: "prohibited" })),
    );
    for (const summary of everyCombination) {
      expect(summary.postureLabel).not.toMatch(/^undisclosed$/i);
      expect(summary.postureLabel.length).toBeLessThanOrEqual(30);
    }
  });

  it("states unidentified custodians without repeating the placeholder noun", () => {
    const summary = project(USDT_LIKE_PROFILE);
    expect(summary.summary).not.toContain(USDT_LIKE_PROFILE.providers[0]!.name);
    expect(summary.summary.match(/\breserves?\b/gi) ?? []).toHaveLength(1);
    expect(summary.summary.match(/\bcustodians?\b/gi) ?? []).toHaveLength(1);
  });

  it("names a leading share only when no tie or unknown remainder could exceed it", () => {
    const withProviders = (providers: CustodyProfile["providers"]) =>
      project({ ...USDC_LIKE_PROFILE, providers, rehypothecation: "unknown" }).summary;
    expect(withProviders([{ name: "Minor bank", role: "bank", sharePct: 20 }, { name: "Major bank", role: "bank", sharePct: 80 }]))
      .toContain("80%");
    expect(withProviders([{ name: "First bank", role: "bank" }, { name: "Second bank", role: "bank" }])).not.toMatch(/\d%/);
    expect(withProviders([{ name: "Known minor bank", role: "bank", sharePct: 20 }, { name: "Unallocated bank", role: "bank" }]))
      .not.toMatch(/\d%/);
    expect(withProviders([{ name: "Tied bank", role: "bank", sharePct: 50 }, { name: "Other tied bank", role: "bank", sharePct: 50 }]))
      .not.toMatch(/\d%/);
  });

  it("keeps every generated verdict within the summary budget and free of provider names", () => {
    const longNames = Array.from({ length: 12 }, (_, index) => ({
      name: `Regulated custodian number ${index + 1} holding tokenized treasury fund shares 0x${"ab".repeat(20)}`,
      role: "custodian" as const,
      sharePct: index === 0 ? 45 : 5,
    }));
    const profiles: CustodyProfile[] = [
      USDC_LIKE_PROFILE,
      NAMED_WITHOUT_SHARES_PROFILE,
      USDT_LIKE_PROFILE,
      USDE_LIKE_PROFILE,
      { ...USDC_LIKE_PROFILE, providers: [] as unknown as CustodyProfile["providers"] },
      {
        ...USDC_LIKE_PROFILE,
        providers: [...longNames, { name: "Undisclosed reserve banks", role: "bank" }],
        segregation: "mixed",
        rehypothecation: "conditional",
      },
      { ...USDC_LIKE_PROFILE, segregation: "unknown", bankruptcyRemoteness: "structured" },
    ];
    for (const profile of profiles) {
      const summary = project(profile);
      expect(findSummaryBudgetViolations(summary.summary)).toEqual([]);
      for (const provider of summary.providers) expect(summary.summary).not.toContain(provider.shortName);
    }
  });

  it("dedupes sources by url", () => {
    const summary = project({
      ...USDC_LIKE_PROFILE,
      sources: [
        { label: "Circle 10-K", url: "https://example.com/10k" },
        { label: "Circle 10-K (mirror)", url: "https://example.com/10k" },
      ],
    });
    expect(summary.sources).toEqual([{ label: "Circle 10-K", url: "https://example.com/10k" }]);
  });
});

describe("isCustodyStructureUndisclosed", () => {
  it("is true only when none of the three structure facts is established", () => {
    expect(isCustodyStructureUndisclosed(project(USDT_LIKE_PROFILE))).toBe(true);
    expect(isCustodyStructureUndisclosed(project({ ...USDT_LIKE_PROFILE, rehypothecation: "prohibited" }))).toBe(false);
    expect(isCustodyStructureUndisclosed(project(USDE_LIKE_PROFILE))).toBe(false);
  });
});

describe("formatCustodySharePct", () => {
  it("prints at most one decimal, drops a trailing zero and never rounds a positive share to zero", () => {
    expect(formatCustodySharePct(97.5)).toBe("97.5%");
    expect(formatCustodySharePct(100)).toBe("100%");
    expect(formatCustodySharePct(92.5059)).toBe("92.5%");
    expect(formatCustodySharePct(0.00002927)).toBe("<0.1%");
    expect(formatCustodySharePct(0)).toBe("0%");
  });
});

describe("shouldDisplayCustodyModule", () => {
  it("shows the module for an explicit centralized custodyModel even on a cdp archetype", () => {
    expect(shouldDisplayCustodyModule({ custodyModel: "institutional-regulated" }, "cdp")).toBe(true);
  });

  it("hides the module for an explicit onchain custodyModel even on a fiat-cash archetype", () => {
    expect(shouldDisplayCustodyModule({ custodyModel: "onchain" }, "fiat-cash")).toBe(false);
  });

  it("hides the module for a cdp archetype with no explicit custodyModel", () => {
    expect(shouldDisplayCustodyModule({ custodyModel: undefined }, "cdp")).toBe(false);
  });

  it("hides the module for an algorithmic archetype with no explicit custodyModel", () => {
    expect(shouldDisplayCustodyModule({ custodyModel: undefined }, "algorithmic")).toBe(false);
  });

  it("shows the module for a fiat-cash archetype with no explicit custodyModel", () => {
    expect(shouldDisplayCustodyModule({ custodyModel: undefined }, "fiat-cash")).toBe(true);
  });

  it("shows the module for a null archetype with no explicit custodyModel", () => {
    expect(shouldDisplayCustodyModule({ custodyModel: undefined }, null)).toBe(true);
  });
});
