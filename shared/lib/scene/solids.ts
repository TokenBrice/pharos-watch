/**
 * Scene kit solids: boxes, cylinders, octagonal prisms, face frames and ground shadows, as {@link SceneMark} data.
 * Only the camera-facing faces are emitted, in paint order. `" e"` appended to a face's class is the kit's hairline
 * edge token.
 */
import { worldPolygon, screenPolygon, type SceneMark } from "./marks";
import { hull, project, round1, round3, type SceneMatrix, type ScenePoint, type SceneProjection } from "./projection";

const DEG = Math.PI / 180;

/** Face classes of a box: a stem ("st" → st-t / st-e / st-s) or explicit classes. */
export type SceneBoxMaterial = string | { t: string; e: string; s: string };

/** Axis-aligned box: the three camera-facing faces (south, east, top), in that paint order. */
export function boxMarks(
  p: SceneProjection,
  i0: number,
  j0: number,
  z0: number,
  di: number,
  dj: number,
  dz: number,
  mat: SceneBoxMaterial,
  edge = " e",
): SceneMark[] {
  const i1 = i0 + di;
  const j1 = j0 + dj;
  const z1 = z0 + dz;
  const m = typeof mat === "string" ? { t: `${mat}-t`, e: `${mat}-e`, s: `${mat}-s` } : mat;
  return [
    worldPolygon(p, m.s + edge, [[i0, j1, z0], [i1, j1, z0], [i1, j1, z1], [i0, j1, z1]]),
    worldPolygon(p, m.e + edge, [[i1, j0, z0], [i1, j1, z0], [i1, j1, z1], [i1, j0, z1]]),
    worldPolygon(p, m.t + edge, [[i0, j0, z1], [i1, j0, z1], [i1, j1, z1], [i0, j1, z1]]),
  ];
}

/** The eight projected corners of a box (unrounded; for extents and hulls). */
export function boxPoints(p: SceneProjection, i0: number, j0: number, z0: number, di: number, dj: number, dz: number): ScenePoint[] {
  const out: ScenePoint[] = [];
  for (const i of [i0, i0 + di]) for (const j of [j0, j0 + dj]) for (const z of [z0, z0 + dz]) out.push(project(p, i, j, z));
  return out;
}

function matrixAt(o: ScenePoint, u: ScenePoint, v: ScenePoint): SceneMatrix {
  return [round3(u[0]), round3(u[1]), round3(v[0]), round3(v[1]), round1(o[0]), round1(o[1])];
}

/** Lit east-face frame at (i, j, z): u → −j, v → −z (text reads left → right on the face). */
export function faceMatrixE(p: SceneProjection, i: number, j: number, z: number): SceneMatrix {
  return matrixAt(project(p, i, j, z), [-p.B[0], -p.B[1]], [-p.C[0], -p.C[1]]);
}

/** Ground frame: u → +i, v → +j. */
export function faceMatrixG(p: SceneProjection, i: number, j: number, z = 0): SceneMatrix {
  return matrixAt(project(p, i, j, z), p.A, p.B);
}

/** Start angle (radians) of the camera-facing half of a horizontal circle. */
function frontArcStart(p: SceneProjection): number {
  const ta = Math.atan2(p.B[0], p.A[0]);
  const ty = Math.atan2(p.B[1], p.A[1]);
  let d = ty - ta;
  while (d < 0) d += 2 * Math.PI;
  while (d >= 2 * Math.PI) d -= 2 * Math.PI;
  return d <= Math.PI ? ta : ta - Math.PI;
}

export interface SceneCylinder {
  marks: SceneMark[];
  /** Visible body outline (unrounded). */
  body: ScenePoint[];
  /** Body + cap points (unrounded; extents). */
  pts: ScenePoint[];
}

/**
 * Vertical cylinder, visible half only; `topFn(θ)` offsets the top rim in z (fractured tops).
 * Marks: body (`${bodyCls} e`), then cap (`${capCls} e`).
 */
export function cylinder(
  p: SceneProjection,
  ic: number,
  jc: number,
  r: number,
  z0: number,
  z1: number,
  bodyCls: string,
  topFn: ((theta: number) => number) | null,
  capCls: string,
): SceneCylinder {
  const N = 20;
  const t0 = frontArcStart(p);
  const top: ScenePoint[] = [];
  const bot: ScenePoint[] = [];
  const cap: ScenePoint[] = [];
  for (let k = 0; k <= N; k++) {
    const th = t0 + (Math.PI * k) / N;
    top.push(project(p, ic + r * Math.cos(th), jc + r * Math.sin(th), z1 + (topFn ? topFn(th) : 0)));
    bot.push(project(p, ic + r * Math.cos(th), jc + r * Math.sin(th), z0));
  }
  for (let k = 0; k < 2 * N; k++) {
    const th = (k / (2 * N)) * 2 * Math.PI;
    cap.push(project(p, ic + r * Math.cos(th), jc + r * Math.sin(th), z1 + (topFn ? topFn(th) : 0)));
  }
  const body = top.concat(bot.reverse());
  return { marks: [screenPolygon(`${bodyCls} e`, body), screenPolygon(`${capCls} e`, cap)], body, pts: body.concat(cap) };
}

/** Octagonal prism: the three camera-facing faces then the cap (defaults: the kit lighthouse's tower classes). */
export function octPrismMarks(
  p: SceneProjection,
  ic: number,
  jc: number,
  R: number,
  z0: number,
  z1: number,
  cls: readonly [string, string, string] = ["lh-e", "lh-m", "lh-s"],
  capCls = "lh-t",
): SceneMark[] {
  const Rv = R / Math.cos(22.5 * DEG);
  const v = (deg: number, z: number) => project(p, ic + Rv * Math.cos(deg * DEG), jc + Rv * Math.sin(deg * DEG), z);
  const out: SceneMark[] = [];
  const faces: [number, number, string][] = [[-22.5, 22.5, cls[0]], [22.5, 67.5, cls[1]], [67.5, 112.5, cls[2]]];
  for (const [a, b, c] of faces) out.push(screenPolygon(`${c} e`, [v(a, z0), v(b, z0), v(b, z1), v(a, z1)]));
  const cap: ScenePoint[] = [];
  for (let k = 0; k < 8; k++) cap.push(v(22.5 + 45 * k, z1));
  out.push(screenPolygon(`${capCls} e`, cap));
  return out;
}

/** Ground shadow of an axis-aligned footprint [i0, i1, j0, j1] cast by height H. */
export function shadowMark(p: SceneProjection, foot: readonly [number, number, number, number], H: number, cls = "shadow"): SceneMark {
  const [i0, i1, j0, j1] = foot;
  const all: ScenePoint[] = [];
  for (const [i, j] of [[i0, j0], [i1, j0], [i1, j1], [i0, j1]]) {
    all.push(project(p, i, j, 0));
    all.push(project(p, i + p.shadow[0] * H, j + p.shadow[1] * H, 0));
  }
  return screenPolygon(cls, hull(all));
}
