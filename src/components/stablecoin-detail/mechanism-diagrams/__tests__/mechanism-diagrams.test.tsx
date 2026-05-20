// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { MechanismArchetype } from "@shared/types";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";

afterEach(() => cleanup());

function renderFor(archetype: MechanismArchetype, symbol: string): string {
  const node = mechanismDiagramFor(archetype, symbol);
  expect(node).not.toBeNull();
  const { container } = render(<>{node}</>);
  const svgs = container.querySelectorAll("svg");
  expect(svgs.length).toBe(2);
  return container.innerHTML;
}

describe("mechanismDiagramFor", () => {
  it("renders the fiat-cash diagram", () => {
    expect(renderFor("fiat-cash", "USDC")).toMatchSnapshot();
  });

  it("renders the tbill diagram", () => {
    expect(renderFor("tbill", "USDC")).toMatchSnapshot();
  });

  it("renders the cdp diagram", () => {
    expect(renderFor("cdp", "USDC")).toMatchSnapshot();
  });

  it("renders the synthetic-delta-neutral diagram", () => {
    expect(renderFor("synthetic-delta-neutral", "USDC")).toMatchSnapshot();
  });

  it("renders the algorithmic diagram", () => {
    expect(renderFor("algorithmic", "USDC")).toMatchSnapshot();
  });

  it("renders the rwa-credit-fund diagram", () => {
    expect(renderFor("rwa-credit-fund", "ACRED")).toMatchSnapshot();
  });

  it("returns null for an unknown archetype", () => {
    expect(mechanismDiagramFor("unknown" as MechanismArchetype, "X")).toBeNull();
  });

  it("applies a coin override to a step label", () => {
    const node = mechanismDiagramFor("cdp", "DAI", {
      override: {
        steps: [
          undefined as unknown as { label?: string; subtitle?: string },
          { label: "PSM swap: USDC ↔ DAI" },
        ],
      },
    });
    expect(node).not.toBeNull();
    const { container } = render(<>{node}</>);
    expect(container.innerHTML).toContain("PSM swap: USDC ↔ DAI");
    // Default step 1 label is preserved.
    expect(container.innerHTML).toContain("Crypto collateral");
  });

  it("applies a coin override to the stress footnote", () => {
    const node = mechanismDiagramFor("fiat-cash", "USDC", {
      override: { stressFootnote: "stress: SVB freeze (March 2023)" },
    });
    const { container } = render(<>{node}</>);
    expect(container.innerHTML).toContain("stress: SVB freeze (March 2023)");
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
      // Wrapper layout container present.
      expect(
        container.querySelector('[data-testid="wrapper-diagram"]'),
      ).not.toBeNull();
      // Parent diagram region rendered with reduced opacity.
      expect(
        container.querySelector('[data-testid="wrapper-parent-diagram"]'),
      ).not.toBeNull();
      // Variant box references child symbol.
      const variantBox = container.querySelector(
        '[data-testid="wrapper-variant-box"]',
      );
      expect(variantBox).not.toBeNull();
      expect(variantBox?.textContent).toContain("sUSDe");
      expect(variantBox?.textContent).toContain("savings vault");
      // Parent symbol appears in the kicker.
      expect(container.textContent).toContain("USDe mechanism");
    });

    it("falls back to plain archetype when wrapper context is incomplete", () => {
      const node = mechanismDiagramFor("cdp", "DAI", {
        isWrapper: true,
        // missing parentSymbol/parentArchetype intentionally
      });
      const { container } = render(<>{node}</>);
      // No wrapper container.
      expect(
        container.querySelector('[data-testid="wrapper-diagram"]'),
      ).toBeNull();
      // Standard 2 SVGs (desktop + mobile).
      expect(container.querySelectorAll("svg").length).toBe(2);
    });

    it("renders WrapperDiagram (not the plain archetype) when isWrapper context is complete", () => {
      const node = mechanismDiagramFor("synthetic-delta-neutral", "sUSDe", {
        isWrapper: true,
        parentSymbol: "USDe",
        parentArchetype: "synthetic-delta-neutral",
        variantKind: "savings-passthrough",
      });
      const { container } = render(<>{node}</>);
      expect(
        container.querySelector('[data-testid="wrapper-diagram"]'),
      ).not.toBeNull();
      // The wrapper's parent diagram region is rendered with the parent symbol,
      // not the standard archetype diagram top-level (which would have aria-label
      // referencing the child symbol directly).
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
      const footnote = container.querySelector(
        '[data-testid="wrapper-stress-footnote"]',
      );
      expect(footnote).not.toBeNull();
      expect(footnote?.textContent).toContain("redemption queue");
    });
  });

  describe("coin override step subtitles", () => {
    it("merges a per-step subtitle override into the synthetic-delta-neutral diagram", () => {
      const node = mechanismDiagramFor("synthetic-delta-neutral", "USDe", {
        override: {
          steps: [
            undefined as unknown as { label?: string; subtitle?: string },
            { subtitle: "perp short on Binance/Bybit/OKX" },
            undefined as unknown as { label?: string; subtitle?: string },
          ],
        },
      });
      const { container } = render(<>{node}</>);
      expect(container.innerHTML).toContain("perp short on Binance/Bybit/OKX");
      // Default step labels are preserved.
      expect(container.innerHTML).toContain("Long spot + short perp");
    });
  });
});
