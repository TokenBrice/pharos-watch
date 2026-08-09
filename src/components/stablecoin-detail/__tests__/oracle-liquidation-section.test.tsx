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

  it("cuts long profile summaries to a lead behind Read more", () => {
    const longSummary = `${"External feeds with response validation and per-branch shutdown. ".repeat(12)}TAIL-MARKER`;
    const html = renderToStaticMarkup(<OracleLiquidationSection summary={{ ...SUMMARY, summary: longSummary }} />);
    expect(html).toContain("Read more");
    expect(html).not.toContain("TAIL-MARKER"); // collapsed lead only
  });

  it("renders nothing without an oracle summary", () => {
    expect(renderToStaticMarkup(<OracleLiquidationSection summary={null} />)).toBe("");
    expect(renderToStaticMarkup(<OracleLiquidationSection />)).toBe("");
  });

  it("labels the branch list for assistive tech", () => {
    const html = renderToStaticMarkup(<OracleLiquidationSection summary={SUMMARY} />);
    expect(html).toContain('aria-label="Oracle branches"');
  });

  it("shows a diverging branch tier as a kicker but not a matching one", () => {
    const divergentSummary: OracleRiskClientSummary = {
      ...SUMMARY,
      branches: [
        { ...SUMMARY.branches[0]!, tierLabel: "Single-source / laggy" },
        SUMMARY.branches[1]!,
      ],
    };
    const html = renderToStaticMarkup(<OracleLiquidationSection summary={divergentSummary} />);
    expect(html).toContain("Single-source / laggy");
    // Only the module's tier badge should read "Redundant + failover"; the
    // second branch shares that tier with the module summary, so it must not
    // duplicate it as a kicker.
    expect((html.match(/Redundant \+ failover/g) ?? []).length).toBe(1);
  });

  it("appends the liquidation delay to the mechanism line, or renders it standalone", () => {
    const summaryWithDelay: OracleRiskClientSummary = {
      ...SUMMARY,
      branches: [
        { ...SUMMARY.branches[0]!, liquidationMechanism: "Immediate Stability Pool offset.", liquidationDelayLabel: "1h" },
        { ...SUMMARY.branches[1]!, liquidationMechanism: null, liquidationDelayLabel: "None" },
      ],
    };
    const html = renderToStaticMarkup(<OracleLiquidationSection summary={summaryWithDelay} />);
    expect(html).toContain("Immediate Stability Pool offset. · liquidation delay 1h");
    expect(html).toContain("Liquidation delay None");
  });

  it("caps the inline branch list at 6, sorted by debt share, with the rest in the disclosure", () => {
    const manyBranches: OracleRiskClientSummary["branches"] = Array.from({ length: 8 }, (_, index) => ({
      id: `branch-${index}`,
      label: `Branch ${index}`,
      tierLabel: "Redundant + failover",
      summary: `Branch ${index} summary.`,
      debtSharePct: index === 7 ? null : 80 - index * 10,
      feeds: [],
      collateralParameters: [],
      liquidationMechanism: null,
      liquidationDelayLabel: null,
      backstop: null,
      fallbackBehavior: null,
      shutdownOrBadDebtBehavior: null,
    }));
    const manySummary: OracleRiskClientSummary = { ...SUMMARY, branches: manyBranches };
    const html = renderToStaticMarkup(<OracleLiquidationSection summary={manySummary} />);

    const detailsIndex = html.indexOf("<details");
    expect(detailsIndex).toBeGreaterThan(-1);
    const beforeDetails = html.slice(0, detailsIndex);
    for (let index = 0; index < 6; index++) {
      expect(beforeDetails).toContain(`Branch ${index}`);
    }
    expect(beforeDetails).not.toContain("Branch 6");
    expect(beforeDetails).not.toContain("Branch 7");
    expect(html).toContain("+ 2 more branches in the breakdown below");
    // The two overflow branches still render (inside the disclosure).
    expect(html).toContain("Branch 6");
    expect(html).toContain("Branch 7");
  });
});
