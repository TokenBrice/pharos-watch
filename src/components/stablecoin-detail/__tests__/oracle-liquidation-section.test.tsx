// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { CONTROL_COMPONENT_ROLE_LABELS, type ControlComponentRole } from "@shared/lib/classification";
import type { ControlComponentRoles } from "@/lib/pillar-evidence-strips";
import {
  dedupeOracleFeeds,
  type OracleBranchClientRow,
  type OracleRiskClientSummary,
} from "@/lib/stablecoin-detail-oracle-client";
import { OracleLiquidationSection, oracleModuleSize, sortOracleBranchesForDisplay } from "../oracle-liquidation-section";

const ETH_USD_FEED = {
  key: "cl:eth",
  provider: "Chainlink",
  path: "ETH / USD push oracle",
  chain: "ethereum",
  chainLabel: "Ethereum",
  heartbeatLabel: "1h",
  stalenessLabel: "1d",
};

function branch(overrides: Partial<OracleBranchClientRow> & Pick<OracleBranchClientRow, "id" | "label">): OracleBranchClientRow {
  return {
    tier: "redundant-with-failover",
    tierLabel: "Redundant + failover",
    summary: `${overrides.label} review prose.`,
    debtSharePct: null,
    feeds: [],
    collateralParameters: [],
    liquidationMechanism: null,
    liquidationDelayLabel: null,
    backstop: null,
    fallbackBehavior: null,
    shutdownOrBadDebtBehavior: null,
    ...overrides,
  };
}

const BRANCHES: OracleBranchClientRow[] = [
  branch({
    id: "weth",
    label: "WETH branch",
    summary: "WETH collateral uses external feeds with last-good-price fallback.",
    debtSharePct: 72,
    feeds: [ETH_USD_FEED],
    collateralParameters: [
      { key: "weth:0", asset: "WETH", maxLtvLabel: "90.9%", maxLtvPct: 90.9, minCrLabel: "110%", minCrPct: 110, shutdownCrLabel: "150%", shutdownCrPct: 150, note: null },
    ],
    liquidationMechanism: "Immediate Stability Pool offset.",
    liquidationDelayLabel: "None",
    backstop: "Dedicated Stability Pool per branch.",
  }),
  branch({ id: "wsteth", label: "wstETH branch", summary: "Composed stETH/ETH and ETH/USD feeds.", debtSharePct: 28, feeds: [ETH_USD_FEED] }),
  branch({ id: "reth", label: "rETH branch", feeds: [ETH_USD_FEED] }),
];

const FEEDS = dedupeOracleFeeds(BRANCHES);

const SUMMARY: OracleRiskClientSummary = {
  role: "collateral-pricing",
  title: "Collateral pricing & liquidation",
  verdict: "3 branches price collateral from redundant feeds with automatic failover; staleness bound 1d.",
  tier: "redundant-with-failover",
  tierLabel: "Redundant + failover",
  tierToneClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  notApplicable: false,
  notApplicableRationale: null,
  summary: "External feeds with response validation and per-branch shutdown.",
  confidenceLabel: "Verified",
  reviewedAt: "2026-07-13",
  branchCount: BRANCHES.length,
  feedCount: FEEDS.length,
  providers: ["Chainlink"],
  feeds: FEEDS,
  maxStalenessLabel: "1d",
  worstMaxLtvPct: 90.9,
  worstMinCrPct: 110,
  maxLiquidationDelayLabel: "None",
  priceDelayLabel: null,
  branches: BRANCHES,
  sources: [{ label: "Liquity V2 contracts", url: "https://example.com/contracts" }],
};

const PRICE_FEED: OracleRiskClientSummary = {
  ...SUMMARY,
  role: "coin-price-feed",
  title: "Price feed",
  verdict: "USDe mint and redeem quotes rely on a privileged internal price.",
  tier: "privileged-internal-pricing",
  tierLabel: "Privileged internal pricing",
  branchCount: 0,
  feedCount: 0,
  providers: [],
  feeds: [],
  maxStalenessLabel: null,
  worstMaxLtvPct: null,
  worstMinCrPct: null,
  maxLiquidationDelayLabel: null,
  branches: [],
};

const NOT_APPLICABLE: OracleRiskClientSummary = {
  ...PRICE_FEED,
  verdict: null,
  tier: "oracleless",
  tierLabel: "No liquidation oracle · not scored",
  notApplicable: true,
  notApplicableRationale: "Challenge auctions set the collateral price, so no liquidation path reads an external oracle.",
  summary: "Positions use challenge auctions to determine collateral market price.",
};

function rolesWithOracle(role: ControlComponentRole, score: number | null = 45): ControlComponentRoles {
  return {
    minimum: 45,
    evaluatedScore: 45,
    adjusted: false,
    components: [
      {
        key: "oracle",
        label: "Oracle",
        kind: "oracle",
        score,
        posture: "privileged-internal-pricing",
        postureLabel: "Privileged Internal Pricing",
        role,
        tone: "warn",
      },
      {
        key: "mint",
        label: "Mint authority",
        kind: "mint",
        score: 68,
        posture: "bounded-admin",
        postureLabel: "Managed",
        role: "eligible",
        tone: "neutral",
      },
    ],
  };
}

function ladder(container: HTMLElement): Element | null {
  return container.querySelector('[role="img"][aria-label^="Oracle tier"]');
}

function pricePath(container: HTMLElement): Element | null {
  return container.querySelector('[role="img"][aria-label^="Price path"]');
}

describe("oracleModuleSize", () => {
  it("gives two or more branches the full-width module and everything else a tile", () => {
    expect(oracleModuleSize({ branchCount: 0 })).toBe("tile");
    expect(oracleModuleSize({ branchCount: 1 })).toBe("tile");
    expect(oracleModuleSize({ branchCount: 2 })).toBe("module");
    expect(oracleModuleSize({ branchCount: 40 })).toBe("module");
  });

  it("is the layout the module takes when the caller does not choose one", () => {
    const multi = render(<OracleLiquidationSection summary={SUMMARY} />);
    expect(multi.container.querySelector("#oracle")?.getAttribute("data-evidence-module")).toBe("module");
    multi.unmount();
    const single = render(<OracleLiquidationSection summary={PRICE_FEED} />);
    expect(single.container.querySelector("#oracle")?.getAttribute("data-evidence-module")).toBe("tile");
  });
});

describe("OracleLiquidationSection", () => {
  it("renders nothing without an oracle summary", () => {
    expect(render(<OracleLiquidationSection summary={null} />).container.innerHTML).toBe("");
    expect(render(<OracleLiquidationSection />).container.innerHTML).toBe("");
  });

  it("anchors one level-3 module titled by the review's role", () => {
    const { container } = render(<OracleLiquidationSection summary={PRICE_FEED} />);
    const oracleModule = container.querySelector("section#oracle")!;
    expect(oracleModule).not.toBeNull();
    const heading = within(oracleModule as HTMLElement).getByRole("heading", { level: 3 });
    expect(heading.textContent).toContain(PRICE_FEED.title);
    expect(heading.textContent).not.toContain(SUMMARY.title);
  });

  it("tags the oracle component as limiting only when it sits at the Control minimum", () => {
    const limiting = render(<OracleLiquidationSection summary={PRICE_FEED} controlRoles={rolesWithOracle("limiting")} />);
    expect(limiting.container.querySelectorAll('[data-control-role="limiting"]')).toHaveLength(1);
    expect(limiting.container.textContent).toContain(CONTROL_COMPONENT_ROLE_LABELS.limiting);
    limiting.unmount();

    for (const role of ["eligible", "diagnostic"] as const) {
      const view = render(<OracleLiquidationSection summary={PRICE_FEED} controlRoles={rolesWithOracle(role)} />);
      expect(view.container.querySelector('[data-control-role="limiting"]')).toBeNull();
      expect(view.container.textContent).not.toContain(CONTROL_COMPONENT_ROLE_LABELS.limiting);
      view.unmount();
    }
  });

  it("reads a non-binding oracle component as a diagnostic, beside its score", () => {
    const { container } = render(
      <OracleLiquidationSection summary={PRICE_FEED} controlRoles={rolesWithOracle("diagnostic")} />,
    );
    expect(container.querySelector('[data-control-role="diagnostic"]')).not.toBeNull();
    expect(container.textContent).toContain(CONTROL_COMPONENT_ROLE_LABELS.diagnostic);
    expect(container.textContent).toContain("45");
  });

  it("falls back to the review's tier chip without a scored oracle component", () => {
    const withoutCard = render(<OracleLiquidationSection summary={PRICE_FEED} />);
    expect(withoutCard.container.querySelector("[data-control-role]")).toBeNull();
    // Header chip plus the aggregator station.
    expect(withoutCard.getAllByText(PRICE_FEED.tierLabel).length).toBeGreaterThanOrEqual(2);
    withoutCard.unmount();

    const unscored = render(<OracleLiquidationSection summary={PRICE_FEED} controlRoles={rolesWithOracle("excluded", null)} />);
    expect(unscored.container.querySelector("[data-control-role]")).toBeNull();
    expect(unscored.getAllByText(PRICE_FEED.tierLabel).length).toBeGreaterThanOrEqual(2);
  });

  it("lights the scored oracle tier on the published ladder", () => {
    const { container } = render(<OracleLiquidationSection summary={PRICE_FEED} controlRoles={rolesWithOracle("limiting")} />);
    const spectrum = ladder(container);
    expect(spectrum?.getAttribute("aria-label")).toContain("Privileged internal pricing");
    expect(spectrum?.getAttribute("aria-label")).toContain("band 1 of 5");
  });

  it("draws an empty provider list as an undisclosed source station feeding the mint / redeem quote", () => {
    const { container } = render(<OracleLiquidationSection summary={PRICE_FEED} />);
    const path = pricePath(container)!;
    expect(path).not.toBeNull();
    expect(path.getAttribute("aria-label")).toContain("sources undisclosed");
    expect(path.textContent).toContain("Undisclosed");
  });

  it("names the reviewed providers and the liquidation engine for collateral pricing", () => {
    const { container } = render(<OracleLiquidationSection summary={SUMMARY} />);
    const path = pricePath(container)!;
    expect(path.textContent).toContain("Chainlink");
    expect(path.textContent).not.toContain("Undisclosed");
    expect(path.getAttribute("aria-label")).toContain("liquidation engine");
  });

  it("collapses providers past three into one overflow chip", () => {
    const providers = ["Chainlink", "Pyth", "RedStone", "Chronicle", "Tellor"];
    const { container } = render(<OracleLiquidationSection summary={{ ...PRICE_FEED, providers }} />);
    const path = pricePath(container)!;
    expect(path.textContent).toContain("RedStone");
    expect(path.textContent).not.toContain("Chronicle");
    expect(path.textContent).toContain("+2");
    // Every provider stays in the accessible name.
    expect(path.getAttribute("aria-label")).toContain("Tellor");
  });

  it("prints a feed shared by several branches once", () => {
    const { container } = render(<OracleLiquidationSection summary={SUMMARY} />);
    const feeds = container.querySelector('ul[aria-label="Price feeds"]')!;
    expect(feeds.querySelectorAll("li")).toHaveLength(1);
    expect(feeds.textContent).toContain("3 branches");
    expect(feeds.textContent).toContain("Ethereum");
    expect(feeds.textContent).not.toContain("ethereum");
  });

  it("states a not-applicable review as one S14 line, with the rationale behind the closed provenance fold", () => {
    const { container } = render(<OracleLiquidationSection summary={NOT_APPLICABLE} variant="tile" />);
    const oracleModule = container.querySelector("section#oracle")!;
    expect(oracleModule.getAttribute("data-evidence-state")).toBe("not-applicable");
    expect(within(oracleModule as HTMLElement).getByRole("heading", { level: 3, name: NOT_APPLICABLE.title })).toBeTruthy();
    // Nothing to draw: no ladder, no price path, no module body.
    expect(ladder(container)).toBeNull();
    expect(pricePath(container)).toBeNull();
    expect(oracleModule.querySelector("[data-evidence-module]")).toBeNull();
    expect(oracleModule.textContent).toContain("Not applicable");
    expect(oracleModule.textContent?.toLowerCase()).toContain(NOT_APPLICABLE.tierLabel.toLowerCase());
    // The rationale and sources live in the one fold; the review date stays on the line.
    const fold = oracleModule.querySelector("details#oracle-review-notes")!;
    expect(fold.hasAttribute("open")).toBe(false);
    expect(fold.textContent).toContain(NOT_APPLICABLE.notApplicableRationale!);
    expect(fold.querySelector('a[href="https://example.com/contracts"]')).not.toBeNull();
    expect(oracleModule.textContent).toContain("Reviewed 2026-07-13");
  });

  it("keeps the generated verdict in the summary layer and reviewer prose behind the notes fold", () => {
    const { container } = render(<OracleLiquidationSection summary={SUMMARY} />);
    expect(container.textContent).toContain(SUMMARY.verdict!);
    const notesFold = container.querySelector("details#oracle-review-notes")!;
    expect(notesFold).not.toBeNull();
    expect(notesFold.hasAttribute("open")).toBe(false);
    expect(notesFold.textContent).toContain(SUMMARY.summary);
    expect(notesFold.textContent).toContain("WETH collateral uses external feeds");
    expect(notesFold.querySelector('a[href="https://example.com/contracts"]')).not.toBeNull();
  });

  it("orders the folds as domain detail, then review notes and sources, all closed", () => {
    const { container } = render(<OracleLiquidationSection summary={SUMMARY} />);
    const folds = [...container.querySelectorAll("details")];
    expect(folds.map((fold) => fold.id)).toEqual(["oracle-feeds", "oracle-review-notes"]);
    expect(folds.every((fold) => !fold.hasAttribute("open"))).toBe(true);
  });

  it("sorts branches by debt share with unmeasured branches last, preserving curated order on ties", () => {
    const row = (id: string, debtSharePct: number | null) => ({ id, debtSharePct }) as unknown as OracleBranchClientRow;
    const sorted = sortOracleBranchesForDisplay([row("a", null), row("b", 20), row("c", 50), row("d", 20), row("e", null)]);
    expect(sorted.map((entry) => entry.id)).toEqual(["c", "b", "d", "a", "e"]);
  });

  it("tags every branch with its own reviewed tier", () => {
    const divergent: OracleRiskClientSummary = {
      ...SUMMARY,
      branches: [
        { ...BRANCHES[0]!, tier: "single-source-or-laggy", tierLabel: "Single-source / laggy" },
        BRANCHES[1]!,
      ],
      branchCount: 2,
    };
    const { container } = render(<OracleLiquidationSection summary={divergent} />);
    const rows = [...container.querySelectorAll('ul[aria-label="Oracle branches"] > li')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Single-source / laggy");
    expect(rows[1]!.textContent).toContain("Redundant + failover");
  });

  it("prints each branch's reviewed minimum collateral ratio, and a dash where none is reviewed", () => {
    const ranged: OracleRiskClientSummary = {
      ...SUMMARY,
      branches: [
        {
          ...BRANCHES[0]!,
          collateralParameters: [
            { ...BRANCHES[0]!.collateralParameters[0]!, minCrPct: 110 },
            { ...BRANCHES[0]!.collateralParameters[0]!, key: "weth:1", minCrPct: 150 },
          ],
        },
        BRANCHES[1]!,
      ],
      branchCount: 2,
    };
    const { container } = render(<OracleLiquidationSection summary={ranged} />);
    const [ranges, unreviewed] = [...container.querySelectorAll('ul[aria-label="Oracle branches"] > li')];
    expect(ranges!.textContent).toContain("Min CR");
    expect(ranges!.textContent).toContain("110–150%");
    expect(unreviewed!.textContent).toContain("not reviewed");
    expect(unreviewed!.textContent).not.toContain("0%");
  });

  it("falls back to the branches' max LTV when no minimum collateral ratio is reviewed", () => {
    const lending: OracleRiskClientSummary = {
      ...SUMMARY,
      branches: BRANCHES.map((entry) => ({
        ...entry,
        collateralParameters: entry.collateralParameters.map((parameter) => ({ ...parameter, minCrPct: null })),
      })),
    };
    const { container } = render(<OracleLiquidationSection summary={lending} />);
    const rows = [...container.querySelectorAll('ul[aria-label="Oracle branches"] > li')];
    expect(rows[0]!.textContent).toContain("Max LTV");
    expect(rows[0]!.textContent).toContain("90.9%");
    expect(rows[0]!.textContent).not.toContain("Min CR");
  });

  it("drops the share bars when no branch's debt share is measured, and says so", () => {
    const unmeasured: OracleRiskClientSummary = {
      ...SUMMARY,
      branches: BRANCHES.map((entry) => ({ ...entry, debtSharePct: null })),
    };
    const { container } = render(<OracleLiquidationSection summary={unmeasured} />);
    const list = container.querySelector('ul[aria-label="Oracle branches"]')!;
    expect(list.querySelector("[style]")).toBeNull();
    expect(list.textContent).not.toContain("debt share not measured");
    expect(container.textContent).toContain("debt shares not measured");
  });

  it("shows the oracle's price delay and the liquidation delay as separate facts", () => {
    const delayed: OracleRiskClientSummary = { ...SUMMARY, priceDelayLabel: "OSM", maxLiquidationDelayLabel: "None" };
    const { getByRole } = render(<OracleLiquidationSection summary={delayed} />);
    const facts = getByRole("group", { name: `${SUMMARY.title} facts` });
    expect(facts.textContent).toContain("Price delay");
    expect(facts.textContent).toContain("OSM");
    expect(facts.textContent).toContain("Liquidation delay");
    expect(facts.textContent).not.toContain("Liq. delay");
  });

  it("appends the liquidation delay to the mechanism line, or renders it standalone", () => {
    const withDelay: OracleRiskClientSummary = {
      ...SUMMARY,
      branches: [
        { ...BRANCHES[0]!, liquidationMechanism: "Immediate Stability Pool offset.", liquidationDelayLabel: "1h" },
        { ...BRANCHES[1]!, liquidationMechanism: null, liquidationDelayLabel: "None" },
      ],
    };
    const { container } = render(<OracleLiquidationSection summary={withDelay} />);
    const detail = container.querySelector("details#oracle-feeds")!;
    expect(detail.textContent).toContain("Immediate Stability Pool offset. · liquidation delay 1h");
    expect(detail.textContent).toContain("Liquidation delay None");
  });

  it("caps the inline branch rows at 5, sorted by debt share, with the rest in the detail fold", () => {
    const manyBranches = Array.from({ length: 8 }, (_, index) =>
      branch({ id: `branch-${index}`, label: `Branch ${index}`, debtSharePct: index === 7 ? null : 80 - index * 10 }),
    );
    const { container } = render(
      <OracleLiquidationSection summary={{ ...SUMMARY, branches: manyBranches, branchCount: manyBranches.length }} />,
    );
    const inline = container.querySelector('ul[aria-label="Oracle branches"]')!;
    expect([...inline.querySelectorAll(":scope > li")].map((row) => row.textContent)).toEqual([
      expect.stringContaining("Branch 0"),
      expect.stringContaining("Branch 1"),
      expect.stringContaining("Branch 2"),
      expect.stringContaining("Branch 3"),
      expect.stringContaining("Branch 4"),
    ]);
    const overflow = container.querySelector('details#oracle-feeds ul[aria-label="Additional oracle branches"]')!;
    expect(overflow.querySelectorAll(":scope > li")).toHaveLength(3);
    expect(overflow.textContent).toContain("Branch 7");
  });

  it("never draws an unmeasured debt share as a measured one", () => {
    const { container } = render(<OracleLiquidationSection summary={SUMMARY} />);
    const rows = [...container.querySelectorAll('ul[aria-label="Oracle branches"] > li')];
    const unmeasured = rows.find((row) => row.textContent?.includes("rETH branch"))!;
    expect(unmeasured.textContent).not.toMatch(/\d+%/);
    expect(unmeasured.querySelector("[style]")).toBeNull();
  });

  it("rounds debt shares for display", () => {
    const { container } = render(
      <OracleLiquidationSection
        summary={{ ...SUMMARY, branches: [{ ...BRANCHES[0]!, debtSharePct: 33.333333333 }, BRANCHES[1]!], branchCount: 2 }}
      />,
    );
    expect(container.textContent).toContain("33.33% of debt");
  });
});
