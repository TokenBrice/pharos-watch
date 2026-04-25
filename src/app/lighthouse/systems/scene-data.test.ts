import { describe, it, expect } from "vitest";
import { buildSceneData } from "./scene-data";
import {
  fixtureChains,
  fixtureStability,
  fixtureStress,
  fixtureStablecoins,
} from "../__fixtures__/scene-data";

describe("buildSceneData", () => {
  const scene = buildSceneData({
    chains: fixtureChains,
    stability: fixtureStability,
    stress: fixtureStress,
    stablecoins: fixtureStablecoins,
  });

  it("emits one harbor per chain", () => {
    expect(scene.harbors.map((h) => h.id)).toEqual(["ethereum", "tron"]);
  });

  it("orders harbors by totalUsd desc", () => {
    expect(scene.harbors[0].totalUsd).toBeGreaterThanOrEqual(scene.harbors[1].totalUsd);
  });

  it("each harbor has boats keyed by topStablecoins", () => {
    const eth = scene.harbors[0];
    expect(eth.boats.map((b) => b.coinId)).toEqual(["usdt", "usdc", "dai"]);
  });

  it("boat style derives from governance/backing", () => {
    const eth = scene.harbors[0];
    expect(eth.boats.find((b) => b.coinId === "usdt")?.style).toBe("galleon");
    expect(eth.boats.find((b) => b.coinId === "dai")?.style).toBe("schooner");
  });

  it("boat pennant color comes from THREAT_BAND_HEX via stress signals", () => {
    const eth = scene.harbors[0];
    expect(eth.boats.find((b) => b.coinId === "usdt")?.pennantHex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("boats with no stress signal get neutral pennant", () => {
    expect(scene.harbors[1].boats[0].pennantHex).toBeDefined();
  });

  it("beam color matches PSI band STEADY", () => {
    expect(scene.beam.color).toBe("#14b8a6");
    expect(scene.beam.sweepSeconds).toBe(9);
  });

  it("includes alt-peg cohort silhouettes", () => {
    expect(scene.horizon.cohorts.length).toBeGreaterThanOrEqual(0);
  });

  it("returns deterministic results for the same inputs", () => {
    const scene2 = buildSceneData({
      chains: fixtureChains,
      stability: fixtureStability,
      stress: fixtureStress,
      stablecoins: fixtureStablecoins,
    });
    expect(scene2).toEqual(scene);
  });
});
