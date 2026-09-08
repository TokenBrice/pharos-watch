// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { MechanismArchetype } from "@shared/types";
import { mechanismDiagramFor, type MechanismDiagramOptions } from "@/components/stablecoin-detail/mechanism-diagrams";
import { VerticalThreeStepDiagram } from "@/components/stablecoin-detail/mechanism-diagrams/vertical-three-step-diagram";


interface RenderedDiagram {
  container: HTMLElement;
  desktopSvg: SVGSVGElement;
  mobileSvg: SVGSVGElement;
}

/** Every return/loop caption an archetype can draw, used for absence checks. */
const RETURN_CAPTIONS = [
  "redeem",
  "or liquidated",
  "reflexive collapse",
  "quarterly redemption",
  "physical delivery",
  "funding",
  "carry",
] as const;

function renderDiagram(
  archetype: MechanismArchetype,
  symbol: string,
  options?: MechanismDiagramOptions,
): RenderedDiagram {
  const node = mechanismDiagramFor(archetype, symbol, options);
  expect(node).not.toBeNull();
  const { container } = render(<>{node}</>);
  const svgs = container.querySelectorAll("svg[role='img']");
  expect(svgs).toHaveLength(2);
  return {
    container,
    desktopSvg: svgs[0] as SVGSVGElement,
    mobileSvg: svgs[1] as SVGSVGElement,
  };
}

/** One variant's own captions — the desktop copy cannot stand in for mobile. */
function textNodes(svg: SVGSVGElement): string[] {
  return Array.from(svg.querySelectorAll("text")).map((node) => node.textContent ?? "");
}

function expectText(container: HTMLElement, labels: readonly string[]) {
  for (const label of labels) {
    expect(container.textContent).toContain(label);
  }
}

/** Each expected caption appears, and appears after the previous one. */
function expectSequence(nodes: readonly string[], expected: readonly string[]) {
  let cursor = -1;
  for (const label of expected) {
    const index = nodes.findIndex((text, position) => position > cursor && text.includes(label));
    expect(index, `caption "${label}" after position ${cursor}`).toBeGreaterThan(cursor);
    cursor = index;
  }
}

type MechanismDiagramCase = {
  archetype: MechanismArchetype;
  symbol: string;
  ariaPhrase: string;
  descPhrase: string;
  steps: readonly string[];
  desktopSteps?: readonly string[];
  returnCaption: string | null;
  stress: string;
};

const ARCHETYPE_CASES = [
  {
    archetype: "fiat-cash",
    symbol: "USDC",
    ariaPhrase: "custodied 1:1, redeemable on demand",
    descPhrase: "custodies the dollars in cash, repos",
    steps: ["User USD", "wire / ACH", "Issuer reserves", "custodied 1:1", "USDC minted", "redeem any time"],
    returnCaption: "redeem",
    stress: "stress: banking-rail freeze (USDC, Mar 2023)",
  },
  {
    archetype: "tbill",
    symbol: "USDC",
    ariaPhrase: "units accrue NAV daily",
    descPhrase: "NAV accrues daily from the underlying yield",
    steps: [
      "Investor cash",
      "subscribed via fund",
      "T-Bills + Repos",
      "short-duration RWA",
      "USDC units",
      "NAV accrues daily",
    ],
    // NAV-accreting fund shares are drawn without a redemption loop.
    returnCaption: null,
    stress: "stress: instant-redemption cap / stablecoin-rail constraint",
  },
  {
    archetype: "cdp",
    symbol: "USDC",
    ariaPhrase: "liquidated if collateral falls below the safety ratio",
    descPhrase: "mints USDC as debt against the collateral",
    steps: [
      "Crypto collateral",
      "overcollateralized",
      "Vault / PSM",
      "mint debt vs collateral",
      "USDC minted",
      "liquidates below ratio",
    ],
    returnCaption: "or liquidated",
    stress: "stress: collateral cascade (DAI, Mar 2020)",
  },
  {
    archetype: "synthetic-delta-neutral",
    symbol: "USDC",
    ariaPhrase: "hedged with equal short perp positions",
    descPhrase: "funding rate paid by perp longs flows to USDC holders",
    steps: [
      "Crypto deposit",
      "spot collateral",
      "Long spot + short perp",
      "delta-neutral hedge",
      "USDC minted",
      "funding-rate yield",
    ],
    // The desktop box splits the hedge into its two legs; the mobile stack
    // states the combined step instead, so each variant is read separately.
    desktopSteps: [
      "Crypto deposit",
      "spot collateral",
      "Long spot",
      "Short perp",
      "USDC minted",
      "funding-rate yield",
    ],
    returnCaption: "funding",
    stress: "stress: funding-rate inversion",
  },
  {
    archetype: "algorithmic",
    symbol: "USDC",
    ariaPhrase: "no 1:1 reserve backing",
    descPhrase: "defends the peg through arbitrage incentives",
    steps: [
      "Burn governance token",
      "algorithmic mint",
      "Mint/burn AMO",
      "defends peg via arbitrage",
      "USDC minted",
      "no 1:1 backing",
    ],
    returnCaption: "reflexive collapse",
    stress: "stress: reflexive collapse (UST, May 2022)",
  },
  {
    archetype: "rwa-credit-fund",
    symbol: "ACRED",
    ariaPhrase: "quarterly redemption gates",
    descPhrase: "private credit, CLOs, or structured debt",
    steps: [
      "Investor cash",
      "subscribed via fund (KYC)",
      "Private credit / CLO",
      "credit risk, illiquid",
      "ACRED fund-share",
      "NAV reflects credit losses",
    ],
    returnCaption: "quarterly redemption",
    stress: "stress: NAV markdown / quarterly gate",
  },
  {
    archetype: "commodity-claim",
    symbol: "XAUT",
    ariaPhrase: "title claim on numbered bars",
    descPhrase: "allocates specific numbered bars in a named vault",
    steps: [
      "Buyer funds",
      "metal purchased",
      "Allocated vault",
      "numbered bars, segregated",
      "XAUT minted",
      "title to specific metal",
    ],
    returnCaption: "physical delivery",
    stress: "stress: vault or title failure; whole-bar redemption minimums",
  },
] as const satisfies ReadonlyArray<MechanismDiagramCase>;

describe("mechanismDiagramFor", () => {
  it.each(ARCHETYPE_CASES)("states the $archetype mechanism in both variants", (testCase: MechanismDiagramCase) => {
    const diagram = renderDiagram(testCase.archetype, testCase.symbol);
    const desktopNodes = textNodes(diagram.desktopSvg);
    const mobileNodes = textNodes(diagram.mobileSvg);

    // One accessible description, shared by both variants.
    const ariaLabel = diagram.desktopSvg.getAttribute("aria-label");
    expect(ariaLabel).toContain(testCase.ariaPhrase);
    expect(diagram.mobileSvg.getAttribute("aria-label")).toBe(ariaLabel);
    const description = diagram.desktopSvg.querySelector("desc")?.textContent;
    expect(description).toContain(testCase.descPhrase);
    expect(diagram.mobileSvg.querySelector("desc")?.textContent).toBe(description);

    // Each variant carries the whole step sequence in order on its own, so a
    // dropped mobile override cannot hide behind the desktop copy.
    expectSequence(desktopNodes, testCase.desktopSteps ?? testCase.steps);
    expectSequence(mobileNodes, testCase.steps);

    if (testCase.returnCaption) {
      expect(desktopNodes).toContain(testCase.returnCaption);
    } else {
      expect(desktopNodes.filter((text) => RETURN_CAPTIONS.includes(text as never))).toEqual([]);
    }
    // The stress footnote is desktop chrome outside both SVGs.
    expect(diagram.container.querySelector("p")?.textContent).toBe(testCase.stress);
  });

  it("marks the algorithmic variant with the danger tone, not just a dash pattern", () => {
    const algorithmic = renderDiagram("algorithmic", "USDC");
    const dangerFilled = Array.from(algorithmic.desktopSvg.querySelectorAll("rect")).filter((rect) =>
      (rect.getAttribute("fill") ?? "").includes("--severity-severe"),
    );
    expect(dangerFilled).toHaveLength(3);
    expect(algorithmic.desktopSvg.querySelectorAll('rect[stroke-dasharray="5 3"]')).toHaveLength(3);
    const collapse = Array.from(algorithmic.desktopSvg.querySelectorAll("text")).find(
      (node) => node.textContent === "reflexive collapse",
    );
    expect(collapse?.getAttribute("fill")).toBe("var(--severity-severe)");
    // Mobile carries the fragility as a dashed border (it has no tone fill).
    expect(algorithmic.mobileSvg.querySelectorAll('rect[stroke-dasharray="3 3"]')).toHaveLength(3);
    cleanup();

    const fiatCash = renderDiagram("fiat-cash", "USDC");
    expect(
      Array.from(fiatCash.desktopSvg.querySelectorAll("rect")).every(
        (rect) => rect.getAttribute("fill") === "var(--card)",
      ),
    ).toBe(true);
    expect(fiatCash.desktopSvg.querySelectorAll("rect[stroke-dasharray]")).toHaveLength(0);
  });

  it("returns null for an unknown archetype", () => {
    expect(mechanismDiagramFor("unknown" as MechanismArchetype, "X")).toBeNull();
  });

  it("applies a coin override to a step label", () => {
    const { container } = renderDiagram("cdp", "DAI", {
      override: {
        steps: [{}, { label: "PSM swap: USDC ↔ DAI" }],
      },
    });
    expectText(container, ["PSM swap: USDC ↔ DAI", "Crypto collateral"]);
  });

  it("applies a coin override to the stress footnote", () => {
    const { container } = renderDiagram("fiat-cash", "USDC", {
      override: { stressFootnote: "stress: SVB freeze (March 2023)" },
    });
    expect(container.textContent).toContain("stress: SVB freeze (March 2023)");
  });

  it("renders ftUSD with borrow/stake semantics and no perp-only text", () => {
    const { container, desktopSvg } = renderDiagram("synthetic-delta-neutral", "ftUSD", {
      override: {
        syntheticStrategy: "borrow-stake",
        steps: [
          { label: "Stablecoin deposit", subtitle: "USDC / USDT / USSD collateral" },
          { label: "Borrow native + stake", subtitle: "WETH / wS into wstETH / stS" },
          { label: "ftUSD base token", subtitle: "carry to sftUSD + protocol" },
        ],
        stressFootnote: "stress: borrow-cost, oracle/liquidation, or withdrawal-buffer shock",
      },
    });
    expectText(container, ["Stablecoin deposit", "Stake native", "Borrow native", "carry", "sftUSD"]);
    expect(container.textContent).not.toMatch(/short perp|funding-rate|funding inversion/i);
    expect(desktopSvg.getAttribute("aria-label")).toContain("borrowed and staked");
  });

  describe("wrapper diagram", () => {
    it("renders the parent's archetype + variant box with a variant-aware stress footnote", () => {
      const node = mechanismDiagramFor("synthetic-delta-neutral", "sUSDe", {
        isWrapper: true,
        parentSymbol: "USDe",
        parentArchetype: "synthetic-delta-neutral",
        variantKind: "savings-passthrough",
      });
      expect(node).not.toBeNull();
      const { container } = render(<>{node}</>);
      expect(container.querySelector('[data-testid="wrapper-diagram"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="wrapper-parent-diagram"]')).not.toBeNull();
      const variantBox = container.querySelector('[data-testid="wrapper-variant-box"]');
      expect(variantBox).not.toBeNull();
      expect(variantBox?.textContent).toContain("sUSDe");
      expect(variantBox?.textContent).toContain("savings vault");
      expect(container.textContent).toContain("USDe mechanism");
      const footnote = container.querySelector('[data-testid="wrapper-stress-footnote"]');
      expect(footnote?.textContent).toContain("redemption queue");
    });

    it("falls back to plain archetype when wrapper context is incomplete", () => {
      const { container } = renderDiagram("cdp", "DAI", {
        isWrapper: true,
      });
      expect(container.querySelector('[data-testid="wrapper-diagram"]')).toBeNull();
      expect(container.querySelectorAll("svg[role='img']")).toHaveLength(2);
    });
  });

  describe("coin override step subtitles", () => {
    it("merges a per-step subtitle override into the synthetic-delta-neutral diagram", () => {
      const { container } = renderDiagram("synthetic-delta-neutral", "USDe", {
        override: {
          steps: [{}, { subtitle: "perp short on Binance/Bybit/OKX" }, {}],
        },
      });
      expectText(container, ["perp short on Binance/Bybit/OKX", "Long spot + short perp"]);
    });
  });

  /**
   * `tbill` covers both NAV-accreting fund shares and $1-pegged tokens that
   * merely hold a T-Bill reserve (25 of 47 tracked coins). Asserting daily NAV
   * accrual for the second family, and drawing them with no redeem loop, is the
   * template-binding defect fixed 2026-08-18.
   */
  describe("tbill NAV split", () => {
    it("keeps the NAV-accreting copy for a NAV token", () => {
      const { container, desktopSvg } = renderDiagram("tbill", "OUSG", { navToken: true });
      expectText(container, ["OUSG units", "NAV accrues daily", "stress: instant-redemption cap / stablecoin-rail constraint"]);
      expect(container.textContent).not.toContain("redeem 1:1");
      // The NAV template draws no redemption loop at all.
      expect(textNodes(desktopSvg)).not.toContain("redeem");
    });

    it("renders par redemption, not NAV accrual, for a non-NAV coin", () => {
      const { container, desktopSvg } = renderDiagram("tbill", "GUSD", { navToken: false });
      expectText(container, [
        "Subscriber cash",
        "T-Bills + Repos",
        "GUSD minted",
        "redeem 1:1",
        "stress: redemption gate / reserve-rail constraint",
      ]);
      expect(container.textContent).not.toContain("NAV accrues daily");
      expect(container.textContent).not.toContain("GUSD units");
      // The redeem loop the NAV template omits entirely.
      expect(textNodes(desktopSvg)).toContain("redeem");
      expect(desktopSvg.getAttribute("aria-label")).toContain("redeemed 1:1");
    });

    it("keeps the NAV-accreting default when no coin is in hand (/learn)", () => {
      const { container } = renderDiagram("tbill", "STBL");
      expectText(container, ["STBL units", "NAV accrues daily"]);
    });

    it("reads the parent's NAV flag, not the wrapper's, in the wrapper parent panel", () => {
      const node = mechanismDiagramFor("tbill", "sfrxUSD", {
        navToken: true,
        isWrapper: true,
        parentSymbol: "frxUSD",
        parentArchetype: "tbill",
        parentNavToken: false,
        variantKind: "savings-passthrough",
      });
      const { container } = render(<>{node}</>);
      const parent = container.querySelector('[data-testid="wrapper-parent-diagram"]');
      expect(parent?.textContent).toContain("frxUSD minted");
      expect(parent?.textContent).toContain("redeem 1:1");
      expect(parent?.textContent).not.toContain("NAV accrues daily");
    });
  });

  describe("VerticalThreeStepDiagram", () => {
    it("takes the same NAV branch as the horizontal renderer", () => {
      const nav = render(<VerticalThreeStepDiagram archetype="tbill" symbol="OUSG" navToken={true} />);
      expect(nav.container.textContent).toContain("NAV accrues daily");
      expect(nav.container.textContent).not.toContain("↺ redeem");
      cleanup();

      const par = render(<VerticalThreeStepDiagram archetype="tbill" symbol="GUSD" navToken={false} />);
      expect(par.container.textContent).toContain("GUSD minted");
      expect(par.container.textContent).toContain("redeem 1:1");
      expect(par.container.textContent).not.toContain("NAV accrues daily");
      // The redeem loop renders as the DOM return bracket + its caption.
      expect(par.container.textContent).toContain("↺ redeem");
      expect(par.container.textContent).toContain("stress: redemption gate / reserve-rail constraint");
    });
  });
});
