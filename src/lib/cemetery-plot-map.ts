/**
 * Stablecoin Cemetery plot map: pure, deterministic, serialisable view model (hero "Isometric Plot Map").
 *
 * Port of the approved prototype v2 (`agents/2026-09-30-cemetery-redesign/concepts/c-isometric-v2/src/`
 * `plot-map-model.js` plus the layout half of `plot-map-render.js`, `plot-map-portrait.js` and `main.js`).
 * Rules:
 * - no DOM, `window`, `Date.now()`, `Math.random()` or theme reads; every seed is FNV-1a(id);
 * - `asOf` is the latest recorded `deathDate` (same rule as `buildCemeteryStats(…).asOf.date`), never the clock;
 * - output is plain data (no functions) and identical for identical input in any order;
 * - world units are rounded to 0.01 (the slot pitch is 0.92), screen/SVG units to 0.1.
 *
 * World axes: `i` east (gate → lighthouse), `j` south (sea wall → front lane), `z` up. Time runs newest at the
 * gate: the newest year block is the west-most, the oldest ground lies under the lighthouse. World `i` is
 * anchored at the OLDEST end: `i = 0` is the east edge of the oldest year block, newer blocks sit at negative `i`.
 * Appending a newer death therefore moves no existing grave; the platform grows toward the gate. (The prototype
 * anchored `i = 0` at the gate, so every append shifted the whole plan.)
 */
import { CAUSE_HEX, CAUSE_HEX_DARK, CAUSE_META, CAUSE_ORDER, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { parseCemeteryDeathDate, sortCemeteryCoins } from "@shared/lib/cemetery";
import { formatDeathDate, formatUtcDayLabel } from "@shared/lib/format";
import { fnv1a32 } from "@shared/lib/fnv1a";
import { faceFloorPx, footprintOverlaps, type CapacityIssue, type CapacityReport } from "@shared/lib/scene/capacity";
import { boxToFrameRect, placeInspectorCard as placeSceneInspectorCard, placeTag, type SceneRect } from "@shared/lib/scene/placement";
import {
  PLOT_ARCHETYPE_BY_CAUSE,
  PLOT_POST_HEIGHT,
  PLOT_PROJECTIONS,
  PLOT_UNIT,
  PORTRAIT_TOP_MARGIN,
  bbox,
  cypressGeometry,
  desktopPerimeterSegments,
  gateGeometry,
  graveAnchorOffsetI,
  graveGeometry,
  graveGroundMarksLayout,
  graveHitHull,
  gravePlinthFootprint,
  lampGeometry,
  lighthouseGeometry,
  lotPadCell,
  plotShapeOf,
  postGeometry,
  project,
  round1,
  roundBox,
  roundPoint,
  seededStream,
  type PlotArchetype,
  type PlotBox,
  type PlotCell,
  type PlotGraveGeometry,
  type PlotGraveShapeInput,
  type PlotLot,
  type PlotPeakClass,
  type PlotPoint,
  type PlotProjection,
  type PlotProjectionName,
  type PlotWeather,
} from "@/lib/cemetery-plot-geometry";
import { formatCemeteryPeak } from "@/lib/cemetery-stats";
import { formatCemeteryPlaque } from "@/lib/cemetery-presentation";

/** Structural input: satisfied by `CemeteryEntry`. */
export interface CemeteryPlotMapInput {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  readonly causeOfDeath: CauseOfDeath;
  /** `YYYY-MM` or `YYYY-MM-DD`. */
  readonly deathDate: string;
  /** Peak market cap in USD; missing, non-finite or ≤ 0 = not recorded. */
  readonly peakMcap?: number;
  readonly pegCurrency: string;
  /** `true` for tracked-archive (frozen) rows: Pharos holds a frozen data page (bronze plaque). */
  readonly archivedDataAvailable?: boolean;
}

export type PlotMapPresetName = "desktop" | "portrait";

export interface PlotMapPreset {
  name: PlotMapPresetName;
  projection: PlotProjectionName;
  /** Lane depth in slots (plan constants, see {@link validatePlotMapCapacity}). */
  depth: Readonly<Record<CauseOfDeath, number>>;
  /** World units per slot along j. */
  slotPitch: number;
  /** World units per row along i. */
  rowPitch: number;
  /** Gravel path between lanes (j). */
  lanePath: number;
  /** Shared cross-path between year blocks (i). */
  yearPath: number;
  /** Strip standing in for a run of years with no recorded death (i). */
  emptyYears: number;
  /** Gate avenue west of the newest block (i). */
  avenue: number;
  /** Cypress walk between the sea wall and the back lane (j); ≥ 0.9 slot lets colossi step onto it. */
  northTerrace: number;
  /** Lawn between the front lane and the south curb (j). */
  southMargin: number;
  /** Lawn between the oldest block and the east curb (i). */
  eastTerrace: number;
  /** Calendar years strictly before this cut-off share one oldest block; null = one block per calendar year. */
  mergeBefore: number | null;
  /** R11 budget: longest empty run of rows inside a bed; null = not budgeted (the portrait plan makes no R11 claim). */
  maxEmptyBedRows: number | null;
}

/**
 * Lane depths and early-year merging keep the desktop plain-stone face above the 15 px floor with headroom for
 * future calendar years, and hold in-bed empty runs ≤ 3 rows (see {@link validatePlotMapCapacity}).
 */
const PLOT_MAP_PRESETS: Readonly<Record<PlotMapPresetName, PlotMapPreset>> = {
  desktop: {
    name: "desktop",
    projection: "dimetric",
    depth: { abandoned: 8, "counterparty-failure": 4, "liquidity-drain": 3, "algorithmic-failure": 4, regulatory: 1 },
    slotPitch: 0.92,
    rowPitch: 1.1,
    lanePath: 0.56,
    yearPath: 0.46,
    emptyYears: 0.72,
    avenue: 1.5,
    northTerrace: 0.95,
    southMargin: 0.5,
    eastTerrace: 0.55,
    mergeBefore: 2022,
    maxEmptyBedRows: 3,
  },
  portrait: {
    name: "portrait",
    projection: "portrait",
    depth: { abandoned: 4, "counterparty-failure": 3, "liquidity-drain": 2, "algorithmic-failure": 2, regulatory: 2 },
    slotPitch: 0.92,
    rowPitch: 1.9,
    lanePath: 0.34,
    yearPath: 2.55,
    emptyYears: 1.3,
    avenue: 0,
    northTerrace: 0,
    southMargin: 0,
    eastTerrace: 0,
    mergeBefore: null,
    maxEmptyBedRows: null,
  },
};

/** Fresh soil: died within 90 days of the latest recorded death (stated verbatim in the legend). */
export const PLOT_FRESH_DAYS = 90;
/** Weathering classes: upper bounds in years for w0…w3; w4 is everything older. */
const PLOT_WEATHER_BOUNDS_YEARS: readonly number[] = [0.5, 1.5, 3, 5];
/** Plinth steps = clamp(floor(log10(peak)) − 6, 0, 4): one step at each of these peaks. */
export const PLOT_STEP_THRESHOLDS_USD: readonly number[] = [1e7, 1e8, 1e9, 1e10];
/** Stone height factor: clamped log scale (floor reached at $10^6.5, ceiling at ≈ $15B). */
export const PLOT_HEIGHT = { floor: 0.64, ceiling: 1.34, atLog10: 6.5, perDecade: 0.19 } as const;
/** Footstone glyphs for non-USD pegs (set in mono); any other non-USD peg gets ◇. */
export const PLOT_PEG_GLYPHS: Readonly<Record<string, string>> = { EUR: "€", JPY: "¥", CNH: "¥", VAR: "∿", OTHER: "◇" };

/** Desktop scene frame around the plan (world units). */
const PLOT_SCENE = {
  /** Rim of the site wall outside the lawn. */
  rim: 0.3,
  /** Verge outside the front railing that carries the per-year cypress band. */
  verge: 1.2,
  /** Depth of the headland slab under the lawn. */
  slab: 0.9,
  /** NE headland rock apothem and j centre; i is derived from the slab east edge so the rock seats flush as a prow. */
  lighthouseApothem: 1.1,
  lighthouseJ: 0.15,
  /** Signpost posts stand at this fraction of the avenue width. */
  postAt: 0.52,
} as const;

/** Viewport-level layout constants the hero, zoom and placement helpers share (CSS px unless stated). */
export const PLOT_LAYOUT = {
  /**
   * R1 reference: 1440×800 has a 1368 px content column; height-fit clamps the live desktop frame to
   * `min(1368, max(floorWidth, heightFit))` (floor-clamped at 15.0 px when `floorWidth <= 1368`, leaving
   * `1368 − floorWidth` px of column headroom before the gate fails).
   */
  reference: { viewportWidth: 1440, viewportHeight: 800, frameWidth: 1368 },
  /** Portrait reference: full-bleed 390 px phone viewport. */
  portraitReference: { viewportWidth: 390, frameWidth: 390 },
  /** Sticky chrome (3 px status strip + 56 px nav) + 8 px: the top of the visible band. */
  chromeTop: 67,
  /**
   * Vertical chrome (top nav + event rail + route head minus sky overlap) subtracted by desktop height-fit sizing
   * (`width: min(100%, max(var(--floor-w), calc((100dvh - var(--fit-chrome)) * var(--plot-ar))))`). Shared by CSS,
   * capacity checks and tests so the continuous rule never has a height cliff or undercuts the 15 px face floor.
   */
  fitChromePx: 205,
  /** Zoom toolbar row ("← Whole cemetery" + section chip). */
  zoomBar: 52,
  zoomSideInset: 24,
  zoomBottomGap: 16,
  zoomCentreOffset: 8,
  zoomMaxScale: 4.5,
  /** Zoom aims for a 30 px plain face (floor 28 px + 2 px margin). */
  zoomTargetFacePx: 30,
  zoomFloorFacePx: 28,
  /** Plain-stone face width (world units): the column / urn pedestal, the narrowest 1×1 face. */
  plainFace: 0.58,
  /** R1 floor: plain stone ≥ 15 px at the desktop reference viewport. */
  faceFloorPx: 15,
  /** Portrait floor: plain stone ≥ 15 px at the full-bleed 390 px phone reference (matches desktop floor; never undercut). */
  portraitFaceFloorPx: 15,
  /** Large lots may start in rows 0…3 of their block. */
  maxLotRow: 3,
  /** Large-lot position combinations searched exhaustively per block (2022's three lots: 20 × 16 × 28 = 8,960). */
  lotSearchBudget: 50_000,
  /**
   * Maximum share of any grave's medallion disc allowed under later-drawn solid faces at rest (desktop and portrait).
   * At 0.40, every grave retains ≥ 60 % unobstructed medallion area before hover spotlighting.
   */
  maxMedallionOcclusion: 0.4,
  /** Desktop viewports audited by `zoom-drops-colossus` so section zoom keeps every colossus and ≥ 28 px faces. */
  zoomCheckViewports: [
    [1024, 768],
    [1280, 720],
    [1366, 650],
    [1440, 800],
    [1440, 900],
  ] as readonly (readonly [number, number])[],
} as const;

/** Minimum desktop frame width (CSS px) at which a plain 1×1 stone stays at or above `PLOT_LAYOUT.faceFloorPx` (15 px). */
function desktopFloorFrameWidth(viewBoxWidth: number): number {
  return Math.ceil((PLOT_LAYOUT.faceFloorPx * viewBoxWidth) / (PLOT_LAYOUT.plainFace * PLOT_UNIT));
}

/**
 * Rendered desktop frame width (CSS px) under the continuous floor-clamped height-fit rule
 * `min(columnWidth, max(floorWidth, (viewportHeight - fitChromePx) * (vbW / vbH)))`.
 */
function desktopFittedFrameWidth(
  map: Pick<DesktopPlotMap, "viewBox" | "floorWidth">,
  viewportWidth: number,
  viewportHeight: number,
): number {
  const pagePad = viewportWidth >= 1280 ? 36 : viewportWidth >= 1024 ? 20 : 16;
  const columnWidth = Math.min(viewportWidth, 1920) - 2 * pagePad;
  const aspect = map.viewBox[2] / map.viewBox[3];
  const heightFit = Math.max(0, viewportHeight - PLOT_LAYOUT.fitChromePx) * aspect;
  return Math.min(columnWidth, Math.max(map.floorWidth, heightFit));
}

const YEAR_MS = 365.25 * 864e5;
const DAY_MS = 864e5;

/** Peak class 0–4, or null when the peak is not recorded (never the 0 class). */
export function plotPeakClassOf(peak: number | null | undefined): PlotPeakClass | null {
  if (peak == null || !Number.isFinite(peak) || peak <= 0) return null;
  return Math.max(0, Math.min(4, Math.floor(Math.log10(peak)) - 6)) as PlotPeakClass;
}

/** Stone height factor for a recorded peak (unrounded). */
export function plotHeightFactorOf(peak: number): number {
  const h = PLOT_HEIGHT.floor + PLOT_HEIGHT.perDecade * (Math.log10(peak) - PLOT_HEIGHT.atLog10);
  return Math.max(PLOT_HEIGHT.floor, Math.min(PLOT_HEIGHT.ceiling, h));
}

/** Quantised weathering class for an age in years. */
function plotWeatherOf(years: number): PlotWeather {
  for (let k = 0; k < PLOT_WEATHER_BOUNDS_YEARS.length; k++) if (years < PLOT_WEATHER_BOUNDS_YEARS[k]) return k as PlotWeather;
  return 4;
}

export interface PlotGraveScreen {
  /** Stone centre on the ground. */
  ground: PlotPoint;
  /** Lot centre at z 0.35 (portrait 44×44 hit box centre). */
  centre: PlotPoint;
  medal: { x: number; y: number; r: number };
  top: PlotPoint;
  /** Hit hull (stone extents + inset lot). */
  hit: PlotPoint[];
  box: PlotBox;
  /** Shared hover/pin ground ring for this grave. */
  ring: { cx: number; cy: number; rx: number; ry: number };
}

export interface PlotGrave extends PlotGraveShapeInput {
  id: string;
  name: string;
  symbol: string;
  cause: CauseOfDeath;
  deathDate: string;
  year: number;
  /** Recorded peak market cap; null = not recorded. */
  peak: number | null;
  peakClass: PlotPeakClass | null;
  unrecorded: boolean;
  peg: string;
  archetype: PlotArchetype;
  /** Chronological index inside its section (keyboard ←/→ order). */
  laneIndex: number;
  /** Packing row inside the block (0 = oldest, east edge) and global slot (north → south; −1 = cypress walk). */
  row: number;
  slot: number;
  /** The lot extends outside its own lane (colossi on the cypress walk, lots bridging a lane path). */
  overhang: boolean;
  /** Lot footprint (world units). */
  cell: PlotCell;
  /** Stone centre on the ground: the west third of its lot (world units). */
  anchor: { i: number; j: number };
  screen: PlotGraveScreen;
  /** Index in `drawOrder`. */
  draw: number;
}

export interface PlotLane {
  cause: CauseOfDeath;
  label: string;
  hex: string;
  hexDark: string;
  depth: number;
  /** First global slot (slots count north → south). */
  slot0: number;
  j0: number;
  j1: number;
  count: number;
  /** Occupied extent along i (first → last block holding a grave of this cause); null for an empty lane. */
  bed: { i0: number; i1: number } | null;
  /** Bed cells: one raised turf cell per occupied year block inside the bed (trimmed along i & j on portrait, trimmed along j on sparse desktop blocks). */
  cells: { year: number; i0: number; i1: number; j0: number; j1: number }[];
  /** Grave ids, oldest first. */
  ids: string[];
}

export interface PlotYearBlock {
  /** "2026", or "2018-2021" / "2019-2020" for a multi-year merged or empty block. */
  key: string;
  /** First (earliest) year of the block. */
  year: number;
  years: number[];
  /** Calendar years inside this block with no recorded death (unavailable ≠ zero). */
  emptyYears: number[];
  empty: boolean;
  count: number;
  rows: number;
  i0: number;
  i1: number;
  /** "2026" or "2018–21". */
  label: string;
  /** Desktop stamp: "2026 · 30", "2018–21 · 6"; empty strip: "2019–20". */
  text: string;
  /** Empty-years disclosure: "none recorded" on an empty strip, or "2019–20 none recorded" on a merged block with gaps. */
  sub: string | null;
  /** Stamp anchor (desktop: under the headland's cut face; portrait: left grid edge, block middle). */
  stamp: PlotPoint;
  /** Screen angle (deg, clockwise) of the front edge, so the desktop stamp is set along the slab. */
  stampAngle: number;
  /** Screen y extent along the front edge (portrait margin labels). */
  span: { y0: number; y1: number };
  /** Grave ids in the block, oldest first. */
  ids: string[];
  /** Too many ≥ $1B deaths for the exhaustive lot search: large lots were placed greedily. */
  greedyLots: boolean;
}

export interface PlotSite {
  /** West edge of the lawn (gate side). */
  iWest: number;
  /** East edge of the gate avenue = west edge of the newest block. */
  iAvenue: number;
  /** East edge of the oldest block (0 by construction). */
  iOldest: number;
  /** East edge of the lawn (lighthouse terrace). */
  iEast: number;
  northTerrace: number;
  /** South edge of the front lane. */
  jFront: number;
  /** South curb. */
  jSouth: number;
}

export interface PlotAreaShare {
  cause: CauseOfDeath;
  deathShare: number;
  areaShare: number;
}

export interface PlotEmptyRun {
  cause: CauseOfDeath;
  depth: number;
  maxEmptyRowsInBed: number;
  lawnRowsBeforeBed: number;
}

export interface PlotMapBase {
  preset: PlotMapPresetName;
  projection: PlotProjectionName;
  asOf: string;
  firstYear: number;
  lastYear: number;
  counts: { total: number; recorded: number; archived: number };
  /** Newest grave (first in `sortCemeteryCoins(…, "newest")`): the roving tab stop's first landing. */
  newestId: string;
  /** Height factor of every unrecorded peak: median of the $10M–$100M class. */
  neutralHeight: number;
  slotPitch: number;
  rowPitch: number;
  site: PlotSite;
  /** SVG viewBox [x, y, width, height]. */
  viewBox: [number, number, number, number];
  /** Canonical cause order (front lane first; j decreases along the array). */
  lanes: PlotLane[];
  /** West → east: newest block first. */
  blocks: PlotYearBlock[];
  /** Sorted by id. */
  graves: PlotGrave[];
  /** Paint order of drawn objects: `grave:<id>`, `lamp:<year>`, `gate`, `lighthouse`, `post:<cause>`. */
  drawOrder: string[];
  /** Roving-tabindex order: sections in canonical order, graves oldest first. */
  keyboard: { initialId: string; sections: { cause: CauseOfDeath; ids: string[] }[] };
  /** R11 accounting. */
  areaShare: PlotAreaShare[];
  emptyRuns: PlotEmptyRun[];
  header: {
    /** "113 interred · first recorded death 2018". */
    plaque: string;
    /** At-rest inspector line: "Latest recorded death · {name} · {dateLabel}". */
    rest: { id: string; name: string; deathDate: string; dateLabel: string };
  };
}

export interface PlotSignpost {
  cause: CauseOfDeath;
  label: string;
  count: number;
  /** Post position (world units). */
  i: number;
  j: number;
  foot: PlotPoint;
  /** Plate anchor: the plate hangs left of the post top. */
  top: PlotPoint;
}

export interface PlotCypress {
  year: number;
  /** Null for a year with no recorded death (bare planting bed), never zero. */
  count: number | null;
  i: number;
  j: number;
  /** 0 for a year with no recorded death (bare planting bed). */
  height: number;
  foot: PlotPoint;
  top: PlotPoint;
  /** "2022 · 14 deaths", or "2019 · none recorded". */
  label: string;
}

export interface PlotColossus {
  id: string;
  cause: CauseOfDeath;
  top: PlotPoint;
  name: string;
  peak: string;
  month: string;
  /** "TerraUSD · peak $18.8B · May 2022". */
  text: string;
}

export interface PlotSectionCamera {
  cause: CauseOfDeath;
  /** Framed box (SVG units): the union of the shown graves' hit boxes. */
  box: PlotBox;
  zoom: number;
  /** Plain-stone face at this zoom (px). */
  facePx: number;
  /**
   * World-group offset for `transform="translate(tx ty) scale(zoom)"`, i.e. about the user-space origin (0, 0)
   * (CSS equivalent: `transform-box: view-box; transform-origin: 0 0`). A user point p lands at frame px
   * `(zoom·p + translate − viewBox origin) · frameWidth / viewBox width`; the box centre lands mid-band.
   */
  translate: PlotPoint;
  total: number;
  shown: number;
  /** Years in view; a partial view frames the contiguous run of years with the most graves that reaches the floor. */
  span: [number, number];
  partial: boolean;
  ids: string[];
}

export interface DesktopPlotMap extends PlotMapBase {
  preset: "desktop";
  /** Minimum frame width (CSS px) where a plain 1×1 stone stays ≥ `PLOT_LAYOUT.faceFloorPx` (passed to CSS as `--floor-w`). */
  floorWidth: number;
  frame: { iA: number; iB: number; jN: number; jB: number; jVerge: number; slab: number };
  /** Canonical order (front lane first = left → right on screen). */
  signposts: PlotSignpost[];
  /** Ascending year; drawn east-first (descending i) so western trees overlap. */
  cypress: PlotCypress[];
  lamps: { year: number; i: number; j: number }[];
  gate: { i0: number; i1: number; j: number };
  lighthouse: { i: number; j: number; apothem: number; rockZ0: number; lantern: PlotPoint; top: PlotPoint };
  /** The beam's pivot (the lantern). */
  beamOrigin: PlotPoint;
  colossi: PlotColossus[];
  sectionCameras: PlotSectionCamera[];
  /** Bounding boxes of every drawn volume except lamps: chips, figure and tags keep clear of them. */
  obstacles: (PlotBox & { key: string })[];
  skyline: {
    /** Breakpoints of the running minimum y over x (header keep-out, see {@link skyTopLeftOf}). */
    prefixTop: PlotPoint[];
    /** Drawn points not covered by `obstacles` (wall crest, lamps). */
    edges: PlotPoint[];
  };
}

export interface PortraitPlotCypress {
  year: number;
  /** Null for an empty-year bare planting bed, never zero. */
  count: number | null;
  i: number;
  j: number;
  /** 0 for a bare planting bed on an empty year strip. */
  height: number;
}

export interface PortraitPlotMap extends PlotMapBase {
  preset: "portrait";
  /** Column heads, canonical order left → right; x0/x1 = the column's screen span on the top edge. */
  columns: { cause: CauseOfDeath; label: string; count: number; x0: number; x1: number }[];
  /** Formal cypresses planted along the walk's gravel year paths (height ∝ year deaths; bare beds on empty years). */
  cypress: PortraitPlotCypress[];
}

export type CemeteryPlotMap = DesktopPlotMap | PortraitPlotMap;

export interface BuildCemeteryPlotMapOptions<P extends PlotMapPresetName = PlotMapPresetName> {
  /** Latest recorded `deathDate`; defaults to the latest in `entries` (the `buildCemeteryStats` rule). */
  asOf?: string;
  preset: P;
}

/** Formats an inclusive calendar-year range ("2019", "2019–20", "1999–2000"). */
function formatYearSpan(lo: number, hi: number): string {
  if (lo === hi) return String(lo);
  return Math.floor(lo / 100) === Math.floor(hi / 100) ? `${lo}–${String(hi).slice(2)}` : `${lo}–${hi}`;
}

/** Formats sorted calendar years as comma-separated contiguous ranges ("2015, 2019–20"). */
function formatYearRanges(years: readonly number[]): string {
  if (!years.length) return "";
  const ranges: string[] = [];
  let lo = years[0];
  let hi = years[0];
  for (let k = 1; k < years.length; k++) {
    if (years[k] === hi + 1) hi = years[k];
    else {
      ranges.push(formatYearSpan(lo, hi));
      lo = hi = years[k];
    }
  }
  ranges.push(formatYearSpan(lo, hi));
  return ranges.join(", ");
}

/** Integer hundredths of a world unit (`+ 0` folds −0 into 0 so the model survives a JSON round trip exactly). */
const hundredths = (n: number) => Math.round(n * 100) + 0;

/** UTC ms of a death date; a month-precision date stands on the 15th. */
function deathTime(id: string, deathDate: string): { t: number; year: number } {
  const parsed = parseCemeteryDeathDate(deathDate);
  if (!parsed || parsed.month === null) throw new Error(`Cemetery entry ${id} has an invalid deathDate "${deathDate}"`);
  return { t: Date.UTC(parsed.year, parsed.month - 1, parsed.day ?? 15), year: parsed.year };
}

interface Working extends PlotGrave {
  t: number;
  rank: number;
  estTopZ: number;
}

/** A block's packing: large lots at fixed (row, slot) and the 1×1 placements that follow from them. */
interface LotPlan {
  rows: number;
  own: number;
  risk: number;
  tie: number;
  lots: { g: Working; r: number; s: number }[];
  at: Map<string, { r: number; s: number }>;
}

/** Approximate resting stone height (world units) for occlusion-aware packing (tallest north/behind-tall). */
const PACK_BASE_HEIGHT: Readonly<Record<PlotArchetype, number>> = {
  pillow: 0.72,
  "split-arch": 0.98,
  "sealed-tablet": 0.9,
  "broken-column": 1.16,
  urn: 1.08,
};

/** Depth sort: A paints before B when A's footprint lies north or west of B's, else by footprint centre. */
function depthSort<T extends { foot: PlotCell; box: PlotBox; key: string }>(objs: readonly T[]): T[] {
  const n = objs.length;
  const cs = objs.map((o) => hundredths(o.foot.i0 + o.foot.i1 + o.foot.j0 + o.foot.j1));
  const adj: number[][] = objs.map(() => []);
  const indeg = new Array<number>(n).fill(0);
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const A = objs[a].box;
      const B = objs[b].box;
      if (!(A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1)) continue;
      const fa = objs[a].foot;
      const fb = objs[b].foot;
      const ab = fa.i1 <= fb.i0 + 1e-6 || fa.j1 <= fb.j0 + 1e-6;
      const ba = fb.i1 <= fa.i0 + 1e-6 || fb.j1 <= fa.j0 + 1e-6;
      const first = ab && !ba ? a : ba && !ab ? b : cs[a] <= cs[b] ? a : b;
      const second = first === a ? b : a;
      adj[first].push(second);
      indeg[second]++;
    }
  }
  const ready: number[] = [];
  for (let q = 0; q < n; q++) if (!indeg[q]) ready.push(q);
  const out: T[] = [];
  while (ready.length) {
    ready.sort((x, y) => cs[y] - cs[x]);
    const q = ready.pop() as number;
    out.push(objs[q]);
    for (const w of adj[q]) if (!--indeg[w]) ready.push(w);
  }
  return out.length === n ? out : objs.slice().sort((a, b) => a.foot.i0 + a.foot.j0 - (b.foot.i0 + b.foot.j0));
}

export function buildCemeteryPlotMap(entries: readonly CemeteryPlotMapInput[], options: BuildCemeteryPlotMapOptions<"desktop">): DesktopPlotMap;
export function buildCemeteryPlotMap(entries: readonly CemeteryPlotMapInput[], options: BuildCemeteryPlotMapOptions<"portrait">): PortraitPlotMap;
export function buildCemeteryPlotMap(entries: readonly CemeteryPlotMapInput[], options: BuildCemeteryPlotMapOptions): CemeteryPlotMap;
export function buildCemeteryPlotMap(entries: readonly CemeteryPlotMapInput[], options: BuildCemeteryPlotMapOptions): CemeteryPlotMap {
  const preset = PLOT_MAP_PRESETS[options.preset];
  if (!preset) throw new Error(`buildCemeteryPlotMap: unknown preset ${String(options.preset)}`);
  if (entries.length === 0) throw new Error("buildCemeteryPlotMap needs at least one cemetery entry");
  const proj = PLOT_PROJECTIONS[preset.projection];

  // Input order must not matter: work on an id-sorted copy (UTF-16 code-unit order).
  const input = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let k = 1; k < input.length; k++) if (input[k].id === input[k - 1].id) throw new Error(`buildCemeteryPlotMap: duplicate id ${input[k].id}`);

  let asOf = options.asOf;
  if (asOf === undefined) {
    asOf = input[0].deathDate;
    for (const e of input) if (e.deathDate > asOf) asOf = e.deathDate;
  }
  const asOfT = deathTime("asOf", asOf).t;

  // One chronological authority for packing and keyboard order.
  const rank = new Map(sortCemeteryCoins([...input], "oldest").map((e, k) => [e.id, k]));
  const newestEntry = sortCemeteryCoins([...input], "newest")[0];

  // Neutral height for unrecorded peaks: lower median of the $10M–$100M class (never the floor).
  const class1 = input
    .filter((e) => plotPeakClassOf(e.peakMcap) === 1)
    .map((e) => plotHeightFactorOf(e.peakMcap as number))
    .sort((a, b) => a - b);
  const neutralHeight = hundredths(class1.length ? class1[Math.floor((class1.length - 1) / 2)] : plotHeightFactorOf(3e7)) / 100;

  const graves: Working[] = input.map((e) => {
    const { t, year } = deathTime(e.id, e.deathDate);
    const peakClass = plotPeakClassOf(e.peakMcap);
    const seed = fnv1a32(e.id);
    const lot: PlotLot = peakClass === 4 ? 3 : peakClass === 3 ? 2 : 1;
    const weather = plotWeatherOf(Math.max(0, (asOfT - t) / YEAR_MS));
    const rnd = seededStream(seed);
    const lean = weather === 4 && lot === 1 ? hundredths((rnd() < 0.5 ? -1 : 1) * (1.2 + 1.8 * rnd())) / 100 : 0;
    const archetype = PLOT_ARCHETYPE_BY_CAUSE[e.causeOfDeath];
    const heightFactor = peakClass === null ? neutralHeight : hundredths(plotHeightFactorOf(e.peakMcap as number)) / 100;
    const estTopZ =
      lot === 3
        ? archetype === "broken-column"
          ? 6.9
          : 3.26
        : (peakClass === null ? 0.1 : peakClass * 0.1) + PACK_BASE_HEIGHT[archetype] * heightFactor * (lot === 2 ? 1.2 : 1);
    return {
      id: e.id,
      name: e.name,
      symbol: e.symbol,
      cause: e.causeOfDeath,
      deathDate: e.deathDate,
      year,
      t,
      rank: rank.get(e.id) as number,
      estTopZ,
      peak: peakClass === null ? null : (e.peakMcap as number),
      peakClass,
      unrecorded: peakClass === null,
      steps: peakClass,
      heightFactor,
      lot,
      archetype,
      shape: plotShapeOf(archetype, lot),
      weather,
      fresh: asOfT - t <= PLOT_FRESH_DAYS * DAY_MS,
      lean,
      peg: e.pegCurrency,
      footstone: e.pegCurrency === "USD" ? null : (PLOT_PEG_GLYPHS[e.pegCurrency] ?? "◇"),
      archived: e.archivedDataAvailable === true,
      seed,
      laneIndex: 0,
      row: 0,
      slot: 0,
      overhang: false,
      cell: { i0: 0, i1: 0, j0: 0, j1: 0 },
      anchor: { i: 0, j: 0 },
      screen: { ground: [0, 0], centre: [0, 0], medal: { x: 0, y: 0, r: 0 }, top: [0, 0], hit: [], box: { x0: 0, y0: 0, x1: 0, y1: 0 }, ring: { cx: 0, cy: 0, rx: 0, ry: 0 } },
      draw: 0,
    };
  });
  const byRank = (a: Working, b: Working) => a.rank - b.rank;

  // ---- lanes along j, laid out north (sea wall) → south (front): back lane = last in canonical order.
  // All layout arithmetic runs in integer hundredths of a world unit, so it is exact and origin-independent.
  const SP = hundredths(preset.slotPitch);
  const RP = hundredths(preset.rowPitch);
  const northToSouth = [...CAUSE_ORDER].reverse();
  const slotJ: number[] = [];
  const laneGeo = {} as Record<CauseOfDeath, { slot0: number; depth: number; j0: number; j1: number }>;
  let jCursor = hundredths(preset.northTerrace);
  for (const cause of northToSouth) {
    const depth = preset.depth[cause];
    laneGeo[cause] = { slot0: slotJ.length, depth, j0: jCursor, j1: jCursor + depth * SP };
    for (let k = 0; k < depth; k++) slotJ.push(jCursor + k * SP);
    jCursor += depth * SP + hundredths(preset.lanePath);
  }
  const slots = slotJ.length;
  const jFront = jCursor - hundredths(preset.lanePath);
  const J = jFront + hundredths(preset.southMargin);
  const jOfSlot = (s: number) => (s < 0 ? slotJ[0] + s * SP : s >= slots ? slotJ[slots - 1] + (s - slots + 1) * SP : slotJ[s]);

  const laneMembers = {} as Record<CauseOfDeath, Working[]>;
  for (const cause of CAUSE_ORDER) {
    const mine = graves.filter((g) => g.cause === cause).sort(byRank);
    mine.forEach((g, k) => (g.laneIndex = k));
    laneMembers[cause] = mine;
  }

  // ---- pack each year block: years strictly before `preset.mergeBefore` share one oldest block (preserving each
  // grave's real date/order and disclosing any internal empty years); later years get one block each.
  const occupiedYears = [...new Set(graves.map((g) => g.year))].sort((a, b) => a - b);
  const occupiedSet = new Set(occupiedYears);
  const firstYear = occupiedYears[0];
  const lastYear = occupiedYears[occupiedYears.length - 1];
  interface PackedGroup {
    years: number[];
    emptyYears: number[];
    members: Working[];
  }
  const groups: PackedGroup[] = [];
  const earlyYears = preset.mergeBefore === null ? [] : occupiedYears.filter((y) => y < preset.mergeBefore!);
  if (earlyYears.length > 0) {
    const lo = earlyYears[0];
    const hi = earlyYears[earlyYears.length - 1];
    const span: number[] = [];
    const emptyYears: number[] = [];
    for (let y = lo; y <= hi; y++) {
      span.push(y);
      if (!occupiedSet.has(y)) emptyYears.push(y);
    }
    groups.push({ years: span, emptyYears, members: graves.filter((g) => g.year >= lo && g.year <= hi).sort(byRank) });
  }
  for (const year of occupiedYears) {
    if (preset.mergeBefore !== null && year < preset.mergeBefore) continue;
    groups.push({ years: [year], emptyYears: [], members: graves.filter((g) => g.year === year).sort(byRank) });
  }
  // Slot −1 is a virtual slot on the cypress walk: only large lots may step onto it ("stand outside the beds").
  // Pack newest → oldest so on desktop a lot-3 monument at row 0 reserves its east-facing stair forecourt slots in the
  // immediately east (older) block when no empty-year strip separates them.
  const northVirtual = preset.northTerrace >= preset.slotPitch * 0.9 ? 1 : 0;
  const isDesktop = preset.name === "desktop";
  /** Rows (along i) and slots (along j) occupied by a grave: portrait caps width to its own cause column. */
  const lotSpanI = (g: Pick<Working, "lot">) => (isDesktop ? g.lot : g.lot === 3 ? 2 : g.lot);
  const lotSpanJ = (g: Pick<Working, "lot" | "cause">) => (isDesktop ? g.lot : Math.min(g.lot, laneGeo[g.cause].depth));
  const groupRows = new Map<number, number>();
  const greedyBlocks = new Set<number>();
  const westForecourtByGroup = new Map<number, Set<number>>();
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const group = groups[gi];
    const { members } = group;
    const large = members.filter((g) => g.lot > 1);
    const small = members.filter((g) => g.lot === 1);
    const blockedWestSlots = isDesktop ? (westForecourtByGroup.get(gi) ?? new Set<number>()) : new Set<number>();
    const smallByCause = new Map<CauseOfDeath, Working[]>(CAUSE_ORDER.map((c) => [c, small.filter((g) => g.cause === c)]));

    const fill = (lots: { g: Working; r: number; s: number }[]) => {
      const occHeight: number[][] = [];
      const free = (r: number, s: number) => !(occHeight[r] && occHeight[r][s + northVirtual]);
      const mark = (r: number, s: number, spanI: number, spanJ: number, h: number) => {
        for (let a = 0; a < spanI; a++) {
          occHeight[r + a] = occHeight[r + a] || [];
          for (let b = 0; b < spanJ; b++) occHeight[r + a][s + b + northVirtual] = h;
        }
      };
      for (const { g, r, s } of lots) {
        const spanI = lotSpanI(g);
        const spanJ = lotSpanJ(g);
        for (let a = 0; a < spanI; a++) for (let b = 0; b < spanJ; b++) if (!free(r + a, s + b)) return null;
        mark(r, s, spanI, spanJ, g.estTopZ);
      }
      // Same-block east forecourt: a lot-3 monument at r > 0 reserves row r − 1 across its j slots on desktop.
      const internalBlocked = new Set<string>();
      if (isDesktop) {
        for (const { g, r, s } of lots) {
          if (g.lot !== 3 || r <= 0) continue;
          for (let b = 0; b < g.lot; b++) {
            const fs = s + b;
            if (fs < 0) continue;
            if (!free(r - 1, fs)) return null;
            internalBlocked.add(`${r - 1}:${fs}`);
          }
        }
      }

      let minRows = Math.max(
        1,
        occHeight.length,
        ...CAUSE_ORDER.map((c) => Math.ceil((smallByCause.get(c)?.length ?? 0) / laneGeo[c].depth)),
      );
      if (blockedWestSlots.size > 0) {
        const lotHitsWest = (rows: number) =>
          lots.some(({ g, r, s }) => r + lotSpanI(g) - 1 === rows - 1 && Array.from({ length: lotSpanJ(g) }, (_, b) => s + b).some((sl) => blockedWestSlots.has(sl)));
        while (lotHitsWest(minRows)) minRows++;
      }
      // Upper bound on rows needed: even if every large lot + forecourt slot occupies one lane, packing still terminates.
      const extraRowsBound = Math.max(
        4,
        lots.reduce((sum, o) => sum + lotSpanI(o.g) + 1, 0) + (blockedWestSlots.size > 0 ? 1 : 0),
      );

      for (let targetRows = minRows; targetRows <= minRows + extraRowsBound; targetRows++) {
        const hGrid = occHeight.map((row) => (row ? [...row] : []));
        const freeSlot = (r: number, s: number) => {
          if (r === targetRows - 1 && blockedWestSlots.has(s)) return false;
          if (internalBlocked.has(`${r}:${s}`)) return false;
          return !(hGrid[r] && hGrid[r][s + northVirtual]);
        };
        const heightAt = (r: number, s: number) => (r >= 0 && hGrid[r] ? (hGrid[r][s + northVirtual] ?? 0) : 0);
        const setH = (r: number, s: number, h: number) => {
          hGrid[r] = hGrid[r] || [];
          hGrid[r][s + northVirtual] = h;
        };
        const at = new Map<string, { r: number; s: number }>();
        let ok = true;
        let risk = 0;
        for (const cause of CAUSE_ORDER) {
          const list = smallByCause.get(cause)!;
          if (!list.length) continue;
          const L = laneGeo[cause];
          const rowAvail: number[][] = [];
          for (let r = 0; r < targetRows; r++) {
            const av: number[] = [];
            for (let k = 0; k < L.depth; k++) if (freeSlot(r, L.slot0 + k)) av.push(L.slot0 + k);
            rowAvail.push(av);
          }
          const totalAvail = rowAvail.reduce((a, b) => a + b.length, 0);
          if (totalAvail < list.length) {
            ok = false;
            break;
          }
          // Keep each lane compact within the minimal rows it needs, using only spare slots inside those rows.
          let acc = 0;
          let laneRows = 0;
          for (let r = 0; r < targetRows && acc < list.length; r++) {
            acc += rowAvail[r].length;
            laneRows = r + 1;
          }
          let idx = 0;
          for (let r = 0; r < laneRows && idx < list.length; r++) {
            const avail = rowAvail[r];
            if (!avail.length) continue;
            const remaining = list.length - idx;
            // Single grave in a multi-slot lane: centre in safe slots clear of any same-row colossus's south stairs.
            if (list.length === 1 && avail.length > 1) {
              const safe = avail.filter((s) => !lots.some(({ g, r: lr, s: ls }) => g.lot === 3 && r >= lr && r < lr + g.lot && s === ls + g.lot));
              const pool = safe.length ? safe : avail;
              const chosenSlot = pool[Math.floor((pool.length - 1) / 2)];
              const g = list[idx++];
              setH(r, chosenSlot, g.estTopZ);
              at.set(g.id, { r, s: chosenSlot });
              continue;
            }
            const scored = avail.map((s) => {
              const occSlot = isDesktop ? s + 1 : s;
              const inLane = occSlot >= L.slot0 && occSlot < L.slot0 + L.depth;
              const occH = r > 0 && inLane ? heightAt(r - 1, occSlot) : 0;
              return { s, occH };
            });
            const futureAvail = rowAvail.slice(r + 1, laneRows).reduce((a, b) => a + b.length, 0);
            const minNeedHere = Math.max(0, remaining - futureAvail);
            const canSkip = avail.length - minNeedHere;
            let keepCount = Math.min(avail.length, remaining);
            if (canSkip > 0 && r < laneRows - 1) {
              const highRisk = scored.filter((x) => x.occH >= 1.2).length;
              keepCount = avail.length - Math.min(canSkip, highRisk);
            }
            // Prefer lowest-occlusion slots (ties: south-most on partial rows, where SE lies on the lane path).
            const picked = [...scored].sort((a, b) => a.occH - b.occH || b.s - a.s).slice(0, keepCount);
            // Pair tallest stones in this row with highest-risk / north-most chosen slots so tall faces clear SE neighbours.
            picked.sort((a, b) => b.occH - a.occH || a.s - b.s);
            const take = list.slice(idx, idx + picked.length);
            const ordered = [...take].sort((a, b) => b.estTopZ - a.estTopZ || a.rank - b.rank);
            for (let k = 0; k < ordered.length; k++) {
              const slot = picked[k].s;
              const occH = picked[k].occH;
              if (occH > 0) risk += Math.max(0, occH - ordered[k].estTopZ + 0.35);
              setH(r, slot, ordered[k].estTopZ);
              at.set(ordered[k].id, { r, s: slot });
            }
            idx += ordered.length;
          }
          if (idx < list.length) {
            ok = false;
            break;
          }
        }
        if (ok) return { rows: targetRows, risk, at };
      }
      return null;
    };

    // Desktop minimises rows (plan length), then own-lane share, then occlusion risk.
    // Portrait has vertical room and tappable cause column heads, so every lot stays inside its own cause column
    // (ranking own-lane strictly above fewer rows).
    const search = (maxRow: number): { plan: LotPlan | null; greedy: boolean } => {
      const candidates = large.map((g) => {
        const L = laneGeo[g.cause];
        const spanJ = lotSpanJ(g);
        const out: { r: number; s: number; own: number }[] = [];
        const sMin = isDesktop ? Math.max(northVirtual ? -1 : 0, L.slot0 - (spanJ - 1)) : L.slot0;
        const sMax = isDesktop ? Math.min(slots - spanJ, L.slot0 + L.depth - 1) : L.slot0 + L.depth - spanJ;
        for (let s = sMin; s <= sMax; s++) {
          const own = Math.min(s + spanJ, L.slot0 + L.depth) - Math.max(s, L.slot0);
          for (let r = 0; r <= maxRow; r++) out.push({ r, s, own });
        }
        return out;
      });
      const consider = (best: LotPlan | null, lots: LotPlan["lots"], own: number): LotPlan | null => {
        const res = fill(lots);
        if (!res) return best;
        const tie = lots.reduce((a, c) => a + c.r * 100 + (c.s + northVirtual), 0);
        const better = !best
          ? true
          : isDesktop
            ? res.rows < best.rows ||
              (res.rows === best.rows &&
                (own > best.own ||
                  (own === best.own && (res.risk < best.risk - 1e-6 || (Math.abs(res.risk - best.risk) <= 1e-6 && tie < best.tie)))))
            : own > best.own ||
              (own === best.own &&
                (res.rows < best.rows ||
                  (res.rows === best.rows && (res.risk < best.risk - 1e-6 || (Math.abs(res.risk - best.risk) <= 1e-6 && tie < best.tie)))));
        if (better) {
          return { rows: res.rows, own, risk: res.risk, tie, lots, at: res.at };
        }
        return best;
      };
      const clashes = (lots: LotPlan["lots"], c: { r: number; s: number }, spanI: number, spanJ: number) =>
        lots.some((o) => c.r < o.r + lotSpanI(o.g) && o.r < c.r + spanI && c.s < o.s + lotSpanJ(o.g) && o.s < c.s + spanJ);
      const combinations = candidates.reduce((a, c) => a * c.length, 1);
      if (combinations <= PLOT_LAYOUT.lotSearchBudget) {
        let best: LotPlan | null = null;
        const walk = (idx: number, chosen: LotPlan["lots"], own: number) => {
          if (idx === large.length) {
            best = consider(best, chosen, own);
            return;
          }
          const spanI = lotSpanI(large[idx]);
          const spanJ = lotSpanJ(large[idx]);
          for (const c of candidates[idx]) {
            if (!clashes(chosen, c, spanI, spanJ)) walk(idx + 1, [...chosen, { g: large[idx], r: c.r, s: c.s }], own + c.own);
          }
        };
        walk(0, [], 0);
        return { plan: best, greedy: false };
      }
      let placed: LotPlan | null = { rows: 0, own: 0, risk: 0, tie: 0, lots: [], at: new Map() };
      for (let idx = 0; idx < large.length && placed; idx++) {
        const before: LotPlan = placed;
        let pick: LotPlan | null = null;
        const spanI = lotSpanI(large[idx]);
        const spanJ = lotSpanJ(large[idx]);
        for (const c of candidates[idx]) {
          if (!clashes(before.lots, c, spanI, spanJ)) pick = consider(pick, [...before.lots, { g: large[idx], r: c.r, s: c.s }], before.own + c.own);
        }
        placed = pick;
      }
      return { plan: placed, greedy: true };
    };
    // Large lots start in rows 0…3; only a block that cannot fit them there searches deeper (flagged by
    // validatePlotMapCapacity as "lot-rows"). Bounded explicitly so pathological inputs never spin.
    let found = search(PLOT_LAYOUT.maxLotRow);
    const maxRowLimit = PLOT_LAYOUT.maxLotRow + Math.max(4, large.length * 4 + 4);
    for (let maxRow = PLOT_LAYOUT.maxLotRow + 1; !found.plan && maxRow <= maxRowLimit; maxRow++) found = search(maxRow);
    if (!found.plan) throw new Error(`buildCemeteryPlotMap: could not pack block ${group.years[0]} within ${maxRowLimit} rows`);
    const chosen = found.plan;
    for (const { g, r, s } of chosen.lots) {
      const L = laneGeo[g.cause];
      g.row = r;
      g.slot = s;
      g.overhang = s < L.slot0 || s + lotSpanJ(g) > L.slot0 + L.depth;
      if (isDesktop && g.lot === 3 && r === 0 && gi > 0) {
        const prevEnd = groups[gi - 1].years[groups[gi - 1].years.length - 1];
        // When the next older block touches this one across a single yearPath (no empty-year strip), reserve its west-most row.
        if (prevEnd + 1 === group.years[0]) {
          const fc = westForecourtByGroup.get(gi - 1) ?? new Set<number>();
          for (let b = 0; b < g.lot; b++) if (s + b >= 0) fc.add(s + b);
          westForecourtByGroup.set(gi - 1, fc);
        }
      }
    }
    for (const g of small) {
      const at = chosen.at.get(g.id)!;
      g.row = at.r;
      g.slot = at.s;
    }
    groupRows.set(group.years[0], chosen.rows);
    if (found.greedy) greedyBlocks.add(group.years[0]);
  }

  // ---- year blocks along i, laid from the oldest (east, i = 0) toward the gate (west, negative i).
  const eastToWest: { years: number[]; emptyYears: number[]; empty: boolean; rows: number; i0: number; i1: number }[] = [];
  let iCursor = 0;
  for (let k = 0; k < groups.length; k++) {
    const group = groups[k];
    if (k > 0) {
      const prevEnd = groups[k - 1].years[groups[k - 1].years.length - 1];
      const gapStart = prevEnd + 1;
      const gapEnd = group.years[0] - 1;
      if (gapStart <= gapEnd) {
        const gapYears: number[] = [];
        for (let y = gapStart; y <= gapEnd; y++) gapYears.push(y);
        const i1 = iCursor;
        const i0 = i1 - hundredths(preset.emptyYears);
        eastToWest.push({ years: gapYears, emptyYears: gapYears, empty: true, rows: 0, i0, i1 });
        iCursor = i0 - hundredths(preset.yearPath);
      }
    }
    const rows = groupRows.get(group.years[0])!;
    const i1 = iCursor;
    const i0 = i1 - rows * RP;
    eastToWest.push({ years: group.years, emptyYears: group.emptyYears, empty: false, rows, i0, i1 });
    iCursor = i0 - hundredths(preset.yearPath);
  }
  const westToEast = eastToWest.reverse();
  const iAvenue = westToEast[0].i0;
  const iWest = iAvenue - hundredths(preset.avenue);
  const iEast = hundredths(preset.eastTerrace);
  const blockOfYear = new Map<number, (typeof westToEast)[number]>();
  for (const b of westToEast) if (!b.empty) for (const y of b.years) blockOfYear.set(y, b);

  // ---- cells:
  // Desktop: row 0 (the block's oldest graves) at the block's east edge, so rows added for newer deaths grow westward
  // and never move an existing lot.
  // Portrait: anchor each lane's rows from the TOP of its year block (`B.i0`, newest at the top directly under the
  // sticky year band) and centre sparse `j` spans symmetrically inside their cause column so lone stones & trimmed
  // beds never sit lopsided or leave blank walls at the top of a year.
  if (isDesktop) {
    for (const g of graves) {
      const B = blockOfYear.get(g.year)!;
      const spanI = lotSpanI(g);
      const spanJ = lotSpanJ(g);
      const i1 = B.i1 - g.row * RP;
      const i0 = i1 - spanI * RP;
      const j0 = jOfSlot(g.slot);
      const j1 = jOfSlot(g.slot + spanJ - 1) + SP;
      g.cell = { i0: i0 / 100, i1: i1 / 100, j0: j0 / 100, j1: j1 / 100 };
      // Per-archetype west anchor keeps square pedestals (column/urn) and large plinths inside their lot/pad.
      const offsetI = hundredths(graveAnchorOffsetI(g.shape, g.lot, g.steps, preset.projection));
      g.anchor = { i: (i0 + offsetI) / 100, j: Math.round((j0 + j1) / 2) / 100 };
    }
  } else {
    const laneOccRows = new Map<string, number>();
    const laneOccJ = new Map<string, { minJ0: number; maxJ1: number }>();
    for (const g of graves) {
      const B = blockOfYear.get(g.year)!;
      const key = `${B.years[0]}:${g.cause}`;
      const endRow = g.row + lotSpanI(g);
      laneOccRows.set(key, Math.max(laneOccRows.get(key) ?? 0, endRow));
      const j0 = jOfSlot(g.slot);
      const j1 = jOfSlot(g.slot + lotSpanJ(g) - 1) + SP;
      const prev = laneOccJ.get(key);
      laneOccJ.set(key, prev ? { minJ0: Math.min(prev.minJ0, j0), maxJ1: Math.max(prev.maxJ1, j1) } : { minJ0: j0, maxJ1: j1 });
    }
    for (const g of graves) {
      const B = blockOfYear.get(g.year)!;
      const key = `${B.years[0]}:${g.cause}`;
      const occRows = laneOccRows.get(key)!;
      const occJ = laneOccJ.get(key)!;
      const L = laneGeo[g.cause];
      const spanI = lotSpanI(g);
      const spanJ = lotSpanJ(g);
      const i1 = B.i0 + (occRows - g.row) * RP;
      const i0 = i1 - spanI * RP;
      const dj = Math.round(((L.j0 + L.j1) - (occJ.minJ0 + occJ.maxJ1)) / 2);
      const j0 = jOfSlot(g.slot) + dj;
      const j1 = jOfSlot(g.slot + spanJ - 1) + SP + dj;
      g.cell = { i0: i0 / 100, i1: i1 / 100, j0: j0 / 100, j1: j1 / 100 };
      const offsetI = hundredths(graveAnchorOffsetI(g.shape, g.lot, g.steps, preset.projection));
      g.anchor = { i: (i0 + offsetI) / 100, j: Math.round((j0 + j1) / 2) / 100 };
    }
  }

  const blocks: PlotYearBlock[] = westToEast.map((b) => {
    const yearSet = new Set(b.years);
    const ids = b.empty ? [] : graves.filter((g) => yearSet.has(g.year)).sort(byRank).map((g) => g.id);
    const lo = b.years[0];
    const hi = b.years[b.years.length - 1];
    const label = formatYearSpan(lo, hi);
    return {
      key: lo !== hi ? `${lo}-${hi}` : String(lo),
      year: lo,
      years: [...b.years],
      emptyYears: [...b.emptyYears],
      empty: b.empty,
      count: ids.length,
      rows: b.rows,
      i0: b.i0 / 100,
      i1: b.i1 / 100,
      label,
      text: b.empty ? label : `${label} · ${ids.length}`,
      sub: b.empty ? "none recorded" : b.emptyYears.length ? `${formatYearRanges(b.emptyYears)} none recorded` : null,
      stamp: [0, 0],
      stampAngle: 0,
      span: { y0: 0, y1: 0 },
      ids,
      greedyLots: !b.empty && greedyBlocks.has(lo),
    };
  });

  const lanes: PlotLane[] = CAUSE_ORDER.map((cause) => {
    const L = laneGeo[cause];
    const mine = laneMembers[cause];
    const laneJ0 = L.j0 / 100;
    const laneJ1 = L.j1 / 100;
    const bed = mine.length ? { i0: Math.min(...mine.map((g) => g.cell.i0)), i1: Math.max(...mine.map((g) => g.cell.i1)) } : null;
    return {
      cause,
      label: CAUSE_META[cause].label,
      hex: CAUSE_HEX[cause],
      hexDark: CAUSE_HEX_DARK[cause],
      depth: L.depth,
      slot0: L.slot0,
      j0: laneJ0,
      j1: laneJ1,
      count: mine.length,
      bed,
      cells: isDesktop
        ? bed
          ? blocks
              .flatMap((b) => {
                if (b.empty || b.i1 <= bed.i0 + 1e-6 || b.i0 >= bed.i1 - 1e-6) return [];
                // Skip emitting a narrow 1-slot lane bed under a block occupied solely by a lot-3 colossus (its raised lot pad is its bed).
                const yearSet = new Set(b.years);
                const inBlock = mine.filter((g) => yearSet.has(g.year));
                if (inBlock.length > 0 && inBlock.every((g) => g.lot === 3)) return [];
                // On desktop, trim sparse per-block beds along j to occupied slots + 1 (centered symmetrically inside the lane)
                // so wide lanes with 1–2 graves in a year do not paint mostly-empty slabs (C-07).
                let cellJ0 = laneJ0;
                let cellJ1 = laneJ1;
                if (inBlock.length > 0 && L.depth >= 3) {
                  const occJ0 = Math.max(laneJ0, Math.min(...inBlock.map((g) => g.cell.j0)));
                  const occJ1 = Math.min(laneJ1, Math.max(...inBlock.map((g) => g.cell.j1)));
                  const targetSpan = Math.min(laneJ1 - laneJ0, occJ1 - occJ0 + preset.slotPitch);
                  if (targetSpan < laneJ1 - laneJ0 - 1e-6) {
                    const mid = (occJ0 + occJ1) / 2;
                    let lo = mid - targetSpan / 2;
                    let hi = mid + targetSpan / 2;
                    if (lo < laneJ0) {
                      hi += laneJ0 - lo;
                      lo = laneJ0;
                    }
                    if (hi > laneJ1) {
                      lo -= hi - laneJ1;
                      hi = laneJ1;
                    }
                    cellJ0 = hundredths(Math.max(laneJ0, lo)) / 100;
                    cellJ1 = hundredths(Math.min(laneJ1, hi)) / 100;
                  }
                }
                return [{ year: b.year, i0: b.i0, i1: b.i1, j0: cellJ0, j1: cellJ1 }];
              })
          : []
        : blocks.flatMap((b) => {
            if (b.empty) return [];
            const yearSet = new Set(b.years);
            const inBlock = mine.filter((g) => yearSet.has(g.year));
            // Portrait: beds hug their occupied rows and occupied slots; empty lane-years remain quiet lawn (no bare
            // curb bars), and pure lot > 1 blocks stand on their own raised curbed lot pads.
            if (inBlock.length === 0) return [];
            if (inBlock.every((g) => g.lot > 1)) return [];
            const occI0 = Math.min(...inBlock.map((g) => g.cell.i0));
            const occI1 = Math.max(...inBlock.map((g) => g.cell.i1));
            const occJ0 = Math.min(...inBlock.map((g) => g.cell.j0));
            const occJ1 = Math.max(...inBlock.map((g) => g.cell.j1));
            return [{ year: b.year, i0: hundredths(occI0) / 100, i1: hundredths(occI1) / 100, j0: hundredths(occJ0) / 100, j1: hundredths(occJ1) / 100 }];
          }),
      ids: mine.map((g) => g.id),
    };
  });

  // ---- R11: bed area share vs death share; empty rows inside each bed and lawn rows west of it.
  const bedArea = lanes.map((L) => (L.bed ? (L.bed.i1 - L.bed.i0) * L.depth * preset.slotPitch : 0));
  const totalArea = bedArea.reduce((a, b) => a + b, 0);
  const areaShare = lanes.map((L, k) => ({
    cause: L.cause,
    deathShare: hundredths((100 * L.count) / graves.length) / 100,
    areaShare: totalArea ? hundredths((100 * bedArea[k]) / totalArea) / 100 : 0,
  }));
  const emptyRuns = lanes.map((L) => {
    let inBed = 0;
    let beforeBed = 0;
    let run = 0;
    for (const B of blocks) {
      if (B.empty || !L.bed) continue;
      for (let r = 0; r < B.rows; r++) {
        const i0 = B.i0 + (r * RP) / 100;
        const hit = graves.some((g) => g.cell.i0 <= i0 + 1e-6 && g.cell.i1 > i0 + 1e-6 && g.cell.j1 > L.j0 + 1e-6 && g.cell.j0 < L.j1 - 1e-6);
        if (i0 + 1e-6 < L.bed.i0) {
          beforeBed++;
          continue;
        }
        if (i0 + 1e-6 >= L.bed.i1) continue;
        run = hit ? 0 : run + 1;
        inBed = Math.max(inBed, run);
      }
    }
    return { cause: L.cause, depth: L.depth, maxEmptyRowsInBed: inBed, lawnRowsBeforeBed: beforeBed };
  });

  const geo = new Map(graves.map((g) => [g.id, graveGeometry(proj, g)]));
  for (const g of graves) {
    const art = geo.get(g.id)!;
    const hit = graveHitHull(proj, art, g.cell);
    const [sx, sy] = project(proj, g.anchor.i, g.anchor.j, 0);
    const rr = (g.lot === 1 ? 0.46 : g.lot === 2 ? 0.9 : 1.7) * Math.SQRT2 * PLOT_UNIT;
    g.screen = {
      ground: [round1(sx), round1(sy)],
      centre: roundPoint(project(proj, (g.cell.i0 + g.cell.i1) / 2, (g.cell.j0 + g.cell.j1) / 2, 0.35)),
      medal: art.medal,
      top: art.top,
      hit: hit.map(roundPoint),
      box: roundBox(bbox(hit)),
      ring: { cx: round1(sx), cy: round1(sy), rx: round1(rr), ry: round1(rr / 2) },
    };
  }

  const J100 = J / 100;
  for (const b of blocks) {
    b.span = { y0: round1(project(proj, b.i0, J100, 0)[1]), y1: round1(project(proj, b.i1, J100, 0)[1]) };
  }

  const site: PlotSite = {
    iWest: iWest / 100,
    iAvenue: iAvenue / 100,
    iOldest: 0,
    iEast: iEast / 100,
    northTerrace: preset.northTerrace,
    jFront: jFront / 100,
    jSouth: J100,
  };
  const total = graves.length;
  const newest = graves.find((g) => g.id === newestEntry.id)!;
  const restDate = parseCemeteryDeathDate(newest.deathDate)!;
  const base = {
    projection: preset.projection,
    asOf,
    firstYear,
    lastYear,
    counts: { total, recorded: graves.filter((g) => !g.unrecorded).length, archived: graves.filter((g) => g.archived).length },
    newestId: newest.id,
    neutralHeight,
    slotPitch: preset.slotPitch,
    rowPitch: preset.rowPitch,
    site,
    lanes,
    blocks,
    keyboard: { initialId: newest.id, sections: lanes.map((L) => ({ cause: L.cause, ids: [...L.ids] })) },
    areaShare,
    emptyRuns,
    header: {
      plaque: formatCemeteryPlaque(total, firstYear),
      rest: {
        id: newest.id,
        name: newest.name,
        deathDate: newest.deathDate,
        dateLabel:
          restDate.day === null
            ? formatDeathDate(newest.deathDate.slice(0, 7))
            : formatUtcDayLabel(new Date(Date.UTC(restDate.year, (restDate.month as number) - 1, restDate.day))),
      },
    },
  };
  const finalGraves = (order: string[]): PlotGrave[] => {
    const drawIndex = new Map(order.map((key, k) => [key, k]));
    return graves.map(({ t: _t, rank: _rank, estTopZ: _estTopZ, ...g }) => ({ ...g, draw: drawIndex.get(`grave:${g.id}`) as number }));
  };

  if (preset.name === "portrait") {
    return buildPortrait(proj, base, graves, geo, finalGraves);
  }
  return buildDesktop(proj, preset, base, graves, geo, finalGraves);
}

type BaseFields = Omit<PlotMapBase, "preset" | "viewBox" | "graves" | "drawOrder">;

function buildPortrait(
  proj: PlotProjection,
  base: BaseFields,
  graves: Working[],
  geo: Map<string, PlotGraveGeometry>,
  finalGraves: (order: string[]) => PlotGrave[],
): PortraitPlotMap {
  const { site, blocks, lanes } = base;
  // Phones: coastal sea strip + low sea wall above the newest block's top year band; headland strata at the oldest end.
  const top = site.iAvenue - PORTRAIT_TOP_MARGIN;
  const I = site.iOldest;
  const J = site.jSouth;
  const side = 0.32;
  const slab = 0.62;
  const ext: PlotPoint[] = [
    project(proj, top, -side, 0),
    project(proj, I + 0.42, J + side, -slab),
    project(proj, I + 0.42, -side, -slab),
    project(proj, top, J + side, 0),
  ];
  for (const g of graves) ext.push(...geo.get(g.id)!.pts);

  // Slender cypresses planted strictly in open lawn bays of non-empty year blocks (never in empty-year strips like
  // 2019–20, never mid-path in a gravel walkway, and clear of every bed, grave and sticky year band).
  const maxBlockCount = Math.max(1, ...blocks.map((b) => b.count));
  const clearOfGraves = (ci: number, cj: number) =>
    graves.every((g) => g.cell.i1 < ci - 0.85 || g.cell.i0 > ci + 0.45 || g.cell.j1 < cj - 0.36 || g.cell.j0 > cj + 0.36);
  const cypress: PortraitPlotCypress[] = [];
  const addCypress = (year: number, count: number, ci: number, cj: number, height: number) => {
    const i = hundredths(ci) / 100;
    const j = hundredths(cj) / 100;
    if (!clearOfGraves(i, j)) return false;
    cypress.push({ year, count, i, j, height: hundredths(height) / 100 });
    ext.push(project(proj, i, j, height));
    return true;
  };
  // Deterministic lane rotation across blocks so lawn cypresses form an organic staggered grove.
  const laneOrderByBlock = [
    ["counterparty-failure", "algorithmic-failure", "liquidity-drain", "regulatory", "abandoned"],
    ["algorithmic-failure", "regulatory", "counterparty-failure", "abandoned", "liquidity-drain"],
    ["counterparty-failure", "regulatory", "algorithmic-failure", "abandoned", "liquidity-drain"],
    ["abandoned", "liquidity-drain", "counterparty-failure", "regulatory", "algorithmic-failure"],
  ] as const;
  const laneByCause = new Map(lanes.map((L) => [L.cause, L]));
  for (let q = 0; q < blocks.length; q++) {
    const b = blocks[q];
    if (b.empty) continue;
    const yearSet = new Set(b.years);
    const h = 0.52 + 0.28 * (b.count / maxBlockCount);
    const maxForBlock = b.rows >= 6 ? 2 : 1;
    const order = laneOrderByBlock[q % laneOrderByBlock.length];
    let placed = 0;
    for (const cause of order) {
      if (placed >= maxForBlock) break;
      const L = laneByCause.get(cause);
      if (!L) continue;
      const inLane = graves.filter((g) => g.cause === cause && yearSet.has(g.year));
      const openI0 = inLane.length > 0 ? Math.max(...inLane.map((g) => g.cell.i1)) + 1.05 : b.i0 + 0.85;
      const openI1 = b.i1 - 0.42;
      if (openI1 - openI0 < 0.2) continue;
      const ci = Math.min(openI1, openI0 + Math.min(1.1, (openI1 - openI0) * 0.42));
      const cj = (L.j0 + L.j1) / 2;
      if (addCypress(b.year, b.count, ci, cj, placed === 0 ? h : h * 0.88)) placed++;
    }
  }
  cypress.sort((a, b) => a.i - b.i || a.j - b.j);

  const eb = bbox(ext);
  const viewBox: [number, number, number, number] = [round1(eb.x0 - 2), round1(eb.y0 - 2), round1(eb.x1 - eb.x0 + 4), round1(eb.y1 - eb.y0 + 4)];
  // Back to front: higher on the page (smaller i) first; ties by j ascending (right → left, matching ENE oblique faces).
  const order = graves
    .slice()
    .sort((a, b) => Math.round((a.cell.i0 - b.cell.i0) * 100) || Math.round((a.cell.j0 - b.cell.j0) * 100))
    .map((g) => `grave:${g.id}`);
  for (const b of blocks) b.stamp = [round1(project(proj, (b.i0 + b.i1) / 2, J, 0)[0]), round1((b.span.y0 + b.span.y1) / 2)];
  const i0 = blocks[0].i0;
  return {
    ...base,
    preset: "portrait",
    viewBox,
    graves: finalGraves(order),
    drawOrder: order,
    columns: lanes.map((L) => ({
      cause: L.cause,
      label: L.label,
      count: L.count,
      x0: round1(project(proj, i0, L.j1, 0)[0]),
      x1: round1(project(proj, i0, L.j0, 0)[0]),
    })),
    cypress,
  };
}

function buildDesktop(
  proj: PlotProjection,
  preset: PlotMapPreset,
  base: BaseFields,
  graves: Working[],
  geo: Map<string, PlotGraveGeometry>,
  finalGraves: (order: string[]) => PlotGrave[],
): DesktopPlotMap {
  const { site, blocks, lanes } = base;
  const W = site.iWest;
  const AV = preset.avenue;
  const I = site.iEast;
  const J = site.jSouth;
  const { rim, verge, slab } = PLOT_SCENE;
  const w2 = (n: number) => hundredths(n) / 100;
  const frame = { iA: w2(W - rim), iB: w2(I + rim), jN: -rim, jB: w2(J + rim + verge), jVerge: w2(J + rim + verge * 0.5), slab };
  const P = (i: number, j: number, z = 0) => project(proj, i, j, z);

  interface SceneObject {
    key: string;
    foot: PlotCell;
    pts: PlotPoint[];
    box: PlotBox;
    lamp: boolean;
  }
  const objs: SceneObject[] = [];
  const addObject = (key: string, foot: PlotCell, pts: PlotPoint[], lamp = false) => objs.push({ key, foot, pts, box: bbox(pts), lamp });
  for (const g of graves) addObject(`grave:${g.id}`, g.cell, geo.get(g.id)!.pts);

  // Year lamps at the cross-path west of every block but the newest (which opens onto the avenue).
  const lamps: DesktopPlotMap["lamps"] = [];
  const lj = w2(site.jFront + 0.25);
  for (const b of blocks) {
    if (b.empty || !(b.i0 > W + AV + 0.2)) continue;
    const li = w2(b.i0 - 0.23);
    lamps.push({ year: b.year, i: li, j: lj });
    addObject(`lamp:${b.year}`, { i0: li - 0.08, i1: li + 0.08, j0: lj - 0.08, j1: lj + 0.08 }, lampGeometry(proj, li, lj).pts, true);
  }
  const gate = { i0: W, i1: site.iAvenue, j: J };
  addObject("gate", { i0: gate.i0, i1: gate.i1, j0: J, j1: w2(J + rim) }, gateGeometry(proj, gate.i0, gate.i1, J).pts);
  // Headland promontory past the NE corner: rock drops flush to the slab floor (−slab), with its SW corner on iB so
  // every visible vertical rock face sits outside the lawn and earth-e.
  const lhApothem = PLOT_SCENE.lighthouseApothem;
  const lhRockZ0 = -slab;
  const lhBevel = lhApothem * (Math.SQRT2 - 1);
  const LH = { i: Math.ceil((frame.iB + lhBevel) * 100) / 100, j: PLOT_SCENE.lighthouseJ };
  const lh = lighthouseGeometry(proj, LH.i, LH.j, { apothem: lhApothem, rockZ0: lhRockZ0 });
  addObject(
    "lighthouse",
    { i0: w2(LH.i - lhApothem), i1: w2(LH.i + lhApothem), j0: w2(LH.j - lhApothem), j1: w2(LH.j + lhApothem) },
    lh.pts,
  );
  const postI = w2(W + AV * PLOT_SCENE.postAt);
  const signposts: PlotSignpost[] = [];
  for (const L of [...lanes].reverse()) {
    const j = w2((L.j0 + L.j1) / 2);
    addObject(`post:${L.cause}`, { i0: postI - 0.05, i1: postI + 0.05, j0: j - 0.05, j1: j + 0.05 }, postGeometry(proj, postI, j).pts);
    signposts.unshift({ cause: L.cause, label: L.label, count: L.count, i: postI, j, foot: roundPoint(P(postI, j, 0)), top: roundPoint(P(postI, j, PLOT_POST_HEIGHT)) });
  }
  const drawOrder = depthSort(objs).map((o) => o.key);

  // Cypress band on the verge outside the front railing: one tree per calendar year, height ∝ deaths.
  const countByYear = new Map<number, number>();
  for (const g of graves) countByYear.set(g.year, (countByYear.get(g.year) ?? 0) + 1);
  const maxYear = Math.max(...countByYear.values());
  const cypress: PlotCypress[] = [];
  for (let y = base.firstYear; y <= base.lastYear; y++) {
    // A year with no record stays unavailable, not zero: the bare bed says "none recorded".
    const n = countByYear.get(y) ?? null;
    const B = blocks.find((b) => b.years.includes(y))!;
    // In a multi-year strip, years run newest (west) → oldest (east) like the blocks.
    const k = B.years.length - 1 - B.years.indexOf(y);
    const i = hundredths(B.years.length > 1 ? B.i0 + ((k + 0.5) / B.years.length) * (B.i1 - B.i0) : (B.i0 + B.i1) / 2) / 100;
    const height = n ? hundredths(0.35 + (1.05 * n) / maxYear) / 100 : 0;
    const tree = cypressGeometry(proj, i, frame.jVerge, height);
    cypress.push({ year: y, count: n, i, j: frame.jVerge, height, foot: roundPoint(P(i, frame.jVerge, 0)), top: roundPoint(tree.top), label: n === null ? `${y} · none recorded` : `${y} · ${n} ${n === 1 ? "death" : "deaths"}` });
  }

  for (const b of blocks) {
    const mid = (b.i0 + b.i1) / 2;
    b.stamp = roundPoint(P(mid, frame.jB, -slab));
    const [ax, ay] = P(mid - 0.5, frame.jB, -slab);
    const [bx, by] = P(mid + 0.5, frame.jB, -slab);
    b.stampAngle = Math.round((Math.atan2(by - ay, bx - ax) * 18000) / Math.PI) / 100;
  }

  // Extents: tight crop from the gate corner to the lighthouse rock, UST top to the slab bottom.
  const { iA, iB, jN, jB } = frame;
  const ext: PlotPoint[] = [P(iA, jB, -slab), P(iB, jB, -slab), P(iB, jN, 0.5), P(iA, jN, 0.5), P(iA, jB, 0.5)];
  for (const o of objs) ext.push(...o.pts);
  for (const c of cypress) ext.push(cypressGeometry(proj, c.i, c.j, c.height).top);
  const eb = bbox(ext);
  const pad = 6;
  const viewBox: [number, number, number, number] = [round1(eb.x0 - pad), round1(eb.y0 - pad * 2.2), round1(eb.x1 - eb.x0 + 2 * pad), round1(eb.y1 - eb.y0 + pad * 8.2)];

  // Skyline: the wall crest (west and north, ending at the headland rock) plus every drawn point.
  const northCrestEnd = Math.min(iB, w2(LH.i - lhApothem));
  const crest: PlotPoint[] = [];
  for (let q = 0; q <= 60; q++) crest.push(P(iA, jB - (q / 60) * (jB - jN), 0.5));
  for (let q = 0; q <= 80; q++) crest.push(P(iA + (q / 80) * (northCrestEnd - iA), jN, 0.5));
  const sky = crest.concat(...objs.map((o) => o.pts)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const prefixTop: PlotPoint[] = [];
  let minY = Infinity;
  for (const pt of sky) {
    if (pt[1] < minY) {
      minY = pt[1];
      prefixTop.push(roundPoint(pt));
    }
  }
  const edges = crest.concat(...objs.filter((o) => o.lamp).map((o) => o.pts)).map(roundPoint);

  const out: DesktopPlotMap = {
    ...base,
    preset: "desktop",
    floorWidth: desktopFloorFrameWidth(viewBox[2]),
    viewBox,
    graves: finalGraves(drawOrder),
    drawOrder,
    frame,
    signposts,
    cypress,
    lamps,
    gate,
    lighthouse: { i: LH.i, j: LH.j, apothem: lhApothem, rockZ0: lhRockZ0, lantern: roundPoint(lh.lantern), top: roundPoint(lh.top) },
    beamOrigin: roundPoint(lh.lantern),
    colossi: [],
    sectionCameras: [],
    obstacles: objs.filter((o) => !o.lamp).map((o) => ({ key: o.key, ...roundBox(o.box) })),
    skyline: { prefixTop, edges },
  };
  out.colossi = out.graves
    .filter((g) => g.lot === 3)
    .map((g) => {
      const peak = formatCemeteryPeak(g.peak as number);
      const month = formatDeathDate(g.deathDate.slice(0, 7));
      return { id: g.id, cause: g.cause, top: g.screen.top, name: g.name, peak, month, text: `${g.name} · peak ${peak} · ${month}` };
    });
  out.sectionCameras = CAUSE_ORDER.map((cause) => fitSectionCamera(out, cause)).filter((c): c is PlotSectionCamera => c !== null);
  return out;
}

export interface PlotCameraViewport {
  /** Frame width in CSS px (the frame follows the container width). */
  frameWidth: number;
  /** Frame height in CSS px; defaults to the viewBox aspect at `frameWidth`. */
  frameHeight?: number;
  viewportHeight: number;
}

/** A candidate camera frame: the union box of `ms` and the zoom that fits it. */
interface CameraFit extends PlotBox {
  z: number;
  ms: PlotGrave[];
}

/**
 * Camera for a signpost zoom: fits the section's graves only (no beds, lighthouse or sea). When the plain face
 * would stay under the 28 px floor it frames the contiguous run of years with the most graves that reaches the
 * target (the approved partial view; ←/→ still reach the rest). Null for an empty section.
 */
export function fitSectionCamera(
  map: DesktopPlotMap,
  cause: CauseOfDeath,
  viewport: PlotCameraViewport = { frameWidth: PLOT_LAYOUT.reference.frameWidth, viewportHeight: PLOT_LAYOUT.reference.viewportHeight },
): PlotSectionCamera | null {
  const list = map.graves.filter((g) => g.cause === cause);
  if (!list.length) return null;
  const [vbX, vbY, vbW, vbH] = map.viewBox;
  const L = PLOT_LAYOUT;
  const scale = viewport.frameWidth / vbW;
  const frameHeight = viewport.frameHeight ?? vbH * scale;
  const availW = viewport.frameWidth - L.zoomSideInset;
  const availH = Math.min(frameHeight, viewport.viewportHeight - L.chromeTop) - L.zoomBar - L.zoomBottomGap;
  const faceUnits = L.plainFace * PLOT_UNIT;
  const needTarget = L.zoomTargetFacePx / (faceUnits * scale);
  const needFloor = L.zoomFloorFacePx / (faceUnits * scale);
  const years = [...new Set(list.map((g) => g.year))].sort((a, b) => a - b);
  const colossusIds = list.filter((g) => g.lot === 3).map((g) => g.id);
  const definingId =
    list
      .filter((g) => g.peak !== null)
      .sort((a, b) => (b.peak as number) - (a.peak as number) || a.laneIndex - b.laneIndex)[0]?.id ?? null;
  /**
   * Framing box for one grave: full hit box by default; when `cropColossi` is enabled on a height-bound viewport,
   * lot-3 colossi frame their podium + medallion so the shaft top may crop at the frame top without dropping the
   * section below the 28 px zoom floor (F3).
   */
  const boxOf = (m: PlotGrave, cropColossi: boolean): PlotBox => {
    if (!cropColossi || m.lot !== 3) return m.screen.box;
    return {
      ...m.screen.box,
      y0: Math.max(m.screen.box.y0, m.screen.medal.y - m.screen.medal.r - 14),
    };
  };
  const fit = (ms: PlotGrave[], cropColossi = false): CameraFit => {
    const boxes = ms.map((m) => boxOf(m, cropColossi));
    const x0 = Math.min(...boxes.map((b) => b.x0));
    const x1 = Math.max(...boxes.map((b) => b.x1));
    const y0 = Math.min(...boxes.map((b) => b.y0));
    const y1 = Math.max(...boxes.map((b) => b.y1));
    return { x0, x1, y0, y1, z: Math.min(availW / ((x1 - x0) * scale), availH / ((y1 - y0) * scale), L.zoomMaxScale), ms };
  };
  let best = fit(list, false);
  let span: [number, number] = [years[0], years[years.length - 1]];
  // Whole section already reaches the target (or the 28 px floor when keeping the defining grave would otherwise clip).
  if (best.z < needTarget && !(definingId !== null && best.z >= needFloor)) {
    const buildRuns = (cropColossi: boolean) => {
      const runs: { f: CameraFit; a: number; b: number; hasColossi: boolean; hasDefining: boolean }[] = [];
      for (let a = 0; a < years.length; a++) {
        for (let b = a; b < years.length; b++) {
          const ms = list.filter((g) => g.year >= years[a] && g.year <= years[b]);
          const ids = new Set(ms.map((m) => m.id));
          runs.push({
            f: fit(ms, cropColossi),
            a: years[a],
            b: years[b],
            hasColossi: colossusIds.every((id) => ids.has(id)),
            hasDefining: definingId !== null && ids.has(definingId),
          });
        }
      }
      return runs;
    };
    const allRuns = buildRuns(false);
    const pickMostGraves = (pool: typeof allRuns) => {
      let chosen: (typeof allRuns)[number] | null = null;
      for (const r of pool) {
        if (!chosen || r.f.ms.length > chosen.f.ms.length || (r.f.ms.length === chosen.f.ms.length && r.f.z > chosen.f.z)) {
          chosen = r;
        }
      }
      return chosen;
    };
    let cand: (typeof allRuns)[number] | null = null;
    if (colossusIds.length > 0) {
      // Sections with a lot-3 colossus must keep it in frame AND meet the 28 px floor: try whole colossus first,
      // then frame colossi by podium + medallion (allowing upper shaft to crop at the frame top) so zoom reaches ≥ 28 px.
      const withColossi = allRuns.filter((r) => r.hasColossi);
      cand =
        pickMostGraves(withColossi.filter((r) => r.f.z >= needTarget)) ??
        pickMostGraves(withColossi.filter((r) => r.f.z >= needFloor));
      if (!cand) {
        const croppedWithColossi = buildRuns(true).filter((r) => r.hasColossi);
        cand =
          pickMostGraves(croppedWithColossi.filter((r) => r.f.z >= needTarget)) ??
          pickMostGraves(croppedWithColossi.filter((r) => r.f.z >= needFloor));
        if (!cand && croppedWithColossi.length > 0) {
          const maxZ = Math.max(...croppedWithColossi.map((r) => r.f.z));
          cand = pickMostGraves(croppedWithColossi.filter((r) => r.f.z >= maxZ * 0.95));
        }
      }
    } else {
      const eligible = allRuns.filter((r) => r.f.z >= needTarget);
      if (eligible.length > 0) {
        const maxCount = Math.max(...eligible.map((r) => r.f.ms.length));
        const nearBestWithDefining = eligible.filter((r) => r.hasDefining && r.f.ms.length >= maxCount * 0.85);
        cand = pickMostGraves(nearBestWithDefining.length > 0 ? nearBestWithDefining : eligible);
      }
    }
    if (cand) {
      best = cand.f;
      span = [cand.a, cand.b];
    }
  }
  const s = Math.round(best.z * 1000) / 1000;
  const cx = (best.x0 + best.x1) / 2;
  const cy = (best.y0 + best.y1) / 2;
  // Target: the box centre at the middle of the visible band, below the zoom toolbar (frame px → user units).
  const tcx = viewport.frameWidth / 2 / scale;
  const tcy = (L.zoomBar + availH / 2 + L.zoomCentreOffset) / scale;
  const shown = best.ms.slice().sort((a, b) => a.laneIndex - b.laneIndex);
  return {
    cause,
    box: roundBox(best),
    zoom: s,
    facePx: round1(s * scale * faceUnits),
    // The transform scales about user (0, 0), not about the viewBox origin: the prototype's
    // `tcx − s·(cx − vbX)` was off by (s − 1)·(vbX, vbY) and framed the lighthouse for Regulatory at 1920×1080.
    translate: [round1(vbX + tcx - s * cx), round1(vbY + tcy - s * cy)],
    total: list.length,
    shown: shown.length,
    span,
    partial: shown.length < list.length,
    ids: shown.map((g) => g.id),
  };
}

export type PlotCapacityIssueKind =
  | "overlap"
  | "lane-overflow"
  | "block-overflow"
  | "lot-rows"
  | "lot-search"
  | "empty-run"
  | "face-floor"
  | "zoom-floor"
  | "perimeter-crossing"
  | "rock-clip"
  | "empty-year-disclosure"
  | "forecourt"
  | "ground-mark-off-lot"
  | "curb-overhang"
  | "zoom-drops-colossus"
  | "medallion-occluded";

export type PlotCapacityIssue = CapacityIssue<PlotCapacityIssueKind>;

/**
 * The kit's capacity report extended with live height-fit diagnostics:
 * - `facePx`: plain-stone face at the preset's reference column width (`1368 px` desktop content box, `390 px` portrait).
 * - `fittedFacePx`: plain-stone face at the live rendered frame (`desktopFittedFrameWidth(map, 1440, 800)` on desktop,
 *   where height-fit clamps at `floorWidth` until `floorWidth > 1368`; identical to `facePx` on portrait).
 * - `columnHeadroomPx`: remaining column width (`1368 − floorWidth`) before desktop trips the 15 px floor; `null` on portrait.
 */
export interface PlotCapacityReport extends CapacityReport<PlotCapacityIssueKind> {
  fittedFacePx: number;
  columnHeadroomPx: number | null;
}

type PlotCapacityCheck = (map: CemeteryPlotMap, eps: number) => PlotCapacityIssue[];

function cellsOverlap(a: PlotCell, b: PlotCell, eps: number): boolean {
  return a.i0 < b.i1 - eps && b.i0 < a.i1 - eps && a.j0 < b.j1 - eps && b.j0 < a.j1 - eps;
}

function checkFootprintOverlaps(map: CemeteryPlotMap, eps: number): PlotCapacityIssue[] {
  return footprintOverlaps(map.graves, (g) => g.cell, eps).map(([a, b]) => ({
    kind: "overlap",
    message: `${a.id} overlaps ${b.id}`,
  }));
}

function checkGraveBounds(map: CemeteryPlotMap, eps: number): PlotCapacityIssue[] {
  const issues: PlotCapacityIssue[] = [];
  const lane = Object.fromEntries(map.lanes.map((L) => [L.cause, L])) as Record<CauseOfDeath, PlotLane>;
  const block = new Map<number, PlotYearBlock>();
  for (const b of map.blocks) if (!b.empty) for (const y of b.years) block.set(y, b);
  const { site } = map;
  for (const g of map.graves) {
    const L = lane[g.cause];
    const B = block.get(g.year);
    const { cell } = g;
    const inLane =
      map.preset === "portrait" || g.lot === 1
        ? cell.j0 >= L.j0 - eps && cell.j1 <= L.j1 + eps
        : cell.j0 < L.j1 - eps && cell.j1 > L.j0 + eps;
    if (!inLane || cell.j0 < -eps || cell.j1 > site.jFront + eps) {
      issues.push({ kind: "lane-overflow", message: `${g.id} (${g.lot}×${g.lot}) leaves the ${L.label} lane or the site` });
    }
    if (!B || cell.i0 < B.i0 - eps || cell.i1 > B.i1 + eps) {
      issues.push({ kind: "block-overflow", message: `${g.id} leaves its ${g.year} block` });
    }
    if (g.lot > 1 && g.row > PLOT_LAYOUT.maxLotRow) {
      issues.push({ kind: "lot-rows", message: `${g.id} needed row ${g.row} (> ${PLOT_LAYOUT.maxLotRow}) of its ${g.year} block` });
    }
  }
  return issues;
}

function checkLotSearch(map: CemeteryPlotMap): PlotCapacityIssue[] {
  return map.blocks
    .filter((b) => b.greedyLots)
    .map((b) => ({ kind: "lot-search", message: `the ${b.label} block has too many ≥ $1B lots for the exhaustive search` }));
}

function checkEmptyRuns(map: CemeteryPlotMap): PlotCapacityIssue[] {
  const maxEmptyRows = PLOT_MAP_PRESETS[map.preset].maxEmptyBedRows;
  if (maxEmptyRows === null) return [];
  return map.emptyRuns
    .filter((r) => r.maxEmptyRowsInBed > maxEmptyRows)
    .map((r) => ({ kind: "empty-run", message: `${CAUSE_META[r.cause].label} bed has ${r.maxEmptyRowsInBed} empty rows (> ${maxEmptyRows})` }));
}

function checkLegibilityFloors(map: CemeteryPlotMap): PlotCapacityIssue[] {
  const issues: PlotCapacityIssue[] = [];
  if (map.preset === "portrait") {
    const facePx = faceFloorPx(PLOT_LAYOUT.plainFace, PLOT_LAYOUT.portraitReference.frameWidth, map.viewBox[2], PLOT_UNIT);
    if (facePx < PLOT_LAYOUT.portraitFaceFloorPx) {
      issues.push({
        kind: "face-floor",
        message: `plain stone ${facePx} px at ${PLOT_LAYOUT.portraitReference.viewportWidth} px portrait (< ${PLOT_LAYOUT.portraitFaceFloorPx})`,
      });
    }
    return issues;
  }
  const ref = PLOT_LAYOUT.reference;
  const facePx = faceFloorPx(PLOT_LAYOUT.plainFace, ref.frameWidth, map.viewBox[2], PLOT_UNIT);
  if (facePx < PLOT_LAYOUT.faceFloorPx) {
    const fittedWidth = desktopFittedFrameWidth(map, ref.viewportWidth, ref.viewportHeight);
    const fittedFacePx = faceFloorPx(PLOT_LAYOUT.plainFace, fittedWidth, map.viewBox[2], PLOT_UNIT);
    const headroomPx = ref.frameWidth - map.floorWidth;
    issues.push({
      kind: "face-floor",
      message: `plain stone ${fittedFacePx} px at ${ref.viewportWidth}×${ref.viewportHeight} (${Math.round(fittedWidth)} px fitted frame; column max ${facePx} px at ${ref.frameWidth} px, headroom ${headroomPx} px, floor ${PLOT_LAYOUT.faceFloorPx} px)`,
    });
  }
  for (const c of map.sectionCameras) {
    if (c.facePx < PLOT_LAYOUT.zoomFloorFacePx) {
      issues.push({ kind: "zoom-floor", message: `${CAUSE_META[c.cause].label} zoom reaches ${c.facePx} px (< ${PLOT_LAYOUT.zoomFloorFacePx})` });
    }
  }
  return issues;
}

/**
 * Ensures no wall, curb or railing run crosses any drawn object footprint (lighthouse rock, gate, signposts, graves),
 * and no site structure overlaps a grave lot.
 */
function checkPerimeterCrossings(map: CemeteryPlotMap, eps: number): PlotCapacityIssue[] {
  if (map.preset !== "desktop") return [];
  const issues: PlotCapacityIssue[] = [];
  const lh = map.lighthouse;
  const lhCell: PlotCell = { i0: lh.i - lh.apothem, i1: lh.i + lh.apothem, j0: lh.j - lh.apothem, j1: lh.j + lh.apothem };
  const rim = map.frame.iB - map.site.iEast;
  const gateCell: PlotCell = { i0: map.gate.i0, i1: map.gate.i1, j0: map.gate.j, j1: map.gate.j + rim };
  const structures: { key: string; cell: PlotCell }[] = [
    { key: "lighthouse", cell: lhCell },
    { key: "gate", cell: gateCell },
    ...map.signposts.map((s) => ({ key: `post:${s.cause}`, cell: { i0: s.i - 0.05, i1: s.i + 0.05, j0: s.j - 0.05, j1: s.j + 0.05 } })),
  ];
  const objects = [...structures, ...map.graves.map((g) => ({ key: `grave:${g.id}`, cell: g.cell }))];
  for (const seg of desktopPerimeterSegments(map)) {
    for (const obj of objects) {
      if (cellsOverlap(seg.cell, obj.cell, eps)) {
        issues.push({ kind: "perimeter-crossing", message: `${seg.key} crosses ${obj.key}` });
      }
    }
  }
  for (const structure of structures) {
    for (const g of map.graves) {
      if (cellsOverlap(structure.cell, g.cell, eps)) {
        issues.push({ kind: "perimeter-crossing", message: `${structure.key} overlaps grave:${g.id}` });
      }
    }
  }
  return issues;
}

/**
 * Ensures a below-grade lighthouse rock bastion sits outside the headland slab's east or north cutaway edge so its
 * subterranean faces never paint over the lawn or earth-e.
 */
function checkLighthouseHeadland(map: CemeteryPlotMap, eps: number): PlotCapacityIssue[] {
  if (map.preset !== "desktop") return [];
  const lh = map.lighthouse;
  if (lh.rockZ0 >= -eps) return [];
  const swI = lh.i - lh.apothem * (Math.SQRT2 - 1);
  const southJ = lh.j + lh.apothem;
  if (swI < map.frame.iB - eps && southJ > map.frame.jN + eps) {
    return [{
      kind: "rock-clip",
      message: `lighthouse rock (z0=${lh.rockZ0}) cuts inside the headland slab (swI=${round1(swI)} < iB=${map.frame.iB}, southJ=${round1(southJ)} > jN=${map.frame.jN})`,
    }];
  }
  return [];
}

/**
 * Ensures every empty calendar year in [firstYear, lastYear] is explicitly disclosed ("none recorded", unavailable ≠ 0)
 * in both its year block and, on desktop, its cypress entry.
 */
function checkEmptyYearDisclosure(map: CemeteryPlotMap): PlotCapacityIssue[] {
  const issues: PlotCapacityIssue[] = [];
  const occupied = new Set(map.graves.map((g) => g.year));
  const blockByYear = new Map<number, PlotYearBlock>();
  for (const b of map.blocks) {
    for (const y of b.years) {
      if (blockByYear.has(y)) issues.push({ kind: "empty-year-disclosure", message: `calendar year ${y} appears in more than one block` });
      blockByYear.set(y, b);
    }
  }
  for (let y = map.firstYear; y <= map.lastYear; y++) {
    const b = blockByYear.get(y);
    if (!b) {
      issues.push({ kind: "empty-year-disclosure", message: `calendar year ${y} is missing from map.blocks` });
      continue;
    }
    if (occupied.has(y)) continue;
    const disclosed = b.emptyYears.includes(y) && Boolean(b.sub && b.sub.includes("none recorded"));
    if (!disclosed) {
      issues.push({ kind: "empty-year-disclosure", message: `empty calendar year ${y} is not disclosed as "none recorded" on block ${b.key}` });
    }
    if (map.preset === "desktop") {
      const tree = map.cypress.find((c) => c.year === y);
      if (!tree || tree.count !== null || tree.height !== 0 || !tree.label.includes("none recorded")) {
        issues.push({ kind: "empty-year-disclosure", message: `empty calendar year ${y} cypress is missing or encodes zero instead of unavailable` });
      }
    }
  }
  return issues;
}

/** Ensures no grave occupies the east-facing stair forecourt of any lot-3 colossus on desktop. */
function checkForecourt(map: CemeteryPlotMap, eps: number): PlotCapacityIssue[] {
  if (map.preset !== "desktop") return [];
  const issues: PlotCapacityIssue[] = [];
  const yearPath = PLOT_MAP_PRESETS.desktop.yearPath;
  for (const col of map.graves) {
    if (col.lot !== 3) continue;
    const zone: PlotCell = { i0: col.cell.i1, i1: col.cell.i1 + yearPath + 0.5, j0: col.cell.j0, j1: col.cell.j1 };
    for (const g of map.graves) {
      if (g.id === col.id) continue;
      if (cellsOverlap(zone, g.cell, eps)) {
        issues.push({ kind: "forecourt", message: `${g.id} intrudes on the east stair forecourt of ${col.id}` });
      }
    }
  }
  return issues;
}

/** Ensures every grave's plinth (or colossus podium) sits strictly inside its lot (and lot pad for lot > 1). */
function checkCurbOverhang(map: CemeteryPlotMap, eps: number): PlotCapacityIssue[] {
  const issues: PlotCapacityIssue[] = [];
  const lane = Object.fromEntries(map.lanes.map((L) => [L.cause, L])) as Record<CauseOfDeath, PlotLane>;
  for (const g of map.graves) {
    const plinth = gravePlinthFootprint(g, map.projection);
    const support = g.lot > 1 ? lotPadCell(g.cell) : g.cell;
    if (plinth.i0 < support.i0 - eps || plinth.i1 > support.i1 + eps || plinth.j0 < support.j0 - eps || plinth.j1 > support.j1 + eps) {
      issues.push({ kind: "curb-overhang", message: `${g.id} plinth extends past its ${g.lot > 1 ? "lot pad" : "cell/bed"}` });
    }
    if (g.lot === 1) {
      const L = lane[g.cause];
      const bedCell = L.cells.find((c) => g.cell.i0 >= c.i0 - eps && g.cell.i1 <= c.i1 + eps);
      const bedJ0 = bedCell ? bedCell.j0 : L.j0;
      const bedJ1 = bedCell ? bedCell.j1 : L.j1;
      if (plinth.j0 < bedJ0 - eps || plinth.j1 > bedJ1 + eps) {
        issues.push({ kind: "curb-overhang", message: `${g.id} plinth overhangs its ${L.label} lane curb` });
      }
    }
  }
  return issues;
}

/** Ensures mounds, bronze plaques and footstones stay strictly inside their lot/pad and never cross a lane path or another bed. */
function checkGroundMarksOnLot(map: CemeteryPlotMap, eps: number): PlotCapacityIssue[] {
  const issues: PlotCapacityIssue[] = [];
  const lane = Object.fromEntries(map.lanes.map((L) => [L.cause, L])) as Record<CauseOfDeath, PlotLane>;
  const block = new Map<number, PlotYearBlock>();
  for (const b of map.blocks) if (!b.empty) for (const y of b.years) block.set(y, b);
  for (const g of map.graves) {
    const layout = graveGroundMarksLayout(g, map.projection);
    const support = g.lot > 1 ? lotPadCell(g.cell) : g.cell;
    const L = lane[g.cause];
    const B = block.get(g.year);
    const items: [string, PlotCell | null][] = [
      ["mound", layout.mound],
      ["bronze", layout.bronze],
      ["footstone", layout.footstone],
    ];
    for (const [kind, rect] of items) {
      if (!rect) continue;
      if (rect.i0 < support.i0 - eps || rect.i1 > support.i1 + eps || rect.j0 < support.j0 - eps || rect.j1 > support.j1 + eps) {
        issues.push({ kind: "ground-mark-off-lot", message: `${g.id} ${kind} leaves its ${g.lot > 1 ? "lot pad" : "lot"}` });
      }
      const bedCell = g.lot === 1 ? L.cells.find((c) => g.cell.i0 >= c.i0 - eps && g.cell.i1 <= c.i1 + eps) : undefined;
      const bedJ0 = bedCell ? bedCell.j0 : L.j0;
      const bedJ1 = bedCell ? bedCell.j1 : L.j1;
      if (g.lot === 1 && (rect.j0 < bedJ0 - eps || rect.j1 > bedJ1 + eps || !B || rect.i0 < B.i0 - eps || rect.i1 > B.i1 + eps)) {
        issues.push({ kind: "ground-mark-off-lot", message: `${g.id} ${kind} crosses a lane path or bed curb` });
      }
    }
    if (layout.bronze && layout.footstone && cellsOverlap(layout.bronze, layout.footstone, eps)) {
      issues.push({ kind: "ground-mark-off-lot", message: `${g.id} bronze plaque overlaps its footstone` });
    }
  }
  return issues;
}

/**
 * Ensures section zoom never drops a section's lot-3 colossus AND never drops below `PLOT_LAYOUT.zoomFloorFacePx`
 * (28 px) across standard desktop viewports, evaluated at the real floor-clamped rendered frame width.
 */
function checkZoomKeepsColossus(map: CemeteryPlotMap): PlotCapacityIssue[] {
  if (map.preset !== "desktop") return [];
  const issues: PlotCapacityIssue[] = [];
  for (const cause of CAUSE_ORDER) {
    const colossi = map.graves.filter((g) => g.cause === cause && g.lot === 3);
    if (!colossi.length) continue;
    const stored = map.sectionCameras.find((c) => c.cause === cause);
    if (stored) {
      for (const col of colossi) {
        if (!stored.ids.includes(col.id)) {
          issues.push({ kind: "zoom-drops-colossus", message: `${CAUSE_META[cause].label} section camera drops ${col.id}` });
        }
      }
      if (stored.facePx < PLOT_LAYOUT.zoomFloorFacePx) {
        issues.push({
          kind: "zoom-drops-colossus",
          message: `${CAUSE_META[cause].label} section camera drops to ${stored.facePx} px (< ${PLOT_LAYOUT.zoomFloorFacePx})`,
        });
      }
    }
    for (const [w, h] of PLOT_LAYOUT.zoomCheckViewports) {
      const frameWidth = desktopFittedFrameWidth(map, w, h);
      const cam = fitSectionCamera(map, cause, { frameWidth, viewportHeight: h });
      if (!cam) continue;
      for (const col of colossi) {
        if (!cam.ids.includes(col.id)) {
          issues.push({ kind: "zoom-drops-colossus", message: `${CAUSE_META[cause].label} zoom at ${w}×${h} drops ${col.id}` });
        }
      }
      if (cam.facePx < PLOT_LAYOUT.zoomFloorFacePx) {
        issues.push({
          kind: "zoom-drops-colossus",
          message: `${CAUSE_META[cause].label} zoom at ${w}×${h} (${Math.round(frameWidth)} px frame) reaches ${cam.facePx} px (< ${PLOT_LAYOUT.zoomFloorFacePx})`,
        });
      }
    }
  }
  return issues;
}

function pointInPolygon(px: number, py: number, poly: readonly PlotPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Deterministic 25-point concentric sample grid inside the unit disc (centre + 8 inner + 16 outer). */
const MEDALLION_SAMPLES: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [[0, 0]];
  for (const [radius, count] of [[0.42, 8], [0.82, 16]] as const) {
    for (let k = 0; k < count; k++) {
      const th = (k / count) * 2 * Math.PI;
      out.push([radius * Math.cos(th), radius * Math.sin(th)]);
    }
  }
  return out;
})();

/**
 * Ensures no grave's medallion disc is occluded beyond `PLOT_LAYOUT.maxMedallionOcclusion` by later-drawn grave solid
 * faces (measured deterministically on both desktop and portrait presets).
 */
function checkMedallionOcclusion(map: CemeteryPlotMap): PlotCapacityIssue[] {
  const proj = PLOT_PROJECTIONS[map.projection];
  const byKey = new Map(map.graves.map((g) => [`grave:${g.id}`, g]));
  const ordered = map.drawOrder.flatMap((key) => {
    const g = byKey.get(key);
    if (!g) return [];
    const geo = graveGeometry(proj, g);
    const polys = geo.body
      .filter((m): m is Extract<typeof m, { kind: "polygon" }> => m.kind === "polygon" && !m.cls.startsWith("hatch"))
      .map((m) => m.points);
    const box = bbox(polys.flat());
    return [{ g, medal: geo.medal, polys, box }];
  });
  const issues: PlotCapacityIssue[] = [];
  const limit = PLOT_LAYOUT.maxMedallionOcclusion;
  for (let i = 0; i < ordered.length; i++) {
    const { g, medal } = ordered[i];
    if (medal.r <= 0) continue;
    let covered = 0;
    for (const [dx, dy] of MEDALLION_SAMPLES) {
      const sx = medal.x + dx * medal.r;
      const sy = medal.y + dy * medal.r;
      for (let j = i + 1; j < ordered.length; j++) {
        const o = ordered[j];
        if (sx < o.box.x0 || sx > o.box.x1 || sy < o.box.y0 || sy > o.box.y1) continue;
        if (o.polys.some((poly) => pointInPolygon(sx, sy, poly))) {
          covered++;
          break;
        }
      }
    }
    const share = covered / MEDALLION_SAMPLES.length;
    if (share > limit + 1e-9) {
      issues.push({
        kind: "medallion-occluded",
        message: `${g.id} (${map.preset}) medallion ${Math.round(share * 100)}% occluded (> ${Math.round(limit * 100)}%)`,
      });
    }
  }
  return issues;
}

/** Ordered capacity/scene-lint checks. Adding a new issue kind is one check function appended here. */
const PLOT_CAPACITY_CHECKS: readonly PlotCapacityCheck[] = [
  checkFootprintOverlaps,
  checkGraveBounds,
  checkLotSearch,
  checkEmptyRuns,
  checkLegibilityFloors,
  checkPerimeterCrossings,
  checkLighthouseHeadland,
  checkEmptyYearDisclosure,
  checkForecourt,
  checkCurbOverhang,
  checkGroundMarksOnLot,
  checkZoomKeepsColossus,
  checkMedallionOcclusion,
];

/**
 * Checks the plan constants and scene invariants against the data: no two lots overlap; every 1×1 grave stays inside
 * its own lane and every lot inside its year block and the site; large lots start in rows 0…3; empty calendar years
 * stay explicitly disclosed; plain stones keep the 15 px floor on both desktop (1440×800) and portrait (390 px); and,
 * on the desktop, no in-bed empty run exceeds the preset's R11 budget (3 rows), no perimeter run crosses an object
 * footprint, the headland rock seats clear of the slab, and every section zoom reaches 28 px.
 */
export function validatePlotMapCapacity(map: CemeteryPlotMap): PlotCapacityReport {
  const eps = 1e-6;
  const issues: PlotCapacityIssue[] = [];
  for (const check of PLOT_CAPACITY_CHECKS) issues.push(...check(map, eps));
  if (map.preset === "portrait") {
    const facePx = faceFloorPx(PLOT_LAYOUT.plainFace, PLOT_LAYOUT.portraitReference.frameWidth, map.viewBox[2], PLOT_UNIT);
    return { ok: issues.length === 0, issues, facePx, fittedFacePx: facePx, columnHeadroomPx: null };
  }
  const ref = PLOT_LAYOUT.reference;
  const facePx = faceFloorPx(PLOT_LAYOUT.plainFace, ref.frameWidth, map.viewBox[2], PLOT_UNIT);
  const fittedWidth = desktopFittedFrameWidth(map, ref.viewportWidth, ref.viewportHeight);
  const fittedFacePx = faceFloorPx(PLOT_LAYOUT.plainFace, fittedWidth, map.viewBox[2], PLOT_UNIT);
  return {
    ok: issues.length === 0,
    issues,
    facePx,
    fittedFacePx,
    columnHeadroomPx: ref.frameWidth - map.floorWidth,
  };
}

// ---------------------------------------------------------------------------
// Placement helpers (runtime inputs are measured sizes; everything else is pure)
// ---------------------------------------------------------------------------

/** Rectangle in CSS px relative to the plan frame (or the viewport, where stated). */
export type PlotRect = SceneRect;

/** An SVG-unit box as frame px, for a frame showing `viewBox` at `scale` px per unit. */
export const plotBoxToFrameRect = boxToFrameRect;

/**
 * Hover tag (R6): the kit's `placeTag`, whose obstacles here are the signposts, figure, plaque, zoom button and
 * inspector.
 */
export const placePlotTag = placeTag;

/** Top-most drawn y (SVG units) at or left of `x`: how far the header may overlap the plan's empty sky. */
export function skyTopLeftOf(map: DesktopPlotMap, x: number): number {
  let top = Infinity;
  for (const [px, py] of map.skyline.prefixTop) {
    if (px > x) break;
    top = py;
  }
  return top;
}

/** The fixed Feedback button's bottom-right reserve (viewport px): the inspector stops above it when it reaches it. */
const FEEDBACK_CORNER = { width: 170, height: 84 } as const;

/**
 * Inspector docking (≥ 1280 px, fix I): the kit's `placeInspectorCard` below the sticky chrome
 * (`PLOT_LAYOUT.chromeTop`) and clear of the Feedback button. `avoid` lists volumes and text the card must not cover
 * (the colossi when another grave is read, the route head); `soft` lists labels (signpost plates, colossus chips,
 * year stamps) the card covers as few of as it can. Viewport px.
 */
export function placeInspectorCard(input: Omit<Parameters<typeof placeSceneInspectorCard>[0], "chromeTop" | "corner">): ReturnType<typeof placeSceneInspectorCard> {
  return placeSceneInspectorCard({ ...input, chromeTop: PLOT_LAYOUT.chromeTop, corner: FEEDBACK_CORNER });
}
