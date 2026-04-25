// src/app/lighthouse/systems/reduced-motion-freeze.test.ts
import { describe, it, expect } from "vitest";
import { pickLargestHarborPlacement, aimBeamAt } from "./reduced-motion-freeze";
import type { HarborPlacement } from "../layers/harbor-layer";
import type { SceneData } from "./scene-data";

const scene: SceneData = {
  harbors: [
    { id: "tron", name: "Tron", totalUsd: 300_000_000, stablecoinCount: 4, change7dPct: 0, resilienceTier: 2, boats: [] },
    { id: "ethereum", name: "Ethereum", totalUsd: 600_000_000, stablecoinCount: 12, change7dPct: 0, resilienceTier: 1, boats: [] },
  ],
  beam: { color: "#22c55e", sweepSeconds: 12, band: "BEDROCK", score: 100 },
  sea: { amplitudePx: 1.5, highestBand: "CALM", tintHex: "#3a4f7a" },
  horizon: { cohorts: [] },
};

function placement(id: string, x: number, y: number, harbor: SceneData["harbors"][number]): HarborPlacement {
  return { harbor, worldX: x, worldY: y, dockEndX: 0, dockEndY: 0, lamps: [] };
}

describe("pickLargestHarborPlacement", () => {
  it("picks the highest totalUsd harbour that has a placement", () => {
    const placements = new Map<string, HarborPlacement>([
      ["tron", placement("tron", 100, 100, scene.harbors[0])],
      ["ethereum", placement("ethereum", 500, 200, scene.harbors[1])],
    ]);
    const best = pickLargestHarborPlacement(scene, placements);
    expect(best?.harbor.id).toBe("ethereum");
  });

  it("returns null if no placement matches", () => {
    expect(pickLargestHarborPlacement(scene, new Map())).toBeNull();
  });
});

describe("aimBeamAt", () => {
  it("sets rotationRad to atan2 of dy/dx", () => {
    const beam = { rotationRad: 0 };
    aimBeamAt(beam, 0, 0, 10, 0);
    expect(beam.rotationRad).toBeCloseTo(0, 6);
    aimBeamAt(beam, 0, 0, 0, 10);
    expect(beam.rotationRad).toBeCloseTo(Math.PI / 2, 6);
  });
});
