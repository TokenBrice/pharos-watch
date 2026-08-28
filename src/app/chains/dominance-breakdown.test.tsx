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
    render(
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
});
