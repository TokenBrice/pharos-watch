// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { UIOverlay } from "./ui-overlay";
import type { SceneData } from "../systems/scene-data";

const SCENE: SceneData = {
  harbors: [
    { id: "ethereum", name: "Ethereum", totalUsd: 1, stablecoinCount: 1, change7dPct: 0, resilienceTier: 1, boats: [] },
    { id: "tron", name: "Tron", totalUsd: 1, stablecoinCount: 1, change7dPct: 0, resilienceTier: 2, boats: [] },
  ],
  beam: { color: "#22c55e", sweepSeconds: 12, band: "BEDROCK", score: 100 },
  sea: { amplitudePx: 1.5, highestBand: "CALM", tintHex: "#3a4f7a" },
  horizon: { cohorts: [] },
};

describe("UIOverlay", () => {
  afterEach(() => cleanup());

  it("renders a button for each positioned harbour", () => {
    const positions = new Map([
      ["ethereum", { x: 100, y: 200 }],
      ["tron", { x: 300, y: 250 }],
    ]);
    render(<UIOverlay scene={SCENE} positions={positions} />);
    expect(screen.getByText("Ethereum")).toBeTruthy();
    expect(screen.getByText("Tron")).toBeTruthy();
  });

  it("omits buttons for harbours without a position", () => {
    const positions = new Map([["ethereum", { x: 100, y: 200 }]]);
    render(<UIOverlay scene={SCENE} positions={positions} />);
    expect(screen.queryByText("Ethereum")).toBeTruthy();
    expect(screen.queryByText("Tron")).toBeNull();
  });
});
