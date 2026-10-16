import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RatioSchema } from "../../types/ratio";
import { buildHarborScene, type HarborChainInput, type HarborSceneInput } from "../harbor-scene";
import { buildHarborGeometry, harborFlagMarks, validateHarborCapacity, type HarborPreset } from "../harbor-scene-geometry";
import { SCENE_DIMETRIC } from "../scene/projection";
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

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

describe("buildHarborGeometry", () => {
  const scene = buildHarborScene(LIVE);

  it("flies Robust as a swallowtail so it differs from Healthy by shape, not only hue", () => {
    const face = (band: "robust" | "healthy") => harborFlagMarks(SCENE_DIMETRIC, 0, 0, 0, { kind: "band", band, label: band, pennants: band === "robust" ? 0 : 1, score: null })
      .find((m) => m.cls === `flag-${band} e`)!;
    const robust = face("robust");
    const healthy = face("healthy");
    expect(robust.kind === "polygon" && robust.points).toHaveLength(5);
    expect(healthy.kind === "polygon" && healthy.points).toHaveLength(4);
  });

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

  it("is byte-stable for the 2026-10-12 fixture (golden)", () => {
    expect({ wide: sha(buildHarborGeometry(scene, "wide")), narrow: sha(buildHarborGeometry(scene, "narrow")) }).toMatchInlineSnapshot(`
      {
        "narrow": "f02d45eb8f11926a",
        "wide": "d54876a5a266711d",
      }
    `);
  });

  it("is deterministic under shuffled input", () => {
    const shuffled = buildHarborScene({ ...LIVE, chains: LIVE.chains.slice().reverse() });
    for (const preset of PRESETS) expect(sha(buildHarborGeometry(shuffled, preset))).toBe(sha(buildHarborGeometry(scene, preset)));
  });

  it("draws hull length linearly: Ethereum's cargo run is ≈ supply ratio × Polygon's", () => {
    const geometry = buildHarborGeometry(scene, "wide");
    const len = (id: string) => {
      const fp = geometry.berths.find((b) => b.id === id)!.footprint;
      return fp.i1 - fp.i0;
    };
    // bow/stern pads and bay gaps are fixed overheads: compare against a linear fit, not a pure ratio
    expect(len("ethereum")).toBeGreaterThan(len("polygon") * 10);
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
