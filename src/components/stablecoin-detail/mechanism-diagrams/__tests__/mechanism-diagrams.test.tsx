// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { MechanismArchetype } from "@shared/types";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";

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
] as const;

function renderDiagram(archetype: MechanismArchetype, symbol: string): RenderedDiagram {
  const node = mechanismDiagramFor(archetype, symbol);
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
    ariaPhrase: "redeemable through the issuer by eligible holders",
    descPhrase: "eligible holders redeem through the issuer",
    steps: [
      "Customer funds",
      "bank transfer (KYC)",
      "Issuer reserves",
      "custodied 1:1",
      "USDC minted",
      "eligible holders redeem",
    ],
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
  it.each([
    ["ucits-trs-fund", "EURSAFO", /proportional.*fund interest/i, /counterparty/i],
    ["shared-reserve", "AUDm", /several currency liabilities/i, /shared liability deficit/i],
    ["protocol-position", "USDB", /local custody.*liability conservation/i, /withdrawal failure/i],
  ] as const)("renders the %s claim and stress path on desktop and mobile", (archetype, symbol, claim, stress) => {
    const diagram = renderDiagram(archetype, symbol);
    for (const svg of [diagram.desktopSvg, diagram.mobileSvg]) {
      expect(svg.getAttribute("aria-label")).toContain(symbol);
      expect(svg.querySelector("desc")?.textContent).toMatch(claim);
      expect(svg.querySelector("desc")?.textContent).not.toMatch(/custodies the funds in cash|short-duration T-Bills and repurchase agreements/);
    }
    expect(diagram.container.textContent).toMatch(stress);
    cleanup();
  });
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
});
