// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { MechanismArchetype } from "@shared/types";
import { mechanismDiagramFor, type MechanismDiagramOptions } from "@/components/stablecoin-detail/mechanism-diagrams";

afterEach(() => cleanup());

interface RenderedDiagram {
  container: HTMLElement;
  desktopSvg: SVGSVGElement;
  mobileSvg: SVGSVGElement;
}

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

function expectText(container: HTMLElement, labels: readonly string[]) {
  for (const label of labels) {
    expect(container.textContent).toContain(label);
  }
}

function expectThreeStepStructure(
  diagram: RenderedDiagram,
  {
    desktopViewBox,
    desktopPathCount,
  }: {
    desktopViewBox: string;
    desktopPathCount: number;
  },
) {
  expect(diagram.desktopSvg.getAttribute("viewBox")).toBe(desktopViewBox);
  expect(diagram.mobileSvg.getAttribute("viewBox")).toBe("0 0 220 288");
  expect(diagram.desktopSvg.querySelectorAll('rect[width="150"], rect[width="200"]')).toHaveLength(3);
  expect(diagram.mobileSvg.querySelectorAll('rect[width="200"]')).toHaveLength(3);
  expect(diagram.desktopSvg.querySelectorAll("line")).toHaveLength(2);
  expect(diagram.mobileSvg.querySelectorAll("line")).toHaveLength(2);
  expect(diagram.desktopSvg.querySelectorAll("path")).toHaveLength(desktopPathCount);
}

const ARCHETYPE_CASES = [
  {
    archetype: "fiat-cash",
    symbol: "USDC",
    desktopViewBox: "0 0 600 155",
    desktopPathCount: 1,
    labels: ["User USD", "Issuer reserves", "USDC minted", "redeem"],
    subtitles: ["wire / ACH", "custodied 1:1", "redeem any time"],
    stress: "stress: banking-rail freeze (USDC, Mar 2023)",
  },
  {
    archetype: "tbill",
    symbol: "USDC",
    desktopViewBox: "0 0 600 120",
    desktopPathCount: 0,
    labels: ["Investor cash", "T-Bills + Repos", "USDC units"],
    subtitles: ["subscribed via fund", "short-duration RWA", "NAV accrues daily"],
    stress: "stress: instant-redemption cap / USDC rail constraint (OUSG)",
  },
  {
    archetype: "cdp",
    symbol: "USDC",
    desktopViewBox: "0 0 600 155",
    desktopPathCount: 1,
    labels: ["Crypto collateral", "Vault / PSM", "USDC minted", "or liquidated"],
    subtitles: ["overcollateralized", "mint debt vs collateral", "liquidates below ratio"],
    stress: "stress: collateral cascade (DAI, Mar 2020)",
  },
  {
    archetype: "synthetic-delta-neutral",
    symbol: "USDC",
    desktopViewBox: "0 0 600 120",
    desktopPathCount: 1,
    labels: ["Crypto deposit", "Long spot", "Short perp", "Long spot + short perp", "USDC minted", "funding"],
    subtitles: ["spot collateral", "delta-neutral hedge", "funding-rate yield"],
    stress: "stress: funding-rate inversion",
  },
  {
    archetype: "algorithmic",
    symbol: "USDC",
    desktopViewBox: "0 0 600 155",
    desktopPathCount: 1,
    labels: ["Burn governance token", "Mint/burn AMO", "USDC minted", "reflexive collapse"],
    subtitles: ["algorithmic mint", "defends peg via arbitrage", "no 1:1 backing"],
    stress: "stress: reflexive collapse (UST, May 2022)",
  },
  {
    archetype: "rwa-credit-fund",
    symbol: "ACRED",
    desktopViewBox: "0 0 600 155",
    desktopPathCount: 1,
    labels: ["Investor cash", "Private credit / CLO", "ACRED fund-share", "quarterly redemption"],
    subtitles: ["subscribed via fund (KYC)", "credit risk, illiquid", "NAV reflects credit losses"],
    stress: "stress: NAV markdown / quarterly gate",
  },
] as const satisfies ReadonlyArray<{
  archetype: MechanismArchetype;
  symbol: string;
  desktopViewBox: string;
  desktopPathCount: number;
  labels: readonly string[];
  subtitles: readonly string[];
  stress: string;
}>;

function structureSignature(diagram: RenderedDiagram): string {
  const markerLabels = Array.from(diagram.desktopSvg.querySelectorAll("text"))
    .map((node) => node.textContent ?? "")
    .filter((label) =>
      [
        "redeem",
        "or liquidated",
        "Long spot",
        "Short perp",
        "funding",
        "reflexive collapse",
        "quarterly redemption",
      ].includes(label),
    )
    .join("|");

  return [
    diagram.desktopSvg.getAttribute("viewBox"),
    `paths:${diagram.desktopSvg.querySelectorAll("path").length}`,
    `dashedLines:${diagram.desktopSvg.querySelectorAll("line[stroke-dasharray]").length}`,
    `dashedRects:${diagram.desktopSvg.querySelectorAll("rect[stroke-dasharray]").length}`,
    `markers:${markerLabels}`,
  ].join(";");
}

describe("mechanismDiagramFor", () => {
  it.each(ARCHETYPE_CASES)("renders the $archetype diagram structure", (testCase) => {
    const diagram = renderDiagram(testCase.archetype, testCase.symbol);
    expectThreeStepStructure(diagram, testCase);
    expectText(diagram.container, [...testCase.labels, ...testCase.subtitles, testCase.stress]);
  });

  it("renders archetype variants with distinct structural markers", () => {
    const signatures = ARCHETYPE_CASES.map((testCase) =>
      structureSignature(renderDiagram(testCase.archetype, testCase.symbol)),
    );
    expect(new Set(signatures).size).toBe(ARCHETYPE_CASES.length);
  });

  it("marks the algorithmic variant as dashed and danger-toned", () => {
    const { desktopSvg, mobileSvg } = renderDiagram("algorithmic", "USDC");
    expect(desktopSvg.querySelectorAll('rect[stroke-dasharray="5 3"]')).toHaveLength(3);
    expect(desktopSvg.querySelectorAll('line[stroke-dasharray="4 3"]')).toHaveLength(2);
    expect(desktopSvg.querySelectorAll('path[stroke-dasharray="4 3"]')).toHaveLength(1);
    expect(mobileSvg.querySelectorAll('rect[stroke-dasharray="3 3"]')).toHaveLength(3);
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

  describe("wrapper diagram", () => {
    it("renders the parent's archetype + variant box", () => {
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
    });

    it("falls back to plain archetype when wrapper context is incomplete", () => {
      const { container } = renderDiagram("cdp", "DAI", {
        isWrapper: true,
      });
      expect(container.querySelector('[data-testid="wrapper-diagram"]')).toBeNull();
      expect(container.querySelectorAll("svg[role='img']")).toHaveLength(2);
    });

    it("renders WrapperDiagram when isWrapper context is complete", () => {
      const node = mechanismDiagramFor("synthetic-delta-neutral", "sUSDe", {
        isWrapper: true,
        parentSymbol: "USDe",
        parentArchetype: "synthetic-delta-neutral",
        variantKind: "savings-passthrough",
      });
      const { container } = render(<>{node}</>);
      expect(container.querySelector('[data-testid="wrapper-diagram"]')).not.toBeNull();
      expect(container.textContent).toContain("USDe mechanism");
    });

    it("renders a variant-aware stress footnote on the wrapper diagram", () => {
      const node = mechanismDiagramFor("synthetic-delta-neutral", "sUSDe", {
        isWrapper: true,
        parentSymbol: "USDe",
        parentArchetype: "synthetic-delta-neutral",
        variantKind: "savings-passthrough",
      });
      const { container } = render(<>{node}</>);
      const footnote = container.querySelector('[data-testid="wrapper-stress-footnote"]');
      expect(footnote).not.toBeNull();
      expect(footnote?.textContent).toContain("redemption queue");
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
});
