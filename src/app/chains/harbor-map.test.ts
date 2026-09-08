// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildChainHarborEntries, buildChainHarborModel, buildChainHarborModelFromEntries } from "./harbor-map";
import { makeChain } from "./harbor-map.test-support";
import { NauticalChart } from "./nautical-chart";
import { SCENE_HEIGHT, SCENE_WIDTH } from "./nautical-constants";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => createElement("img", { ...props, alt: props.alt ?? "" }),
}));

describe("chain harbor DOM smokes", () => {
  it("renders nautical chart annotations and chain logos on the scene", () => {
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
    expect(screen.getAllByText("Aptos").length).toBeGreaterThan(0);
    expect(chart.querySelector('image[href="/chains/aptos.png"]')).toBeTruthy();
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
    expect(water).toBeTruthy();
    expect(Number(water?.getAttribute("y"))).toBeGreaterThan(180);

    const beams = [...chart.querySelectorAll('path[fill="url(#nc-beam)"]')];
    expect(beams.length).toBeGreaterThan(0);
    for (const beam of beams) {
      const points = [...(beam.getAttribute("d") ?? "").matchAll(/(-?[\d.]+)[\s,]+(-?[\d.]+)/g)]
        .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
      expect(points.length).toBeGreaterThanOrEqual(3);
      for (const { x, y } of points) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(SCENE_WIDTH);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(SCENE_HEIGHT);
      }
    }
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
