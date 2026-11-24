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
import {
  SCENE_DIMETRIC,
  SCENE_UNIT,
  bbox,
  formatPath,
  hull,
  project,
  round1,
  round3,
  roundBox,
  roundHalfWidth,
  roundPoint,
  type SceneBox,
  type SceneCell,
  type ScenePoint,
  type SceneProjection,
} from "@shared/lib/scene/projection";
import { seededStream } from "@shared/lib/scene/seed";
import { screenPolygon, worldPolygon, type SceneMark, type SceneObjectGeometry } from "@shared/lib/scene/marks";
import { boxMarks, boxPoints, contactShadowMark, cylinder as sceneCylinder, faceMatrixE, faceMatrixG, shadowMark, type SceneCylinder } from "@shared/lib/scene/solids";
import { lighthouseGeometry } from "@shared/lib/scene/objects/lighthouse";
import type { CauseOfDeath } from "@shared/lib/cause-of-death";
import type { DesktopPlotMap, PlotGrave, PortraitPlotMap } from "@/lib/cemetery-plot-map";

// The projection core, marks and solids live in the scene kit (`shared/lib/scene/`); the Cemetery keeps its names.
export { bbox, hull, lighthouseGeometry, project, round1, roundBox, roundPoint, seededStream };
export type PlotPoint = ScenePoint;
/** Screen-space bounding box (SVG user units unless stated otherwise). */
export type PlotBox = SceneBox;
/** Axis-aligned world footprint. */
export type PlotCell = SceneCell;
export type PlotCylinder = SceneCylinder;
export type PlotObjectGeometry = SceneObjectGeometry;

/** SVG units per world unit along a horizontal axis. */
export const PLOT_UNIT = SCENE_UNIT;
const DEG = Math.PI / 180;

export type PlotProjectionName = "dimetric" | "portrait";
export interface PlotProjection extends SceneProjection {
  name: PlotProjectionName;
}

const S = PLOT_UNIT;
/** Lawn + coastal sea-wall band above the newest year block on the portrait plan (world units), clearing the top sticky year band, sea wall and stones. */
export const PORTRAIT_TOP_MARGIN = 2.45;
export const PLOT_PROJECTIONS: Readonly<Record<PlotProjectionName, PlotProjection>> = {
  dimetric: { ...SCENE_DIMETRIC, name: "dimetric" },
  portrait: { name: "portrait", A: [0, S * 0.9], B: [-S, 0], C: [0, -S * 0.8], shadow: [-0.32, 0.24] },
};

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

/** The kit's marks plus the grave medallion (cause ring + atlas logo window), which the Cemetery renders itself. */
export type PlotMark = SceneMark | PlotMedallionMark;

/** The kit's vertical cylinder; the cap defaults to the stone top (`st-t`) and the rim to flat. */
function cylinder(
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
  return sceneCylinder(p, ic, jc, r, z0, z1, bodyCls, topFn, capCls);
}

/**
 * The single clean planar break of a snapped column, as a z offset of the top rim at angle θ: the rim drops `drop`
 * plus up to `amp` toward direction `phase` (the low side), and stays whole opposite it.
 */
function columnFractureTop(opts: { phase: number; amp: number; drop?: number }): (theta: number) => number {
  const { phase, amp, drop = 0 } = opts;
  return (th) => -drop - amp * (0.5 + 0.5 * Math.cos(th - phase));
}

/**
 * Direction (θ in the i–j plane) of a snapped column's low side: toward the east-north-east light. The break then
 * falls left → right on screen and its cross-section (`brk`) faces the light, the lightest face of the column.
 */
const PLOT_FRACTURE_PHASE = Math.atan2(-0.383, 0.924);

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
/** Raised turf bed top height per projection (world units). */
const PLOT_BED_HEIGHT: Readonly<Record<PlotProjectionName, number>> = { dimetric: 0.045, portrait: 0.14 };
/** Raised lot pad top height for lot > 1 graves per projection (world units). */
const PLOT_PAD_HEIGHT: Readonly<Record<PlotProjectionName, number>> = { dimetric: 0.05, portrait: 0.16 };
/** Inset of a lot > 1 raised pad inside its lot footprint (world units). */
const PLOT_PAD_INSET = 0.05;
/** Margin of the solid neutral plinth for an unrecorded peak (world units). */
const PLOT_UNRECORDED_PLINTH_EXTENT = 0.08;
/** Medallion diameter on a 1×1 stone (world units). */
const PLOT_MEDALLION = 0.44;
/** Base stone heights before the log-peak height factor (world units). */
const PLOT_BASE_HEIGHT: Readonly<Record<PlotArchetype, number>> = {
  pillow: 0.72,
  "split-arch": 0.98,
  "sealed-tablet": 0.9,
  "broken-column": 1.16,
  urn: 1.08,
};

/** Top z of the bed (lot 1) or raised lot pad (lot > 1) a grave stands on. */
function graveSupportZ(projectionName: PlotProjectionName, lot: PlotLot): number {
  return lot > 1 ? PLOT_PAD_HEIGHT[projectionName] : PLOT_BED_HEIGHT[projectionName];
}

/** Footprint of the raised lot pad for a lot > 1 grave, inset inside its lot cell. */
export function lotPadCell(cell: PlotCell): PlotCell {
  return {
    i0: cell.i0 + PLOT_PAD_INSET,
    i1: cell.i1 - PLOT_PAD_INSET,
    j0: cell.j0 + PLOT_PAD_INSET,
    j1: cell.j1 - PLOT_PAD_INSET,
  };
}

/**
 * Half-extents of a lot-3 colossus podium. Desktop fills its 2 × 2 lot clear of the pad edge and of the 0.14 west
 * shift; portrait scales cleanly inside its own column pad.
 */
function colossusHalfExtents(shape: PlotShape, cell: PlotCell, projectionName: PlotProjectionName): { ei: number; ej: number } {
  if (projectionName !== "portrait") {
    return {
      ei: round3((cell.i1 - cell.i0) / 2 - PLOT_PAD_INSET - 0.2),
      ej: round3((cell.j1 - cell.j0) / 2 - PLOT_PAD_INSET - 0.04),
    };
  }
  const maxJ = Math.max(0.36, (cell.j1 - cell.j0) / 2 - PLOT_PAD_INSET - 0.13);
  const maxI = Math.max(0.42, (cell.i1 - cell.i0) / 2 - PLOT_PAD_INSET - 0.12);
  const ej = Math.min(1.24, maxJ);
  const ei = Math.min(shape === "colossal-column" ? 1.24 : 1.28, ej * 1.04, maxI);
  return { ei, ej };
}

/**
 * Colossus centre along i inside its lot: slightly west on desktop to widen east stair clearance, and seated low in
 * its portrait pad so upward shaft/roof relief stays strictly inside its own lot without colliding with older/newer rows.
 */
function colossusCenterI(shape: PlotShape, cell: PlotCell, projectionName: PlotProjectionName): number {
  if (projectionName !== "portrait") return (cell.i0 + cell.i1) / 2 - 0.14;
  const { ei } = colossusHalfExtents(shape, cell, projectionName);
  const lo = cell.i0 + PLOT_PAD_INSET + ei + 0.04;
  const hi = cell.i1 - PLOT_PAD_INSET - ei - 0.78;
  return hi >= lo ? hi : (cell.i0 + cell.i1) / 2;
}

/** Single authority for a grave's stone half-widths (hi, hj) and plinth flange (fe) in world units. */
function graveHalfExtents(
  shape: PlotShape,
  lot: PlotLot,
  steps: PlotPeakClass | null,
  cell?: PlotCell,
  projectionName: PlotProjectionName = "dimetric",
): { hi: number; hj: number; fe: number } {
  if (lot === 3) {
    if (cell) {
      const { ei, ej } = colossusHalfExtents(shape, cell, projectionName);
      return { hi: ei, hj: ej, fe: 0 };
    }
    return { hi: shape === "colossal-column" ? 1.24 : 1.28, hj: 1.24, fe: 0 };
  }
  const open = steps === null;
  const n = steps ?? 0;
  const fe = open ? PLOT_UNRECORDED_PLINTH_EXTENT : n ? 0.05 + 0.06 * (n - 1) : 0;
  const sc = lot === 2 ? 1.55 : 1;
  if (shape === "chest-tomb") return { hi: 0.6, hj: 0.45, fe };
  const archetype = baseArchetypeOf(shape);
  if (archetype === "pillow") return { hi: 0.13 * sc, hj: 0.34 * sc, fe };
  if (archetype === "split-arch") return { hi: 0.1 * sc, hj: 0.3 * sc, fe };
  if (archetype === "sealed-tablet") return { hi: 0.09 * sc, hj: 0.32 * sc, fe };
  return { hi: 0.29 * sc, hj: 0.29 * sc, fe };
}

/**
 * Per-archetype anchor offset east of `cell.i0` (world units), keeping every plinth, cornice and lid inside its lot
 * (and inside its lot pad for lot > 1) instead of overhanging the cell's west edge. In the vertical portrait walk,
 * 1×1 stones seat deeper in their row so upward shafts clear plinths in the row above.
 */
export function graveAnchorOffsetI(
  shape: PlotShape,
  lot: PlotLot,
  steps: PlotPeakClass | null,
  projectionName: PlotProjectionName = "dimetric",
): number {
  // Desktop: the podium centre of a 2-row colossus lot (half its two 1.1-unit rows, less the 0.14 west shift).
  if (lot === 3) return projectionName === "portrait" ? 1.1 : 0.96;
  const { hi, fe } = graveHalfExtents(shape, lot, steps);
  const sc = lot === 2 ? 1.55 : 1;
  const baseReach =
    shape === "chest-tomb"
      ? Math.max(hi + fe, hi + 0.07)
      : shape === "urn"
        ? Math.max(hi + fe, hi + 0.03 * sc)
        : shape === "sealed-tablet"
          ? Math.max(hi + fe, hi + 0.02 * sc)
          : hi + fe;
  const floorOffset =
    lot === 2
      ? projectionName === "portrait"
        ? shape === "chest-tomb"
          ? 1.78
          : shape === "broken-column"
            ? 1.56
            : 1.32
        : 0.78
      : projectionName === "portrait"
        ? 0.56
        : 0.3;
  const minOffset = lot === 2 ? Math.max(floorOffset, baseReach + PLOT_PAD_INSET + 0.02) : Math.max(floorOffset, baseReach + 0.02);
  return Math.ceil(minOffset * 100) / 100;
}

/** World footprint of a grave's bottom plinth (or colossus podium), shared by geometry and the curb-overhang check. */
export function gravePlinthFootprint(
  g: Pick<PlotGraveShapeInput, "shape" | "lot" | "steps" | "cell" | "anchor">,
  projectionName: PlotProjectionName = "dimetric",
): PlotCell {
  const { hi, hj, fe } = graveHalfExtents(g.shape, g.lot, g.steps, g.cell, projectionName);
  const ic = g.lot === 3 ? colossusCenterI(g.shape, g.cell, projectionName) : g.anchor.i;
  const jc = g.anchor.j;
  return { i0: ic - hi - fe, i1: ic + hi + fe, j0: jc - hj - fe, j1: jc + hj + fe };
}

export interface PlotGroundMarkLayout {
  mound: PlotCell | null;
  bronze: PlotCell | null;
  footstone: PlotCell | null;
}

/**
 * Single authority for a grave's ground-mark footprints (mound/fresh soil, bronze archive plaque, non-USD footstone),
 * clipped strictly to the grave's bed cell (lot 1) or raised lot pad (lot > 1). When both plaque and footstone exist,
 * they sit side by side along `j` without overlap.
 */
export function graveGroundMarksLayout(
  g: Pick<PlotGraveShapeInput, "shape" | "lot" | "steps" | "archived" | "footstone" | "cell" | "anchor">,
  projectionName: PlotProjectionName = "dimetric",
): PlotGroundMarkLayout {
  const jc = g.anchor.j;
  const pad = g.lot > 1 ? lotPadCell(g.cell) : g.cell;
  const inset = g.lot > 1 ? 0.03 : 0.04;
  const sup: PlotCell = { i0: pad.i0 + inset, i1: pad.i1 - inset, j0: pad.j0 + inset, j1: pad.j1 - inset };
  const plinth = gravePlinthFootprint(g, projectionName);
  if (projectionName === "portrait") {
    if (g.lot === 3) {
      if (!g.archived) return { mound: null, bronze: null, footstone: null };
      const bi0 = Math.min(plinth.i1 + 0.06, sup.i1 - 0.16);
      const bi1 = Math.min(sup.i1, bi0 + 0.16);
      if (bi1 - bi0 < 0.09) return { mound: null, bronze: null, footstone: null };
      return {
        mound: null,
        bronze: { i0: bi0, i1: bi1, j0: Math.max(sup.j0, jc - 0.24), j1: Math.min(sup.j1, jc + 0.24) },
        footstone: null,
      };
    }
    const mi0 = plinth.i1 + 0.03;
    const both = g.archived && g.footstone !== null;
    const maxMoundLen = g.lot === 2 ? 0.38 : both ? 0.34 : 0.3;
    const mi1 = Math.min(sup.i1, mi0 + maxMoundLen);
    if (mi1 - mi0 < 0.14) return { mound: null, bronze: null, footstone: null };
    const targetMhj = g.lot === 1 ? (both ? 0.34 : 0.24) : 0.36;
    const maxMhj = Math.max(0, Math.min(jc - sup.j0, sup.j1 - jc));
    const mhj = Math.min(targetMhj, maxMhj);
    const mound: PlotCell = { i0: mi0, i1: mi1, j0: jc - mhj, j1: jc + mhj };
    let bronze: PlotCell | null = null;
    let footstone: PlotCell | null = null;
    if (both) {
      const pi0 = mi0 + 0.03;
      const pi1 = Math.min(mi1 - 0.02, pi0 + 0.15);
      const fi0 = mi0 + 0.02;
      const fi1 = Math.min(mi1, fi0 + 0.22);
      bronze = { i0: pi0, i1: pi1, j0: Math.max(sup.j0, jc - 0.31), j1: jc - 0.05 };
      footstone = { i0: fi0, i1: fi1, j0: jc + 0.04, j1: Math.min(sup.j1, jc + 0.31) };
    } else if (g.archived) {
      const pi0 = mi0 + 0.03;
      const pi1 = Math.min(mi1 - 0.02, pi0 + 0.15);
      bronze = { i0: pi0, i1: pi1, j0: Math.max(sup.j0, jc - 0.17), j1: Math.min(sup.j1, jc + 0.17) };
    } else if (g.footstone !== null) {
      const fi0 = mi0 + 0.02;
      const fi1 = Math.min(mi1, fi0 + 0.22);
      footstone = { i0: fi0, i1: fi1, j0: Math.max(sup.j0, jc - 0.14), j1: Math.min(sup.j1, jc + 0.14) };
    }
    return { mound, bronze, footstone };
  }
  if (g.lot === 3) {
    if (!g.archived) return { mound: null, bronze: null, footstone: null };
    const bi0 = Math.max(plinth.i1 + 0.04, sup.i1 - 0.24);
    const bi1 = sup.i1;
    if (bi1 - bi0 < 0.14) return { mound: null, bronze: null, footstone: null };
    return {
      mound: null,
      bronze: { i0: bi0, i1: bi1, j0: Math.max(sup.j0, jc - 0.14), j1: Math.min(sup.j1, jc + 0.14) },
      footstone: null,
    };
  }
  const mi0 = g.shape === "chest-tomb" ? Math.max(plinth.i1 + 0.05, sup.i1 - 0.3) : plinth.i1 + 0.05;
  const both = g.archived && g.footstone !== null;
  const maxMoundLen = g.lot === 2 ? 0.55 : both ? 0.42 : 0.46;
  const mi1 = Math.min(sup.i1, mi0 + maxMoundLen);
  if (mi1 - mi0 < 0.18) return { mound: null, bronze: null, footstone: null };
  const targetMhj = g.lot === 1 ? (both ? 0.34 : 0.24) : 0.34;
  const maxMhj = Math.max(0, Math.min(jc - sup.j0, sup.j1 - jc));
  const mhj = Math.min(targetMhj, maxMhj);
  const mound: PlotCell = { i0: mi0, i1: mi1, j0: jc - mhj, j1: jc + mhj };
  let bronze: PlotCell | null = null;
  let footstone: PlotCell | null = null;
  if (both) {
    const pi1 = Math.min(mi1 - 0.01, mi0 + 0.21);
    const pi0 = Math.max(mi0, pi1 - 0.19);
    const fi0 = Math.max(mi0, Math.min(mi0 + 0.02, mi1 - 0.2));
    const fi1 = Math.min(mi1, fi0 + 0.2);
    bronze = { i0: pi0, i1: pi1, j0: Math.max(sup.j0, jc - 0.29), j1: jc - 0.05 };
    footstone = { i0: fi0, i1: fi1, j0: jc + 0.03, j1: Math.min(sup.j1, jc + 0.31) };
  } else if (g.archived) {
    const pi1 = Math.min(mi1 - 0.01, Math.max(mi0 + 0.18, mi1 - 0.03));
    const pi0 = Math.max(mi0, pi1 - 0.2);
    bronze = { i0: pi0, i1: pi1, j0: Math.max(sup.j0, jc - 0.13), j1: Math.min(sup.j1, jc + 0.13) };
  } else if (g.footstone !== null) {
    const fi0 = Math.max(mi0, Math.min(mi0 + 0.04, mi1 - 0.2));
    const fi1 = Math.min(mi1, fi0 + 0.2);
    footstone = { i0: fi0, i1: fi1, j0: Math.max(sup.j0, jc - 0.15), j1: Math.min(sup.j1, jc + 0.15) };
  }
  return { mound, bronze, footstone };
}

/** The grave fields the shape geometry reads (a `PlotGrave` satisfies it; the legend builds its own). */
export interface PlotGraveShapeInput {
  readonly shape: PlotShape;
  readonly lot: PlotLot;
  /** Plinth steps; null = peak not recorded (one solid neutral hatched plinth, hatched face). */
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
  /** Level plinth (or colossus podium), never rotated by `lean`. */
  plinth: PlotMark[];
  /** Stone, weathering and medallion, in paint order; rotated by `lean` when set. */
  stone: PlotMark[];
  /** Deterministic ground contact-shadow band along the base's south and west edges (rendered before `plinth`). */
  contact: PlotMark[];
  /** Convenience union `[...plinth, ...stone]` in paint order for read-only consumers (glyphs, colossus hulls). */
  body: PlotMark[];
  lean: { deg: number; x: number; y: number } | null;
  /** Flat ground marks: raised lot pad (lot > 1), shadow, mound or fresh soil, bronze plaque, footstone. */
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

/** Plinth ladder: one box per step; an unrecorded peak gets one cool neutral plinth hatched on front and top faces. */
function plinthMarks(p: PlotProjection, ic: number, jc: number, hi: number, hj: number, n: number, open: boolean, baseZ: number): PlotMark[] {
  if (open) {
    const e = PLOT_UNRECORDED_PLINTH_EXTENT;
    const i0 = ic - hi - e;
    const j0 = jc - hj - e;
    const di = 2 * (hi + e);
    const dj = 2 * (hj + e);
    const z1 = baseZ + PLOT_STEP_HEIGHT;
    return [
      ...boxMarks(p, i0, j0, baseZ, di, dj, PLOT_STEP_HEIGHT, { t: "pl-nr-t", e: "pl-nr-e", s: "pl-nr-s" }, " e"),
      worldPolygon(p, "hatch-plinth", [[i0, j0 + dj, baseZ], [i0 + di, j0 + dj, baseZ], [i0 + di, j0 + dj, z1], [i0, j0 + dj, z1]]),
      worldPolygon(p, "hatch-plinth", [[i0 + di, j0, baseZ], [i0 + di, j0 + dj, baseZ], [i0 + di, j0 + dj, z1], [i0 + di, j0, z1]]),
      worldPolygon(p, "hatch-plinth", [[i0, j0, z1], [i0 + di, j0, z1], [i0 + di, j0 + dj, z1], [i0, j0 + dj, z1]]),
    ];
  }
  const out: PlotMark[] = [];
  for (let s = 0; s < n; s++) {
    const e = 0.05 + 0.06 * (n - 1 - s);
    out.push(...boxMarks(p, ic - hi - e, jc - hj - e, baseZ + s * PLOT_STEP_HEIGHT, 2 * (hi + e), 2 * (hj + e), PLOT_STEP_HEIGHT, "pl"));
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

/**
 * Local front-oblique camera for portrait graves (`A = [+aX, aY]`, `B = [-S, 0]`, `C = [0, -cY]`): keeps columns
 * plumb and every stone's front face level with the horizontal bed curbs and sticky year bands, while revealing
 * shaded left side faces (`st-s`, `pl-s`) on every monument, pedestal, chest tomb and colossus.
 */
function portraitLocalCamera(
  p: PlotProjection,
  iRef: number,
  lot: PlotLot,
): { proj: PlotProjection; dx: number; dy: number } {
  if (p.name !== "portrait") return { proj: p, dx: 0, dy: 0 };
  const aX = lot === 3 ? S * 0.18 : S * 0.28;
  const proj: PlotProjection = { ...p, A: [aX, p.A[1]] };
  return { proj, dx: -iRef * aX, dy: 0 };
}

function shiftPt(pt: PlotPoint, dx: number, dy: number): PlotPoint {
  return dx === 0 && dy === 0 ? pt : [pt[0] + dx, pt[1] + dy];
}

function shiftPathCoords(d: string, dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return d;
  let out = "";
  let pos = 0;
  while (pos < d.length) {
    const cmd = d[pos];
    if (cmd !== "M" && cmd !== "L") {
      out += cmd;
      pos++;
      continue;
    }
    const comma = d.indexOf(",", pos + 1);
    if (comma < 0) return out + d.slice(pos);
    let end = comma + 1;
    while (end < d.length && d[end] !== "M" && d[end] !== "L") end++;
    const x = Number(d.slice(pos + 1, comma));
    const y = Number(d.slice(comma + 1, end));
    out += `${cmd}${round1(x + dx)},${round1(y + dy)}`;
    pos = end;
  }
  return out;
}

function shiftMark(m: PlotMark, dx: number, dy: number): PlotMark {
  if (dx === 0 && dy === 0) return m;
  switch (m.kind) {
    case "polygon":
    case "polyline":
      return { ...m, points: m.points.map(([x, y]) => [round1(x + dx), round1(y + dy)]) };
    case "ellipse":
      return { ...m, cx: round1(m.cx + dx), cy: round1(m.cy + dy) };
    case "line":
      return { ...m, x1: round1(m.x1 + dx), y1: round1(m.y1 + dy), x2: round1(m.x2 + dx), y2: round1(m.y2 + dy) };
    case "medallion":
      return {
        ...m,
        cx: round1(m.cx + dx),
        cy: round1(m.cy + dy),
        logo: { ...m.logo, x: round1(m.logo.x + dx), y: round1(m.logo.y + dy) },
        initial: { ...m.initial, x: round1(m.initial.x + dx), y: round1(m.initial.y + dy) },
      };
    case "path":
      return m.transform
        ? { ...m, transform: [m.transform[0], m.transform[1], m.transform[2], m.transform[3], round1(m.transform[4] + dx), round1(m.transform[5] + dy)] }
        : { ...m, d: shiftPathCoords(m.d, dx, dy) };
    case "circle":
      return m.transform
        ? { ...m, transform: [m.transform[0], m.transform[1], m.transform[2], m.transform[3], round1(m.transform[4] + dx), round1(m.transform[5] + dy)] }
        : { ...m, cx: round1(m.cx + dx), cy: round1(m.cy + dy) };
    case "glyph":
      return { ...m, transform: [m.transform[0], m.transform[1], m.transform[2], m.transform[3], round1(m.transform[4] + dx), round1(m.transform[5] + dy)] };
  }
}

/**
 * Raised stone-curbed box for portrait beds and lot pads: plumb vertical alignment with the gravel paths, a visible
 * front curb face (`i = i1`), a subtly battered shaded left curb face (`j = j1`), and a grounded base contact shadow.
 */
function portraitCurbedBoxMarks(
  p: PlotProjection,
  i0: number,
  i1: number,
  j0: number,
  j1: number,
  height: number,
  mat: { t: string; curb: string },
  edge = " e",
  batter = 0.055,
  shadowBand = 0.055,
): PlotMark[] {
  const topJ1 = Math.max(j0 + 0.08, j1 - batter);
  return [
    ...(shadowBand > 0
      ? [
          worldPolygon(p, "contact", [
            [i0, j1, 0.002],
            [i1, j1, 0.002],
            [i1, j0, 0.002],
            [i1 + shadowBand * 1.15, j0, 0.002],
            [i1 + shadowBand * 1.15, j1 + shadowBand, 0.002],
            [i0, j1 + shadowBand, 0.002],
          ]),
        ]
      : []),
    // Shaded left (south) battered curb face
    worldPolygon(p, mat.curb + edge, [[i0, j1, 0], [i1, j1, 0], [i1, topJ1, height], [i0, topJ1, height]]),
    // Shaded front (east) curb face
    worldPolygon(p, mat.curb + edge, [[i1, j0, 0], [i1, j1, 0], [i1, topJ1, height], [i1, j0, height]]),
    // Top lawn / pad surface
    worldPolygon(p, mat.t + edge, [[i0, j0, height], [i1, j0, height], [i1, topJ1, height], [i0, topJ1, height]]),
  ];
}

/** Portrait base contact shadow: grounds the stone along its left (south) edge AND directly beneath its front (east) lip. */
function portraitContactShadowMark(p: PlotProjection, foot: readonly [number, number, number, number], z: number, band: number): PlotMark {
  const [i0, i1, j0, j1] = foot;
  const front = band * 1.15;
  return worldPolygon(p, "contact", [
    [i0 - band * 0.6, j0, z],
    [i0, j0, z],
    [i0, j1, z],
    [i1, j1, z],
    [i1, j0, z],
    [i1 + front, j0, z],
    [i1 + front, j1 + band, z],
    [i0 - band * 0.6, j1 + band, z],
  ]);
}

/** Raised lot pad for lot > 1 graves, painted in bed material + cause tint before ground marks and shadows. */
function lotPadMarks(p: PlotProjection, cell: PlotCell, height: number): PlotMark[] {
  const pad = lotPadCell(cell);
  if (p.name === "portrait") {
    return portraitCurbedBoxMarks(p, pad.i0, pad.i1, pad.j0, pad.j1, height, { t: "pad", curb: "pad-curb" }, " e", 0.05, 0.05);
  }
  return boxMarks(p, pad.i0, pad.j0, 0, pad.i1 - pad.i0, pad.j1 - pad.j0, height, { t: "pad", e: "pad-curb", s: "pad-curb" }, " e");
}

/** Mound east of the stone, bronze archive plaque, non-USD footstone; fresh soil within 90 days of `asOf`. */
function moundMarks(p: PlotProjection, g: PlotGraveShapeInput, baseZ: number): PlotMark[] {
  const layout = graveGroundMarksLayout(g, p.name);
  const out: PlotMark[] = [];
  const mz = baseZ + 0.004;
  const isPortrait = p.name === "portrait";
  if (layout.mound) {
    const m = layout.mound;
    if (isPortrait) {
      // Soft chamfered organic turf/soil apron in the walk (no heavy rectangular outline under every grave).
      const c = Math.min(0.05, (m.i1 - m.i0) * 0.28, (m.j1 - m.j0) * 0.16);
      out.push(
        worldPolygon(p, g.fresh ? "soil es" : "mound", [
          [m.i0, m.j0 + c, mz],
          [m.i0, m.j1 - c, mz],
          [m.i0 + c, m.j1, mz],
          [m.i1 - c, m.j1, mz],
          [m.i1, m.j1 - c, mz],
          [m.i1, m.j0 + c, mz],
          [m.i1 - c, m.j0, mz],
          [m.i0 + c, m.j0, mz],
        ]),
      );
    } else {
      out.push(worldPolygon(p, `${g.fresh ? "soil" : "mound"} es`, [[m.i0, m.j0, mz], [m.i1, m.j0, mz], [m.i1, m.j1, mz], [m.i0, m.j1, mz]]));
    }
  }
  if (layout.bronze) {
    const b = layout.bronze;
    const bz = mz + 0.003;
    out.push(worldPolygon(p, "bronze e", [[b.i0, b.j0, bz], [b.i1, b.j0, bz], [b.i1, b.j1, bz], [b.i0, b.j1, bz]]));
  }
  if (layout.footstone && g.footstone !== null) {
    const f = layout.footstone;
    const fh = 0.08;
    out.push(
      isPortrait
        ? portraitContactShadowMark(p, [f.i0, f.i1, f.j0, f.j1], mz, 0.022)
        : contactShadowMark(p, [f.i0, f.i1, f.j0, f.j1], mz, 0.025),
    );
    out.push(...boxMarks(p, f.i0, f.j0, mz, f.i1 - f.i0, f.j1 - f.j0, fh, "fs", " e"));
    if (isPortrait) {
      const [gx, gy] = project(p, (f.i0 + f.i1) / 2, (f.j0 + f.j1) / 2, mz + fh + 0.002);
      out.push({
        kind: "glyph",
        cls: "glyph",
        text: g.footstone,
        transform: [S, 0, 0, S, round1(gx - S * 0.075), round1(gy + S * 0.085)],
        scale: 0.24,
      });
    } else {
      out.push({
        kind: "glyph",
        cls: "glyph",
        text: g.footstone,
        transform: faceMatrixG(p, f.i0 + 0.03, f.j1 - 0.03, mz + fh + 0.002),
        scale: 0.24,
      });
    }
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
export function graveGeometry(siteP: PlotProjection, g: PlotGraveShapeInput): PlotGraveGeometry {
  if (g.lot === 3) return colossusGeometry(siteP, g);
  const rnd = seededStream(g.seed);
  const sc = g.lot === 2 ? 1.55 : 1;
  const ic = g.anchor.i;
  const jc = g.anchor.j;
  const { proj: p, dx, dy } = portraitLocalCamera(siteP, ic, g.lot);
  const isPortrait = siteP.name === "portrait";
  const open = g.steps === null;
  const n = g.steps ?? 0;
  const baseZ = graveSupportZ(siteP.name, g.lot);
  const z0 = baseZ + (open ? PLOT_STEP_HEIGHT : n * PLOT_STEP_HEIGHT);
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
    pts = boxPoints(p, ic - hi - 0.07, jc - hj - 0.07, baseZ, bi + 0.14, bj + 0.14, topZ - baseZ);
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
    // one clean planar break toward the light; the seeded jitter (±0.25 rad) keeps the columns from reading as stamped.
    // On the steep portrait walk, cap column shaft relief slightly so stacked algorithmic columns clear the plinth above.
    const colH = isPortrait ? h * 0.8 : h;
    const topFn = columnFractureTop({ phase: PLOT_FRACTURE_PHASE + (rnd() - 0.5) * 0.5, amp: (isPortrait ? 0.24 : 0.3) * sc });
    stone.push(...cylinder(p, ic, jc, r * 1.22, z0 + bh, z0 + bh + 0.05, "col", null, "st-t").marks);
    const cyl = cylinder(p, ic, jc, r, z0 + bh + 0.05, z0 + colH + 0.06, "col", topFn, "brk");
    stone.push(...cyl.marks);
    if (isPortrait) topZ = z0 + colH + 0.06;
    if (open) stone.push(worldPolygon(p, "hatch", [[ic + hi, jc - hj, z0], [ic + hi, jc + hj, z0], [ic + hi, jc + hj, z0 + bh], [ic + hi, jc - hj, z0 + bh]]));
    faceI = ic + hi;
    faceW = bw;
    faceH = bh;
    medZ = z0 + bh * 0.5;
    medD = Math.min(PLOT_MEDALLION, bh * 1.2);
    pts = cyl.pts.concat(boxPoints(p, ic - hi, jc - hj, baseZ, bw, bw, z0 + bh - baseZ));
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
    pts = bodyPts.concat(boxPoints(p, ic - hi - 0.035, jc - hj - 0.035, baseZ, pw + 0.07, pw + 0.07, zb - baseZ));
    stone.push(...weatheringMarks(p, g.weather, faceI, jc, z0, pw, ph, rnd));
  }

  const [mx, my] = project(p, faceI + 0.01, jc, medZ);
  stone.push(medallionMark(mx, my, medD));

  const plinth = plinthMarks(p, ic, jc, hi, hj, open ? 1 : n, open, baseZ);
  const fe = open ? PLOT_UNRECORDED_PLINTH_EXTENT : n ? 0.05 + 0.06 * (n - 1) : 0;
  if (n || open) pts = pts.concat(boxPoints(p, ic - hi - fe, jc - hj - fe, baseZ, 2 * (hi + fe), 2 * (hj + fe), 0.001));
  const foot: [number, number, number, number] = [ic - hi - fe, ic + hi + fe, jc - hj - fe, jc + hj + fe];
  const contact = [
    isPortrait
      ? portraitContactShadowMark(p, foot, baseZ, g.lot === 2 ? 0.06 : 0.048)
      : contactShadowMark(p, foot, baseZ, g.lot === 2 ? 0.055 : 0.04),
  ];

  let lean: PlotGraveGeometry["lean"] = null;
  if (g.lean) {
    const [bx, by] = shiftPt(project(p, ic, jc, z0), dx, dy);
    lean = { deg: round1(g.lean), x: round1(bx), y: round1(by) };
  }
  const shiftedPlinth = dx === 0 && dy === 0 ? plinth : plinth.map((m) => shiftMark(m, dx, dy));
  const shiftedStone = dx === 0 && dy === 0 ? stone : stone.map((m) => shiftMark(m, dx, dy));
  const shiftedContact = dx === 0 && dy === 0 ? contact : contact.map((m) => shiftMark(m, dx, dy));
  const localGround: PlotMark[] = [shadowMark(p, foot, topZ), ...moundMarks(p, g, baseZ)];
  const ground: PlotMark[] = [
    ...(g.lot > 1 ? lotPadMarks(siteP, g.cell, baseZ) : []),
    ...(dx === 0 && dy === 0 ? localGround : localGround.map((m) => shiftMark(m, dx, dy))),
  ];
  const shiftedPts = dx === 0 && dy === 0 ? pts : pts.map((pt) => shiftPt(pt, dx, dy));
  const [tx, ty] = shiftPt(project(p, ic, jc, topZ), dx, dy);
  return {
    plinth: shiftedPlinth,
    stone: shiftedStone,
    contact: shiftedContact,
    body: [...shiftedPlinth, ...shiftedStone],
    lean,
    ground,
    pts: shiftedPts,
    topZ,
    medal: { x: round1(mx + dx), y: round1(my + dy), r: round1((medD * S) / 2) },
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
function colossusGeometry(siteP: PlotProjection, g: PlotGraveShapeInput): PlotGraveGeometry {
  const rnd = seededStream(g.seed);
  const isPortrait = siteP.name === "portrait";
  const baseZ = graveSupportZ(siteP.name, g.lot);
  const jc = g.anchor.j;
  const ic = colossusCenterI(g.shape, g.cell, siteP.name);
  const { proj: p, dx, dy } = portraitLocalCamera(siteP, ic, g.lot);
  const { ei, ej } = colossusHalfExtents(g.shape, g.cell, siteP.name);
  // Portrait scales the whole colossus into its pad; on desktop the column keeps its full drum and pedestal on its 2 × 2
  // podium while the mausoleum scales its plan (not its height) into the same lot.
  const scaled = isPortrait || g.shape === "mausoleum";
  const sx = scaled ? ej / 1.24 : 1;
  const si = scaled ? ei / (g.shape === "colossal-column" ? 1.24 : 1.28) : 1;
  const plinth: PlotMark[] = [];
  const stone: PlotMark[] = [];
  const padMarks: PlotMark[] = [...lotPadMarks(siteP, g.cell, baseZ)];
  const ground: PlotMark[] = [];
  let pts: PlotPoint[];
  let H: number;
  let medal: { x: number; y: number; r: number };
  const stepH = isPortrait ? 0.065 : 0.13;
  // Desktop podium steps narrow to 0.03 on any side shorter than the full 1.2 half-extent, keeping the top step wider
  // than the pedestal or cella it carries.
  const treadI = isPortrait ? 0.09 * si : ei < 1.2 ? 0.03 : 0.09;
  const treadJ = isPortrait ? 0.09 * sx : ej < 1.2 ? 0.03 : 0.09;
  const podium = (pi: number, pj: number) => {
    for (let q = 0; q < 4; q++) {
      plinth.push(...boxMarks(p, ic - pi + treadI * q, jc - pj + treadJ * q, baseZ + q * stepH, 2 * (pi - treadI * q), 2 * (pj - treadJ * q), stepH, "pl", q === 0 ? " e" : " es"));
    }
  };
  const foot: [number, number, number, number] = [ic - ei, ic + ei, jc - ej, jc + ej];
  if (g.shape === "colossal-column") {
    // UST: a snapped colossal fluted column (the broken top already tells the collapse; no fallen drum).
    podium(ei, ej);
    const zp = baseZ + 4 * stepH;
    const pedBaseH = isPortrait ? 0.06 : 0.12;
    const pedBodyH = isPortrait ? 0.62 : 1.18;
    const pedCapH = isPortrait ? 0.06 : 0.12;
    const pbI = 0.74 * si;
    const pbJ = 0.74 * sx;
    const pI = 0.64 * si;
    const pJ = 0.64 * sx;
    const pcI = 0.76 * si;
    const pcJ = 0.76 * sx;
    stone.push(...boxMarks(p, ic - pbI, jc - pbJ, zp, 2 * pbI, 2 * pbJ, pedBaseH, "st"));
    stone.push(...boxMarks(p, ic - pI, jc - pJ, zp + pedBaseH, 2 * pI, 2 * pJ, pedBodyH, "st"));
    stone.push(...boxMarks(p, ic - pcI, jc - pcJ, zp + pedBaseH + pedBodyH, 2 * pcI, 2 * pcJ, pedCapH, "st"));
    const fi = ic + pI + 0.004;
    stone.push(...weatheringMarks(p, g.weather, ic + pI, jc, zp + pedBaseH, 1.1 * sx, pedBodyH * 0.92, rnd));
    const z1 = zp + pedBaseH + pedBodyH + pedCapH;
    const top = isPortrait ? 2.15 : 6.9;
    const colR = 0.48 * Math.min(si, sx);
    const topFn = columnFractureTop({ phase: PLOT_FRACTURE_PHASE, drop: isPortrait ? 0.09 : 0.25, amp: isPortrait ? 0.3 : 0.85 });
    const cyl = cylinder(p, ic, jc, colR, z1, top, "col", topFn, "brk");
    stone.push(...cyl.marks);
    let fl = "";
    for (let q = 0; q < 8; q++) {
      const th = (-36 + q * 22) * DEG;
      const a = project(p, ic + colR * Math.cos(th), jc + colR * Math.sin(th), z1 + 0.04);
      const b = project(p, ic + colR * Math.cos(th), jc + colR * Math.sin(th), top + topFn(th) - 0.04);
      fl += `M${round1(a[0])},${round1(a[1])}L${round1(b[0])},${round1(b[1])}`;
    }
    stone.push({ kind: "path", cls: "flute", d: fl, transform: null });
    const medD = isPortrait ? Math.min(0.54, 1.5 * pJ) : 0.62;
    const [mx, my] = project(p, fi + 0.01, jc, zp + pedBaseH + pedBodyH * 0.68);
    stone.push(medallionMark(mx, my, medD));
    medal = { x: round1(mx), y: round1(my), r: round1((medD * S) / 2) };
    H = top;
    pts = cyl.pts.concat(boxPoints(p, ic - ei, jc - ej, baseZ, 2 * ei, 2 * ej, z1 - baseZ));
    ground.push(shadowMark(p, foot, zp), shadowMark(p, [ic - 0.5 * si, ic + 0.5 * si, jc - 0.5 * sx, jc + 0.5 * sx], H * 0.92));
  } else {
    // BUSD: a sealed, intact mausoleum; barred door with a closed-by-order seal, gavel carved flat in the tympanum.
    podium(ei, ej);
    const zp = baseZ + 4 * stepH;
    const ze = isPortrait ? baseZ + 1.04 : baseZ + 2.3;
    const ci0 = ic - 1.02 * si;
    const ci1 = ic + 0.45 * si;
    const cj = 0.92 * sx;
    stone.push(...boxMarks(p, ci0, jc - cj, zp, ci1 - ci0, 2 * cj, ze - zp, "st"));
    const di = ci1 + 0.004;
    const doorH = isPortrait ? Math.min(0.58, (ze - zp) * 0.78) : 1.12;
    const dw = 0.3 * sx;
    stone.push(worldPolygon(p, "door e", [[di, jc - dw, zp], [di, jc + dw, zp], [di, jc + dw, zp + doorH], [di, jc - dw, zp + doorH]]));
    const doorFrame = faceMatrixE(p, di + 0.002, jc, zp);
    const barY = (f: number) => round3(-doorH * f);
    const dwr = round3(dw);
    const dwh = round3(dw / 2);
    stone.push({
      kind: "path",
      cls: "bars",
      d: `M${-dwr},${barY(0.27)} L${dwr},${barY(0.27)} M${-dwr},${barY(0.55)} L${dwr},${barY(0.55)} M${-dwr},${barY(0.84)} L${dwr},${barY(0.84)} M${-dwh},0 L${-dwh},${round3(-doorH)} M${dwh},0 L${dwh},${round3(-doorH)}`,
      transform: doorFrame,
    });
    stone.push({ kind: "circle", cls: "seal-disc", cx: 0, cy: round3(-doorH * 0.55), r: isPortrait ? round3(0.08 * sx) : 0.1, transform: doorFrame });
    // Cella weathering (and desktop medallion, framed cleanly in the central intercolumniation) paint BEFORE the columns.
    stone.push(...weatheringMarks(p, g.weather, ci1, jc - 0.62 * sx, zp, 0.5 * sx, (ze - zp) * 0.78, rnd));
    let mx = 0;
    let my = 0;
    const medD = isPortrait ? Math.min(0.46, 0.9 * sx) : 0.48;
    if (!isPortrait) {
      // The narrow portico holds only the barred door: the medallion sits mid-way along the south wall of the cella.
      [mx, my] = project(p, (ci0 + ci1) / 2, jc + cj + 0.01, zp + 0.85);
      stone.push(medallionMark(mx, my, medD));
    }
    const colI = ic + 0.96 * si;
    const colR = 0.095 * Math.min(si, sx);
    for (const dj of [-0.88, -0.38, 0.38, 0.88]) stone.push(...cylinder(p, colI, jc + dj * sx, colR, zp, ze, "col", null, "st-t").marks);
    const ei0 = ic - 1.12 * si;
    const ei1 = ic + 1.14 * si;
    const ejRoof = 1.02 * sx;
    const entabH = isPortrait ? 0.18 : 0.26;
    stone.push(...boxMarks(p, ei0, jc - ejRoof, ze, ei1 - ei0, 2 * ejRoof, entabH, "st"));
    const zr = ze + entabH;
    const zRidge = zr + (isPortrait ? 0.34 : 0.7);
    stone.push(worldPolygon(p, "st-t e", [[ei0, jc - ejRoof, zr], [ei1, jc - ejRoof, zr], [ei1, jc, zRidge], [ei0, jc, zRidge]]));
    stone.push(worldPolygon(p, "st-s e", [[ei0, jc + ejRoof, zr], [ei1, jc + ejRoof, zr], [ei1, jc, zRidge], [ei0, jc, zRidge]]));
    stone.push(worldPolygon(p, "st-e e", [[ei1, jc - ejRoof, zr], [ei1, jc + ejRoof, zr], [ei1, jc, zRidge]]));
    // gavel carved flat into the tympanum: a relief outline, nothing lodged, no crack
    if (!isPortrait) {
      const carve = { tx: -0.02, ty: -0.24, deg: -24, k: 0.9 };
      stone.push({
        kind: "path",
        cls: "relief",
        d: transformedRoundRect(-0.05, -0.02, 0.42, 0.05, 0.02, carve) + transformedRoundRect(-0.19, -0.1, 0.14, 0.21, 0.02, carve),
        transform: faceMatrixE(p, ei1 + 0.005, jc, zr),
      });
    } else {
      // Portrait steep overhead view puts the cella behind the roof; mount the medallion cleanly on the front frieze/pediment.
      [mx, my] = project(p, ei1 + 0.01, jc, ze + entabH * 0.55);
      stone.push(medallionMark(mx, my, medD));
    }
    medal = { x: round1(mx), y: round1(my), r: round1((medD * S) / 2) };
    H = zRidge;
    pts = boxPoints(p, ic - ei, jc - ej, baseZ, 2 * ei, 2 * ej, zp - baseZ).concat(boxPoints(p, ei0, jc - ejRoof, zp, ei1 - ei0, 2 * ejRoof, zRidge - zp));
    ground.push(shadowMark(p, foot, zp), shadowMark(p, [ei0, ei1, jc - ejRoof, jc + ejRoof], zRidge * 0.85));
  }
  const contact = [
    isPortrait
      ? portraitContactShadowMark(p, foot, baseZ, 0.055)
      : contactShadowMark(p, foot, baseZ, 0.065),
  ];
  const gLayout = graveGroundMarksLayout(g, siteP.name);
  if (gLayout.bronze) {
    const b = gLayout.bronze;
    const bz = baseZ + 0.004;
    ground.push(worldPolygon(p, "bronze e", [[b.i0, b.j0, bz], [b.i1, b.j0, bz], [b.i1, b.j1, bz], [b.i0, b.j1, bz]]));
  }
  const shiftedPlinth = dx === 0 && dy === 0 ? plinth : plinth.map((m) => shiftMark(m, dx, dy));
  const shiftedStone = dx === 0 && dy === 0 ? stone : stone.map((m) => shiftMark(m, dx, dy));
  const shiftedContact = dx === 0 && dy === 0 ? contact : contact.map((m) => shiftMark(m, dx, dy));
  const shiftedGround = [...padMarks, ...(dx === 0 && dy === 0 ? ground : ground.map((m) => shiftMark(m, dx, dy)))];
  const shiftedPts = dx === 0 && dy === 0 ? pts : pts.map((pt) => shiftPt(pt, dx, dy));
  const [tx, ty] = shiftPt(project(p, ic, jc, H), dx, dy);
  return {
    plinth: shiftedPlinth,
    stone: shiftedStone,
    contact: shiftedContact,
    body: [...shiftedPlinth, ...shiftedStone],
    lean: null,
    ground: shiftedGround,
    pts: shiftedPts,
    topZ: H,
    medal: { x: round1(medal.x + dx), y: round1(medal.y + dy), r: medal.r },
    top: [round1(tx), round1(ty)],
    faceW: 1.28,
    faceH: 1.18,
  };
}

/** Hit area of a grave: hull of its extents and its (inset) lot. Unrounded. */
export function graveHitHull(p: PlotProjection, geo: PlotGraveGeometry, cell: PlotCell): PlotPoint[] {
  const cellPts = boxPoints(p, cell.i0 + 0.04, cell.j0 + 0.04, 0, cell.i1 - cell.i0 - 0.08, cell.j1 - cell.j0 - 0.08, 0.01);
  return hull(geo.pts.concat(cellPts));
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
  const marks: SceneMark[] = [
    contactShadowMark(p, [i - 0.022, i + 0.022, j - 0.022, j + 0.022], 0, 0.025),
    ...boxMarks(p, i - 0.022, j - 0.022, 0, 0.044, 0.044, 0.66, { t: "lamp-post", e: "lamp-post", s: "lamp-post" }, ""),
  ];
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
function lampPoolMark(p: PlotProjection, i: number, j: number): PlotMark {
  const [x, y] = project(p, i, j, 0);
  return { kind: "ellipse", cls: "pool", cx: round1(x), cy: round1(y), rx: round1(S * 1.7), ry: round1(S * 0.85) };
}

/** Gate on the south curb at the avenue: two capped masonry piers spanned by a solid stone lintel. */
export function gateGeometry(p: PlotProjection, i0: number, i1: number, j: number): PlotObjectGeometry {
  const pw = 0.28;
  const pd = 0.3;
  const ph = 0.84;
  const capOver = 0.03;
  const capH = 0.06;
  const lintelZ = ph + capH;
  const lintelH = 0.14;
  const copingH = 0.05;
  const topZ = lintelZ + lintelH + copingH;
  const marks: SceneMark[] = [
    contactShadowMark(p, [i0, i0 + pw, j, j + pd], 0, 0.045),
    contactShadowMark(p, [i1 - pw, i1, j, j + pd], 0, 0.045),
    // West pier, then east pier, then caps, solid lintel and coping in back-to-front paint order.
    ...boxMarks(p, i0, j, 0, pw, pd, ph, "w"),
    ...boxMarks(p, i1 - pw, j, 0, pw, pd, ph, "w"),
    ...boxMarks(p, i0 - capOver, j - capOver, ph, pw + 2 * capOver, pd + 2 * capOver, capH, "w"),
    ...boxMarks(p, i1 - pw - capOver, j - capOver, ph, pw + 2 * capOver, pd + 2 * capOver, capH, "w"),
    ...boxMarks(p, i0, j + 0.03, lintelZ, i1 - i0, pd - 0.06, lintelH, "w"),
    ...boxMarks(p, i0 - capOver, j, lintelZ + lintelH, i1 - i0 + 2 * capOver, pd, copingH, "w"),
  ];
  return {
    marks,
    pts: [
      project(p, i0 - capOver, j, 0),
      project(p, i1 + capOver, j + pd, 0),
      project(p, i0 - capOver, j, topZ),
      project(p, i1 + capOver, j + pd, topZ),
    ],
  };
}

/** Signpost post height (world units). */
export const PLOT_POST_HEIGHT = 0.95;

/** Signpost post (the plate is an HTML overlay hung from its top). */
export function postGeometry(p: PlotProjection, i: number, j: number): PlotObjectGeometry {
  return {
    marks: [
      contactShadowMark(p, [i - 0.03, i + 0.03, j - 0.03, j + 0.03], 0, 0.025),
      ...boxMarks(p, i - 0.03, j - 0.03, 0, 0.06, 0.06, PLOT_POST_HEIGHT, { t: "post", e: "post", s: "post" }, ""),
    ],
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
    if (key === "lighthouse") {
      return {
        key,
        kind: "lighthouse",
        geometry: lighthouseGeometry(p, map.lighthouse.i, map.lighthouse.j, { apothem: map.lighthouse.apothem, rockZ0: map.lighthouse.rockZ0 }),
      };
    }
    throw new Error(`plotDrawnObjects: unknown draw key ${key}`);
  });
}

export interface PlotPerimeterWall {
  kind: "wall" | "curb";
  key: string;
  layer: "back" | "front";
  cell: PlotCell;
  height: number;
}

export interface PlotPerimeterRail {
  kind: "rail";
  key: string;
  layer: "front";
  alongI: boolean;
  start: number;
  end: number;
  fixed: number;
  /** Skip the final post when this run terminates on a shared corner post drawn by a meeting rail. */
  skipEndPost?: boolean;
  cell: PlotCell;
}

export type PlotPerimeterSegment = PlotPerimeterWall | PlotPerimeterRail;

/**
 * Single authority for the desktop plan's perimeter runs (north/west walls, south/east curbs and railings), split
 * around the gate and the NE lighthouse headland. Consumed by both {@link desktopSiteMarks} and the capacity linter.
 */
export function desktopPerimeterSegments(map: DesktopPlotMap): PlotPerimeterSegment[] {
  const { iA, iB, jN } = map.frame;
  const { iWest: W, iAvenue, iEast: I, jSouth: J } = map.site;
  const rim = iB - I;
  const lhI0 = map.lighthouse.i - map.lighthouse.apothem;
  const lhJ1 = map.lighthouse.j + map.lighthouse.apothem;
  const northWallEnd = Math.min(iB, lhI0);
  const eastCurbStart = Math.max(jN, lhJ1);
  const cornerI = I + 0.15;
  const cornerJ = J + 0.15;
  const eastRailStart = eastCurbStart + 0.05;
  const segments: PlotPerimeterSegment[] = [
    { kind: "wall", key: "wall:north", layer: "back", cell: { i0: iA, i1: northWallEnd, j0: jN, j1: 0 }, height: 0.5 },
    // West wall runs cleanly to the SW corner and abuts the west gate pier (no protruding SW curb stub).
    { kind: "wall", key: "wall:west", layer: "back", cell: { i0: iA, i1: W, j0: 0, j1: J + rim }, height: 0.5 },
    { kind: "curb", key: "curb:south", layer: "front", cell: { i0: iAvenue, i1: iB, j0: J, j1: J + rim }, height: 0.2 },
  ];
  if (eastCurbStart < J) {
    segments.push({ kind: "curb", key: "curb:east", layer: "front", cell: { i0: I, i1: iB, j0: eastCurbStart, j1: J }, height: 0.2 });
  }
  const railHalf = 0.01;
  segments.push({
    kind: "rail",
    key: "rail:south",
    layer: "front",
    alongI: true,
    start: iAvenue,
    end: cornerI,
    fixed: cornerJ,
    cell: { i0: iAvenue, i1: cornerI, j0: cornerJ - railHalf, j1: cornerJ + railHalf },
  });
  if (eastRailStart < cornerJ) {
    segments.push({
      kind: "rail",
      key: "rail:east",
      layer: "front",
      alongI: false,
      start: eastRailStart,
      end: cornerJ,
      fixed: cornerI,
      skipEndPost: true,
      cell: { i0: cornerI - railHalf, i1: cornerI + railHalf, j0: eastRailStart, j1: cornerJ },
    });
  }
  return segments;
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
  const rim = iB - I;
  const lhI0 = map.lighthouse.i - map.lighthouse.apothem;
  const lhI1 = map.lighthouse.i + map.lighthouse.apothem;
  const lhJ1 = Math.max(jN, map.lighthouse.j + map.lighthouse.apothem);
  const perimeter = desktopPerimeterSegments(map);

  const seaEast = Math.max(iB + 6, lhI1 + 6);
  const back: PlotMark[] = [
    worldPolygon(p, "sea far", [[iA - 6, jN - 2.6, -0.32], [seaEast, jN - 2.6, -0.32], [seaEast, jN - 1.5, -0.32], [iA - 6, jN - 1.5, -0.32]]),
    worldPolygon(p, "sea", [[iA - 6, jN - 1.5, -0.32], [seaEast, jN - 1.5, -0.32], [seaEast, jN, -0.32], [iA - 6, jN, -0.32]]),
  ];
  let swell = "";
  const swellEast = Math.max(iB + 1.5, lhI1 + 1.5);
  for (let q = 0; q < 3; q++) {
    const j = jN - 0.35 - q * 0.42;
    const a = P(iA + 1.2 + (q % 3) * 2.3, j, -0.32);
    const b = P(swellEast, j, -0.32);
    swell += `M${round1(a[0])},${round1(a[1])}L${round1(b[0])},${round1(b[1])}`;
  }
  back.push(
    { kind: "path", cls: "swell", d: swell, transform: null },
    worldPolygon(p, "earth-e e", [[iB, lhJ1, 0], [iB, jB, 0], [iB, jB, -slab], [iB, lhJ1, -slab]]),
    worldPolygon(p, "earth-s e", [[iA, jB, 0], [iB, jB, 0], [iB, jB, -slab], [iA, jB, -slab]]),
    { kind: "path", cls: "strata", d: [-0.24, -0.5, -0.7].map((z) => formatPath([P(iA, jB, z), P(iB, jB, z), P(iB, lhJ1, z)])).join(""), transform: null },
  );
  for (const seg of perimeter) {
    if (seg.layer === "back") {
      back.push(...boxMarks(p, seg.cell.i0, seg.cell.j0, 0, seg.cell.i1 - seg.cell.i0, seg.cell.j1 - seg.cell.j0, seg.height, "w"));
    }
  }

  const northToSouth = [...map.lanes].reverse();
  const ground: PlotMark[] = [
    flat(p, "lawn", W, I, 0, J, 0.001),
    // Corner apron tucked between the east lawn edge, the headland rock's SW bevel and the north end of the east curb.
    worldPolygon(p, "lawn", [[I, Math.max(0, lhJ1 - rim), 0.001], [iB, lhJ1, 0.001], [I, lhJ1, 0.001]]),
    flat(p, "gravel strip", iA, iB, J + 0.3, jB, 0.001),
  ];
  ground.push(flat(p, "gravel", W + 0.18, iAvenue - 0.18, 0.18, J - 0.12, 0.003)); // gate avenue
  const walkEast = Math.min(I - 0.1, lhI0 - 0.04);
  if (walkEast > iAvenue - 0.18) ground.push(flat(p, "gravel", iAvenue - 0.18, walkEast, 0.14, NT - 0.12, 0.003)); // sea-wall walk
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
    marks: L.cells.flatMap((c) => boxMarks(p, c.i0 - 0.05, c.j0 - 0.05, 0, c.i1 - c.i0 + 0.1, c.j1 - c.j0 + 0.1, PLOT_BED_HEIGHT.dimetric, { t: "bed", e: "curb", s: "curb" }, " e")),
  }));
  const pools = map.lamps.map((l) => lampPoolMark(p, l.i, l.j));

  const front: PlotMark[] = [];
  const southCurb = perimeter.find((seg): seg is PlotPerimeterWall => seg.key === "curb:south");
  const eastCurb = perimeter.find((seg): seg is PlotPerimeterWall => seg.key === "curb:east");
  const joinedSeCurb = Boolean(
    southCurb && eastCurb && Math.abs(southCurb.cell.i1 - eastCurb.cell.i1) < 1e-6 && Math.abs(southCurb.cell.j0 - eastCurb.cell.j1) < 1e-6,
  );
  if (joinedSeCurb && southCurb && eastCurb) {
    const ch = southCurb.height;
    const sc = southCurb.cell;
    const ec = eastCurb.cell;
    // One continuous L-shaped curb around the SE corner so no vertical or top seam cuts across (I..iB, J).
    front.push(
      worldPolygon(p, "w-s e", [[sc.i0, sc.j1, 0], [sc.i1, sc.j1, 0], [sc.i1, sc.j1, ch], [sc.i0, sc.j1, ch]]),
      worldPolygon(p, "w-e e", [[ec.i1, ec.j0, 0], [ec.i1, sc.j1, 0], [ec.i1, sc.j1, ch], [ec.i1, ec.j0, ch]]),
      worldPolygon(p, "w-t e", [[sc.i0, sc.j0, ch], [ec.i0, sc.j0, ch], [ec.i0, ec.j0, ch], [ec.i1, ec.j0, ch], [sc.i1, sc.j1, ch], [sc.i0, sc.j1, ch]]),
    );
  }
  for (const seg of perimeter) {
    if (seg.layer !== "front" || seg.kind === "rail") continue;
    if (joinedSeCurb && (seg.key === "curb:south" || seg.key === "curb:east")) continue;
    front.push(...boxMarks(p, seg.cell.i0, seg.cell.j0, 0, seg.cell.i1 - seg.cell.i0, seg.cell.j1 - seg.cell.j0, seg.height, "w"));
  }
  let rail = "";
  const railRun = (a: number, b: number, fixed: number, alongI: boolean, skipEndPost = false) => {
    const at = (u: number, z: number) => (alongI ? P(u, fixed, z) : P(fixed, u, z));
    const len = b - a;
    const nPosts = Math.max(1, Math.round(len / 1.1));
    const lastPost = skipEndPost ? nPosts - 1 : nPosts;
    for (let q = 0; q <= lastPost; q++) {
      const u = a + (len * q) / nPosts;
      rail += formatPath([at(u, 0.2), at(u, 0.56)]);
    }
    rail += formatPath([at(a, 0.52), at(b, 0.52)]);
  };
  for (const seg of perimeter) {
    if (seg.kind === "rail") railRun(seg.start, seg.end, seg.fixed, seg.alongI, seg.skipEndPost);
  }
  front.push({ kind: "path", cls: "rail", d: rail, transform: null });

  const trees = [...map.cypress]
    .sort((a, b) => b.i - a.i)
    .map((c) => ({ year: c.year, marks: cypressGeometry(p, c.i, c.j, c.height).marks }));
  return { back, ground, beds, pools, front, trees };
}

/** Slender Italian cypress for the portrait walk's open lawn bays (seated softly on grass, never in a mid-path square pit). */
function portraitCypressMarks(p: PlotProjection, i: number, j: number, h: number): PlotMark[] {
  if (!h) return [];
  const rw = 0.15 + 0.045 * h;
  const [bx, by] = project(p, i, j, 0.1);
  const [, ty] = project(p, i, j, h);
  const W = rw * roundHalfWidth(p);
  const hh = by - ty;
  const marks: PlotMark[] = [
    { kind: "ellipse", cls: "shadow", cx: round1(bx - 1.1), cy: round1(by + 1.1), rx: round1(W * 0.92), ry: round1(W * 0.36) },
  ];
  marks.push(...boxMarks(p, i - 0.03, j - 0.03, 0.01, 0.06, 0.06, 0.13, { t: "trunk", e: "trunk", s: "trunk" }, ""));
  const outline = `M${round1(bx)},${round1(ty)} C${round1(bx + W * 0.62)},${round1(ty + hh * 0.22)} ${round1(bx + W * 1.02)},${round1(ty + hh * 0.68)} ${round1(bx + W * 0.5)},${round1(by)} L${round1(bx - W * 0.5)},${round1(by)} C${round1(bx - W * 1.02)},${round1(ty + hh * 0.68)} ${round1(bx - W * 0.62)},${round1(ty + hh * 0.22)} ${round1(bx)},${round1(ty)} Z`;
  const lit = `M${round1(bx)},${round1(ty)} C${round1(bx + W * 0.62)},${round1(ty + hh * 0.22)} ${round1(bx + W * 1.02)},${round1(ty + hh * 0.68)} ${round1(bx + W * 0.5)},${round1(by)} L${round1(bx + W * 0.06)},${round1(by)} C${round1(bx + W * 0.2)},${round1(ty + hh * 0.6)} ${round1(bx + W * 0.1)},${round1(ty + hh * 0.3)} ${round1(bx)},${round1(ty)} Z`;
  let hatch = "";
  for (let q = 1; q < 5; q++) {
    const y = ty + (hh * q) / 5;
    const half = W * (0.35 + 0.42 * Math.sin((q / 5) * Math.PI));
    hatch += `M${round1(bx - half * 0.88)},${round1(y)}L${round1(bx - half * 0.2)},${round1(y + 0.7)}`;
  }
  marks.push(
    { kind: "path", cls: "tree-d e", d: outline, transform: null },
    { kind: "path", cls: "tree-l", d: lit, transform: null },
    { kind: "path", cls: "tree-h", d: hatch, transform: null },
  );
  return marks;
}

/** Options for `portraitSiteMarks`: the SSR skeleton omits contact/cypress detail to stay well inside the HTML size budget (0 CLS). */
export interface PortraitSiteMarkOptions {
  /** Emit cypresses and bed contact shadows (default `true`; `false` for the lightweight SSR skeleton). */
  detail?: boolean;
}

/** Structure of the portrait walk: coastal sea strip + low stone sea wall, lawn, lane & year gravel paths, raised curbed beds, cypresses, headland strata. */
export function portraitSiteMarks(
  map: PortraitPlotMap,
  options: PortraitSiteMarkOptions = {},
): Pick<PlotSiteMarks, "ground" | "beds" | "trees"> {
  const detail = options.detail ?? true;
  const p = PLOT_PROJECTIONS[map.projection];
  const P = (i: number, j: number, z = 0) => project(p, i, j, z);
  const top = map.site.iAvenue - PORTRAIT_TOP_MARGIN;
  const I = map.site.iOldest;
  const J = map.site.jSouth;
  const side = 0.32;
  const slab = 0.62;
  // Sea strip starts under the top `2026` sticky band and opens onto a low coastal stone sea wall clear of top-row stones.
  const wallI0 = map.site.iAvenue - 1.15;
  const wallI1 = map.site.iAvenue - 0.99;
  const ground: PlotMark[] = [
    worldPolygon(p, "sea", [[top, -side, 0], [top, J + side, 0], [wallI0, J + side, 0], [wallI0, -side, 0]]),
    {
      kind: "path",
      cls: "swell",
      d: formatPath([P(wallI0 - 0.24, J - 0.8, 0), P(wallI0 - 0.24, 0.8, 0)]),
      transform: null,
    },
    flat(p, "lawn", wallI1, I + 0.42, -side, J + side, 0.001),
    // Low stone sea wall crowning the north edge of the cemetery grounds.
    ...portraitCurbedBoxMarks(p, wallI0, wallI1, -side, J + side, 0.16, { t: "w-t", curb: "w-s" }, " e", 0.035, detail ? 0.055 : 0),
    // Subtle stone perimeter edge curbs framing the left and right lawn verges.
    ...portraitCurbedBoxMarks(p, wallI1, I + 0.42, J + side - 0.08, J + side, 0.09, { t: "w-t", curb: "w-s" }, " es", 0.02, 0),
    ...portraitCurbedBoxMarks(p, wallI1, I + 0.42, -side, -side + 0.08, 0.09, { t: "w-t", curb: "w-s" }, " es", 0.02, 0),
    // Headland cut face + geological strata lines at the oldest end of the walk.
    worldPolygon(p, "earth-e e", [[I + 0.42, -side, 0], [I + 0.42, J + side, 0], [I + 0.42, J + side, -slab], [I + 0.42, -side, -slab]]),
    {
      kind: "path",
      cls: "strata",
      d: [-0.18, -0.36, -0.52].map((z) => formatPath([P(I + 0.42, J + side, z), P(I + 0.42, -side, z)])).join(""),
      transform: null,
    },
  ];
  // Vertical gravel lane paths running cleanly between the 5 cause columns through the entire walk.
  const northToSouth = [...map.lanes].reverse();
  for (let q = 0; q + 1 < northToSouth.length; q++) {
    const pj0 = northToSouth[q].j1 + 0.05;
    const pj1 = northToSouth[q + 1].j0 - 0.05;
    if (pj1 > pj0 + 0.02) {
      ground.push(flat(p, "gravel", wallI1 + 0.06, I + 0.24, pj0, pj1, 0.003));
    }
  }
  // Refined horizontal gravel cross-paths seated under each inter-year threshold (leaving green lawn above the next block's stone tops).
  for (let q = 0; q + 1 < map.blocks.length; q++) {
    const gap0 = map.blocks[q].i1;
    const gap1 = map.blocks[q + 1].i0;
    const pathI0 = gap0 + 0.26;
    const pathI1 = Math.min(gap1 - 0.26, pathI0 + 0.68);
    if (pathI1 > pathI0 + 0.05) {
      ground.push(flat(p, "gravel", pathI0, pathI1, -side + 0.1, J + side - 0.1, 0.003));
    }
  }
  for (const b of map.blocks) if (b.empty) ground.push(flat(p, "gravel strip", b.i0, b.i1, -side + 0.1, J + side - 0.1, 0.003));

  const beds = northToSouth.map((L) => ({
    cause: L.cause,
    marks: L.cells.flatMap((c) => {
      const inCell = map.graves.filter(
        (g) => g.cause === L.cause && g.cell.i0 >= c.i0 - 1e-6 && g.cell.i1 <= c.i1 + 1e-6,
      );
      let fitI1 = c.i1;
      if (inCell.length > 0) {
        let maxBottom = -Infinity;
        for (const g of inCell) {
          const plinth = gravePlinthFootprint(g, map.projection);
          const gm = graveGroundMarksLayout(g, map.projection);
          const markBot = Math.max(
            plinth.i1 + 0.18,
            gm.mound ? gm.mound.i1 + 0.06 : -Infinity,
            gm.bronze ? gm.bronze.i1 + 0.08 : -Infinity,
            gm.footstone ? gm.footstone.i1 + 0.08 : -Infinity,
          );
          if (markBot > maxBottom) maxBottom = markBot;
        }
        if (Number.isFinite(maxBottom)) fitI1 = Math.min(c.i1, maxBottom + 0.08);
      }
      const ci0 = c.i0 - 0.04;
      const ci1 = fitI1 + 0.04;
      const cj0 = c.j0 - 0.04;
      const cj1 = c.j1 + 0.07;
      return portraitCurbedBoxMarks(p, ci0, ci1, cj0, cj1, PLOT_BED_HEIGHT.portrait, { t: "bed", curb: "curb" }, " e", 0.055, detail ? 0.055 : 0);
    }),
  }));

  const trees = detail
    ? map.cypress.map((c) => ({
        year: c.year,
        marks: portraitCypressMarks(p, c.i, c.j, c.height),
      }))
    : [];
  return { ground, beds, trees };
}
