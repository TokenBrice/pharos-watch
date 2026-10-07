import { describe, expect, it } from "vitest";
import type { OracleRiskProfile, StablecoinMeta } from "@shared/types";
import { ORACLE_RISK_TIER_VALUES } from "@shared/types/core";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { findSummaryBudgetViolations } from "@shared/lib/summary-budget";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import {
  buildOracleVerdict,
  dedupeOracleFeeds,
  formatOracleDurationSec,
  formatOraclePct,
  ORACLE_TIER_POLICY_BANDS,
  projectOracleRiskClientSummary,
  resolveOracleTierLadder,
  type OracleBranchClientRow,
} from "../stablecoin-detail-oracle-client";

function coinWith(oracleRisk: unknown, extra: Record<string, unknown> = {}): StablecoinMeta {
  return { id: "test-coin", symbol: "TEST", oracleRisk, ...extra } as unknown as StablecoinMeta;
}

const BOLD_LIKE_PROFILE: OracleRiskProfile = {
  tier: "redundant-with-failover",
  summary: "External feeds with response validation, last-good-price handling, and per-branch shutdown.",
  branchModel: "multi-branch",
  confidence: "verified",
  reviewedAt: "2026-07-13",
  sources: [{ label: "Liquity V2 contracts", url: "https://example.com/contracts" }],
  branches: [
    {
      id: "weth",
      label: "WETH branch",
      tier: "redundant-with-failover",
      summary: "WETH collateral uses external feeds with last-good-price fallback.",
      debtSharePct: 72,
      feeds: [
        { provider: "Chainlink", path: "ETH/USD", chain: "ethereum", heartbeatSec: 3600, stalenessBoundSec: 86400 },
      ],
      collateralParameters: [
        { asset: "WETH", maximumLtvPct: 90.9, minimumCollateralRatioPct: 110, shutdownCollateralRatioPct: 150 },
      ],
      liquidationMechanism: "Immediate Stability Pool offset.",
      liquidationDelaySec: 0,
      backstop: "Dedicated Stability Pool per branch.",
      sources: [{ label: "Liquity V2 docs", url: "https://example.com/docs" }],
    },
    {
      id: "wsteth",
      label: "wstETH branch",
      tier: "redundant-with-failover",
      summary: "Composed stETH/ETH and ETH/USD feeds.",
      debtSharePct: 28,
      collateralParameters: [{ asset: "wstETH", minimumCollateralRatioPct: 120 }],
    },
  ],
};

describe("formatOracleDurationSec", () => {
  it("formats durations at natural units", () => {
    expect(formatOracleDurationSec(0)).toBe("None");
    expect(formatOracleDurationSec(45)).toBe("45s");
    expect(formatOracleDurationSec(300)).toBe("5m");
    expect(formatOracleDurationSec(3600)).toBe("1h");
    expect(formatOracleDurationSec(86400)).toBe("1d");
    expect(formatOracleDurationSec(null)).toBeNull();
    expect(formatOracleDurationSec(undefined)).toBeNull();
  });
});

describe("formatOraclePct", () => {
  it("rounds to at most 2 decimals and trims trailing zeros", () => {
    expect(formatOraclePct(66.6667)).toBe("66.67%");
    expect(formatOraclePct(110)).toBe("110%");
    expect(formatOraclePct(90.9)).toBe("90.9%");
  });
});

describe("projectOracleRiskClientSummary", () => {
  it("uses explicit pricing paths rather than an aggregate no-oracle disposition to identify borrower risk", () => {
    const summary = projectOracleRiskClientSummary(coinWith({
      ...BOLD_LIKE_PROFILE,
      branchModel: "single-path",
      branches: undefined,
      branchApplicability: {
        disposition: "not-applicable", reviewedAt: "2026-10-01", reviewer: "test",
        rationale: "Aggregate disposition must not override explicit pricing paths.",
        sources: [{ label: "Docs", url: "https://example.com/docs" }],
      },
      paths: [{
        id: "market", chain: "ethereum", address: "0x1111111111111111111111111111111111111111",
        pricingAuthority: "external-price", branchId: "weth",
        applicability: {
          disposition: "branches-required", reviewedAt: "2026-10-01", reviewer: "test", confidence: "verified",
          rationale: "This exact market consumes borrower collateral prices.",
          sources: [{ label: "Market source", url: "https://example.com/market" }],
        },
      }],
    }));
    expect(summary!.role).toBe("collateral-pricing");
    expect(summary!.sources).toContainEqual({ label: "Market source", url: "https://example.com/market" });
  });

  it("returns null without an oracle risk profile", () => {
    expect(projectOracleRiskClientSummary(coinWith(undefined))).toBeNull();
  });

  it("titles the two price-authority roles apart and frames the verdict by who reads the price", () => {
    const collateral = projectOracleRiskClientSummary(
      coinWith({ ...BOLD_LIKE_PROFILE, role: "collateral-pricing" }),
    );
    expect(collateral!.role).toBe("collateral-pricing");
    expect(collateral!.title).toBe("Collateral pricing & liquidation");
    expect(collateral!.verdict).toContain("collateral");

    const feed = projectOracleRiskClientSummary(coinWith({ ...BOLD_LIKE_PROFILE, role: "coin-price-feed" }));
    expect(feed!.role).toBe("coin-price-feed");
    expect(feed!.title).toBe("Price feed");
    expect(feed!.verdict).toContain("TEST");
  });

  it("generates verdicts that differ by tier and stay inside the summary budget", () => {
    const verdicts = ORACLE_RISK_TIER_VALUES.flatMap((tier) =>
      (["coin-price-feed", "collateral-pricing"] as const).map((role) =>
        buildOracleVerdict({ role, tier, symbol: "USDe", branchCount: 3, maxStalenessLabel: "2d", stalenessBoundCount: 2 }),
      ),
    );
    for (const verdict of verdicts) expect(findSummaryBudgetViolations(verdict)).toEqual([]);
    expect(new Set(verdicts).size).toBe(verdicts.length);
  });

  it("adds the staleness clause only when a bound is reviewed", () => {
    const base = { role: "coin-price-feed", tier: "standard-external", symbol: "TEST", branchCount: 0 } as const;
    const without = buildOracleVerdict({ ...base, maxStalenessLabel: null, stalenessBoundCount: 0 });
    const withBound = buildOracleVerdict({ ...base, maxStalenessLabel: "1d", stalenessBoundCount: 1 });
    expect(without).not.toContain("1d");
    expect(withBound).toContain("1d");
    expect(withBound.startsWith(without.slice(0, -1))).toBe(true);
  });

  it("falls back to the curated backfill rule when a profile omits role", () => {
    const branched = projectOracleRiskClientSummary(
      coinWith({
        ...BOLD_LIKE_PROFILE,
        branchApplicability: {
          disposition: "branches-required",
          reviewedAt: "2026-07-13",
          reviewer: "test",
          rationale: "Borrower collateral branches reviewed.",
          sources: [{ label: "docs", url: "https://example.com/docs" }],
        },
      }),
    );
    expect(branched!.role).toBe("collateral-pricing");

    // Unresolved branch applicability on a crypto-backed CDP still prices collateral.
    const unresolvedCdp = projectOracleRiskClientSummary(
      coinWith({ tier: "standard-external", summary: "Vaults receive collateral prices from a median feed." }, {
        mechanismArchetype: "cdp",
        flags: { backing: "crypto-backed" },
      }),
    );
    expect(unresolvedCdp!.role).toBe("collateral-pricing");

    const notApplicable = projectOracleRiskClientSummary(
      coinWith(
        {
          tier: "oracleless",
          summary: "No borrower debt market prices collateral for liquidation.",
          branchApplicability: {
            disposition: "not-applicable",
            reviewedAt: "2026-07-13",
            reviewer: "test",
            rationale: "No borrower liquidation market exists.",
            sources: [{ label: "docs", url: "https://example.com/docs" }],
          },
        },
        { mechanismArchetype: "cdp", flags: { backing: "crypto-backed" } },
      ),
    );
    expect(notApplicable!.role).toBe("coin-price-feed");
  });

  it("projects branches, feeds, parameters, and aggregates", () => {
    const summary = projectOracleRiskClientSummary(coinWith(BOLD_LIKE_PROFILE));
    expect(summary).not.toBeNull();
    expect(summary!.tierLabel).toBe("Redundant + failover");
    expect(summary!.notApplicable).toBe(false);
    expect(summary!.branchCount).toBe(2);
    expect(summary!.feedCount).toBe(1);
    expect(summary!.providers).toEqual(["Chainlink"]);
    expect(summary!.feeds[0]).toMatchObject({ chainLabel: "Ethereum", branchLabels: ["WETH branch"] });
    expect(summary!.maxStalenessLabel).toBe("1d");
    expect(summary!.worstMaxLtvPct).toBe(90.9);
    expect(summary!.worstMinCrPct).toBe(110);
    expect(summary!.maxLiquidationDelayLabel).toBe("None");
    const weth = summary!.branches[0]!;
    expect(weth.debtSharePct).toBe(72);
    expect(weth.feeds[0]).toMatchObject({
      provider: "Chainlink",
      path: "ETH/USD",
      chain: "ethereum",
      heartbeatLabel: "1h",
      stalenessLabel: "1d",
    });
    expect(weth.collateralParameters[0]).toMatchObject({
      asset: "WETH",
      maxLtvLabel: "90.9%",
      minCrLabel: "110%",
      shutdownCrLabel: "150%",
      minCrPct: 110,
      shutdownCrPct: 150,
    });
    // A branch that reviews no shutdown ratio carries a null figure, never zero.
    expect(summary!.branches[1]!.collateralParameters[0]).toMatchObject({ minCrPct: 120, shutdownCrPct: null });
    expect(weth.liquidationDelayLabel).toBe("None");
    // top-level + branch sources merged, deduped by url
    expect(summary!.sources.map((source) => source.url)).toEqual([
      "https://example.com/contracts",
      "https://example.com/docs",
    ]);
  });

  it("aggregates the worst later branch instead of the first", () => {
    const summary = projectOracleRiskClientSummary(coinWith({
      ...BOLD_LIKE_PROFILE,
      branches: [
        { ...BOLD_LIKE_PROFILE.branches![0], liquidationDelaySec: 60,
          collateralParameters: [{ asset: "WETH", maximumLtvPct: 75, minimumCollateralRatioPct: 140 }] },
        { ...BOLD_LIKE_PROFILE.branches![1], liquidationDelaySec: 3600,
          collateralParameters: [{ asset: "wstETH", maximumLtvPct: 90, minimumCollateralRatioPct: 110 }] },
      ],
    }));
    expect(summary).toMatchObject({ worstMaxLtvPct: 90, worstMinCrPct: 110, maxLiquidationDelayLabel: "1h" });
  });

  it("omits zero feed timings but preserves instant liquidation", () => {
    const summary = projectOracleRiskClientSummary(coinWith({
      ...BOLD_LIKE_PROFILE,
      branches: [{ ...BOLD_LIKE_PROFILE.branches![0],
        feeds: [{ provider: "Chainlink", path: "ETH/USD", chain: "ethereum", heartbeatSec: 0, stalenessBoundSec: 0 }],
        liquidationDelaySec: 0,
      }],
    }));
    expect(summary!.branches[0].feeds[0]).toMatchObject({ heartbeatLabel: null, stalenessLabel: null });
    expect(summary!.branches[0].liquidationDelayLabel).toBe("None");
    expect(summary!.maxLiquidationDelayLabel).toBe("None");
  });

  it("separates the oracle's own price delay from the liquidation delay", () => {
    const osm = projectOracleRiskClientSummary(coinWith({
      ...BOLD_LIKE_PROFILE,
      tier: "medianized-with-delay",
      branches: [{
        ...BOLD_LIKE_PROFILE.branches![0],
        tier: "medianized-with-delay",
        feeds: [{ provider: "Sky whitelisted oracle set", path: "Median -> OSM -> Spot -> Vat", chain: "ethereum" }],
        liquidationDelaySec: 0,
      }],
    }));
    expect(osm).toMatchObject({ priceDelayLabel: "OSM", maxLiquidationDelayLabel: "None" });
    expect(osm!.verdict).toContain("price delay");

    const median = projectOracleRiskClientSummary(coinWith({
      tier: "medianized-with-delay",
      summary: "Witness median over a history window.",
    }));
    expect(median!.priceDelayLabel).toBe("Yes");

    const partial = projectOracleRiskClientSummary(coinWith({
      ...BOLD_LIKE_PROFILE,
      branches: [
        { ...BOLD_LIKE_PROFILE.branches![0], tier: "medianized-with-delay" },
        BOLD_LIKE_PROFILE.branches![1],
      ],
    }));
    expect(partial!.priceDelayLabel).toBe("1 of 2 branches");

    expect(projectOracleRiskClientSummary(coinWith(BOLD_LIKE_PROFILE))!.priceDelayLabel).toBeNull();
  });

  it("carries each branch's own tier, reading an unrecognised one as opaque", () => {
    const summary = projectOracleRiskClientSummary(coinWith({
      ...BOLD_LIKE_PROFILE,
      branches: [
        { ...BOLD_LIKE_PROFILE.branches![0], tier: "single-source-or-laggy" },
        { ...BOLD_LIKE_PROFILE.branches![1], tier: "bespoke-tier" },
      ],
    }));
    expect(summary!.branches.map((entry) => entry.tier)).toEqual(["single-source-or-laggy", "opaque-or-unknown"]);
    expect(summary!.branches[0]!.collateralParameters[0]).toMatchObject({ maxLtvPct: 90.9 });
    expect(summary!.branches[1]!.collateralParameters[0]).toMatchObject({ maxLtvPct: null });
  });

  it("reads a missing or unrecognised tier as opaque / unknown instead of crashing", () => {
    const summary = projectOracleRiskClientSummary(coinWith({
      summary: "Tier not recorded in this fixture.",
      branches: [{ ...BOLD_LIKE_PROFILE.branches![0], tier: undefined }],
    }));
    expect(summary!.tier).toBe("opaque-or-unknown");
    expect(summary!.tierLabel).toBe("Opaque / unknown");
    expect(summary!.branches[0]!.tierLabel).toBe("Opaque / unknown");
    expect(findSummaryBudgetViolations(summary!.verdict!)).toEqual([]);

    const bespoke = projectOracleRiskClientSummary(coinWith({ ...BOLD_LIKE_PROFILE, tier: "bespoke-tier" }));
    expect(bespoke!.tierLabel).toBe("Opaque / unknown");
  });

  it("tolerates a single-path profile with no branches", () => {
    const summary = projectOracleRiskClientSummary(
      coinWith({ tier: "privileged-internal-pricing", summary: "Internal exchange-rate accounting only." }),
    );
    expect(summary!.branchCount).toBe(0);
    expect(summary!.providers).toEqual([]);
    expect(summary!.feeds).toEqual([]);
    expect(summary!.maxStalenessLabel).toBeNull();
    expect(summary!.worstMaxLtvPct).toBeNull();
    expect(summary!.maxLiquidationDelayLabel).toBeNull();
    expect(summary!.confidenceLabel).toBeNull();
    expect(summary!.reviewedAt).toBeNull();
    expect(findSummaryBudgetViolations(summary!.verdict!)).toEqual([]);
  });

  it("presents a not-applicable liquidation review as neutral and unscored, carrying the reviewer's reason", () => {
    const summary = projectOracleRiskClientSummary(
      coinWith({
        tier: "oracleless",
        summary: "No liquidation oracle is needed.",
        branchApplicability: {
          disposition: "not-applicable",
          reviewedAt: "2026-08-11",
          reviewer: "test",
          rationale: "This asset has no price-sensitive liquidation path.",
          sources: [{ label: "Docs", url: "https://example.com/docs" }],
        },
      }),
    );

    expect(summary).toMatchObject({
      notApplicable: true,
      notApplicableRationale: "This asset has no price-sensitive liquidation path.",
      verdict: null,
      tierToneClass: SEVERITY_TONE_CLASS.neutral.pill,
    });
  });

  it("rounds collateral-parameter percentage labels while keeping the numeric worst-case fields exact", () => {
    const summary = projectOracleRiskClientSummary(
      coinWith({
        ...BOLD_LIKE_PROFILE,
        branches: [
          {
            ...BOLD_LIKE_PROFILE.branches![0]!,
            collateralParameters: [
              { asset: "WETH", maximumLtvPct: 66.6667, minimumCollateralRatioPct: 110 },
            ],
          },
        ],
      }),
    );
    expect(summary!.branches[0]!.collateralParameters[0]).toMatchObject({
      maxLtvLabel: "66.67%",
      minCrLabel: "110%",
    });
    expect(summary!.worstMaxLtvPct).toBe(66.6667);
  });

  it("dedupes merged sources by url", () => {
    const summary = projectOracleRiskClientSummary(
      coinWith({
        ...BOLD_LIKE_PROFILE,
        sources: [{ label: "Liquity V2 contracts", url: "https://example.com/contracts" }],
        branches: [
          {
            ...BOLD_LIKE_PROFILE.branches![0]!,
            sources: [{ label: "Mirror", url: "https://example.com/contracts" }],
          },
        ],
      }),
    );
    expect(summary!.sources).toEqual([{ label: "Liquity V2 contracts", url: "https://example.com/contracts" }]);
  });
});

describe("dedupeOracleFeeds", () => {
  const feed = (overrides: Partial<OracleBranchClientRow["feeds"][number]> = {}) => ({
    key: "k",
    provider: "Chainlink",
    path: "ETH / USD push oracle",
    chain: "ethereum",
    chainLabel: "Ethereum",
    heartbeatLabel: "1h",
    stalenessLabel: "1d",
    ...overrides,
  });
  const branch = (label: string, feeds: OracleBranchClientRow["feeds"]) =>
    ({ id: label, label, feeds }) as unknown as OracleBranchClientRow;

  it("prints a feed shared by several branches once, naming every branch that reads it", () => {
    const rows = dedupeOracleFeeds([
      branch("WETH branch", [feed()]),
      branch("wstETH branch", [feed({ path: "stETH / USD push oracle" }), feed()]),
      branch("rETH branch", [feed()]),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.branchLabels).toEqual(["WETH branch", "wstETH branch", "rETH branch"]);
    expect(rows[1]!.branchLabels).toEqual(["wstETH branch"]);
  });

  it("keeps feeds apart when their timings differ", () => {
    const rows = dedupeOracleFeeds([branch("A", [feed()]), branch("B", [feed({ heartbeatLabel: "1d" })])]);
    expect(rows).toHaveLength(2);
  });
});

describe("oracle tier ladder", () => {
  const quality = V9_CANDIDATE_POLICY_V1.policy.semantic.control.oracleTierQuality;

  it("bands every published tier once, in ascending policy quality, tied tiers together", () => {
    const banded = ORACLE_TIER_POLICY_BANDS.flatMap((band) => band.tiers);
    expect([...banded].sort()).toEqual([...ORACLE_RISK_TIER_VALUES].sort());
    for (const band of ORACLE_TIER_POLICY_BANDS) {
      for (const tier of band.tiers) expect(quality[tier]).toBe(band.quality);
    }
    const qualities = ORACLE_TIER_POLICY_BANDS.map((band) => band.quality);
    expect(qualities).toEqual([...new Set(qualities)].sort((a, b) => a - b));
  });

  it("lights the band holding the tier and names its tied siblings", () => {
    const ladder = resolveOracleTierLadder("single-source-or-laggy")!;
    expect(ladder.position).toBe(1);
    expect(ladder.bands).toHaveLength(ORACLE_TIER_POLICY_BANDS.length);
    expect(ladder.tiedTierLabels).toEqual(["Privileged internal pricing", "Opaque / unknown"]);
    expect(resolveOracleTierLadder("oracleless")!.position).toBe(ORACLE_TIER_POLICY_BANDS.length);
    expect(resolveOracleTierLadder("redundant-with-failover")!.tiedTierLabels).toEqual([]);
  });

  it("lights an opaque tier on the lowest band in neutral, never in a healthy hue", () => {
    const ladder = resolveOracleTierLadder("opaque-or-unknown")!;
    expect(ladder.position).toBe(1);
    const lit = ladder.bands.find((band) => band.key === ladder.activeKey)!;
    expect(lit.fillClass).toBe(SEVERITY_TONE_CLASS.neutral.bar);
    expect(lit.fillClass).not.toBe(SEVERITY_TONE_CLASS.ok.bar);
  });

  it("gives every band a one-word narrow label, never a joined list of tier names", () => {
    for (const tier of ORACLE_RISK_TIER_VALUES) {
      const ladder = resolveOracleTierLadder(tier)!;
      for (const band of ladder.bands) {
        expect(band.shortLabel).not.toContain("/");
        expect(band.shortLabel.split(" ").length).toBeLessThanOrEqual(2);
      }
      const lit = ladder.bands.find((band) => band.key === ladder.activeKey)!;
      // The wide label names the lit tier in full.
      expect(lit.label).toBe(projectOracleRiskClientSummary(coinWith({ tier, summary: "Fixture tier summary." }))!.tierLabel);
    }
  });

  it("draws no ladder for a value outside the published tiers", () => {
    expect(resolveOracleTierLadder("bespoke-tier")).toBeNull();
  });
});
