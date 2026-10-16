import { describe, expect, it } from "vitest";
import { RatioSchema } from "../../types/ratio";
import { buildHarborScene, type HarborChainInput, type HarborSceneInput } from "../harbor-scene";
import { buildHarborGeometry, validateHarborCapacity, type HarborPreset } from "../harbor-scene-geometry";
import { HARBOR_LIVE, scaleHarborInput as scale } from "./harbor-scene.test-support";

const LIVE = HARBOR_LIVE;
const PRESETS: HarborPreset[] = ["wide", "narrow"];


function synthetic(count: number): HarborSceneInput {
  const chains: HarborChainInput[] = Array.from({ length: count }, (_, k) => {
    const totalUsd = 150e9 / (k + 1) ** 1.6;
    return {
      id: `chain-${String(k).padStart(3, "0")}`,
      name: `Chain ${k}`,
      logoPath: "/chains/ethereum.png",
      totalUsd,
      change7d: totalUsd * 0.01,
      change7dPct: RatioSchema.parse(((k % 7) - 3) / 100),
      stablecoinCount: 1,
      topStablecoins: [{ id: "usdc-circle", symbol: "USDC", share: 1, supplyUsd: totalUsd }],
      dominanceShare: 0,
      healthScore: 60,
      healthBand: "mixed",
      unavailableSupplyObservationCount: 0,
    };
  });
  const attributed = chains.reduce((s, c) => s + c.totalUsd, 0);
  return { chains, globalTotalUsd: attributed + 5e9, chainAttributedTotalUsd: attributed, unattributedTotalUsd: 5e9, attributionDiscrepancyUsd: -5e9, updatedAt: 1 };
}

describe("buildHarborGeometry", () => {
  const scene = buildHarborScene(LIVE);

  it("tints wakes only from the hue threshold; smaller moves stay neutral ink", () => {
    const wakeClasses = (pct: number) => {
      const input = synthetic(3);
      input.chains = input.chains.map((chain, index) =>
        index === 0 ? { ...chain, change7dPct: RatioSchema.parse(pct / 100) } : chain);
      const g = buildHarborGeometry(buildHarborScene(input), "wide");
      return [...new Set(g.berths[0]!.wake.map((m) => m.cls))];
    };
    expect(wakeClasses(-1)).toEqual(["wake-down"]);
    expect(wakeClasses(6)).toEqual(["wake-up wake-hue"]);
    expect(wakeClasses(-12)).toEqual(["wake-down wake-hue", "wake-break wake-down wake-hue"]);
  });

  it.each(PRESETS)("draws one berth per vessel and every container (%s)", (preset) => {
    const geometry = buildHarborGeometry(scene, preset);
    expect(geometry.berths.map((b) => b.id)).toEqual(scene.vessels.map((v) => v.id));
    for (const berth of geometry.berths) {
      const vessel = scene.vessels.find((v) => v.id === berth.id)!;
      expect(berth.containerCount).toBe(vessel.containers.length);
      const cargoFaces = berth.marks.filter((m) => /^cg-[a-z]+-t\b/.test(m.cls)).length;
      const bands = vessel.containers.reduce((s, c) => s + c.bands.length, 0);
      expect(cargoFaces).toBe(bands);
    }
  });

});

describe("validateHarborCapacity", () => {
  const fixtures: [string, HarborSceneInput][] = [
    ["today", LIVE],
    ["today ×2", scale(LIVE, 2)],
    ["today ×4", scale(LIVE, 4)],
    ["one chain", { ...LIVE, chains: LIVE.chains.filter((c) => c.id === "ethereum"), chainAttributedTotalUsd: LIVE.chains.find((c) => c.id === "ethereum")!.totalUsd }],
    ["150 chains", synthetic(150)],
  ];
  for (const [name, input] of fixtures) {
    it.each(PRESETS)(`${name} fits the %s preset`, (preset) => {
      const report = validateHarborCapacity(buildHarborScene(input), preset);
      expect(report.issues).toEqual([]);
      expect(report.ok).toBe(true);
    });
  }

  it("reports tiering beyond $160B instead of rescaling the unit", () => {
    expect(validateHarborCapacity(buildHarborScene(scale(LIVE, 2)), "wide").tiered).toBe(true);
    expect(validateHarborCapacity(buildHarborScene(LIVE), "wide").tiered).toBe(false);
  });
});
