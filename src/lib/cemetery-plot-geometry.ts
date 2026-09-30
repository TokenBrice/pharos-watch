/**
 * Stablecoin Cemetery plot map: projection and pure shape geometry.
 *
 * Port of the approved prototype v2 (`agents/2026-09-30-cemetery-redesign/concepts/c-isometric-v2/src/`
 * `plot-map-geometry.js` and the geometry half of `plot-map-shapes.js` / `plot-map-render.js`). Every function is
 * pure and deterministic: no DOM, no clock, no randomness beyond `seededStream(FNV-1a(id))`. Nothing here emits
 * SVG elements or JSX; shapes come back as {@link PlotMark} data that the scene renders one element per mark.
 *
 * A projection is linear: screen = i·A + j·B + z·C.
 * - `dimetric` (desktop plan): 2:1 dimetric, camera elevation 30°. x = (i − j)·S, y = (i + j)·S/2 − z·S·K.
 * - `portrait` (≤ 760 px plan): lanes become vertical columns (j → screen left), time runs down the page, a small
 *   oblique shear shows the south faces.
 * World axes: `i` points east (gate → lighthouse), `j` south (sea wall → front), `z` up. One light from the
 * east-north-east: the east face (medallion) is lit, south faces are shaded, shadows fall away from the lighthouse.
 *
 * `cls` on a mark is the prototype's class-token list (for example `"st-t e"`: stone top face + hairline edge);
 * the scene maps each token to its CSS-module class. Screen coordinates are rounded to 0.1 SVG units, face-local
 * path data to 0.001 world units, so output is byte-stable.
 */
import type { CauseOfDeath } from "@shared/lib/cause-of-death";
import type { DesktopPlotMap, PlotGrave, PortraitPlotMap } from "@/lib/cemetery-plot-map";

export type PlotPoint = [number, number];
/** Screen-space bounding box (SVG user units unless stated otherwise). */
export interface PlotBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/** SVG `matrix(a,b,c,d,e,f)` operands. */
export type PlotMatrix = [number, number, number, number, number, number];
/** Axis-aligned world footprint. */
export interface PlotCell {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

/** SVG units per world unit along a horizontal axis. */
export const PLOT_UNIT = 20;
/** Vertical foreshortening of the 30° dimetric camera. */
export const PLOT_Z_SCALE = 1.2247;
const DEG = Math.PI / 180;

export type PlotProjectionName = "dimetric" | "portrait";
export interface PlotProjection {
  name: PlotProjectionName;
  A: PlotPoint;
  B: PlotPoint;
  C: PlotPoint;
  /** World (i, j) offset of a shadow per unit of caster height. */
  shadow: PlotPoint;
}

const S = PLOT_UNIT;
export const PLOT_PROJECTIONS: Readonly<Record<PlotProjectionName, PlotProjection>> = {
  dimetric: { name: "dimetric", A: [S, S / 2], B: [-S, S / 2], C: [0, -S * PLOT_Z_SCALE], shadow: [-0.58, 0.3] },
  portrait: { name: "portrait", A: [S * 0.07, S * 0.9], B: [-S, 0], C: [0, -S * 1.0], shadow: [-0.45, 0.4] },
};

/** Round to 0.1 (screen coordinates); `+ 0` folds −0 into 0 so rounded data survives a JSON round trip exactly. */
export const round1 = (n: number): number => Math.round(n * 10) / 10 + 0;
/** Round to 0.001 (matrix coefficients, face-local path data). */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000 + 0;

export function project(p: PlotProjection, i: number, j: number, z = 0): PlotPoint {
  return [i * p.A[0] + j * p.B[0] + z * p.C[0], i * p.A[1] + j * p.B[1] + z * p.C[1]];
}

/** Screen half-width of a unit horizontal radius (screen-aligned round bodies: urns, trees, domes). */
export function roundHalfWidth(p: PlotProjection): number {
  return Math.hypot(p.A[0], p.B[0]);
}

export function roundPoint(pt: PlotPoint): PlotPoint {
  return [round1(pt[0]), round1(pt[1])];
}

/** `points` attribute value ("x,y x,y …"), 0.1-rounded. */
export function formatPoints(pts: readonly PlotPoint[]): string {
  return pts.map(([x, y]) => `${round1(x)},${round1(y)}`).join(" ");
}

/** Open polyline as path data ("Mx,yLx,y…"), 0.1-rounded. */
export function formatPath(pts: readonly PlotPoint[]): string {
  return pts.map(([x, y], k) => `${k ? "L" : "M"}${round1(x)},${round1(y)}`).join("");
}

/** `transform` attribute value for a {@link PlotMatrix}. */
export function formatMatrix(m: PlotMatrix): string {
  return `matrix(${m[0]},${m[1]},${m[2]},${m[3]},${m[4]},${m[5]})`;
}

/** Convex hull (monotone chain), counter-clockwise from the left-most point. */
export function hull(points: readonly PlotPoint[]): PlotPoint[] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: PlotPoint, a: PlotPoint, b: PlotPoint) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: PlotPoint[] = [];
  const hi: PlotPoint[] = [];
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

export function bbox(pts: readonly PlotPoint[]): PlotBox {
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

export function roundBox(b: PlotBox): PlotBox {
  return { x0: round1(b.x0), y0: round1(b.y0), x1: round1(b.x1), y1: round1(b.y1) };
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash: the only seed source (`fnv1a(id)`). */
export function fnv1a(str: string): number {
  let h = 2166136261;
  for (let k = 0; k < str.length; k++) {
    h ^= str.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 stream in [0, 1) from a 32-bit seed. */
export function seededStream(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

export interface PlotMedallionMark {
  kind: "medallion";
  /** Disc centre and radius; the cause-colour ring is its stroke of width `ring`. */
  cx: number;
  cy: number;
  r: number;
  ring: number;
  /** Square the atlas cell is drawn into. */
  logo: { x: number; y: number; size: number };
  /** Fallback initial (no atlas cell): baseline position and font size. */
  initial: { x: number; y: number; fontSize: number };
}

export type PlotMark =
  | { kind: "polygon"; cls: string; points: PlotPoint[] }
  | { kind: "polyline"; cls: string; points: PlotPoint[] }
  /** `d` is in screen units, or in face-local world units when `transform` is set. */
  | { kind: "path"; cls: string; d: string; transform: PlotMatrix | null }
  | { kind: "circle"; cls: string; cx: number; cy: number; r: number; transform: PlotMatrix | null }
  | { kind: "ellipse"; cls: string; cx: number; cy: number; rx: number; ry: number }
  | { kind: "line"; cls: string; x1: number; y1: number; x2: number; y2: number }
  /** Footstone peg glyph: one em at `font-size: 1`, placed by `transform` then scaled by `scale`. */
  | { kind: "glyph"; cls: "glyph"; text: string; transform: PlotMatrix; scale: number }
  | PlotMedallionMark;

/** Face classes of a box: a stem ("st" → st-t / st-e / st-s) or explicit classes. */
export type PlotBoxMaterial = string | { t: string; e: string; s: string };

/** Polygon from screen points (0.1-rounded). */
export function screenPolygon(cls: string, pts: readonly PlotPoint[]): PlotMark {
  return { kind: "polygon", cls, points: pts.map(roundPoint) };
}

/** Polygon from world points. */
export function worldPolygon(p: PlotProjection, cls: string, world: readonly (readonly number[])[]): PlotMark {
  return screenPolygon(
    cls,
    world.map((w) => project(p, w[0], w[1], w[2] || 0)),
  );
}

/** Axis-aligned box: the three camera-facing faces (south, east, top), in that paint order. */
export function boxMarks(
  p: PlotProjection,
  i0: number,
  j0: number,
  z0: number,
  di: number,
  dj: number,
  dz: number,
  mat: PlotBoxMaterial,
  edge = " e",
): PlotMark[] {
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
export function boxPoints(p: PlotProjection, i0: number, j0: number, z0: number, di: number, dj: number, dz: number): PlotPoint[] {
  const out: PlotPoint[] = [];
  for (const i of [i0, i0 + di]) for (const j of [j0, j0 + dj]) for (const z of [z0, z0 + dz]) out.push(project(p, i, j, z));
  return out;
}

function matrixAt(o: PlotPoint, u: PlotPoint, v: PlotPoint): PlotMatrix {
  return [round3(u[0]), round3(u[1]), round3(v[0]), round3(v[1]), round1(o[0]), round1(o[1])];
}

/** Lit east-face frame at (i, j, z): u → −j, v → −z (text reads left → right on the face). */
export function faceMatrixE(p: PlotProjection, i: number, j: number, z: number): PlotMatrix {
  return matrixAt(project(p, i, j, z), [-p.B[0], -p.B[1]], [-p.C[0], -p.C[1]]);
}

/** South-face frame: u → +i, v → −z. */
export function faceMatrixS(p: PlotProjection, i: number, j: number, z: number): PlotMatrix {
  return matrixAt(project(p, i, j, z), p.A, [-p.C[0], -p.C[1]]);
}

/** Ground frame: u → +i, v → +j. */
export function faceMatrixG(p: PlotProjection, i: number, j: number, z = 0): PlotMatrix {
  return matrixAt(project(p, i, j, z), p.A, p.B);
}

/** Start angle (radians) of the camera-facing half of a horizontal circle. */
function frontArcStart(p: PlotProjection): number {
  const ta = Math.atan2(p.B[0], p.A[0]);
  const ty = Math.atan2(p.B[1], p.A[1]);
  let d = ty - ta;
  while (d < 0) d += 2 * Math.PI;
  while (d >= 2 * Math.PI) d -= 2 * Math.PI;
  return d <= Math.PI ? ta : ta - Math.PI;
}

export interface PlotCylinder {
  marks: PlotMark[];
  /** Visible body outline (unrounded). */
  body: PlotPoint[];
  /** Body + cap points (unrounded; extents). */
  pts: PlotPoint[];
}

/**
 * Vertical cylinder, visible half only; `topFn(θ)` offsets the top rim in z (fractured tops).
 * Marks: body (`${bodyCls} e`), then cap (`${capCls} e`).
 */
export function cylinder(
  p: PlotProjection,
  ic: number,
  jc: number,
  r: number,
  z0: number,
  z1: number,
  bodyCls: string,
  topFn: ((theta: number) => number) | null = null,
  capCls = "st-t",
): PlotCylinder {
  const N = 20;
  const t0 = frontArcStart(p);
  const top: PlotPoint[] = [];
  const bot: PlotPoint[] = [];
  const cap: PlotPoint[] = [];
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

/**
 * The single clean planar break of a snapped column, as a z offset of the top rim at angle θ: the rim drops `drop`
 * plus up to `amp` toward direction `phase` (the low side), and stays whole opposite it.
 */
export function columnFractureTop(opts: { phase: number; amp: number; drop?: number }): (theta: number) => number {
  const { phase, amp, drop = 0 } = opts;
  return (th) => -drop - amp * (0.5 + 0.5 * Math.cos(th - phase));
}

/**
 * Direction (θ in the i–j plane) of a snapped column's low side: toward the east-north-east light. The break then
 * falls left → right on screen and its cross-section (`brk`) faces the light, the lightest face of the column.
 */
export const PLOT_FRACTURE_PHASE = Math.atan2(-0.383, 0.924);

/** Octagonal prism: the three camera-facing faces then the cap. */
export function octPrismMarks(
  p: PlotProjection,
  ic: number,
  jc: number,
  R: number,
  z0: number,
  z1: number,
  cls: readonly [string, string, string] = ["lh-e", "lh-m", "lh-s"],
  capCls = "lh-t",
): PlotMark[] {
  const Rv = R / Math.cos(22.5 * DEG);
  const v = (deg: number, z: number) => project(p, ic + Rv * Math.cos(deg * DEG), jc + Rv * Math.sin(deg * DEG), z);
  const out: PlotMark[] = [];
  const faces: [number, number, string][] = [[-22.5, 22.5, cls[0]], [22.5, 67.5, cls[1]], [67.5, 112.5, cls[2]]];
  for (const [a, b, c] of faces) out.push(screenPolygon(`${c} e`, [v(a, z0), v(b, z0), v(b, z1), v(a, z1)]));
  const cap: PlotPoint[] = [];
  for (let k = 0; k < 8; k++) cap.push(v(22.5 + 45 * k, z1));
  out.push(screenPolygon(`${capCls} e`, cap));
  return out;
}

/** Ground shadow of an axis-aligned footprint [i0, i1, j0, j1] cast by height H. */
export function shadowMark(p: PlotProjection, foot: readonly [number, number, number, number], H: number, cls = "shadow"): PlotMark {
  const [i0, i1, j0, j1] = foot;
  const all: PlotPoint[] = [];
  for (const [i, j] of [[i0, j0], [i1, j0], [i1, j1], [i0, j1]]) {
    all.push(project(p, i, j, 0));
    all.push(project(p, i + p.shadow[0] * H, j + p.shadow[1] * H, 0));
  }
  return screenPolygon(cls, hull(all));
}

// ---------------------------------------------------------------------------
// Graves
// ---------------------------------------------------------------------------

export type PlotArchetype = "pillow" | "split-arch" | "urn" | "broken-column" | "sealed-tablet";
/**
 * Drawn shape. Class 3 ($1B–$10B) abandonments become a chest tomb; class 4 (≥ $10B) is architecture:
 * an algorithmic colossus is the snapped fluted column (UST), any other cause the sealed mausoleum (BUSD).
 */
export type PlotShape = PlotArchetype | "chest-tomb" | "colossal-column" | "mausoleum";
export type PlotLot = 1 | 2 | 3;
export type PlotPeakClass = 0 | 1 | 2 | 3 | 4;
export type PlotWeather = 0 | 1 | 2 | 3 | 4;

/** Stone shape encodes cause of death (never what holders recovered). */
export const PLOT_ARCHETYPE_BY_CAUSE: Readonly<Record<CauseOfDeath, PlotArchetype>> = {
  abandoned: "pillow",
  "counterparty-failure": "split-arch",
  "liquidity-drain": "urn",
  "algorithmic-failure": "broken-column",
  regulatory: "sealed-tablet",
};

export function plotShapeOf(archetype: PlotArchetype, lot: PlotLot): PlotShape {
  if (lot === 3) return archetype === "broken-column" ? "colossal-column" : "mausoleum";
  if (lot === 2 && archetype === "pillow") return "chest-tomb";
  return archetype;
}

/** One plinth step per order of magnitude of peak market cap (world units). */
export const PLOT_STEP_HEIGHT = 0.1;
/** Medallion diameter on a 1×1 stone (world units). */
export const PLOT_MEDALLION = 0.44;
/** Base stone heights before the log-peak height factor (world units). */
export const PLOT_BASE_HEIGHT: Readonly<Record<PlotArchetype, number>> = {
  pillow: 0.72,
  "split-arch": 0.98,
  "sealed-tablet": 0.9,
  "broken-column": 1.16,
  urn: 1.08,
};

/** The grave fields the shape geometry reads (a `PlotGrave` satisfies it; the legend builds its own). */
export interface PlotGraveShapeInput {
  readonly shape: PlotShape;
  readonly lot: PlotLot;
  /** Plinth steps; null = peak not recorded (one outlined plinth, hatched face). */
  readonly steps: PlotPeakClass | null;
  readonly heightFactor: number;
  readonly weather: PlotWeather;
  readonly fresh: boolean;
  /** Bronze plaque: Pharos holds a frozen data page. */
  readonly archived: boolean;
  /** Footstone glyph for a non-USD peg; null for USD. */
  readonly footstone: string | null;
  readonly seed: number;
  /** Lean in degrees (0 = upright). */
  readonly lean: number;
  readonly cell: PlotCell;
  readonly anchor: { readonly i: number; readonly j: number };
}

export interface PlotGraveGeometry {
  /** Plinth + stone + medallion, in paint order; the whole group rotates by `lean` when set. */
  body: PlotMark[];
  lean: { deg: number; x: number; y: number } | null;
  /** Flat ground marks: shadow, mound or fresh soil, bronze plaque, footstone. */
  ground: PlotMark[];
  /** Extent points (unrounded) for depth sorting, hit hulls and cameras. */
  pts: PlotPoint[];
  /** Top z of the stone. */
  topZ: number;
  /** Medallion centre and radius (beam target, tag anchor). */
  medal: { x: number; y: number; r: number };
  top: PlotPoint;
  /** Width / height of the medallion face (world units). */
  faceW: number;
  faceH: number;
}

function medallionMark(x: number, y: number, d: number): PlotMedallionMark {
  const R = (d * S) / 2;
  const inner = R * 0.8;
  const ring = round1(R * 0.12);
  return {
    kind: "medallion",
    cx: round1(x),
    cy: round1(y),
    r: round1(R - ring / 2),
    ring,
    logo: { x: round1(x - inner), y: round1(y - inner), size: round1(2 * inner) },
    initial: { x: round1(x), y: round1(y + inner * 0.36), fontSize: round1(inner * 1.05) },
  };
}

/** Plinth ladder: one box per step; an unrecorded peak gets one outlined (open) plinth instead. */
function plinthMarks(p: PlotProjection, ic: number, jc: number, hi: number, hj: number, n: number, open: boolean): PlotMark[] {
  if (open) {
    const e = 0.08;
    return boxMarks(p, ic - hi - e, jc - hj - e, 0, 2 * (hi + e), 2 * (hj + e), PLOT_STEP_HEIGHT, { t: "pl-open", e: "pl-open", s: "pl-open" }, " eo");
  }
  const out: PlotMark[] = [];
  for (let s = 0; s < n; s++) {
    const e = 0.05 + 0.06 * (n - 1 - s);
    out.push(...boxMarks(p, ic - hi - e, jc - hj - e, s * PLOT_STEP_HEIGHT, 2 * (hi + e), 2 * (hj + e), PLOT_STEP_HEIGHT, "pl"));
  }
  return out;
}

/** Weathering on a lit face: lichen from w2, moss band from w3 (seeded positions); one path each. */
function weatheringMarks(
  p: PlotProjection,
  weather: PlotWeather,
  fi: number,
  jc: number,
  z0: number,
  w: number,
  h: number,
  rnd: () => number,
): PlotMark[] {
  const out: PlotMark[] = [];
  if (weather >= 2) {
    const n = weather + 1;
    let d = "";
    for (let k = 0; k < n; k++) {
      const u = (rnd() - 0.5) * w * 0.8;
      const v = -(0.1 + rnd() * 0.75) * h;
      const rx = 0.035 + rnd() * 0.03;
      const ry = 0.028 + rnd() * 0.02;
      d += `M${round3(u - rx)},${round3(v)}a${round3(rx)},${round3(ry)} 0 1,0 ${round3(2 * rx)},0a${round3(rx)},${round3(ry)} 0 1,0 ${round3(-2 * rx)},0`;
    }
    out.push({ kind: "path", cls: "lichen", d, transform: faceMatrixE(p, fi + 0.004, jc, z0) });
  }
  if (weather >= 3) {
    out.push({
      kind: "path",
      cls: "moss",
      d: `M${round3(-w / 2)},0 L${round3(w / 2)},0 L${round3(w / 2)},-0.07 Q${round3(w / 4)},${round3(-0.16 - 0.04 * weather)} 0,-0.08 T${round3(-w / 2)},-0.11 Z`,
      transform: faceMatrixE(p, fi + 0.004, jc, z0),
    });
  }
  return out;
}

/** Mound east of the stone, bronze archive plaque, non-USD footstone; fresh soil within 90 days of `asOf`. */
function moundMarks(p: PlotProjection, g: PlotGraveShapeInput, mi0: number, mhj: number): PlotMark[] {
  const jc = g.anchor.j;
  const mi1 = g.cell.i1 - 0.1;
  if (mi1 - mi0 < 0.2) return [];
  const out = [
    worldPolygon(p, `${g.fresh ? "soil" : "mound"} es`, [[mi0, jc - mhj, 0.04], [mi1, jc - mhj, 0.04], [mi1, jc + mhj, 0.04], [mi0, jc + mhj, 0.04]]),
  ];
  if (g.archived) {
    const a = mi1 - 0.28;
    out.push(worldPolygon(p, "bronze e", [[a, jc - 0.13, 0.043], [a + 0.2, jc - 0.13, 0.043], [a + 0.2, jc + 0.13, 0.043], [a, jc + 0.13, 0.043]]));
  }
  if (g.footstone !== null) {
    const fi = mi0 + 0.06;
    out.push(...boxMarks(p, fi, jc - 0.15, 0.04, 0.2, 0.3, 0.08, "fs"));
    out.push({ kind: "glyph", cls: "glyph", text: g.footstone, transform: faceMatrixG(p, fi + 0.03, jc + 0.12, 0.122), scale: 0.26 });
  }
  return out;
}

type Profile = [number, number][];

/** Pillow marker profile (dj, dz) around the centre line, north (−j) first. */
function pillowProfile(w: number, h: number): Profile {
  const r = Math.min(0.17, h * 0.4);
  const prof: Profile = [[w / 2, 0], [-w / 2, 0]];
  for (let a = 0; a <= 5; a++) {
    const ph = (180 - 18 * a) * DEG;
    prof.push([-w / 2 + r + r * Math.cos(ph), h - r + r * Math.sin(ph)]);
  }
  for (let a = 0; a <= 5; a++) {
    const ph = (90 - 18 * a) * DEG;
    prof.push([w / 2 - r + r * Math.cos(ph), h - r + r * Math.sin(ph)]);
  }
  return prof;
}

/** Arched headstone profile; `notch` cuts the crown split into the silhouette. */
function archProfile(w: number, h: number, notch = 0): Profile {
  const hv = h - w / 2;
  const prof: Profile = [[w / 2, 0], [-w / 2, 0]];
  for (let a = 0; a <= 12; a++) {
    const ph = (a / 12) * Math.PI;
    const dj = -(w / 2) * Math.cos(ph);
    const dz = hv + (w / 2) * Math.sin(ph);
    if (notch && a === 6) {
      prof.push([-notch * 0.5, dz], [0, dz - notch * 1.6], [notch * 0.5, dz]);
      continue;
    }
    prof.push([dj, dz]);
  }
  return prof;
}

function tabletProfile(w: number, h: number): Profile {
  return [[w / 2, 0], [-w / 2, 0], [-w / 2, h - 0.05], [-w / 2 + 0.05, h], [w / 2 - 0.05, h], [w / 2, h - 0.05]];
}

/** Extruded slab stone: side (top) hull, south strip, lit east face. */
function slabStone(p: PlotProjection, ic: number, jc: number, z0: number, t: number, prof: Profile) {
  const i1 = ic + t / 2;
  const iB = ic - t / 2;
  const front = prof.map(([dj, dz]) => project(p, i1, jc + dj, z0 + dz));
  const back = prof.map(([dj, dz]) => project(p, iB, jc + dj, z0 + dz));
  const side = hull(front.concat(back));
  const southZ = Math.min(...prof.filter(([dj]) => dj > 0).map(([, dz]) => (dz > 0 ? dz : Infinity)));
  const wHalf = Math.max(...prof.map(([dj]) => dj));
  const sz = Number.isFinite(southZ) ? southZ : 0.1;
  const marks = [
    screenPolygon("st-t e", side),
    worldPolygon(p, "st-s e", [[iB, jc + wHalf, z0], [i1, jc + wHalf, z0], [i1, jc + wHalf, z0 + sz], [iB, jc + wHalf, z0 + sz]]),
    screenPolygon("st-e e", front),
  ];
  return { marks, front, pts: side, faceI: i1 };
}

function baseArchetypeOf(shape: PlotShape): PlotArchetype {
  if (shape === "chest-tomb") return "pillow";
  if (shape === "colossal-column") return "broken-column";
  if (shape === "mausoleum") return "sealed-tablet";
  return shape;
}

/** Geometry of one grave (any lot size; class-4 colossi go through the monument builders). */
export function graveGeometry(p: PlotProjection, g: PlotGraveShapeInput): PlotGraveGeometry {
  if (g.lot === 3) return colossusGeometry(p, g);
  const rnd = seededStream(g.seed);
  const sc = g.lot === 2 ? 1.55 : 1;
  const ic = g.anchor.i;
  const jc = g.anchor.j;
  const open = g.steps === null;
  const n = g.steps ?? 0;
  const z0 = open ? PLOT_STEP_HEIGHT : n * PLOT_STEP_HEIGHT;
  const archetype = baseArchetypeOf(g.shape);
  const h = PLOT_BASE_HEIGHT[archetype] * g.heightFactor * (g.lot === 2 ? 1.2 : 1);
  const stone: PlotMark[] = [];
  let pts: PlotPoint[] = [];
  let hi = 0.1;
  let hj = 0.3;
  let faceI = ic;
  let medZ = z0 + h * 0.55;
  let medD = PLOT_MEDALLION * sc;
  let topZ = z0 + h;
  let faceW = 0.62;
  let faceH = h;

  if (g.shape === "chest-tomb") {
    // The one ≥ $1B abandonment: a chest tomb, still a plain pillow-family marker (no damage).
    const bi = 1.2;
    const bj = 0.9;
    const bh = 0.6;
    hi = bi / 2;
    hj = bj / 2;
    stone.push(...boxMarks(p, ic - hi, jc - hj, z0, bi, bj, bh, "st"));
    stone.push(...boxMarks(p, ic - hi - 0.07, jc - hj - 0.07, z0 + bh, bi + 0.14, bj + 0.14, 0.09, "st"));
    faceI = ic + hi;
    medZ = z0 + bh * 0.5;
    medD = 0.5;
    topZ = z0 + bh + 0.09;
    faceW = bj;
    faceH = bh;
    pts = boxPoints(p, ic - hi - 0.07, jc - hj - 0.07, 0, bi + 0.14, bj + 0.14, topZ);
  } else if (archetype === "pillow" || archetype === "split-arch" || archetype === "sealed-tablet") {
    const w = (archetype === "pillow" ? 0.68 : archetype === "split-arch" ? 0.6 : 0.64) * sc;
    const t = (archetype === "pillow" ? 0.26 : archetype === "split-arch" ? 0.2 : 0.18) * sc;
    const prof = archetype === "pillow" ? pillowProfile(w, h) : archetype === "split-arch" ? archProfile(w, h, 0.07 * sc) : tabletProfile(w, h);
    hi = t / 2;
    hj = w / 2;
    faceW = w;
    const st = slabStone(p, ic, jc, z0, t, prof);
    stone.push(...st.marks);
    faceI = st.faceI;
    pts = st.pts;
    medZ = archetype === "split-arch" ? z0 + (h - w / 2) * 0.62 : archetype === "pillow" ? z0 + h * 0.48 : z0 + h * 0.6;
    if (open) stone.push(screenPolygon("hatch", st.front));
    if (archetype === "split-arch") {
      // hairline continuing the crown split down the face
      const cr = [[0, h - 0.11 * sc], [0.025, h - 0.2 * sc], [-0.015, h - 0.28 * sc], [0.02, h - 0.34 * sc]];
      stone.push({ kind: "polyline", cls: "crack", points: cr.map(([dj, dz]) => roundPoint(project(p, faceI + 0.004, jc + dj * sc, z0 + dz))) });
    }
    if (archetype === "sealed-tablet") {
      // "closed by order": a bronze seal plate across the lower face and a projecting lid; the stone stays whole.
      const pz = z0 + h * 0.2;
      const ph = 0.09;
      const pw = w * 0.36;
      stone.push(worldPolygon(p, "seal e", [[faceI + 0.004, jc - pw, pz], [faceI + 0.004, jc + pw, pz], [faceI + 0.004, jc + pw, pz + ph], [faceI + 0.004, jc - pw, pz + ph]]));
      stone.push(...boxMarks(p, ic - hi - 0.02, jc - hj - 0.03, z0 + h, t + 0.04, w + 0.06, 0.05, "st"));
      topZ = z0 + h + 0.05;
    }
    stone.push(...weatheringMarks(p, g.weather, faceI, jc, z0, w, h, rnd));
  } else if (archetype === "broken-column") {
    // pedestal as wide as the slab stones so the medallion face reads at the R1 floor size
    const bw = 0.58 * sc;
    const bh = 0.36 * sc;
    const r = 0.19 * sc;
    hi = bw / 2;
    hj = bw / 2;
    stone.push(...boxMarks(p, ic - hi, jc - hj, z0, bw, bw, bh, "st"));
    // one clean planar break toward the light; the seeded jitter (±0.25 rad) keeps the columns from reading as stamped
    const topFn = columnFractureTop({ phase: PLOT_FRACTURE_PHASE + (rnd() - 0.5) * 0.5, amp: 0.3 * sc });
    stone.push(...cylinder(p, ic, jc, r * 1.22, z0 + bh, z0 + bh + 0.05, "col", null, "st-t").marks);
    const cyl = cylinder(p, ic, jc, r, z0 + bh + 0.05, z0 + h + 0.06, "col", topFn, "brk");
    stone.push(...cyl.marks);
    if (open) stone.push(worldPolygon(p, "hatch", [[ic + hi, jc - hj, z0], [ic + hi, jc + hj, z0], [ic + hi, jc + hj, z0 + bh], [ic + hi, jc - hj, z0 + bh]]));
    faceI = ic + hi;
    faceW = bw;
    faceH = bh;
    medZ = z0 + bh * 0.5;
    medD = Math.min(PLOT_MEDALLION, bh * 1.2);
    pts = cyl.pts.concat(boxPoints(p, ic - hi, jc - hj, 0, bw, bw, z0 + bh));
    stone.push(...weatheringMarks(p, g.weather, faceI, jc, z0, bw * 0.85, bh, rnd));
  } else {
    // liquidity drain: the emptied urn on a pedestal (R9)
    const pw = 0.58 * sc;
    const ph = 0.56 * h;
    hi = pw / 2;
    hj = pw / 2;
    stone.push(...boxMarks(p, ic - hi, jc - hj, z0, pw, pw, ph, "st"));
    stone.push(...boxMarks(p, ic - hi - 0.03, jc - hj - 0.03, z0 + ph, pw + 0.06, pw + 0.06, 0.045, "st"));
    const zb = z0 + ph + 0.045;
    const uh = h - ph - 0.045;
    const [ax] = project(p, ic, jc, 0);
    const rhw = roundHalfWidth(p);
    const right: PlotPoint[] = [];
    const left: PlotPoint[] = [];
    const prof = [[0, 0.1], [0.07, 0.08], [0.15, 0.14], [0.33, 0.24], [0.55, 0.23], [0.74, 0.14], [0.84, 0.1], [0.9, 0.14], [1, 0.15]];
    for (const [hh, rr] of prof) {
      const [, y] = project(p, ic, jc, zb + hh * uh);
      right.push([ax + rr * sc * rhw, y]);
      left.unshift([ax - rr * sc * rhw, y]);
    }
    const bodyPts = right.concat(left);
    stone.push(screenPolygon("col e", bodyPts));
    const [, yt] = project(p, ic, jc, zb + uh);
    const rx = 0.11 * sc * rhw;
    stone.push({ kind: "ellipse", cls: "mouth", cx: round1(ax), cy: round1(yt), rx: round1(rx), ry: round1(rx / 2) });
    topZ = zb + uh;
    if (open) stone.push(worldPolygon(p, "hatch", [[ic + hi, jc - hj, z0], [ic + hi, jc + hj, z0], [ic + hi, jc + hj, z0 + ph], [ic + hi, jc - hj, z0 + ph]]));
    faceI = ic + hi;
    medZ = z0 + ph * 0.5;
    medD = Math.min(PLOT_MEDALLION, ph * 1.25, pw * 0.8) * (g.lot === 2 ? 1.25 : 1);
    faceW = pw;
    faceH = ph;
    pts = bodyPts.concat(boxPoints(p, ic - hi - 0.035, jc - hj - 0.035, 0, pw + 0.07, pw + 0.07, zb));
    stone.push(...weatheringMarks(p, g.weather, faceI, jc, z0, pw, ph, rnd));
  }

  const [mx, my] = project(p, faceI + 0.01, jc, medZ);
  stone.push(medallionMark(mx, my, medD));

  const plinth = plinthMarks(p, ic, jc, hi, hj, open ? 1 : n, open);
  const fe = open ? 0.08 : n ? 0.05 + 0.06 * (n - 1) : 0;
  if (n || open) pts = pts.concat(boxPoints(p, ic - hi - fe, jc - hj - fe, 0, 2 * (hi + fe), 2 * (hj + fe), 0.001));

  let lean: PlotGraveGeometry["lean"] = null;
  if (g.lean) {
    const [bx, by] = project(p, ic, jc, z0);
    lean = { deg: round1(g.lean), x: round1(bx), y: round1(by) };
  }
  const moundI0 = g.shape === "chest-tomb" ? g.cell.i1 - 0.35 : ic + hi + fe + 0.12;
  const ground = [shadowMark(p, [ic - hi - fe, ic + hi + fe, jc - hj - fe, jc + hj + fe], topZ), ...moundMarks(p, g, moundI0, g.lot === 1 ? 0.24 : 0.4)];
  const [tx, ty] = project(p, ic, jc, topZ);
  return {
    body: [...plinth, ...stone],
    lean,
    ground,
    pts,
    topZ,
    medal: { x: round1(mx), y: round1(my), r: round1((medD * S) / 2) },
    top: [round1(tx), round1(ty)],
    faceW,
    faceH,
  };
}

/** Rounded rectangle as path data after `translate(tx,ty) rotate(deg) scale(k)` (face-local units). */
function transformedRoundRect(x: number, y: number, w: number, h: number, rx: number, t: { tx: number; ty: number; deg: number; k: number }): string {
  const c = Math.cos(t.deg * DEG);
  const s = Math.sin(t.deg * DEG);
  const tp = (px: number, py: number) => {
    const sx = px * t.k;
    const sy = py * t.k;
    return `${round3(t.tx + sx * c - sy * s)},${round3(t.ty + sx * s + sy * c)}`;
  };
  const r = round3(rx * t.k);
  const arc = (px: number, py: number) => `A${r},${r} 0 0 1 ${tp(px, py)}`;
  return (
    `M${tp(x + rx, y)}L${tp(x + w - rx, y)}${arc(x + w, y + rx)}L${tp(x + w, y + h - rx)}${arc(x + w - rx, y + h)}` +
    `L${tp(x + rx, y + h)}${arc(x, y + h - rx)}L${tp(x, y + rx)}${arc(x + rx, y)}Z`
  );
}

/** Class 4 (≥ $10B): architecture carries the class, not continuous height (R8). UST is the tallest element. */
function colossusGeometry(p: PlotProjection, g: PlotGraveShapeInput): PlotGraveGeometry {
  const rnd = seededStream(g.seed);
  const jc = g.anchor.j;
  const ic = (g.cell.i0 + g.cell.i1) / 2 - 0.12;
  const s: PlotMark[] = [];
  const ground: PlotMark[] = [];
  let pts: PlotPoint[];
  let H: number;
  let medal: { x: number; y: number; r: number };
  const podium = (ei: number, ej: number) => {
    for (let q = 0; q < 4; q++) s.push(...boxMarks(p, ic - ei + 0.11 * q, jc - ej + 0.11 * q, q * 0.13, 2 * (ei - 0.11 * q), 2 * (ej - 0.11 * q), 0.13, "pl"));
  };
  if (g.shape === "colossal-column") {
    // UST: a snapped colossal fluted column; its fallen drum lies in the lot.
    podium(1.3, 1.3);
    const zp = 0.52;
    s.push(...boxMarks(p, ic - 0.74, jc - 0.74, zp, 1.48, 1.48, 0.12, "st"));
    s.push(...boxMarks(p, ic - 0.64, jc - 0.64, zp + 0.12, 1.28, 1.28, 1.18, "st"));
    s.push(...boxMarks(p, ic - 0.76, jc - 0.76, zp + 1.3, 1.52, 1.52, 0.12, "st"));
    const fi = ic + 0.64 + 0.004;
    s.push(...weatheringMarks(p, g.weather, ic + 0.64, jc, zp + 0.12, 1.1, 1.1, rnd));
    const z1 = zp + 1.42;
    const top = 6.9;
    const topFn = columnFractureTop({ phase: PLOT_FRACTURE_PHASE, drop: 0.25, amp: 0.85 });
    const cyl = cylinder(p, ic, jc, 0.48, z1, top, "col", topFn, "brk");
    s.push(...cyl.marks);
    let fl = "";
    for (let q = 0; q < 8; q++) {
      const th = (-36 + q * 22) * DEG;
      const a = project(p, ic + 0.48 * Math.cos(th), jc + 0.48 * Math.sin(th), z1 + 0.05);
      const b = project(p, ic + 0.48 * Math.cos(th), jc + 0.48 * Math.sin(th), top + topFn(th) - 0.06);
      fl += `M${round1(a[0])},${round1(a[1])}L${round1(b[0])},${round1(b[1])}`;
    }
    s.push({ kind: "path", cls: "flute", d: fl, transform: null });
    const [mx, my] = project(p, fi + 0.01, jc, zp + 0.92);
    s.push(medallionMark(mx, my, 0.62));
    medal = { x: round1(mx), y: round1(my), r: round1(0.31 * S) };
    H = top;
    pts = cyl.pts.concat(boxPoints(p, ic - 1.3, jc - 1.3, 0, 2.6, 2.6, zp + 1.42));
    // fallen drum: lying cylinder along j, south-east in the lot, broken face turned to the viewer
    const di = ic + 1.12;
    const dr = 0.36;
    const capA: PlotPoint[] = [];
    const capB: PlotPoint[] = [];
    for (let q = 0; q < 22; q++) {
      const th = (q / 22) * 2 * Math.PI;
      capA.push(project(p, di + dr * Math.cos(th), jc - 0.1, 0.52 + dr + dr * Math.sin(th)));
      capB.push(project(p, di + dr * Math.cos(th), jc + 0.95, 0.52 + dr + dr * Math.sin(th)));
    }
    s.push(screenPolygon("st-t e", hull(capA.concat(capB))), screenPolygon("brk e", capB));
    pts = pts.concat(capA, capB);
    ground.push(shadowMark(p, [ic - 1.3, ic + 1.3, jc - 1.3, jc + 1.3], 0.52), shadowMark(p, [ic - 0.5, ic + 0.5, jc - 0.5, jc + 0.5], H * 0.92));
  } else {
    // BUSD: a sealed, intact mausoleum; barred door with a closed-by-order seal, gavel carved flat in the tympanum.
    podium(1.4, 1.3);
    const zp = 0.52;
    const ze = 2.3;
    const ci0 = ic - 1.05;
    const ci1 = ic + 0.45;
    s.push(...boxMarks(p, ci0, jc - 0.92, zp, ci1 - ci0, 1.84, ze - zp, "st"));
    const di = ci1 + 0.004;
    s.push(worldPolygon(p, "door e", [[di, jc - 0.3, zp], [di, jc + 0.3, zp], [di, jc + 0.3, zp + 1.12], [di, jc - 0.3, zp + 1.12]]));
    const doorFrame = faceMatrixE(p, di + 0.002, jc, zp);
    s.push({ kind: "path", cls: "bars", d: "M-.3,-.3 L.3,-.3 M-.3,-.62 L.3,-.62 M-.3,-.94 L.3,-.94 M-.15,0 L-.15,-1.12 M.15,0 L.15,-1.12", transform: doorFrame });
    s.push({ kind: "circle", cls: "seal-disc", cx: 0, cy: -0.62, r: 0.1, transform: doorFrame });
    const colI = ic + 1.02;
    for (const dj of [-0.84, -0.28, 0.28, 0.84]) s.push(...cylinder(p, colI, jc + dj, 0.11, zp, ze, "col", null, "st-t").marks);
    const ei0 = ic - 1.15;
    const ei1 = ic + 1.2;
    const ej = 1.04;
    s.push(...boxMarks(p, ei0, jc - ej, ze, ei1 - ei0, 2 * ej, 0.26, "st"));
    const zr = ze + 0.26;
    const zRidge = zr + 0.7;
    s.push(worldPolygon(p, "st-t e", [[ei0, jc - ej, zr], [ei1, jc - ej, zr], [ei1, jc, zRidge], [ei0, jc, zRidge]]));
    s.push(worldPolygon(p, "st-s e", [[ei0, jc + ej, zr], [ei1, jc + ej, zr], [ei1, jc, zRidge], [ei0, jc, zRidge]]));
    s.push(worldPolygon(p, "st-e e", [[ei1, jc - ej, zr], [ei1, jc + ej, zr], [ei1, jc, zRidge]]));
    // gavel carved flat into the tympanum: a relief outline, nothing lodged, no crack
    const carve = { tx: -0.02, ty: -0.24, deg: -24, k: 0.9 };
    s.push({
      kind: "path",
      cls: "relief",
      d: transformedRoundRect(-0.05, -0.02, 0.42, 0.05, 0.02, carve) + transformedRoundRect(-0.19, -0.1, 0.14, 0.21, 0.02, carve),
      transform: faceMatrixE(p, ei1 + 0.005, jc, zr),
    });
    const [mx, my] = project(p, ci1 + 0.01, jc - 0.62, zp + 0.8);
    s.push(medallionMark(mx, my, 0.5));
    medal = { x: round1(mx), y: round1(my), r: round1(0.25 * S) };
    s.push(...weatheringMarks(p, g.weather, ci1, jc - 0.62, zp, 0.5, 1.4, rnd));
    H = zRidge;
    pts = boxPoints(p, ic - 1.4, jc - 1.3, 0, 2.8, 2.6, zp).concat(boxPoints(p, ei0, jc - ej, zp, ei1 - ei0, 2 * ej, zRidge - zp));
    ground.push(shadowMark(p, [ic - 1.4, ic + 1.4, jc - 1.3, jc + 1.3], 0.52), shadowMark(p, [ei0, ei1, jc - ej, jc + ej], zRidge * 0.85));
  }
  if (g.archived) {
    ground.push(worldPolygon(p, "bronze e", [[g.cell.i1 - 0.35, jc - 0.14, 0.01], [g.cell.i1 - 0.12, jc - 0.14, 0.01], [g.cell.i1 - 0.12, jc + 0.14, 0.01], [g.cell.i1 - 0.35, jc + 0.14, 0.01]]));
  }
  const [tx, ty] = project(p, ic, jc, H);
  return { body: s, lean: null, ground, pts, topZ: H, medal, top: [round1(tx), round1(ty)], faceW: 1.28, faceH: 1.18 };
}

/** Hit area of a grave: hull of its extents and its (inset) lot. Unrounded. */
export function graveHitHull(p: PlotProjection, geo: PlotGraveGeometry, cell: PlotCell): PlotPoint[] {
  const cellPts = boxPoints(p, cell.i0 + 0.04, cell.j0 + 0.04, 0, cell.i1 - cell.i0 - 0.08, cell.j1 - cell.j0 - 0.08, 0.01);
  return hull(geo.pts.concat(cellPts));
}

// ---------------------------------------------------------------------------
// Scenery objects
// ---------------------------------------------------------------------------

export interface PlotObjectGeometry {
  marks: PlotMark[];
  /** Extent points (unrounded). */
  pts: PlotPoint[];
}

/** Cypress: height ∝ deaths that calendar year; an empty year stays a bare planting bed. */
export function cypressGeometry(p: PlotProjection, i: number, j: number, h: number): PlotObjectGeometry & { top: PlotPoint } {
  const marks = [worldPolygon(p, "tree-bed e", [[i - 0.26, j - 0.26, 0.01], [i + 0.26, j - 0.26, 0.01], [i + 0.26, j + 0.26, 0.01], [i - 0.26, j + 0.26, 0.01]])];
  if (!h) {
    const top = project(p, i, j, 0.02);
    return { marks, pts: [top], top };
  }
  const rw = 0.2 + 0.05 * h;
  const [bx, by] = project(p, i, j, 0.12);
  const [, ty] = project(p, i, j, h);
  const W = rw * roundHalfWidth(p);
  const hh = by - ty;
  marks.push(...boxMarks(p, i - 0.04, j - 0.04, 0, 0.08, 0.08, 0.16, { t: "trunk", e: "trunk", s: "trunk" }, ""));
  const outline = `M${round1(bx)},${round1(ty)} C${round1(bx + W * 0.62)},${round1(ty + hh * 0.22)} ${round1(bx + W * 1.02)},${round1(ty + hh * 0.68)} ${round1(bx + W * 0.5)},${round1(by)} L${round1(bx - W * 0.5)},${round1(by)} C${round1(bx - W * 1.02)},${round1(ty + hh * 0.68)} ${round1(bx - W * 0.62)},${round1(ty + hh * 0.22)} ${round1(bx)},${round1(ty)} Z`;
  const lit = `M${round1(bx)},${round1(ty)} C${round1(bx + W * 0.62)},${round1(ty + hh * 0.22)} ${round1(bx + W * 1.02)},${round1(ty + hh * 0.68)} ${round1(bx + W * 0.5)},${round1(by)} L${round1(bx + W * 0.06)},${round1(by)} C${round1(bx + W * 0.2)},${round1(ty + hh * 0.6)} ${round1(bx + W * 0.1)},${round1(ty + hh * 0.3)} ${round1(bx)},${round1(ty)} Z`;
  let hatch = "";
  for (let q = 1; q < 6; q++) {
    const y = ty + (hh * q) / 6;
    const half = W * (0.35 + 0.45 * Math.sin((q / 6) * Math.PI));
    hatch += `M${round1(bx - half * 0.9)},${round1(y)}L${round1(bx - half * 0.2)},${round1(y + 0.8)}`;
  }
  marks.push(
    { kind: "path", cls: "tree-d e", d: outline, transform: null },
    { kind: "path", cls: "tree-l", d: lit, transform: null },
    { kind: "path", cls: "tree-h", d: hatch, transform: null },
  );
  const top = project(p, i, j, h);
  return { marks, pts: [top], top };
}

/** Year lamp (post + lantern); its warm pool is a ground mark shown in the dark theme only. */
export function lampGeometry(p: PlotProjection, i: number, j: number): PlotObjectGeometry {
  const marks = boxMarks(p, i - 0.022, j - 0.022, 0, 0.044, 0.044, 0.66, { t: "lamp-post", e: "lamp-post", s: "lamp-post" }, "");
  marks.push(...boxMarks(p, i - 0.06, j - 0.06, 0.66, 0.12, 0.12, 0.13, { t: "lamp-post", e: "lamp-glass", s: "lamp-glass" }, " e"));
  const a = project(p, i - 0.075, j - 0.075, 0.79);
  const b = project(p, i + 0.075, j - 0.075, 0.79);
  const c = project(p, i + 0.075, j + 0.075, 0.79);
  const d = project(p, i - 0.075, j + 0.075, 0.79);
  const apex = project(p, i, j, 0.88);
  marks.push(screenPolygon("lamp-post", [a, b, apex]), screenPolygon("lamp-post", [b, c, apex]), screenPolygon("lamp-post", [c, d, apex]));
  return { marks, pts: [project(p, i - 0.1, j, 0), project(p, i + 0.1, j, 0), project(p, i, j, 0.9)] };
}

/** Warm light pool under a year lamp. */
export function lampPoolMark(p: PlotProjection, i: number, j: number): PlotMark {
  const [x, y] = project(p, i, j, 0);
  return { kind: "ellipse", cls: "pool", cx: round1(x), cy: round1(y), rx: round1(S * 1.7), ry: round1(S * 0.85) };
}

/**
 * The Pharos on its bastion (square base, octagonal middle, round lantern), kept shorter than the UST column so
 * UST stays the tallest element. `lantern` is the beam origin, `top` the finial.
 */
export function lighthouseGeometry(p: PlotProjection, i: number, j: number): PlotObjectGeometry & { lantern: PlotPoint; top: PlotPoint } {
  const m: PlotMark[] = [];
  m.push(...octPrismMarks(p, i, j, 1.18, -0.55, 0.16, ["rock", "rock", "rock-s"], "rock"));
  m.push(...boxMarks(p, i - 0.92, j - 0.92, 0.16, 1.84, 1.84, 0.28, "lh"));
  m.push(...boxMarks(p, i - 0.7, j - 0.7, 0.44, 1.4, 1.4, 2.35, "lh"));
  for (let row = 0; row < 3; row++) {
    const z = 0.9 + row * 0.62;
    m.push(worldPolygon(p, "lh-win", [[i + 0.705, j - 0.06, z], [i + 0.705, j + 0.06, z], [i + 0.705, j + 0.06, z + 0.26], [i + 0.705, j - 0.06, z + 0.26]]));
    m.push(worldPolygon(p, "lh-win", [[i - 0.06, j + 0.705, z + 0.15], [i + 0.06, j + 0.705, z + 0.15], [i + 0.06, j + 0.705, z + 0.41], [i - 0.06, j + 0.705, z + 0.41]]));
  }
  m.push(...boxMarks(p, i - 0.8, j - 0.8, 2.79, 1.6, 1.6, 0.12, "lh"));
  m.push(...octPrismMarks(p, i, j, 0.52, 2.91, 4.35));
  m.push(worldPolygon(p, "lh-win", [[i + 0.525, j - 0.05, 3.4], [i + 0.525, j + 0.05, 3.4], [i + 0.525, j + 0.05, 3.7], [i + 0.525, j - 0.05, 3.7]]));
  m.push(...octPrismMarks(p, i, j, 0.63, 4.35, 4.44));
  m.push(...cylinder(p, i, j, 0.36, 4.44, 5.05, "lh-c", null, "lh-t").marks);
  m.push(...cylinder(p, i, j, 0.46, 5.05, 5.11, "lh-c", null, "lh-t").marks);
  m.push(...cylinder(p, i, j, 0.29, 5.11, 5.52, "lh-glass", null, "lh-t").marks);
  const [dx, dy] = project(p, i, j, 5.52);
  const drx = 0.33 * roundHalfWidth(p);
  m.push({
    kind: "path",
    cls: "lh-t e",
    d: `M${round1(dx - drx)},${round1(dy)} A${round1(drx)},${round1(drx * 0.95)} 0 0 1 ${round1(dx + drx)},${round1(dy)} A${round1(drx)},${round1(drx / 2)} 0 0 1 ${round1(dx - drx)},${round1(dy)} Z`,
    transform: null,
  });
  const fin = project(p, i, j, 6.05);
  m.push({ kind: "line", cls: "e", x1: round1(dx), y1: round1(dy - drx * 0.95), x2: round1(fin[0]), y2: round1(fin[1]) });
  return {
    marks: m,
    lantern: project(p, i, j, 5.3),
    top: fin,
    pts: [project(p, i - 1.2, j, -0.55), project(p, i + 1.2, j, -0.55), project(p, i, j + 1.2, -0.55), project(p, i, j - 1.2, -0.55), fin],
  };
}

/** Gate on the south curb at the avenue: two low piers and a hairline arch. */
export function gateGeometry(p: PlotProjection, i0: number, i1: number, j: number): PlotObjectGeometry {
  const marks = [...boxMarks(p, i0, j, 0, 0.24, 0.24, 0.8, "w"), ...boxMarks(p, i1 - 0.24, j, 0, 0.24, 0.24, 0.8, "w")];
  const mid = (i0 + i1) / 2;
  const half = (i1 - i0) / 2 - 0.12;
  const arch: PlotPoint[] = [];
  for (let q = 0; q <= 12; q++) {
    const ph = (q / 12) * Math.PI;
    arch.push(project(p, mid - half * Math.cos(ph), j + 0.12, 0.8 + 0.3 * Math.sin(ph)));
  }
  marks.push({ kind: "path", cls: "rail", d: formatPath(arch), transform: null });
  return { marks, pts: [project(p, i0, j, 0), project(p, i1, j + 0.24, 0), project(p, mid, j, 1.15), project(p, i0, j, 0.8), project(p, i1, j, 0.8)] };
}

/** Signpost post height (world units). */
export const PLOT_POST_HEIGHT = 0.95;

/** Signpost post (the plate is an HTML overlay hung from its top). */
export function postGeometry(p: PlotProjection, i: number, j: number): PlotObjectGeometry {
  return {
    marks: boxMarks(p, i - 0.03, j - 0.03, 0, 0.06, 0.06, PLOT_POST_HEIGHT, { t: "post", e: "post", s: "post" }, ""),
    pts: [project(p, i, j, 0), project(p, i, j, PLOT_POST_HEIGHT)],
  };
}

// ---------------------------------------------------------------------------
// Scene structure (built from a view model; world coordinates are anchored at the oldest end)
// ---------------------------------------------------------------------------

export type PlotDrawnObject =
  | { key: string; kind: "grave"; grave: PlotGrave; geometry: PlotGraveGeometry }
  | { key: string; kind: "lamp"; year: number; geometry: PlotObjectGeometry }
  | { key: string; kind: "post"; cause: CauseOfDeath; geometry: PlotObjectGeometry }
  | { key: string; kind: "gate" | "lighthouse"; geometry: PlotObjectGeometry };

/** Every drawn volume of a desktop plan with its geometry, in paint order (`map.drawOrder`). */
export function plotDrawnObjects(map: DesktopPlotMap): PlotDrawnObject[] {
  const p = PLOT_PROJECTIONS[map.projection];
  const graves = new Map(map.graves.map((g) => [`grave:${g.id}`, g]));
  const lamps = new Map(map.lamps.map((l) => [`lamp:${l.year}`, l]));
  const posts = new Map(map.signposts.map((s) => [`post:${s.cause}`, s]));
  return map.drawOrder.map((key): PlotDrawnObject => {
    const grave = graves.get(key);
    if (grave) return { key, kind: "grave", grave, geometry: graveGeometry(p, grave) };
    const lamp = lamps.get(key);
    if (lamp) return { key, kind: "lamp", year: lamp.year, geometry: lampGeometry(p, lamp.i, lamp.j) };
    const post = posts.get(key);
    if (post) return { key, kind: "post", cause: post.cause, geometry: postGeometry(p, post.i, post.j) };
    if (key === "gate") return { key, kind: "gate", geometry: gateGeometry(p, map.gate.i0, map.gate.i1, map.gate.j) };
    if (key === "lighthouse") return { key, kind: "lighthouse", geometry: lighthouseGeometry(p, map.lighthouse.i, map.lighthouse.j) };
    throw new Error(`plotDrawnObjects: unknown draw key ${key}`);
  });
}

export interface PlotSiteMarks {
  /** Atmosphere: sea bands, swell, headland faces, strata, north and west walls. */
  back: PlotMark[];
  /** Lawn, verge strip, gate avenue, sea-wall walk, lane paths, year cross-paths and empty-year strips. */
  ground: PlotMark[];
  /** Raised, cause-tinted bed cells (one per lane × year block inside the lane's bed), lanes north → south. */
  beds: { cause: CauseOfDeath; marks: PlotMark[] }[];
  /** Warm lamp pools (dark theme only), after the graves' ground marks. */
  pools: PlotMark[];
  /** Low south and east curbs, then the railing; the cypress band paints after these. */
  front: PlotMark[];
  /** Cypress band, east first so western trees overlap. */
  trees: { year: number; marks: PlotMark[] }[];
}

const flat = (p: PlotProjection, cls: string, i0: number, i1: number, j0: number, j1: number, z: number) =>
  worldPolygon(p, cls, [[i0, j0, z], [i1, j0, z], [i1, j1, z], [i0, j1, z]]);

/**
 * Structure of the desktop plan (the prototype renderer's atmosphere, structure and front layers). Paint order:
 * back → ground → beds → graves' `ground` marks → pools → objects in `drawOrder` → front → trees.
 */
export function desktopSiteMarks(map: DesktopPlotMap): PlotSiteMarks {
  const p = PLOT_PROJECTIONS[map.projection];
  const P = (i: number, j: number, z = 0) => project(p, i, j, z);
  const { iA, iB, jN, jB, slab } = map.frame;
  const { iWest: W, iAvenue, iOldest, iEast: I, jSouth: J, jFront, northTerrace: NT } = map.site;
  const back: PlotMark[] = [
    worldPolygon(p, "sea far", [[iA - 6, jN - 2.6, -0.32], [iB + 6, jN - 2.6, -0.32], [iB + 6, jN - 1.5, -0.32], [iA - 6, jN - 1.5, -0.32]]),
    worldPolygon(p, "sea", [[iA - 6, jN - 1.5, -0.32], [iB + 6, jN - 1.5, -0.32], [iB + 6, jN, -0.32], [iA - 6, jN, -0.32]]),
  ];
  let swell = "";
  for (let q = 0; q < 3; q++) {
    const j = jN - 0.35 - q * 0.42;
    const a = P(iA + 1.2 + (q % 3) * 2.3, j, -0.32);
    const b = P(iB + 1.5, j, -0.32);
    swell += `M${round1(a[0])},${round1(a[1])}L${round1(b[0])},${round1(b[1])}`;
  }
  back.push(
    { kind: "path", cls: "swell", d: swell, transform: null },
    worldPolygon(p, "earth-e e", [[iB, jN, 0], [iB, jB, 0], [iB, jB, -slab], [iB, jN, -slab]]),
    worldPolygon(p, "earth-s e", [[iA, jB, 0], [iB, jB, 0], [iB, jB, -slab], [iA, jB, -slab]]),
    { kind: "path", cls: "strata", d: [-0.24, -0.5, -0.7].map((z) => formatPath([P(iA, jB, z), P(iB, jB, z), P(iB, jN, z)])).join(""), transform: null },
    ...boxMarks(p, iA, jN, 0, iB - iA, 0.3, 0.5, "w"),
    ...boxMarks(p, iA, 0, 0, 0.3, J, 0.5, "w"),
  );

  const northToSouth = [...map.lanes].reverse();
  const ground: PlotMark[] = [flat(p, "lawn", W, I, 0, J, 0.001), flat(p, "gravel strip", iA, iB, J + 0.3, jB, 0.001)];
  ground.push(flat(p, "gravel", W + 0.18, iAvenue - 0.18, 0.18, J - 0.12, 0.003)); // gate avenue
  ground.push(flat(p, "gravel", iAvenue - 0.18, I - 0.2, 0.14, NT - 0.12, 0.003)); // sea-wall walk
  for (let q = 0; q + 1 < northToSouth.length; q++) {
    ground.push(flat(p, "gravel", iAvenue - 0.18, iOldest + 0.2, northToSouth[q].j1 + 0.07, northToSouth[q + 1].j0 - 0.07, 0.003));
  }
  ground.push(flat(p, "gravel", iAvenue - 0.18, iOldest + 0.2, NT - 0.12, northToSouth[0].j0 - 0.07, 0.003));
  for (let q = 0; q < map.blocks.length; q++) {
    const b = map.blocks[q];
    const next = map.blocks[q + 1];
    if (next) ground.push(flat(p, "gravel", b.i1 + 0.06, next.i0 - 0.06, NT - 0.12, jFront + 0.12, 0.003));
    if (b.empty) ground.push(flat(p, "gravel strip", b.i0, b.i1, NT - 0.12, jFront + 0.12, 0.003));
  }
  // The back lane before its first death is part of the sea-wall walk, not a lawn band (R11).
  const backLane = northToSouth[0];
  if (backLane.bed && backLane.bed.i0 > iAvenue + 0.5) ground.push(flat(p, "gravel", iAvenue - 0.18, backLane.bed.i0 - 0.1, backLane.j0 - 0.07, backLane.j1 + 0.07, 0.003));

  const beds = northToSouth.map((L) => ({
    cause: L.cause,
    marks: L.cells.flatMap((c) => boxMarks(p, c.i0 - 0.05, L.j0 - 0.05, 0, c.i1 - c.i0 + 0.1, L.j1 - L.j0 + 0.1, 0.045, { t: "bed", e: "curb", s: "curb" }, " e")),
  }));
  const pools = map.lamps.map((l) => lampPoolMark(p, l.i, l.j));

  const front: PlotMark[] = [
    ...boxMarks(p, W - 0.3, J, 0, 0.42, 0.3, 0.2, "w"),
    ...boxMarks(p, iAvenue - 0.12, J, 0, I - iAvenue + 0.42, 0.3, 0.2, "w"),
    ...boxMarks(p, I, -0.3, 0, 0.3, J + 0.3, 0.2, "w"),
  ];
  let rail = "";
  const railRun = (a: number, b: number, fixed: number, alongI: boolean) => {
    const at = (u: number, z: number) => (alongI ? P(u, fixed, z) : P(fixed, u, z));
    const len = b - a;
    const nPosts = Math.max(1, Math.round(len / 1.1));
    for (let q = 0; q <= nPosts; q++) {
      const u = a + (len * q) / nPosts;
      rail += formatPath([at(u, 0.2), at(u, 0.56)]);
    }
    rail += formatPath([at(a, 0.52), at(b, 0.52)]);
  };
  railRun(iAvenue, I, J + 0.15, true);
  railRun(-0.25, J + 0.2, I + 0.15, false);
  front.push({ kind: "path", cls: "rail", d: rail, transform: null });

  const trees = [...map.cypress]
    .sort((a, b) => b.i - a.i)
    .map((c) => ({ year: c.year, marks: cypressGeometry(p, c.i, c.j, c.height).marks }));
  return { back, ground, beds, pools, front, trees };
}

/** Structure of the portrait plan: sea-wall strip, lawn, headland faces, cross-paths, empty strips, bed cells. */
export function portraitSiteMarks(map: PortraitPlotMap): Pick<PlotSiteMarks, "ground" | "beds"> {
  const p = PLOT_PROJECTIONS[map.projection];
  const top = map.site.iAvenue - 0.3;
  const I = map.site.iOldest;
  const J = map.site.jSouth;
  const ground: PlotMark[] = [
    worldPolygon(p, "sea", [[top - 0.55, -0.35, 0], [top - 0.55, J + 0.35, 0], [top, J + 0.35, 0], [top, -0.35, 0]]),
    flat(p, "lawn", top, I + 0.35, -0.35, J + 0.35, 0.001),
    worldPolygon(p, "earth-e e", [[I + 0.35, -0.35, 0], [I + 0.35, J + 0.35, 0], [I + 0.35, J + 0.35, -0.6], [I + 0.35, -0.35, -0.6]]),
    worldPolygon(p, "earth-s e", [[top + 0.3, J + 0.35, 0], [I + 0.35, J + 0.35, 0], [I + 0.35, J + 0.35, -0.6], [top + 0.3, J + 0.35, -0.6]]),
  ];
  for (let q = 0; q + 1 < map.blocks.length; q++) {
    ground.push(flat(p, "gravel", map.blocks[q].i1 + 0.05, map.blocks[q + 1].i0 - 0.05, -0.2, J + 0.2, 0.003));
  }
  for (const b of map.blocks) if (b.empty) ground.push(flat(p, "gravel strip", b.i0, b.i1, -0.2, J + 0.2, 0.003));
  const beds = [...map.lanes].reverse().map((L) => ({
    cause: L.cause,
    marks: L.cells.flatMap((c) => boxMarks(p, c.i0 - 0.04, L.j0 - 0.04, 0, c.i1 - c.i0 + 0.08, L.j1 - L.j0 + 0.08, 0.04, { t: "bed", e: "curb", s: "curb" }, " e")),
  }));
  return { ground, beds };
}
