// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainSummary, StressSignalsAllResponse } from "@shared/types";
import type { StabilityIndexCurrent } from "@shared/types/stability";
import { Lighthouse2ExpeditionStage } from "./expedition-stage";
import { buildLighthouse2Model } from "./nautical-model";

afterEach(() => cleanup());

function makeChain(overrides: Partial<ChainSummary> & Pick<ChainSummary, "id" | "name" | "totalUsd">): ChainSummary {
  return {
    id: overrides.id,
    name: overrides.name,
    logoPath: overrides.logoPath ?? `/logos/${overrides.id}.svg`,
    type: overrides.type ?? "evm",
    totalUsd: overrides.totalUsd,
    change24h: overrides.change24h ?? 0,
    change24hPct: overrides.change24hPct ?? 0,
    change7d: overrides.change7d ?? 0,
    change7dPct: overrides.change7dPct ?? 0,
    change30d: overrides.change30d ?? 0,
    change30dPct: overrides.change30dPct ?? 0,
    stablecoinCount: overrides.stablecoinCount ?? 1,
    dominantStablecoin: overrides.dominantStablecoin ?? { id: `${overrides.id}-dominant`, symbol: "USDX", share: 0.4 },
    topStablecoins: overrides.topStablecoins,
    dominanceShare: overrides.dominanceShare ?? 0.05,
    healthScore: overrides.healthScore ?? 70,
    healthBand: overrides.healthBand ?? "healthy",
    healthFactors: overrides.healthFactors ?? {
      concentration: 0.1,
      quality: 0.7,
      pegStability: 0.8,
      backingDiversity: 0.6,
      chainEnvironment: 0.7,
    },
  };
}

const PSI: StabilityIndexCurrent = {
  score: 84,
  band: "BEDROCK",
  components: {
    severity: 8,
    breadth: 4,
    stressBreadth: 2,
    trend: -1,
  },
  computedAt: 1710000000,
  methodologyVersion: "v1",
};

const STRESS: StressSignalsAllResponse = {
  updatedAt: 1710000000,
  methodology: {} as StressSignalsAllResponse["methodology"],
  signals: {
    "coin-danger": { score: 92, band: "DANGER", signals: {}, computedAt: 1710000000, methodologyVersion: "v1" },
  },
};

function makeModel() {
  return buildLighthouse2Model({
    chains: [
      makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 500_000_000, healthBand: "robust" }),
      makeChain({ id: "tron", name: "Tron", totalUsd: 300_000_000, healthBand: "concentrated" }),
    ],
    totalUsd: 800_000_000,
    stabilityIndex: PSI,
    stressSignals: STRESS,
    stablecoins: [],
  });
}

describe("Lighthouse2ExpeditionStage", () => {
  it("renders a textless SVG expedition chart with accessible ledger", () => {
    const { container } = render(<Lighthouse2ExpeditionStage model={makeModel()} />);

    const svg = screen.getByTestId("lighthouse-2-svg");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toContain("Pharos Lighthouse 2 sea chart");
    expect(container.querySelector("svg text")).toBeNull();
    expect(screen.getByRole("button", { name: "Chain harbors" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "PSI lighthouse" })).toBeTruthy();
    expect(screen.getByTestId("lighthouse-2-a11y-ledger").className).toContain("sr-only");
    expect(within(screen.getByTestId("lighthouse-2-a11y-ledger")).getByText("Chain lanes")).toBeTruthy();
  });

  it("fires module preview and keyboard commit callbacks", () => {
    const onPreviewModule = vi.fn();
    const onPreviewEnd = vi.fn();
    const onSelectModule = vi.fn();
    const { container } = render(
      <Lighthouse2ExpeditionStage
        model={makeModel()}
        onPreviewModule={onPreviewModule}
        onPreviewEnd={onPreviewEnd}
        onSelectModule={onSelectModule}
      />,
    );
    const dews = container.querySelector<SVGGElement>('[data-module-id="dews"]');
    expect(dews).toBeTruthy();

    fireEvent.pointerEnter(dews!);
    fireEvent.pointerLeave(dews!);
    fireEvent.keyDown(dews!, { key: "Enter" });

    expect(onPreviewModule).toHaveBeenCalledWith("dews");
    expect(onPreviewEnd).toHaveBeenCalledTimes(1);
    expect(onSelectModule).toHaveBeenCalledWith("dews");
  });

  it("fires mark preview and selection callbacks", () => {
    const onPreviewMark = vi.fn();
    const onSelectMark = vi.fn();
    const { container } = render(
      <Lighthouse2ExpeditionStage
        model={makeModel()}
        onPreviewMark={onPreviewMark}
        onSelectMark={onSelectMark}
      />,
    );
    const vessel = container.querySelector<SVGGElement>('[data-mark-id="chain:ethereum"]');
    expect(vessel).toBeTruthy();

    fireEvent.pointerEnter(vessel!);
    fireEvent.click(vessel!);

    expect(onPreviewMark).toHaveBeenCalledWith("chain:ethereum", "chains");
    expect(onSelectMark).toHaveBeenCalledWith("chain:ethereum", "chains");
  });
});
