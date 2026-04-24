// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainSummary } from "@shared/types/chains";
import { buildChainHarborModel } from "./harbor-map";
import { HarborList as ChainHarborMap } from "./harbor-list";
import { NauticalChart } from "./nautical-chart";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => createElement("img", { ...props, alt: props.alt ?? "" }),
}));

afterEach(() => cleanup());

function makeChain(overrides: Partial<ChainSummary>): ChainSummary {
  return {
    id: overrides.id ?? "ethereum",
    name: overrides.name ?? "Ethereum",
    logoPath: overrides.logoPath ?? "/logos/chains/ethereum.svg",
    type: overrides.type ?? "evm",
    totalUsd: overrides.totalUsd ?? 100,
    change24h: overrides.change24h ?? 0,
    change24hPct: overrides.change24hPct ?? 0,
    change7d: overrides.change7d ?? 0,
    change7dPct: overrides.change7dPct ?? 0,
    change30d: overrides.change30d ?? 0,
    change30dPct: overrides.change30dPct ?? 0,
    stablecoinCount: overrides.stablecoinCount ?? 3,
    dominantStablecoin: overrides.dominantStablecoin ?? {
      id: "usdc-circle",
      symbol: "USDC",
      share: 0.6,
    },
    dominanceShare: overrides.dominanceShare ?? 0.5,
    healthScore: overrides.healthScore === undefined ? 82 : overrides.healthScore,
    healthBand: overrides.healthBand === undefined ? "healthy" : overrides.healthBand,
    healthFactors: overrides.healthFactors ?? {
      concentration: 80,
      quality: 85,
      pegStability: 90,
      backingDiversity: 70,
      chainEnvironment: 80,
    },
  };
}

describe("buildChainHarborModel", () => {
  it("sorts chains by supply and derives top-harbor share and health summary", () => {
    const model = buildChainHarborModel([
      makeChain({ id: "base", name: "Base", totalUsd: 25, healthScore: 70, healthBand: "mixed" }),
      makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 60, healthScore: 90, healthBand: "robust" }),
      makeChain({ id: "fragile", name: "FragileNet", totalUsd: 15, healthScore: 40, healthBand: "fragile" }),
    ], 100);

    expect(model.entries.map((entry) => entry.id)).toEqual(["ethereum", "base", "fragile"]);
    expect(model.topSharePct).toBe(100);
    expect(model.largestHarbor).toMatchObject({
      id: "ethereum",
      sharePct: 60,
      berthPct: 100,
      dominantSharePct: 60,
    });
    expect(model.fragileHarbors).toBe(1);
    expect(model.averageHealthScore).toBe(67);
  });

  it("caps the harbor map to the largest eight chains", () => {
    const chains = Array.from({ length: 10 }, (_, index) => makeChain({
      id: `chain-${index}`,
      name: `Chain ${index}`,
      totalUsd: 10 - index,
    }));

    const model = buildChainHarborModel(chains, 55);

    expect(model.entries).toHaveLength(8);
    expect(model.entries[0]?.id).toBe("chain-0");
    expect(model.entries[7]?.id).toBe("chain-7");
  });

  it("handles zero global supply and ignores unrated chains in the health average", () => {
    const model = buildChainHarborModel([
      makeChain({
        id: "zero",
        name: "ZeroNet",
        totalUsd: 0,
        healthScore: null,
        healthBand: null,
      }),
      makeChain({
        id: "scored",
        name: "ScoredNet",
        totalUsd: 0,
        healthScore: 64,
        healthBand: "mixed",
      }),
    ], 0);

    expect(model.topSharePct).toBe(0);
    expect(model.entries[0]).toMatchObject({
      id: "zero",
      sharePct: 0,
      berthPct: 0,
      healthScore: null,
      healthBand: null,
    });
    expect(model.averageHealthScore).toBe(64);
  });

  it("renders the harbor map summary and chain rows", () => {
    render(createElement(ChainHarborMap, {
      chains: [
        makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 60, healthScore: 90, healthBand: "robust" }),
        makeChain({ id: "base", name: "Base", totalUsd: 25, healthScore: 70, healthBand: "mixed" }),
      ],
      globalTotalUsd: 100,
    }));

    expect(screen.getByRole("heading", { name: "Where stablecoin supply is docked" })).toBeTruthy();
    expect(screen.getAllByText("Ethereum").length).toBeGreaterThan(0);
    expect(screen.getByText("Base")).toBeTruthy();
    expect(screen.getByText("Top 2 chains hold 85.0%")).toBeTruthy();
  });

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
});
