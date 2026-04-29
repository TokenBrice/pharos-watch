import { describe, expect, it } from "vitest";
import type { BuildingType, PharosVilleWorld, VisualCue, VisualCueChannel } from "./world-types";
import { buildVisualCueRegistry } from "./visual-cue-registry";

const BUILDING_TYPES = [
  "mint-burn-foundry",
  "exit-route-gatehouse",
  "yield-orchard-moonwell",
  "dependency-loom-chainworks",
] as const satisfies readonly BuildingType[];

const ALLOWED_CHANNELS = [
  "color",
  "glow",
  "motion",
  "opacity",
  "position",
  "shape",
  "size",
] as const satisfies readonly VisualCueChannel[];

const STRUCTURAL_WORLD_FIELDS = {
  effects: "WorldEffect entries are bounded annotations on already-cued entities, not standalone analytical targets.",
} as const satisfies Partial<Record<keyof PharosVilleWorld, string>>;

function cueKey(cue: VisualCue): string {
  if (cue.target.kind === "building") return `building:${cue.target.buildingType}`;
  if (cue.target.kind === "area") return `area:${cue.target.dataAreaType}`;
  return cue.target.kind;
}

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
      "cue.ship-cluster",
      "cue.building.mint-burn-foundry",
      "cue.area.north-froze-pole",
      "cue.building.exit-route-gatehouse",
      "cue.building.yield-orchard",
      "cue.building.dependency-loom",
    ]));
    expect(cues.find((cue) => cue.id === "cue.ship.motion")).toMatchObject({
      visual: "ship route and docking cadence",
      sourceField: "stablecoins.peggedAssets[].chainCirculating, pegSummary.coins[], stress.signals[]",
      failureState: "reduced-motion static harbor mooring or risk patrol / data fog",
      domEquivalent: "ship detail route facts and accessibility ledger",
      target: { kind: "ship" },
      primaryChannels: ["motion", "position", "opacity"],
    });
    expect(cues.every((cue) => cue.sourceField && cue.domEquivalent && cue.failureState && cue.reducedMotionEquivalent)).toBe(true);
  });

  it("uses explicit typed targets instead of cue-id suffixes for building and North Froze Pole coverage", () => {
    const cues = buildVisualCueRegistry();
    const buildingTargets = cues
      .map((cue) => cue.target)
      .filter((target) => target.kind === "building")
      .map((target) => target.buildingType);

    expect(new Set(buildingTargets)).toEqual(new Set(BUILDING_TYPES));
    expect(buildingTargets).toHaveLength(BUILDING_TYPES.length);
    expect(cues).toContainEqual(expect.objectContaining({
      target: { kind: "area", dataAreaType: "north-froze-pole" },
    }));
  });

  it("covers world node kinds or records a structural-only exclusion", () => {
    const cues = buildVisualCueRegistry();
    const targetKeys = new Set(cues.map(cueKey));
    const coveredWorldFields = {
      areas: targetKeys.has("area:north-froze-pole"),
      buildings: BUILDING_TYPES.every((buildingType) => targetKeys.has(`building:${buildingType}`)),
      docks: targetKeys.has("dock"),
      graves: targetKeys.has("grave"),
      lighthouse: targetKeys.has("lighthouse"),
      shipClusters: targetKeys.has("ship-cluster"),
      ships: targetKeys.has("ship"),
    } as const satisfies Partial<Record<keyof PharosVilleWorld, boolean>>;

    expect(coveredWorldFields).toEqual({
      areas: true,
      buildings: true,
      docks: true,
      graves: true,
      lighthouse: true,
      shipClusters: true,
      ships: true,
    });
    expect(STRUCTURAL_WORLD_FIELDS).toEqual({
      effects: "WorldEffect entries are bounded annotations on already-cued entities, not standalone analytical targets.",
    });
  });

  it("requires source, question, failure, DOM parity, target, and non-color-only channels", () => {
    const cues = buildVisualCueRegistry();
    const allowed = new Set<VisualCueChannel>(ALLOWED_CHANNELS);

    expect(cues).not.toHaveLength(0);
    for (const cue of cues) {
      expect(cue.sourceField.trim()).not.toBe("");
      expect(cue.questionAnswered.trim()).not.toBe("");
      expect(cue.failureState.trim()).not.toBe("");
      expect(cue.domEquivalent.trim()).not.toBe("");
      expect(cue.reducedMotionEquivalent.trim()).not.toBe("");
      expect(cue.target.kind).toBeTruthy();
      expect(cue.primaryChannels.length).toBeGreaterThan(0);
      expect(cue.primaryChannels.every((channel) => allowed.has(channel))).toBe(true);
      expect(cue.primaryChannels).not.toEqual(["color"]);
    }
  });

  it("requires motion cues to document reduced-motion equivalents", () => {
    const motionCues = buildVisualCueRegistry().filter((cue) => cue.primaryChannels.includes("motion"));

    expect(motionCues).not.toHaveLength(0);
    for (const cue of motionCues) {
      expect(cue.reducedMotionEquivalent).toMatch(/static|without RAF|frozen|representative/i);
    }
  });

  it("describes area cues as printed cartographic labels instead of signs or posts", () => {
    const areaCues = buildVisualCueRegistry().filter((cue) => cue.target.kind === "area");

    expect(areaCues.map((cue) => cue.visual)).toEqual(expect.arrayContaining([
      expect.stringContaining("printed cartographic"),
    ]));
    for (const cue of areaCues) {
      expect(cue.visual).not.toMatch(/\b(sign|post|board|badge)\b/i);
    }
  });
});
