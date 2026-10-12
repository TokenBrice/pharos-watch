import { describe, expect, it } from "vitest";
import { SCENE_DIMETRIC, SCENE_UNIT, SCENE_Z_SCALE, bbox, formatPath, formatPoints, hull, project, round1, round3, roundBox } from "../projection";
import { fnv1a, seededStream } from "../seed";
import { boxMarks } from "../solids";
import { lighthouseGeometry } from "../objects/lighthouse";

describe("scene projection", () => {
  it("is linear in i, j and z", () => {
    const p = SCENE_DIMETRIC;
    const a = project(p, 1.3, -2.1, 0.4);
    const b = project(p, 0.2, 0.7, 1.1);
    const sum = project(p, 1.5, -1.4, 1.5);
    expect(sum[0]).toBeCloseTo(a[0] + b[0], 9);
    expect(sum[1]).toBeCloseTo(a[1] + b[1], 9);
    expect(project(p, 0, 0, 1)).toEqual([0, -SCENE_UNIT * SCENE_Z_SCALE]);
    expect(project(p, 1, 0, 0)).toEqual([SCENE_UNIT, SCENE_UNIT / 2]);
  });

  it("rounds to 0.1 and 0.001 and folds −0", () => {
    expect(Object.is(round1(-0.04), 0)).toBe(true);
    expect(Object.is(round3(-0.0004), 0)).toBe(true);
    expect(round1(1.26)).toBe(1.3);
    expect(round3(1.23456)).toBe(1.235);
    expect(formatPoints([[0.04, -0.04], [1.25, 2]])).toBe("0,0 1.3,2");
    expect(formatPath([[0, 0], [1.04, 2]])).toBe("M0,0L1,2");
  });

  it("hulls and boxes point sets", () => {
    const pts: [number, number][] = [[0, 0], [2, 0], [1, 1], [2, 2], [0, 2], [1, 0.5]];
    expect(hull(pts)).toEqual([[0, 0], [2, 0], [2, 2], [0, 2]]);
    expect(bbox(pts)).toEqual({ x0: 0, y0: 0, x1: 2, y1: 2 });
    expect(roundBox({ x0: 0.04, y0: 1.26, x1: -0.04, y1: 3 })).toEqual({ x0: 0, y0: 1.3, x1: 0, y1: 3 });
  });
});

describe("scene seeds", () => {
  it("hashes with FNV-1a 32-bit", () => {
    expect(fnv1a("")).toBe(2166136261);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });

  it("streams mulberry32 deterministically in [0, 1)", () => {
    const a = seededStream(fnv1a("pharos"));
    const b = seededStream(fnv1a("pharos"));
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededStream(1)()).toBeCloseTo(0.6270739405881613, 15);
  });
});

describe("scene geometry is pure", () => {
  it("draws the same marks for the same inputs in any order", () => {
    const boxes: [number, number][] = [[0, 0], [2, 1], [-1, 3]];
    const draw = (order: [number, number][]) =>
      Object.fromEntries(order.map(([i, j]) => [`${i},${j}`, JSON.stringify(boxMarks(SCENE_DIMETRIC, i, j, 0, 1, 1, 0.5, "lh"))]));
    expect(draw([...boxes].reverse())).toEqual(draw(boxes));
    expect(JSON.stringify(lighthouseGeometry(SCENE_DIMETRIC, 3, 4))).toBe(JSON.stringify(lighthouseGeometry(SCENE_DIMETRIC, 3, 4)));
  });

  it("puts the lighthouse lantern below its finial", () => {
    const lh = lighthouseGeometry(SCENE_DIMETRIC, 0, 0);
    expect(lh.lantern[1]).toBeGreaterThan(lh.top[1]);
    expect(lh.marks.every((m) => m.cls.length > 0)).toBe(true);
  });
});
