import { describe, it, expect } from "vitest";
import { computeEffectiveSource } from "./format";
import type { FollowedPreset, SubscribedCoin, TelegramMiniAppState } from "./types";

type GlobalAlerts = TelegramMiniAppState["subscriber"]["globalAlerts"];

function makeCoin(
  alertTypes: Partial<SubscribedCoin["alertTypes"]>,
  alertOverrides: Partial<NonNullable<SubscribedCoin["alertOverrides"]>> = {},
): SubscribedCoin {
  return {
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    alertTypes: { dews: false, depeg: false, safety: false, launch: false, reserve: false, ...alertTypes },
    alertOverrides: { dews: false, depeg: false, safety: false, launch: false, reserve: false, ...alertOverrides },
    dewsMinBand: null,
    depegStepBps: null,
    safetyMode: null,
    snoozeUntilTs: null,
  };
}

const NO_GLOBAL: GlobalAlerts = { dews: false, depeg: false, safety: false, launch: false, reserve: false, depegStepBps: null };

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
    const global: GlobalAlerts = { dews: true, depeg: false, safety: false, launch: false, reserve: false, depegStepBps: null };
    const result = computeEffectiveSource(makeCoin({}, { dews: true }), global, []);
    expect(result.dews).toBe("off-override");
  });

  it("treats an off type as an off-override when a followed preset would otherwise cover it", () => {
    const result = computeEffectiveSource(makeCoin({}, { depeg: true }), NO_GLOBAL, [makePreset({ depeg: true })]);
    expect(result.depeg).toBe("off-override");
  });

  it("does not treat an unmarked legacy/default zero as a local opt-out", () => {
    const global: GlobalAlerts = { dews: true, depeg: false, safety: false, launch: false, reserve: false, depegStepBps: null };
    const result = computeEffectiveSource(makeCoin({}), global, []);
    expect(result.dews).toBe("global");
  });

  it("lets per-coin win over a preset/global that also covers the type", () => {
    const global: GlobalAlerts = { dews: true, depeg: false, safety: false, launch: false, reserve: false, depegStepBps: null };
    const result = computeEffectiveSource(makeCoin({ dews: true }), global, [makePreset({ dews: true })]);
    expect(result.dews).toBe("per-coin");
  });

  it("ignores presets for the launch type (presets do not cover launch)", () => {
    const result = computeEffectiveSource(makeCoin({}), NO_GLOBAL, [makePreset({ dews: true })]);
    expect(result.launch).toBe("global");
  });

  it("classifies Reserve-only rows as per-coin", () => {
    const result = computeEffectiveSource(makeCoin({ reserve: true }), NO_GLOBAL, []);
    expect(result.reserve).toBe("per-coin");
  });

  it("ignores presets for the reserve type (presets do not cover reserve)", () => {
    const result = computeEffectiveSource(makeCoin({}), NO_GLOBAL, [makePreset({ dews: true, depeg: true, safety: true })]);
    expect(result.reserve).toBe("global");
  });
});
