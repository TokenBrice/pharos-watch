// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import { NauticalChart } from "./nautical-chart";
import { makeChain } from "./harbor-map.test-support";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) =>
    createElement("img", { ...props, alt: props.alt ?? "" }),
}));


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

  it("emits harbor selection from hover and Enter/Space activation only", () => {
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
    expect(onSelectChain).toHaveBeenCalledTimes(1);
    expect(onSelectChain).toHaveBeenLastCalledWith("base");

    onSelectChain.mockClear();
    fireEvent.keyDown(baseShip, { key: "Enter" });
    expect(onSelectChain).toHaveBeenCalledTimes(1);
    expect(onSelectChain).toHaveBeenLastCalledWith("base");

    onSelectChain.mockClear();
    fireEvent.keyDown(baseShip, { key: " " });
    expect(onSelectChain).toHaveBeenCalledTimes(1);
    expect(onSelectChain).toHaveBeenLastCalledWith("base");

    onSelectChain.mockClear();
    fireEvent.keyDown(baseShip, { key: "Tab" });
    expect(onSelectChain).not.toHaveBeenCalled();
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
