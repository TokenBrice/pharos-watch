import { describe, expect, it } from "vitest";
import type { PharosVilleWorld, VisualCue, VisualCueChannel, WorldEffect } from "./world-types";
import { buildVisualCueRegistry } from "./visual-cue-registry";

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
  effects: "WorldEffect entries must declare analytical cue metadata or explicit non-data ambient purpose.",
} as const satisfies Partial<Record<keyof PharosVilleWorld, string>>;

function cueKey(cue: VisualCue): string {
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
      "cue.water.semantic-terrain",
    ]));
    expect(cues.find((cue) => cue.id === "cue.ship.motion")).toMatchObject({
      visual: "ship route and docking cadence",
      sourceField: "stablecoins.peggedAssets[].chainCirculating, pegSummary.coins[], stress.signals[]",
      failureState: "reduced-motion static risk-water idle position with evidence caveat",
      domEquivalent: "ship detail route facts and accessibility ledger",
      target: { kind: "ship" },
      primaryChannels: ["motion", "position", "opacity"],
    });
    expect(cues.every((cue) => cue.sourceField && cue.domEquivalent && cue.failureState && cue.reducedMotionEquivalent)).toBe(true);
  });

  it("does not expose removed data-building cue targets", () => {
    const cues = buildVisualCueRegistry();
    expect(cues.map((cue) => cue.id).filter((id) => id.startsWith("cue.building."))).toEqual([]);
    expect(cues).toContainEqual(expect.objectContaining({ target: { kind: "area" } }));
  });

  it("covers world node kinds or records a structural-only exclusion", () => {
    const cues = buildVisualCueRegistry();
    const targetKeys = new Set(cues.map(cueKey));
    const coveredWorldFields = {
      areas: targetKeys.has("area"),
      docks: targetKeys.has("dock"),
      graves: targetKeys.has("grave"),
      lighthouse: targetKeys.has("lighthouse"),
      shipClusters: targetKeys.has("ship-cluster"),
      ships: targetKeys.has("ship"),
    } as const satisfies Partial<Record<keyof PharosVilleWorld, boolean>>;

    expect(coveredWorldFields).toEqual({
      areas: true,
      docks: true,
      graves: true,
      lighthouse: true,
      shipClusters: true,
      ships: true,
    });
    expect(STRUCTURAL_WORLD_FIELDS).toEqual({
      effects: "WorldEffect entries must declare analytical cue metadata or explicit non-data ambient purpose.",
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

  it("enforces analytical effect cue metadata and explicit ambient non-data markings", () => {
    const cues = buildVisualCueRegistry();
    const validEffects: WorldEffect[] = [
      {
        cueId: "cue.ship.motion",
        entityId: "ship.usdc-circle",
        id: "effect.route",
        intensity: 0.6,
        kind: "recent-change",
        purpose: "analytical",
        reducedMotionEquivalent: "static selected route line and detail facts",
      },
      {
        entityId: "lighthouse",
        id: "effect.birds",
        intensity: 0.2,
        kind: "fog",
        nonData: true,
        purpose: "ambient",
        reducedMotionEquivalent: "ambient birds hidden or static without analytical meaning",
      },
    ];
    const invalidEffects: WorldEffect[] = [
      {
        entityId: "ship.usdc-circle",
        id: "effect.missing-cue",
        intensity: 0.6,
        kind: "recent-change",
        purpose: "analytical",
        reducedMotionEquivalent: "static detail facts",
      },
      {
        entityId: "lighthouse",
        id: "effect.ambient-not-marked",
        intensity: 0.2,
        kind: "fog",
        purpose: "ambient",
        reducedMotionEquivalent: "static ambient detail",
      },
    ];

    expect(effectCueParityFailures(validEffects, cues)).toEqual([]);
    expect(effectCueParityFailures(invalidEffects, cues)).toEqual([
      "effect.missing-cue missing analytical cueId",
      "effect.ambient-not-marked ambient effect missing nonData=true",
    ]);
  });
});

function effectCueParityFailures(effects: readonly WorldEffect[], cues: readonly VisualCue[]): string[] {
  const cueIds = new Set(cues.map((cue) => cue.id));
  const failures: string[] = [];
  for (const effect of effects) {
    if (!effect.reducedMotionEquivalent.trim()) failures.push(`${effect.id} missing reduced-motion equivalent`);
    if (effect.purpose === "ambient") {
      if (effect.nonData !== true) failures.push(`${effect.id} ambient effect missing nonData=true`);
      continue;
    }
    if (!effect.cueId) {
      failures.push(`${effect.id} missing analytical cueId`);
      continue;
    }
    if (!cueIds.has(effect.cueId)) failures.push(`${effect.id} references unknown cueId`);
  }
  return failures;
}
