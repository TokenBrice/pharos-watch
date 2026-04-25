import { describe, it, expect } from "vitest";
import gsap from "gsap";
import { createTimelineRegistry } from "./timeline-registry";
import { startBeamSweep, startLanternPulse, setBeamSweepDuration } from "./animation";

describe("animation helpers", () => {
  it("startBeamSweep parents tween to the registry timeline", () => {
    const reg = createTimelineRegistry(gsap);
    const beam = { rotationRad: 0, alpha: 0.55, colorHex: "#22c55e" };
    const tween = startBeamSweep(beam, 6, reg);
    expect(tween.duration()).toBe(6);
    expect(tween.parent === reg.parent || tween.parent?.parent === reg.parent).toBe(true);
    reg.destroy();
  });

  it("startLanternPulse yoyos alpha around 0.85 / 0.7", () => {
    const reg = createTimelineRegistry(gsap);
    const lantern = { alpha: 0.85 };
    const tween = startLanternPulse(lantern, reg);
    expect(tween.repeat()).toBe(-1);
    expect(tween.yoyo()).toBe(true);
    reg.destroy();
  });

  it("setBeamSweepDuration preserves progress", () => {
    const reg = createTimelineRegistry(gsap);
    const beam = { rotationRad: 0, alpha: 0.55, colorHex: "#22c55e" };
    const tween = startBeamSweep(beam, 6, reg);
    tween.progress(0.5);
    setBeamSweepDuration(tween, 12);
    expect(tween.duration()).toBe(12);
    expect(tween.progress()).toBeCloseTo(0.5, 5);
    reg.destroy();
  });
});
