// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildChainHarborEntries, buildChainHarborModel, buildChainHarborModelFromEntries } from "./harbor-map";
import { makeChain } from "./harbor-map.test-support";
import { NauticalChart } from "./nautical-chart";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => createElement("img", { ...props, alt: props.alt ?? "" }),
}));

describe("chain harbor DOM smokes", () => {
  it("keeps nautical chart annotations readable on the dark scene in both themes", () => {
    render(createElement(NauticalChart, {
      chains: [
        makeChain({
          id: "aptos",
          name: "Aptos",
          logoPath: "/chains/aptos.png",
          totalUsd: 60,
          healthScore: 90,
          healthBand: "robust",
        }),
        makeChain({ id: "base", name: "Base", totalUsd: 25, healthScore: 70, healthBand: "mixed" }),
      ],
      globalTotalUsd: 100,
    }));

    const chart = screen.getByRole("img", { name: "Nautical chart of 2 largest stablecoin chains" });
    expect(chart.classList.contains("text-slate-100")).toBe(true);
    expect(chart.classList.contains("text-foreground")).toBe(false);

    const aptosLogo = chart.querySelector('image[href="/chains/aptos.png"]');
    expect(aptosLogo).toBeTruthy();
    expect(aptosLogo?.getAttribute("style") ?? "").not.toContain("invert");
  });

  it("keeps the lowered lighthouse beam inside the scene", () => {
    render(createElement(NauticalChart, {
      chains: [
        makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 60, healthScore: 90, healthBand: "robust" }),
        makeChain({ id: "base", name: "Base", totalUsd: 25, healthScore: 70, healthBand: "mixed" }),
      ],
      globalTotalUsd: 100,
    }));

    const chart = screen.getByRole("img", { name: "Nautical chart of 2 largest stablecoin chains" });
    const water = chart.querySelector('rect[fill="url(#nc-water)"]');
    expect(Number(water?.getAttribute("y"))).toBeGreaterThan(180);

    const beam = chart.querySelector('path[fill="url(#nc-beam)"]');
    const yValues = [...(beam?.getAttribute("d") ?? "").matchAll(/[ML]\s+[-\d.]+\s+([-\d.]+)/g)]
      .map((match) => Number(match[1]));
    expect(Math.min(...yValues)).toBeGreaterThanOrEqual(0);
  });
});

describe("chain harbor model helpers", () => {
  it("builds the same aggregate model from precomputed entries", () => {
    const chains = [
      makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 60, healthScore: 90, healthBand: "robust" }),
      makeChain({ id: "base", name: "Base", totalUsd: 25, healthScore: 70, healthBand: "mixed" }),
    ];
    const entries = buildChainHarborEntries(chains, 100);

    expect(buildChainHarborModelFromEntries(entries, 100)).toEqual(buildChainHarborModel(chains, 100));
  });
});
