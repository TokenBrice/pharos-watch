import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import { formatOracleDurationSec, projectOracleRiskClientSummary } from "../stablecoin-detail-oracle-client";

function coinWith(oracleRisk: unknown): StablecoinMeta {
  return { id: "test-coin", oracleRisk } as unknown as StablecoinMeta;
}

const BOLD_LIKE_PROFILE = {
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

describe("projectOracleRiskClientSummary", () => {
  it("returns null without an oracle risk profile", () => {
    expect(projectOracleRiskClientSummary(coinWith(undefined))).toBeNull();
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
      coinWith({ tier: "oracleless-or-internal", summary: "Internal exchange-rate accounting only." }),
    );
    expect(summary!.branchCount).toBe(0);
    expect(summary!.worstMaxLtvPct).toBeNull();
    expect(summary!.maxLiquidationDelayLabel).toBeNull();
    expect(summary!.confidenceLabel).toBeNull();
    expect(summary!.reviewedAt).toBeNull();
  });
});
