import { describe, expect, it } from "vitest";
import {
  BAND_GUIDE_DASHARRAY,
  CHART_KEY_PANEL,
  bubblesOverlap,
  classifyLogoPlate,
  centerHeroPair,
  computeDemandOrbitZones,
  loadLogoDataUri,
  buildPsiSubtitle,
  parsePsiResponse,
  placeSubgradeRadialLanes,
  radiusForMcap,
  renderPsiStatus,
  selectMapPsi,
  subgradeLaneForGrade,
  supplyMassBarWidth,
} from "../maintenance/build-safety-score-map";
import { PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/psi-colors";
import { validateAnnotationScene } from "../lib/map-annotations";

describe("Safety Map PSI footer", () => {
  it("uses the canonical one-decimal PSI level and condition band", () => {
    expect(buildPsiSubtitle({ score: 93.8, band: "BEDROCK", basis: "24H AVG" })).toBe(
      "PSI 93.8 · BEDROCK · 24H AVG",
    );
  });

  it.each(Object.entries(PSI_HEX_COLORS) as Array<[ConditionBand, string]>)(
    "themes %s with the canonical band colour while keeping small text neutral",
    (band, color) => {
      const svg = renderPsiStatus({ score: 92.6, band, basis: "24H AVG", computedAt: 1_777_000_000 }, 48, 886);
      expect(svg).toContain(`data-psi-band="${band}"`);
      expect(svg).toContain(`data-psi-color="${color}"`);
      expect(svg).toContain(`data-psi-band-marker="true" cx="52" cy="882.5" r="3.5" fill="${color}"`);
      expect(svg).toContain(`font-size="10.5" font-weight="750" fill="#f5f7fb" letter-spacing="0.25">PSI 92.6 · ${band} · 24H AVG</text>`);
    },
  );

  it("accepts the live PSI display fields and rejects incomplete rolling values", () => {
    expect(parsePsiResponse({
      current: {
        score: 94.3,
        band: "BEDROCK",
        avg24h: 93.8,
        avg24hBand: "BEDROCK",
        computedAt: 1_777_000_000,
      },
    }).current).toEqual({
      score: 94.3,
      band: "BEDROCK",
      avg24h: 93.8,
      avg24hBand: "BEDROCK",
      computedAt: 1_777_000_000,
    });
    expect(() => parsePsiResponse({
      current: { score: 94.3, band: "BEDROCK", avg24h: 93.8, computedAt: 1_777_000_000 },
    })).toThrow(/avg24h and current\.avg24hBand must appear together/);
  });

  it("labels the rolling display value and raw fallback explicitly", () => {
    expect(selectMapPsi({
      score: 94.3,
      band: "BEDROCK",
      avg24h: 93.8,
      avg24hBand: "BEDROCK",
      computedAt: 1_777_000_000,
    })).toEqual({ score: 93.8, band: "BEDROCK", basis: "24H AVG", computedAt: 1_777_000_000 });
    expect(selectMapPsi({ score: 72.1, band: "TREMOR", computedAt: 1_777_000_000 })).toEqual({
      score: 72.1,
      band: "TREMOR",
      basis: "RAW",
      computedAt: 1_777_000_000,
    });
  });
});

const radii = (overrides: Partial<Record<"A" | "B" | "C" | "D" | "F", number[]>> = {}) => ({
  A: [],
  B: Array.from({ length: 41 }, () => 7.8125),
  C: Array.from({ length: 133 }, () => 7.8125),
  D: Array.from({ length: 75 }, () => 7.8125),
  F: Array.from({ length: 56 }, () => 7.8125),
  ...overrides,
});

describe("Safety Map chart key geometry", () => {
  it("reserves a compact key panel in the header rather than the body", () => {
    expect(CHART_KEY_PANEL.y).toBeGreaterThanOrEqual(4);
    expect(CHART_KEY_PANEL.y + CHART_KEY_PANEL.h).toBeLessThan(68);
    expect(CHART_KEY_PANEL.x + CHART_KEY_PANEL.w).toBeLessThanOrEqual(1536);
    expect(CHART_KEY_PANEL.w).toBeGreaterThan(CHART_KEY_PANEL.h * 15);
  });

  it("keeps every outer guide pattern distinct without changing grade colours", () => {
    expect(new Set(["B", "C", "D", "F"].map((tier) => BAND_GUIDE_DASHARRAY[tier as "B" | "C" | "D" | "F"])).size).toBe(4);
  });

  it("uses the bubble radius function for both disclosed floors", () => {
    const k = 0.0002;
    const gravelFloor = 7.8125;
    const aFloorMcap = (10.9375 / k) ** 2;
    const otherFloorMcap = (gravelFloor / k) ** 2;
    expect(radiusForMcap("A", aFloorMcap, k, gravelFloor)).toBeCloseTo(10.9375, 10);
    expect(radiusForMcap("F", otherFloorMcap, k, gravelFloor)).toBeCloseTo(gravelFloor, 10);
  });
});

describe("Safety Map supply mass and demand bands", () => {
  it("centres the unequal hero pair by visible circle area", () => {
    const [left, right] = centerHeroPair(68, 42);
    expect(right - left).toBeCloseTo(112.5, 10);
    expect((left * 68 ** 2 + right * 42 ** 2) / (68 ** 2 + 42 ** 2)).toBeCloseTo(800, 10);
    expect(left).toBeLessThan(800);
    expect(right).toBeGreaterThan(800);
  });

  it("keeps the constructed hero pair legal under both collision predicates", () => {
    // `centerHeroPair` places the leaders at exactly `r0 + r1 + BUBBLE_GAP`, but
    // rebuilds that distance from two area-weighted divisions. A strict `<`
    // against the same sum therefore rejected a pair the layout had just built to
    // spec for ~44% of radius pairs (1-2 ULP short), which made a successful
    // render depend on the day's supply values: the poster published 2026-08-21
    // through 2026-08-24 and then could not fit at any scale on 2026-08-25 once
    // USDT re-entered tier A. Sweep realistic leader ratios rather than pinning
    // one pair, because the defect only appears for specific radii.
    for (let leader = 20; leader <= 70; leader += 0.5) {
      for (const ratio of [0.3, 0.4028, 0.45, 0.55, 0.635, 0.75, 0.9, 1]) {
        const follower = leader * ratio;
        const [left, right] = centerHeroPair(leader, follower);
        const pair = [
          { cx: left, cy: 0, r: leader },
          { cx: right, cy: 0, r: follower },
        ] as const;
        expect(bubblesOverlap(pair[0], pair[1])).toBe(false);
        expect(
          validateAnnotationScene(
            {
              frame: { x: -400, y: -400, w: 1600, h: 900 },
              circles: pair.map((bubble, index) => ({
                id: `hero-${index}`,
                role: "bubble" as const,
                cx: bubble.cx,
                cy: bubble.cy,
                r: bubble.r,
              })),
            },
            { bubbleGap: 2.5, labelGap: 1, leaderGap: 1 },
          ).filter((item) => item.code === "bubble-bubble"),
        ).toEqual([]);
      }
    }
  });

  it("renders a 0.7% bar at exactly 0.7% of the track with no minimum", () => {
    expect(supplyMassBarWidth(7, 1000, 40)).toBeCloseTo(0.28, 12);
    expect(supplyMassBarWidth(0, 1000, 40)).toBe(0);
  });

  it("gives the high-census C band more short-axis thickness than D", () => {
    const result = computeDemandOrbitZones(radii());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cThickness = result.zones.C.outerRy - result.zones.C.innerRy;
    const dThickness = result.zones.D.outerRy - result.zones.D.innerRy;
    expect(cThickness).toBeGreaterThan(dThickness);
    expect(cThickness).toBeGreaterThanOrEqual(2 * 7.8125 + 8);
    expect(result.zones.A.outerRy).toBe(164);
    expect(result.zones.B.innerRy - result.zones.A.outerRy).toBe(8);
    expect(result.zones.B.innerRy).toBeLessThan(232);
    expect(result.zones.F.outerRy).toBeLessThanOrEqual(384);
    expect(result.zones.F.outerRx).toBeLessThanOrEqual(744);
  });

  it("adds bounded demand-derived room only for tiers with published modifier lanes", () => {
    const base = computeDemandOrbitZones(radii());
    const laned = computeDemandOrbitZones(radii(), { B: true, C: true });
    expect(base.ok).toBe(true);
    expect(laned.ok).toBe(true);
    if (!base.ok || !laned.ok) return;
    expect(laned.requiredThickness.B).toBeGreaterThan(base.requiredThickness.B);
    expect(laned.requiredThickness.C).toBeGreaterThan(base.requiredThickness.C);
    expect(laned.zones.B.outerRy - laned.zones.B.innerRy).toBeCloseTo(laned.requiredThickness.B, 10);
    expect(laned.zones.C.outerRy - laned.zones.C.innerRy).toBeGreaterThanOrEqual(laned.requiredThickness.C - 1e-9);
    expect(laned.zones.D.outerRy - laned.zones.D.innerRy).toBeCloseTo(base.zones.D.outerRy - base.zones.D.innerRy, 10);
    expect(laned.zones.F.outerRy - laned.zones.F.innerRy).toBeCloseTo(base.zones.F.outerRy - base.zones.F.innerRy, 10);
    expect(laned.zones.D.innerRy).toBeCloseTo(base.zones.D.innerRy, 10);
    expect(laned.zones.F.outerRy).toBeCloseTo(384, 10);
  });

  it("fails closed when required bubble thickness exceeds the bounded map", () => {
    const result = computeDemandOrbitZones(radii({ B: [60], C: [60], D: [60], F: [60] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/require .*px.*only .*px is available/);
  });
});

describe("Safety Map adaptive logo plates", () => {
  it("keeps USDT transparent while recognizing USDC as a full-bleed tile", async () => {
    const [usdt, usdc] = await Promise.all([
      loadLogoDataUri("/logos/1-usdt.svg", 128),
      loadLogoDataUri("/logos/2-usdc.svg", 128),
    ]);
    expect(usdt).toMatchObject({ plate: "none" });
    expect(usdc).toMatchObject({ plate: "light" });
    expect(usdt?.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(usdc?.dataUri).toMatch(/^data:image\/png;base64,/);
  });

  it("gives a transparent near-white mark a dark plate", () => {
    const rgba = new Uint8Array(12 * 12 * 4);
    for (let y = 3; y < 9; y++) {
      for (let x = 4; x < 8; x++) {
        const index = (y * 12 + x) * 4;
        rgba.set([248, 250, 252, 255], index);
      }
    }
    expect(classifyLogoPlate(rgba, 12, 12)).toBe("dark");
  });
});

describe("Safety Map published sub-grade lanes", () => {
  const zone = { innerRx: 300, innerRy: 200, outerRx: 340, outerRy: 240 };
  const guideRx = 320;
  const guideRy = 220;
  const centers = [
    { x: 800 + guideRx, y: 482 },
    { x: 800 - guideRx / 2, y: 482 + guideRy * Math.sqrt(3) / 2 },
    { x: 800 - guideRx / 2, y: 482 - guideRy * Math.sqrt(3) / 2 },
  ];
  const guideValue = ({ x, y }: { x: number; y: number }) =>
    ((x - 800) ** 2) / guideRx ** 2 + ((y - 482) ** 2) / guideRy ** 2;

  it("derives plus/base/minus only from the published grade modifier", () => {
    expect([subgradeLaneForGrade("B+"), subgradeLaneForGrade("B"), subgradeLaneForGrade("B-")]).toEqual([
      "plus",
      "base",
      "minus",
    ]);
    expect(subgradeLaneForGrade("D")).toBe("base");
    expect(subgradeLaneForGrade("F")).toBe("base");
  });

  it("places plus inward, base on the guide, and minus outward", () => {
    const result = placeSubgradeRadialLanes(centers, [5, 5, 5], ["B+", "B", "B-"], zone);
    expect(result).not.toBeNull();
    expect(result?.offsetY).toBe(13.75);
    expect(guideValue(result!.centers[0])).toBeLessThan(1);
    expect(guideValue(result!.centers[1])).toBeCloseTo(1, 10);
    expect(guideValue(result!.centers[2])).toBeGreaterThan(1);
  });

  it("shrinks the offset deterministically in a narrow band and collapses base-only tiers", () => {
    const narrow = { innerRx: 300, innerRy: 200, outerRx: 313, outerRy: 213 };
    const narrowCenters = [
      { x: 800 + 306.5, y: 482 },
      { x: 800 - 153.25, y: 482 + 206.5 * Math.sqrt(3) / 2 },
      { x: 800 - 153.25, y: 482 - 206.5 * Math.sqrt(3) / 2 },
    ];
    const shrunk = placeSubgradeRadialLanes(narrowCenters, [5, 5, 5], ["C+", "C", "C-"], narrow);
    expect(shrunk?.offsetY).toBeGreaterThan(0);
    expect(shrunk?.offsetY).toBeLessThan(15);

    const baseOnly = placeSubgradeRadialLanes(centers, [5, 5, 5], ["D", "D", "D"], zone);
    expect(baseOnly).toEqual({ centers, offsetY: 0 });
  });
});
