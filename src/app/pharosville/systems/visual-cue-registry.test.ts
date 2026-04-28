import { describe, expect, it } from "vitest";
import { buildVisualCueRegistry } from "./visual-cue-registry";

describe("buildVisualCueRegistry", () => {
  it("documents visual cues with source and DOM equivalents", () => {
    const cues = buildVisualCueRegistry();

    expect(cues.map((cue) => cue.id)).toContain("cue.lighthouse.psi");
    expect(cues.map((cue) => cue.id)).toEqual(expect.arrayContaining([
      "cue.ship.hull",
      "cue.ship.rigging",
      "cue.ship.pennant",
      "cue.ship.scale",
    ]));
    expect(cues.every((cue) => cue.sourceField && cue.domEquivalent && cue.failureState)).toBe(true);
  });
});
