import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OracleLiquidationSection } from "../oracle-liquidation-section";
import type { OracleRiskClientSummary } from "@/lib/stablecoin-detail-oracle-client";

const SUMMARY: OracleRiskClientSummary = {
  tier: "redundant-with-failover",
  tierLabel: "Redundant + failover",
  tierToneClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  summary: "External feeds with response validation and per-branch shutdown.",
  confidenceLabel: "Verified",
  reviewedAt: "2026-07-13",
  branchCount: 2,
  feedCount: 1,
  worstMaxLtvPct: 90.9,
  worstMinCrPct: 110,
  maxLiquidationDelayLabel: "None",
  branches: [
    {
      id: "weth",
      label: "WETH branch",
      tierLabel: "Redundant + failover",
      summary: "WETH collateral uses external feeds with last-good-price fallback.",
      debtSharePct: 72,
      feeds: [
        { key: "cl:0", provider: "Chainlink", path: "ETH/USD", chain: "ethereum", heartbeatLabel: "1h", stalenessLabel: "1d" },
      ],
      collateralParameters: [
        { key: "weth:0", asset: "WETH", maxLtvLabel: "90.9%", minCrLabel: "110%", shutdownCrLabel: "150%", note: null },
      ],
      liquidationMechanism: "Immediate Stability Pool offset.",
      liquidationDelayLabel: "None",
      backstop: "Dedicated Stability Pool per branch.",
      fallbackBehavior: null,
      shutdownOrBadDebtBehavior: null,
    },
    {
      id: "wsteth",
      label: "wstETH branch",
      tierLabel: "Redundant + failover",
      summary: "Composed stETH/ETH and ETH/USD feeds.",
      debtSharePct: 28,
      feeds: [],
      collateralParameters: [],
      liquidationMechanism: null,
      liquidationDelayLabel: null,
      backstop: null,
      fallbackBehavior: null,
      shutdownOrBadDebtBehavior: null,
    },
  ],
  sources: [{ label: "Liquity V2 contracts", url: "https://example.com/contracts" }],
};

describe("OracleLiquidationSection", () => {
  it("renders tier badge, facts, branches, and folded detail", () => {
    const html = renderToStaticMarkup(<OracleLiquidationSection summary={SUMMARY} />);
    expect(html).toContain("Oracle &amp; liquidation");
    expect(html).toContain("Redundant + failover");
    expect(html).toContain("per-branch shutdown");
    expect(html).toContain("WETH branch");
    expect(html).toContain("72% of debt");
    expect(html).toContain("90.9%");
    expect(html).toContain("110%");
    expect(html).toContain("ETH/USD");
    expect(html).toContain("1h heartbeat");
    expect(html).toContain("Reviewed 2026-07-13");
    expect(html).toContain("https://example.com/contracts");
    // detail disclosure closed by default (native <details> without open attr)
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
  });

  it("renders nothing without an oracle summary", () => {
    expect(renderToStaticMarkup(<OracleLiquidationSection summary={null} />)).toBe("");
    expect(renderToStaticMarkup(<OracleLiquidationSection />)).toBe("");
  });
});
