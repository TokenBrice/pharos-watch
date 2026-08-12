import { describe, expect, it } from "vitest";
import type { OracleRiskProfile, StablecoinMeta } from "@shared/types";
import { formatOracleDurationSec, formatOraclePct, projectOracleRiskClientSummary } from "../stablecoin-detail-oracle-client";

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
  it("returns null without an oracle risk profile", () => {
    expect(projectOracleRiskClientSummary(coinWith(undefined))).toBeNull();
  });

  it("titles and frames the two price-authority roles apart", () => {
    const collateral = projectOracleRiskClientSummary(
      coinWith({ ...BOLD_LIKE_PROFILE, role: "collateral-pricing" }),
    );
    expect(collateral!.role).toBe("collateral-pricing");
    expect(collateral!.title).toBe("Collateral pricing & liquidation");
    expect(collateral!.roleNote).toContain("collateral behind TEST");

    const feed = projectOracleRiskClientSummary(coinWith({ ...BOLD_LIKE_PROFILE, role: "coin-price-feed" }));
    expect(feed!.role).toBe("coin-price-feed");
    expect(feed!.title).toBe("Price feed");
    expect(feed!.roleNote).toContain("how TEST and the assets behind it are priced");
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
    expect(summary!.branchCount).toBe(2);
    expect(summary!.feedCount).toBe(1);
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
    });
    expect(weth.liquidationDelayLabel).toBe("None");
    // top-level + branch sources merged, deduped by url
    expect(summary!.sources.map((source) => source.url)).toEqual([
      "https://example.com/contracts",
      "https://example.com/docs",
    ]);
  });

  it("tolerates a single-path profile with no branches", () => {
    const summary = projectOracleRiskClientSummary(
      coinWith({ tier: "privileged-internal-pricing", summary: "Internal exchange-rate accounting only." }),
    );
    expect(summary!.branchCount).toBe(0);
    expect(summary!.worstMaxLtvPct).toBeNull();
    expect(summary!.maxLiquidationDelayLabel).toBeNull();
    expect(summary!.confidenceLabel).toBeNull();
    expect(summary!.reviewedAt).toBeNull();
  });

  it("presents a not-applicable liquidation review as neutral and unscored", () => {
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
      tierLabel: "No liquidation oracle · not scored",
      tierToneClass: "border-border/60 bg-muted/30 text-muted-foreground",
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
