// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ImgHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeChain } from "@/hooks/__tests__/chain-profile-fixtures";
import { DominanceBreakdown } from "./dominance-breakdown";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => <img {...props} alt={props.alt ?? ""} />,
}));

afterEach(() => {
  cleanup();
});

// The bar is the only div[role="img"]; legend icons are <img> elements.
function dominanceBarLabel(container: HTMLElement) {
  return container.querySelector('div[role="img"]')?.getAttribute("aria-label") ?? "";
}

describe("DominanceBreakdown", () => {
  const topBySupply = [
    makeChain({ id: "ethereum", name: "Ethereum", dominanceShare: 0.5 }),
    makeChain({ id: "tron", name: "Tron", dominanceShare: 0.2 }),
  ];

  it("renders a legend entry per top chain with its dominance percent", () => {
    render(
      <DominanceBreakdown
        topBySupply={topBySupply}
        globalTotalUsd={1_000}
        chainAttributedTotalUsd={1_000}
        unattributedTotalUsd={0}
        chains={topBySupply}
      />,
    );

    expect(screen.getByText("Ethereum")).toBeTruthy();
    expect(screen.getByText("50.0%")).toBeTruthy();
    expect(screen.getByText("Tron")).toBeTruthy();
    expect(screen.getByText("20.0%")).toBeTruthy();
  });

  it("surfaces the residual attributed share as 'Other chains'", () => {
    // chainAttributedShare = 900/1000 = 0.9; topShare = 0.7 -> Other = 0.2.
    const { container } = render(
      <DominanceBreakdown
        topBySupply={topBySupply}
        globalTotalUsd={1_000}
        chainAttributedTotalUsd={900}
        unattributedTotalUsd={100}
        chains={topBySupply}
      />,
    );

    expect(screen.getByText("Other chains")).toBeTruthy();
    expect(screen.getByText("Unattributed")).toBeTruthy();
    expect(dominanceBarLabel(container)).toBe(
      "Supply dominance: Ethereum 50.0%, Tron 20.0%, Other chains 20.0%, Unattributed 10.0%",
    );
  });

  it("hides 'Other chains' and 'Unattributed' below the 0.5% threshold", () => {
    render(
      <DominanceBreakdown
        topBySupply={topBySupply}
        globalTotalUsd={1_000}
        chainAttributedTotalUsd={700}
        unattributedTotalUsd={0}
        chains={topBySupply}
      />,
    );

    expect(screen.queryByText("Other chains")).toBeNull();
    expect(screen.queryByText("Unattributed")).toBeNull();
  });

  it("hides residuals below and at the strict 0.5% threshold and shows them above", () => {
    const labelFor = (chainAttributedTotalUsd: number, unattributedTotalUsd: number) => {
      const { container } = render(
        <DominanceBreakdown
          topBySupply={topBySupply}
          globalTotalUsd={1_000}
          chainAttributedTotalUsd={chainAttributedTotalUsd}
          unattributedTotalUsd={unattributedTotalUsd}
          chains={topBySupply}
        />,
      );
      return dominanceBarLabel(container);
    };
    // Subtraction branch: 0.4% hidden, 0.6% shown; float rounding puts a
    // nominal 0.5% residual on the shown side, so the strict-threshold exact
    // case is asserted on the direct-division branch below.
    expect(labelFor(704, 0)).not.toContain("Other chains");
    expect(labelFor(706, 0)).toContain("Other chains 0.6%");
    expect(labelFor(700, 5)).not.toContain("Unattributed");
    expect(labelFor(700, 6)).toContain("Unattributed 0.6%");
  });

  it("falls back to chain sums for the residual when the attributed total is not finite", () => {
    const { container } = render(
      <DominanceBreakdown
        topBySupply={topBySupply}
        globalTotalUsd={1_000}
        chainAttributedTotalUsd={Number.NaN}
        unattributedTotalUsd={0}
        chains={[
          makeChain({ id: "ethereum", name: "Ethereum", dominanceShare: 0.5, totalUsd: 420 }),
          makeChain({ id: "tron", name: "Tron", dominanceShare: 0.2, totalUsd: 350 }),
        ]}
      />,
    );

    expect(dominanceBarLabel(container)).toContain("Other chains 7.0%");
  });

  it("announces no residual percentages when global supply is zero", () => {
    const { container } = render(
      <DominanceBreakdown
        topBySupply={topBySupply}
        globalTotalUsd={0}
        chainAttributedTotalUsd={0}
        unattributedTotalUsd={0}
        chains={topBySupply}
      />,
    );

    const label = dominanceBarLabel(container);
    expect(label).toBe("Supply dominance: Ethereum 50.0%, Tron 20.0%");
    expect(label).not.toMatch(/NaN|Infinity/);
  });
});
