// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainSummary } from "@shared/types";
import type { StabilityIndexCurrent } from "@shared/types/stability";
import { buildLighthouseCinematicModel } from "./cinematic-model";
import { LighthouseStage } from "./lighthouse-stage";

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
  totalMcapUsd: 1_000_000_000,
  contributors: [],
};

function makeModel() {
  return buildLighthouseCinematicModel({
    chains: [
      makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 500_000_000, healthBand: "robust" }),
      makeChain({ id: "tron", name: "Tron", totalUsd: 300_000_000, healthBand: "concentrated" }),
    ],
    totalUsd: 800_000_000,
    stabilityIndex: PSI,
    stressSignals: null,
    stablecoins: [],
    selectedHarborId: "ethereum",
  });
}

describe("LighthouseStage", () => {
  it("renders a textless SVG stage with icon controls and screen-reader ledger", () => {
    const { container } = render(
      <LighthouseStage
        model={makeModel()}
        onModeChange={vi.fn()}
        onSelectHarbor={vi.fn()}
      />,
    );

    const svg = screen.getByTestId("lighthouse-stage-svg");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toContain("Pharos Lighthouse");
    expect(container.querySelector("svg text")).toBeNull();
    expect(screen.getByRole("button", { name: "Watch mode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lens mode" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Toggle data ledger" })).toBeNull();
    expect(container.querySelector('[data-module-id="harbors"]')).toBeTruthy();
    expect(container.querySelector('[data-module-id="lens"]')).toBeTruthy();
    expect(container.querySelector('[data-module-id="radar"]')).toBeTruthy();
    expect(container.querySelector('[data-module-id="atlas"]')).toBeTruthy();
    expect(screen.getByTestId("lighthouse-a11y-ledger").className).toContain("sr-only");
  });

  it("fires harbor selection and keyboard activation callbacks", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <LighthouseStage
        model={makeModel()}
        onModeChange={vi.fn()}
        onSelectHarbor={onSelect}
      />,
    );
    const tron = container.querySelector<SVGGElement>('[data-harbor-id="tron"]');
    expect(tron).toBeTruthy();

    fireEvent.click(tron!);
    fireEvent.keyDown(tron!, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("tron");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("fires mode control callbacks", () => {
    const onModeChange = vi.fn();
    render(
      <LighthouseStage
        model={makeModel()}
        onModeChange={onModeChange}
        onSelectHarbor={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Lens mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Radar mode" }));

    expect(onModeChange).toHaveBeenCalledWith("lens");
    expect(onModeChange).toHaveBeenCalledWith("radar");
  });

  it("exposes module hover preview and keyboard commit callbacks", () => {
    const onPreviewModule = vi.fn();
    const onPreviewModuleEnd = vi.fn();
    const onSelectModule = vi.fn();
    const { container } = render(
      <LighthouseStage
        model={makeModel()}
        onModeChange={vi.fn()}
        onSelectHarbor={vi.fn()}
        onPreviewModule={onPreviewModule}
        onPreviewModuleEnd={onPreviewModuleEnd}
        onSelectModule={onSelectModule}
      />,
    );
    const radar = container.querySelector<SVGGElement>('[data-module-id="radar"]');
    expect(radar).toBeTruthy();

    fireEvent.pointerEnter(radar!);
    fireEvent.pointerLeave(radar!);
    fireEvent.keyDown(radar!, { key: " " });

    expect(onPreviewModule).toHaveBeenCalledWith("radar");
    expect(onPreviewModuleEnd).toHaveBeenCalledTimes(1);
    expect(onSelectModule).toHaveBeenCalledWith("radar");
  });

  it("exposes an optional fullscreen inspection trigger", () => {
    const onExpandStage = vi.fn();
    render(
      <LighthouseStage
        model={makeModel()}
        onModeChange={vi.fn()}
        onSelectHarbor={vi.fn()}
        onExpandStage={onExpandStage}
        fullscreenOpen={false}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Expand lighthouse" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(onExpandStage).toHaveBeenCalledTimes(1);
  });

  it("keeps exact data facts in the screen-reader ledger", () => {
    render(
      <LighthouseStage
        model={makeModel()}
        onModeChange={vi.fn()}
        onSelectHarbor={vi.fn()}
      />,
    );

    const ledger = screen.getByTestId("lighthouse-a11y-ledger");
    expect(within(ledger).getByText("Lighthouse data ledger")).toBeTruthy();
    expect(within(ledger).getByText("Selected Harbor")).toBeTruthy();
    expect(within(ledger).getAllByText(/Ethereum/).length).toBeGreaterThan(0);
  });
});
