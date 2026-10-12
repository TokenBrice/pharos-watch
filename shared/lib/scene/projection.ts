/**
 * Scene kit: linear projection, rounding and point-set helpers.
 *
 * A projection is linear: screen = i·A + j·B + z·C, in SVG user units. World axes: `i` east, `j` south, `z` up; one
 * light from the east-north-east, so east faces are lit and south faces shaded. Screen coordinates are rounded to 0.1
 * SVG units ({@link round1}), face-local path data and matrix coefficients to 0.001 ({@link round3}); both fold −0
 * into 0, so rounded output survives a JSON round trip and stays byte-stable.
 *
 * Pure and runtime-neutral (no DOM, clock or randomness): the frontend and the Worker share it.
 */

export type ScenePoint = [number, number];
/** Screen-space bounding box (SVG user units unless stated otherwise). */
export interface SceneBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/** SVG `matrix(a,b,c,d,e,f)` operands. */
export type SceneMatrix = [number, number, number, number, number, number];
/** Axis-aligned world footprint. */
export interface SceneCell {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

/** SVG units per world unit along a horizontal axis. */
export const SCENE_UNIT = 20;
/** Vertical foreshortening of the 30° dimetric camera. */
export const SCENE_Z_SCALE = 1.2247;

export interface SceneProjection {
  name: string;
  A: ScenePoint;
  B: ScenePoint;
  C: ScenePoint;
  /** World (i, j) offset of a shadow per unit of caster height. */
  shadow: ScenePoint;
}

const S = SCENE_UNIT;
/**
 * The kit camera: 2:1 dimetric, elevation 30°. x = (i − j)·S, y = (i + j)·S/2 − z·S·K. Shadows fall west-south-west,
 * away from the east-north-east light.
 */
export const SCENE_DIMETRIC: Readonly<SceneProjection> = { name: "dimetric", A: [S, S / 2], B: [-S, S / 2], C: [0, -S * SCENE_Z_SCALE], shadow: [-0.58, 0.3] };

/** Round to 0.1 (screen coordinates); `+ 0` folds −0 into 0 so rounded data survives a JSON round trip exactly. */
export const round1 = (n: number): number => Math.round(n * 10) / 10 + 0;
/** Round to 0.001 (matrix coefficients, face-local path data). */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000 + 0;

export function project(p: SceneProjection, i: number, j: number, z = 0): ScenePoint {
  return [i * p.A[0] + j * p.B[0] + z * p.C[0], i * p.A[1] + j * p.B[1] + z * p.C[1]];
}

/** Screen half-width of a unit horizontal radius (screen-aligned round bodies: urns, trees, domes). */
export function roundHalfWidth(p: SceneProjection): number {
  return Math.hypot(p.A[0], p.B[0]);
}

export function roundPoint(pt: ScenePoint): ScenePoint {
  return [round1(pt[0]), round1(pt[1])];
}

/** `points` attribute value ("x,y x,y …"), 0.1-rounded. */
export function formatPoints(pts: readonly ScenePoint[]): string {
  return pts.map(([x, y]) => `${round1(x)},${round1(y)}`).join(" ");
}

/** Open polyline as path data ("Mx,yLx,y…"), 0.1-rounded. */
export function formatPath(pts: readonly ScenePoint[]): string {
  return pts.map(([x, y], k) => `${k ? "L" : "M"}${round1(x)},${round1(y)}`).join("");
}

/** `transform` attribute value for a {@link SceneMatrix}. */
export function formatMatrix(m: SceneMatrix): string {
  return `matrix(${m[0]},${m[1]},${m[2]},${m[3]},${m[4]},${m[5]})`;
}

/** Convex hull (monotone chain), counter-clockwise from the left-most point. */
export function hull(points: readonly ScenePoint[]): ScenePoint[] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: ScenePoint, a: ScenePoint, b: ScenePoint) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: ScenePoint[] = [];
  const hi: ScenePoint[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let k = p.length - 1; k >= 0; k--) {
    const q = p[k];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
    hi.push(q);
  }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

export function bbox(pts: readonly ScenePoint[]): SceneBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function roundBox(b: SceneBox): SceneBox {
  return { x0: round1(b.x0), y0: round1(b.y0), x1: round1(b.x1), y1: round1(b.y1) };
}
