import { describe, expect, it } from "vitest";
import { buildPsiBeaconModel, derivePsiBeaconState, type PsiBeaconCurrentLike } from "../psi-beacon";
import { layoutPsiBeacon, psiBeaconRadius, psiBeaconViewBox } from "../psi-beacon-geometry";
import { SCENE_DIMETRIC } from "../scene/projection";

const LIVE: PsiBeaconCurrentLike = {
  score: 91.9,
  band: "BEDROCK",
  avg24h: 92.1,
  computedAt: 1,
  components: { severity: 0.02, breadth: 6.65, stressBreadth: 1.33, trend: -0.14 },
};

function layout(current: PsiBeaconCurrentLike | null, isFresh = true) {
  return layoutPsiBeacon(buildPsiBeaconModel(derivePsiBeaconState({ current, isFresh })), SCENE_DIMETRIC);
}

function xs(points: string): number[] {
  return points.split(" ").map((pair) => Number(pair.split(",")[0]));
}

describe("layoutPsiBeacon", () => {
  it("maps ruler values linearly to world radius with no floor", () => {
    const r0 = psiBeaconRadius(0);
    const r100 = psiBeaconRadius(100);
    expect(psiBeaconRadius(50)).toBeCloseTo((r0 + r100) / 2, 10);
    expect(psiBeaconRadius(-5)).toBe(r0);
    expect(psiBeaconRadius(120)).toBe(r100);
  });

  it("ends the lit beam where its tip tick sits and before the fog", () => {
    const result = layout(LIVE);
    const beamMaxX = Math.max(...xs(result.beam!.points));
    const tipX = Math.max(result.beam!.tip.x1, result.beam!.tip.x2);
    expect(beamMaxX).toBeCloseTo(tipX, 0);
    const breadth = result.fog.find((bank) => bank.key === "breadth")!;
    expect(Math.min(...xs(breadth.points))).toBeGreaterThan(Math.min(...xs(result.beam!.points)));
  });

  it("keeps every ring, label and the full ruler inside the fixed viewBox", () => {
    const box = psiBeaconViewBox(SCENE_DIMETRIC);
    const result = layout(LIVE);
    const points = [
      ...result.rings.map((ring) => [ring.label.x, ring.label.y]),
      ...result.zones.map((zone) => [zone.label.x, zone.label.y]),
      [result.axis.x2, result.axis.y2],
      [result.avgTick!.label.x, result.avgTick!.label.y],
    ];
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(box.x);
      expect(x).toBeLessThanOrEqual(box.x + box.width);
      expect(y).toBeGreaterThanOrEqual(box.y);
      expect(y).toBeLessThanOrEqual(box.y + box.height);
    }
  });

  it("draws nothing data-bound when unavailable, but keeps the rings", () => {
    const result = layout({ ...LIVE, band: "UNKNOWN" });
    expect(result.beam).toBeNull();
    expect(result.fog).toEqual([]);
    expect(result.avgTick).toBeNull();
    expect(result.rings).toHaveLength(6);
  });

  it("labels a real zero score", () => {
    const result = layout({ ...LIVE, score: 0, band: "MELTDOWN" });
    expect(result.zeroLabel?.text).toBe("0");
  });

  it("names the lower bound on the severity bank", () => {
    const result = layout({ ...LIVE, inputDegradation: { openDepegNoPrice: true, openDepegsWithoutPrice: 3 } });
    expect(result.fog[0].lowerBound?.text).toBe("≥ · 3 unpriced");
  });
});
