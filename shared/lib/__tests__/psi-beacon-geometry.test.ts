import { describe, expect, it } from "vitest";
import { buildPsiBeaconModel, derivePsiBeaconState, type PsiBeaconCurrentLike } from "../psi-beacon";
import {
  estimatePsiBeaconLabelBox,
  layoutPsiBeacon,
  psiBeaconRadius,
  psiBeaconViewBox,
  type PsiBeaconLabelBox,
} from "../psi-beacon-geometry";
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

describe("layoutPsiBeacon", () => {
  it("maps ruler values linearly to world radius with no floor", () => {
    const r0 = psiBeaconRadius(0);
    const r100 = psiBeaconRadius(100);
    expect(psiBeaconRadius(50)).toBeCloseTo((r0 + r100) / 2, 10);
    expect(psiBeaconRadius(-5)).toBe(r0);
    expect(psiBeaconRadius(120)).toBe(r100);
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

  it("keeps the lower-bound mark compact on the severity bank", () => {
    const result = layout({ ...LIVE, inputDegradation: { openDepegNoPrice: true, openDepegsWithoutPrice: 3 } });
    expect(result.fog[0].lowerBound?.text).toBe("≥");
  });

  it.each([
    [89.0, 89.0, { severity: 0.02, breadth: 9.5, stressBreadth: 1.48, trend: 0 }],
    [91.9, 92.1, LIVE.components!],
    [91.9, 96.5, LIVE.components!],
    [91.9, 99.5, LIVE.components!],
  ])(
    "flips avgTick past 75 and avoids bounding collision or right-edge clipping at score=%s avg=%s with unpriced lower bound",
    (score, avg24h, components) => {
      const box = psiBeaconViewBox(SCENE_DIMETRIC);
      const result = layout({
        ...LIVE,
        score,
        band: score >= 90 ? "BEDROCK" : "STEADY",
        avg24h,
        components,
        inputDegradation: { openDepegNoPrice: true, openDepegsWithoutPrice: 3 },
      });
      const avgLabel = result.avgTick!.label;
      const lowerBound = result.fog[0]!.lowerBound!;
      expect(avgLabel.anchor).toBe("end");

      const overlaps = (a: PsiBeaconLabelBox, b: PsiBeaconLabelBox) =>
        a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

      const avgBox = estimatePsiBeaconLabelBox(avgLabel);
      const lowerBox = estimatePsiBeaconLabelBox(lowerBound);
      expect(overlaps(avgBox, lowerBox)).toBe(false);
      for (const ring of result.rings) {
        expect(overlaps(avgBox, estimatePsiBeaconLabelBox(ring.label))).toBe(false);
      }
      for (const candidate of [avgBox, lowerBox, ...result.rings.map((ring) => estimatePsiBeaconLabelBox(ring.label))]) {
        expect(candidate.x0).toBeGreaterThanOrEqual(box.x);
        expect(candidate.x1).toBeLessThanOrEqual(box.x + box.width);
      }
    },
  );
});
