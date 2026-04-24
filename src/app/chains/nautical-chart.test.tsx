// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainSummary } from "@shared/types/chains";
import { NauticalChart } from "./nautical-chart";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) =>
    createElement("img", { ...props, alt: props.alt ?? "" }),
}));

afterEach(() => cleanup());

function makeChain(overrides: Partial<ChainSummary>): ChainSummary {
  return {
    id: overrides.id ?? "ethereum",
    name: overrides.name ?? "Ethereum",
    logoPath: overrides.logoPath ?? "/logos/chains/ethereum.svg",
    type: overrides.type ?? "evm",
    totalUsd: overrides.totalUsd ?? 100,
    change24h: 0, change24hPct: 0,
    change7d: 0, change7dPct: overrides.change7dPct ?? 0,
    change30d: 0, change30dPct: 0,
    stablecoinCount: overrides.stablecoinCount ?? 3,
    dominantStablecoin: overrides.dominantStablecoin ?? { id: "usdc-circle", symbol: "USDC", share: 0.6 },
    dominanceShare: overrides.dominanceShare ?? 0.5,
    healthScore: overrides.healthScore ?? 82,
    healthBand: overrides.healthBand ?? "healthy",
    healthFactors: { concentration: 80, quality: 85, pegStability: 90, backingDiversity: 70, chainEnvironment: 80 },
  };
}

describe("NauticalChart", () => {
  it("renders nothing when no chains", () => {
    const { container } = render(createElement(NauticalChart, { chains: [], globalTotalUsd: 0 }));
    expect(container.firstChild).toBeNull();
  });

  it("renders SVG scene and compass plates with top-share headline", () => {
    const chains = [
      makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 60 }),
      makeChain({ id: "base", name: "Base", totalUsd: 25, healthBand: "mixed", healthScore: 70 }),
      makeChain({ id: "tron", name: "Tron", totalUsd: 15, healthBand: "fragile", healthScore: 45 }),
    ];
    render(createElement(NauticalChart, { chains, globalTotalUsd: 100 }));

    // Heading appears in both the SVG scene and the xl:hidden HarborList fallback.
    expect(screen.getAllByRole("heading", { name: "Where stablecoin supply is docked" }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Top 3 chains hold 100.0%").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Ethereum").length).toBeGreaterThan(0);
    // SVG scene renders with aria-label
    expect(screen.getByRole("img", { name: /Nautical chart of 3 largest/ })).toBeTruthy();
    // Fragile-ports compass plate shows 1
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the mobile fallback list (HarborList) inside xl:hidden wrapper", () => {
    const chains = [makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 60 })];
    const { container } = render(createElement(NauticalChart, { chains, globalTotalUsd: 100 }));
    // HarborList's heading id must be present in the DOM even when xl:hidden.
    const fallbackHeadings = container.querySelectorAll('[id="chain-harbor-heading"]');
    expect(fallbackHeadings.length).toBeGreaterThanOrEqual(1);
  });
});
