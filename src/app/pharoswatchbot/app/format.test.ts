import { describe, it, expect } from "vitest";
import { computeEffectiveSource } from "./format";
import { makeSubscribedCoin as makeCoin } from "./mini-app-test-fixtures";
import type { FollowedPreset, TelegramMiniAppState } from "./types";

type GlobalAlerts = TelegramMiniAppState["subscriber"]["globalAlerts"];

const NO_GLOBAL: GlobalAlerts = { dews: false, depeg: false, safety: false, launch: false, reserve: false, freeze: false, depegStepBps: null };

function makePreset(alertTypes: Partial<FollowedPreset["alertTypes"]>): FollowedPreset {
  return {
    id: "usd-top25",
    label: "USD Top 25",
    alertTypes: { dews: false, depeg: false, safety: false, ...alertTypes },
    depegStepBps: null,
  };
}

describe("computeEffectiveSource", () => {
  it("classifies an enabled per-coin flag as per-coin", () => {
    const result = computeEffectiveSource(makeCoin({ dews: true }), NO_GLOBAL, []);
    expect(result.dews).toBe("per-coin");
  });

  it("classifies an off type with no preset/global coverage as the global default lane", () => {
    const result = computeEffectiveSource(makeCoin({ dews: true }), NO_GLOBAL, []);
    expect(result.depeg).toBe("global");
    expect(result.safety).toBe("global");
    expect(result.launch).toBe("global");
  });

  it("treats an all-off row as an off-override when a global default would otherwise cover it", () => {
    const global: GlobalAlerts = { dews: true, depeg: false, safety: false, launch: false, reserve: false, freeze: false, depegStepBps: null };
    const result = computeEffectiveSource(makeCoin({}, { dews: true }), global, []);
    expect(result.dews).toBe("off-override");
  });

  it("treats an off type as an off-override when a followed preset would otherwise cover it", () => {
    const result = computeEffectiveSource(makeCoin({}, { depeg: true }), NO_GLOBAL, [makePreset({ depeg: true })]);
    expect(result.depeg).toBe("off-override");
  });

  it("does not treat an unmarked legacy/default zero as a local opt-out", () => {
    const global: GlobalAlerts = { dews: true, depeg: false, safety: false, launch: false, reserve: false, freeze: false, depegStepBps: null };
    const result = computeEffectiveSource(makeCoin({}), global, []);
    expect(result.dews).toBe("global");
  });

  it("lets per-coin win over a preset/global that also covers the type", () => {
    const global: GlobalAlerts = { dews: true, depeg: false, safety: false, launch: false, reserve: false, freeze: false, depegStepBps: null };
    const result = computeEffectiveSource(makeCoin({ dews: true }), global, [makePreset({ dews: true })]);
    expect(result.dews).toBe("per-coin");
  });

  it("ignores presets for the launch type (presets do not cover launch)", () => {
    expect(computeEffectiveSource(makeCoin({}, { dews: true, launch: true }), NO_GLOBAL, [makePreset({ dews: true })])).toEqual({
      dews: "off-override",
      depeg: "global",
      safety: "global",
      launch: "global",
      reserve: "global",
      freeze: "global",
    });
    expect(computeEffectiveSource(makeCoin({}, { launch: true }), { ...NO_GLOBAL, launch: true }, []).launch).toBe("off-override");
  });

  it("classifies Reserve-only rows as per-coin", () => {
    const result = computeEffectiveSource(makeCoin({ reserve: true }), NO_GLOBAL, []);
    expect(result.reserve).toBe("per-coin");
  });

  it("ignores presets for the reserve type (presets do not cover reserve)", () => {
    expect(computeEffectiveSource(makeCoin({}, { dews: true, reserve: true }), NO_GLOBAL, [makePreset({ dews: true })]).reserve).toBe("global");
    expect(computeEffectiveSource(makeCoin({}, { reserve: true }), { ...NO_GLOBAL, reserve: true }, []).reserve).toBe("off-override");
  });

  it("classifies freeze-only rows as direct and never inherits freeze from presets", () => {
    expect(computeEffectiveSource(makeCoin({ freeze: true }), NO_GLOBAL, []).freeze).toBe("per-coin");
    expect(computeEffectiveSource(makeCoin({}, { dews: true, freeze: true }), NO_GLOBAL, [makePreset({ dews: true })]).freeze).toBe("global");
    expect(computeEffectiveSource(makeCoin({}, { freeze: true }), { ...NO_GLOBAL, freeze: true }, []).freeze).toBe("off-override");
  });

});
