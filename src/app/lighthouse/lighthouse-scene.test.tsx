// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LighthouseSceneModel } from "./view-model";
import { LighthouseScene } from "./lighthouse-scene";

afterEach(() => cleanup());

const model: LighthouseSceneModel = {
  totalUsd: 100_000_000,
  chainCount: 2,
  visibleShipCount: 2,
  ships: [
    {
      id: "ethereum",
      name: "Ethereum",
      logoPath: "/logos/ethereum.svg",
      totalUsd: 70_000_000,
      sharePct: 0.7,
      change7dPct: 0.02,
      healthScore: 88,
      healthBand: "robust",
      dominantSymbol: "USDT",
      dominantSharePct: 46,
      dominantCargoUsd: 32_200_000,
      stablecoinCount: 12,
      cargoCount: 4,
      draftLayers: 3,
      hullWidth: 144,
      hullHeight: 42,
      mastHeight: 110,
      wakeDirection: 1,
      wakeLength: 0.1,
      centerX: 220,
      deckY: 366,
      isSelected: true,
    },
    {
      id: "tron",
      name: "Tron",
      logoPath: "/logos/tron.svg",
      totalUsd: 30_000_000,
      sharePct: 0.3,
      change7dPct: -0.03,
      healthScore: 71,
      healthBand: "healthy",
      dominantSymbol: "USDT",
      dominantSharePct: 60,
      dominantCargoUsd: 18_000_000,
      stablecoinCount: 7,
      cargoCount: 3,
      draftLayers: 2,
      hullWidth: 88,
      hullHeight: 34,
      mastHeight: 98,
      wakeDirection: -1,
      wakeLength: -0.15,
      centerX: 470,
      deckY: 376,
      isSelected: false,
    },
  ],
  tailFleet: {
    remainingCount: 0,
    remainingUsd: 0,
    remainingSharePct: 0,
    label: "No remaining fleet",
  },
  selectedId: "ethereum",
  selectedShip: null,
  fleetBand: "sun",
  watchScore: 72,
  watchBand: "STEADY",
  watchLabel: "STEADY 72.0",
  sceneSummary: "Pharos Lighthouse watching 2 chain harbors, largest Ethereum, PSI STEADY 72 · clear watch.",
  sceneSubtitle: "PSI STEADY 72 · clear watch",
  largestHarbor: "Ethereum",
  lighthouseX: 1184,
  lighthouseY: 170,
  waterlineY: 382,
};

describe("LighthouseScene", () => {
  it("renders a labeled svg with a selected manifest and beam", () => {
    const onSelect = vi.fn();
    const { container } = render(<LighthouseScene model={model} onSelect={onSelect} />);
    const svg = screen.getByTestId("lighthouse-scene");

    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toContain("Pharos Lighthouse");
    expect(svg.getAttribute("data-selected-id")).toBe("ethereum");
    expect(container.querySelector('[data-testid="lighthouse-selected-manifest"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="lighthouse-beam"]')).toBeTruthy();
  });

  it("invokes selection when a ship is clicked or keyboard-activated", () => {
    const onSelect = vi.fn();
    const { container } = render(<LighthouseScene model={model} onSelect={onSelect} />);
    const ship = container.querySelector<SVGGElement>('[data-testid="lighthouse-ship-tron"]');
    expect(ship).toBeTruthy();

    fireEvent.click(ship!);
    fireEvent.keyDown(ship!, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("tron");
  });

  it("exposes the fleet summary in the caption", () => {
    render(<LighthouseScene model={model} onSelect={vi.fn()} />);
    expect(screen.getByText(/Night Watch/i)).toBeTruthy();
    expect(screen.getByText(/Largest Harbor/i)).toBeTruthy();
  });
});
