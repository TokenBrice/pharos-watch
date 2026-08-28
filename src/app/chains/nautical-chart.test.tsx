// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ChainSummary } from "@shared/types/chains";
import { ZERO_RATIO } from "@shared/types/ratio";
import { NauticalChart } from "./nautical-chart";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) =>
    createElement("img", { ...props, alt: props.alt ?? "" }),
}));

function makeChain(overrides: Partial<ChainSummary>): ChainSummary {
  return {
    id: overrides.id ?? "ethereum",
    name: overrides.name ?? "Ethereum",
    logoPath: overrides.logoPath ?? "/logos/chains/ethereum.svg",
    type: overrides.type ?? "evm",
    totalUsd: overrides.totalUsd ?? 100,
    change24h: 0, change24hPct: ZERO_RATIO,
    change7d: 0, change7dPct: overrides.change7dPct ?? ZERO_RATIO,
    change30d: 0, change30dPct: ZERO_RATIO,
    stablecoinCount: overrides.stablecoinCount ?? 3,
    dominantStablecoin: overrides.dominantStablecoin ?? { id: "usdc-circle", symbol: "USDC", share: 0.6 },
    topStablecoins: overrides.topStablecoins ?? [
      { id: "usdc-circle", symbol: "USDC", share: 0.5, supplyUsd: 50 },
      { id: "usdt-tether", symbol: "USDT", share: 0.3, supplyUsd: 30 },
      { id: "dai-makerdao", symbol: "DAI", share: 0.2, supplyUsd: 20 },
    ],
    dominanceShare: overrides.dominanceShare ?? 0.5,
    healthScore: overrides.healthScore ?? 82,
    healthBand: overrides.healthBand ?? "healthy",
    healthFactors: { concentration: 80, quality: 85, pegStability: 90, backingDiversity: 70, chainEnvironment: 80 },
    chainEnvironmentEvidence: overrides.chainEnvironmentEvidence ?? {
      source: "pharos-chain-tier",
      score: 80,
      resilienceTier: 2,
    },
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

    expect(screen.getByRole("heading", { name: "Where stablecoin supply is docked" })).toBeTruthy();
    expect(screen.getByText("Top 3 chains hold 100.0%")).toBeTruthy();
    expect(screen.getAllByText("Ethereum").length).toBeGreaterThan(0);
    // SVG scene renders with aria-label
    const chart = screen.getByRole("img", { name: /Nautical chart of 3 largest/ });
    expect(chart).toBeTruthy();
    expect(chart.querySelector('image[href="/logos/2-usdc.svg"]')).toBeTruthy();
    expect(chart.querySelector('image[href="/logos/1-usdt.svg"]')).toBeTruthy();
    expect(chart.querySelector('image[href="/logos/5-dai.png"]')).toBeTruthy();
    const cargoImages = [...chart.querySelectorAll("image")]
      .filter((node) => (node.getAttribute("clip-path") ?? node.getAttribute("clipPath") ?? "").includes("nc-cargo-"));
    expect(cargoImages.length).toBeGreaterThanOrEqual(9);
    expect([...chart.querySelectorAll("text")].map((node) => node.textContent?.trim()).some((text) => text?.startsWith("#"))).toBe(false);
    // Fragile-ports compass plate shows 1
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the chart inside a focusable responsive viewport instead of a list-only mobile fallback", () => {
    const chains = [makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 60 })];
    const { container } = render(createElement(NauticalChart, { chains, globalTotalUsd: 100 }));
    const chart = screen.getByRole("img", { name: "Nautical chart of 1 largest stablecoin chain" });
    const viewport = chart.closest(".nc-chart-viewport");

    expect(viewport).toBeTruthy();
    expect(viewport?.getAttribute("tabindex")).toBe("0");
    expect(viewport?.getAttribute("aria-label")).toBe("Horizontally scrollable nautical chart of 1 largest stablecoin chain");
    expect(chart.classList.contains("nc-chart-svg")).toBe(true);
    expect(chart.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
    expect(container.querySelector('[id="chain-harbor-heading"]')).toBeNull();
  });

  it("emits harbor selection from interactive ships", () => {
    const onSelectChain = vi.fn();
    const chains = [
      makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 60 }),
      makeChain({ id: "base", name: "Base", totalUsd: 25 }),
    ];
    render(createElement(NauticalChart, {
      chains,
      globalTotalUsd: 100,
      selectedChainId: "ethereum",
      onSelectChain,
    }));

    const baseShip = screen.getByRole("button", { name: "Select Base harbor" });
    fireEvent.mouseEnter(baseShip);
    expect(onSelectChain).toHaveBeenCalledWith("base");

    fireEvent.keyDown(baseShip, { key: "Enter" });
    expect(onSelectChain).toHaveBeenCalledWith("base");
  });

  it("aims the lighthouse beam at the selected harbor", () => {
    const chains = [
      makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 60 }),
      makeChain({ id: "base", name: "Base", totalUsd: 25 }),
    ];
    const { rerender } = render(createElement(NauticalChart, {
      chains,
      globalTotalUsd: 100,
      selectedChainId: "ethereum",
    }));

    const initialBeam = screen.getByTestId("nc-lighthouse-beam");
    const initialAngle = initialBeam.getAttribute("style");

    rerender(createElement(NauticalChart, {
      chains,
      globalTotalUsd: 100,
      selectedChainId: "base",
    }));

    expect(screen.getByTestId("nc-lighthouse-beam").getAttribute("style")).not.toBe(initialAngle);
  });

  it("marks the selected harbor with a light wash instead of a dotted frame", () => {
    const { container } = render(createElement(NauticalChart, {
      chains: [
        makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 60 }),
        makeChain({ id: "base", name: "Base", totalUsd: 25 }),
      ],
      globalTotalUsd: 100,
      selectedChainId: "ethereum",
    }));

    expect(screen.getByTestId("nc-harbor-light")).toBeTruthy();
    expect(container.querySelector("rect[stroke-dasharray='5 5']")).toBeNull();
  });
});
