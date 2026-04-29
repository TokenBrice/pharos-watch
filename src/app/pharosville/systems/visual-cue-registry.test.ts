import { describe, expect, it } from "vitest";
import { buildVisualCueRegistry } from "./visual-cue-registry";

describe("buildVisualCueRegistry", () => {
  it("documents visual cues with source and DOM equivalents", () => {
    const cues = buildVisualCueRegistry();

    expect(cues.map((cue) => cue.id)).toContain("cue.lighthouse.psi");
    expect(cues.map((cue) => cue.id)).toEqual(expect.arrayContaining([
      "cue.ship.motion",
      "cue.ship.hull",
      "cue.ship.rigging",
      "cue.ship.pennant",
      "cue.ship.scale",
      "cue.building.mint-burn-foundry",
      "cue.building.frost-ward-keep",
      "cue.building.exit-route-gatehouse",
      "cue.building.yield-orchard",
      "cue.building.dependency-loom",
    ]));
    expect(cues.find((cue) => cue.id === "cue.ship.motion")).toMatchObject({
      visual: "ship route and docking cadence",
      sourceField: "stablecoins.peggedAssets[].chainCirculating, pegSummary.coins[], stress.signals[]",
      failureState: "reduced-motion static harbor mooring or risk patrol / data fog",
      domEquivalent: "ship detail route facts and accessibility ledger",
    });
    expect(cues.every((cue) => cue.sourceField && cue.domEquivalent && cue.failureState)).toBe(true);
  });
});
