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
import {
  PLOT_ARCHETYPE_BY_CAUSE,
  PLOT_POST_HEIGHT,
  PLOT_PROJECTIONS,
  PLOT_UNIT,
  bbox,
  cypressGeometry,
  fnv1a,
  gateGeometry,
  graveGeometry,
  graveHitHull,
  lampGeometry,
  lighthouseGeometry,
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

// ---------------------------------------------------------------------------
// Input, presets, encodings
// ---------------------------------------------------------------------------

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
  /** Lawn and lighthouse bastion east of the oldest block (i). */
  eastTerrace: number;
  /** R11 budget: longest empty run of rows inside a bed; null = not budgeted (the portrait plan makes no R11 claim). */
  maxEmptyBedRows: number | null;
}

/**
 * Lane depths were chosen by the prototype's `tools/search-depths.mjs` (shared year blocks: the most compact plan
 * whose in-bed empty runs stay ≤ 3 rows at the 15 px floor). Re-check with {@link validatePlotMapCapacity} when a
 * year block grows.
 */
export const PLOT_MAP_PRESETS: Readonly<Record<PlotMapPresetName, PlotMapPreset>> = {
  desktop: {
    name: "desktop",
    projection: "dimetric",
    depth: { abandoned: 7, "counterparty-failure": 4, "liquidity-drain": 3, "algorithmic-failure": 3, regulatory: 1 },
    slotPitch: 0.92,
    rowPitch: 1.1,
    lanePath: 0.56,
    yearPath: 0.46,
    emptyYears: 0.72,
    avenue: 1.5,
    northTerrace: 0.95,
    southMargin: 0.5,
    eastTerrace: 2.0,
    maxEmptyBedRows: 3,
  },
  portrait: {
    name: "portrait",
    projection: "portrait",
    depth: { abandoned: 4, "counterparty-failure": 3, "liquidity-drain": 2, "algorithmic-failure": 2, regulatory: 1 },
    slotPitch: 1,
    rowPitch: 1,
    lanePath: 0.3,
    yearPath: 0.5,
    emptyYears: 0.7,
    avenue: 0,
    northTerrace: 0,
    southMargin: 0,
    eastTerrace: 0,
    maxEmptyBedRows: null,
  },
};

/** Fresh soil: died within 90 days of the latest recorded death (stated verbatim in the legend). */
export const PLOT_FRESH_DAYS = 90;
/** Weathering classes: upper bounds in years for w0…w3; w4 is everything older. */
export const PLOT_WEATHER_BOUNDS_YEARS: readonly number[] = [0.5, 1.5, 3, 5];
/** Plinth steps = clamp(floor(log10(peak)) − 6, 0, 4): one step at each of these peaks. */
export const PLOT_STEP_THRESHOLDS_USD: readonly number[] = [1e7, 1e8, 1e9, 1e10];
/** Stone height factor: clamped log scale (floor reached at $10^6.5, ceiling at ≈ $15B). */
export const PLOT_HEIGHT = { floor: 0.64, ceiling: 1.34, atLog10: 6.5, perDecade: 0.19 } as const;
/** Footstone glyphs for non-USD pegs (set in mono); any other non-USD peg gets ◇. */
export const PLOT_PEG_GLYPHS: Readonly<Record<string, string>> = { EUR: "€", JPY: "¥", CNH: "¥", VAR: "∿", OTHER: "◇" };

/** Desktop scene frame around the plan (world units). */
export const PLOT_SCENE = {
  /** Rim of the site wall outside the lawn. */
  rim: 0.3,
  /** Verge outside the front railing that carries the per-year cypress band. */
  verge: 1.2,
  /** Depth of the headland slab under the lawn. */
  slab: 0.9,
  /** Lighthouse centre: west of the east edge, south of the sea wall. */
  lighthouseInset: 1.0,
  lighthouseJ: 0.2,
  /** Signpost posts stand at this fraction of the avenue width. */
  postAt: 0.52,
} as const;

/** Viewport-level layout constants the hero, zoom and placement helpers share (CSS px unless stated). */
export const PLOT_LAYOUT = {
  /** R1 reference: 1440×800 with the real chrome; the frame follows the 1368 px content box. */
  reference: { viewportWidth: 1440, viewportHeight: 800, frameWidth: 1368 },
  /** Sticky chrome (105 px) + 8 px: the top of the visible band. */
  chromeTop: 113,
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
  /** R1 floor: plain stone ≥ 15 px at the reference viewport. */
  faceFloorPx: 15,
  /** Large lots may start in rows 0…3 of their block. */
  maxLotRow: 3,
  /** Large-lot position combinations searched exhaustively per block (2022's three lots: 20 × 16 × 28 = 8,960). */
  lotSearchBudget: 50_000,
} as const;

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
export function plotWeatherOf(years: number): PlotWeather {
  for (let k = 0; k < PLOT_WEATHER_BOUNDS_YEARS.length; k++) if (years < PLOT_WEATHER_BOUNDS_YEARS[k]) return k as PlotWeather;
  return 4;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

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
  /** Bed cells: one raised turf cell per year block inside the bed. */
  cells: { year: number; i0: number; i1: number }[];
  /** Grave ids, oldest first. */
  ids: string[];
}

export interface PlotYearBlock {
  /** "2026", or "2019-2020" for a strip standing in for years with no recorded death. */
  key: string;
  /** First (earliest) year of the block. */
  year: number;
  years: number[];
  empty: boolean;
  count: number;
  rows: number;
  i0: number;
  i1: number;
  /** "2026" or "2019–20". */
  label: string;
  /** Desktop stamp: "2026 · 30"; empty strip: "2019–20". */
  text: string;
  sub: string | null;
  /** Stamp anchor (desktop: under the headland's cut face; portrait: left grid edge, block middle). */
  stamp: PlotPoint;
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
  count: number;
  i: number;
  j: number;
  /** 0 for a year with no recorded death (bare planting bed). */
  height: number;
  foot: PlotPoint;
  top: PlotPoint;
  /** "2022 · 14 deaths". */
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
  /** World-group transform: `translate(tx, ty) scale(zoom)` in SVG units. */
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
  frame: { iA: number; iB: number; jN: number; jB: number; jVerge: number; slab: number };
  /** Canonical order (front lane first = left → right on screen). */
  signposts: PlotSignpost[];
  /** Ascending year; drawn east-first (descending i) so western trees overlap. */
  cypress: PlotCypress[];
  lamps: { year: number; i: number; j: number }[];
  gate: { i0: number; i1: number; j: number };
  lighthouse: { i: number; j: number; lantern: PlotPoint; top: PlotPoint };
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

export interface PortraitPlotMap extends PlotMapBase {
  preset: "portrait";
  /** Column heads, canonical order left → right; x0/x1 = the column's screen span on the top edge. */
  columns: { cause: CauseOfDeath; label: string; count: number; x0: number; x1: number }[];
}

export type CemeteryPlotMap = DesktopPlotMap | PortraitPlotMap;

export interface BuildCemeteryPlotMapOptions<P extends PlotMapPresetName = PlotMapPresetName> {
  /** Latest recorded `deathDate`; defaults to the latest in `entries` (the `buildCemeteryStats` rule). */
  asOf?: string;
  preset: P;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

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
}

/** A block's packing: large lots at fixed (row, slot) and the 1×1 placements that follow from them. */
interface LotPlan {
  rows: number;
  own: number;
  tie: number;
  lots: { g: Working; r: number; s: number }[];
  at: Map<string, { r: number; s: number }>;
}

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
    const seed = fnv1a(e.id);
    const lot: PlotLot = peakClass === 4 ? 3 : peakClass === 3 ? 2 : 1;
    const weather = plotWeatherOf(Math.max(0, (asOfT - t) / YEAR_MS));
    const rnd = seededStream(seed);
    const lean = weather === 4 && lot === 1 ? hundredths((rnd() < 0.5 ? -1 : 1) * (1.2 + 1.8 * rnd())) / 100 : 0;
    const archetype = PLOT_ARCHETYPE_BY_CAUSE[e.causeOfDeath];
    return {
      id: e.id,
      name: e.name,
      symbol: e.symbol,
      cause: e.causeOfDeath,
      deathDate: e.deathDate,
      year,
      t,
      rank: rank.get(e.id) as number,
      peak: peakClass === null ? null : (e.peakMcap as number),
      peakClass,
      unrecorded: peakClass === null,
      steps: peakClass,
      heightFactor: peakClass === null ? neutralHeight : hundredths(plotHeightFactorOf(e.peakMcap as number)) / 100,
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

  // ---- pack each calendar year: large lots at fixed (row, slot), then 1×1 graves row-major in their own lane.
  const years = [...new Set(graves.map((g) => g.year))].sort((a, b) => a - b);
  const firstYear = years[0];
  const lastYear = years[years.length - 1];
  // Slot −1 is a virtual slot on the cypress walk: only large lots may step onto it ("stand outside the beds").
  const northVirtual = preset.northTerrace >= preset.slotPitch * 0.9 ? 1 : 0;
  const blockRows = new Map<number, number>();
  const greedyYears = new Set<number>();
  for (const year of years) {
    const members = graves.filter((g) => g.year === year).sort(byRank);
    const large = members.filter((g) => g.lot > 1);
    const small = members.filter((g) => g.lot === 1);

    const fill = (lots: { g: Working; r: number; s: number }[]) => {
      const occ: boolean[][] = [];
      const free = (r: number, s: number) => !(occ[r] && occ[r][s + northVirtual]);
      const mark = (r: number, s: number, k: number) => {
        for (let a = 0; a < k; a++) {
          occ[r + a] = occ[r + a] || [];
          for (let b = 0; b < k; b++) occ[r + a][s + b + northVirtual] = true;
        }
      };
      for (const { g, r, s } of lots) {
        for (let a = 0; a < g.lot; a++) for (let b = 0; b < g.lot; b++) if (!free(r + a, s + b)) return null;
        mark(r, s, g.lot);
      }
      const at = new Map<string, { r: number; s: number }>();
      const cursor = Object.fromEntries(CAUSE_ORDER.map((c) => [c, { r: 0, s: 0 }])) as Record<CauseOfDeath, { r: number; s: number }>;
      for (const g of small) {
        const L = laneGeo[g.cause];
        const cur = cursor[g.cause];
        let r = cur.r;
        let s = cur.s;
        for (;;) {
          if (s >= L.depth) {
            r++;
            s = 0;
          }
          if (free(r, L.slot0 + s)) break;
          s++;
        }
        mark(r, L.slot0 + s, 1);
        at.set(g.id, { r, s: L.slot0 + s });
        cur.r = r;
        cur.s = s + 1;
      }
      return { rows: Math.max(1, occ.length), at };
    };

    // Minimise rows (plan length), then keep lots inside their own lane, then prefer early rows and the north.
    // Exhaustive over every clash-free combination while that stays within budget; beyond it (many ≥ $1B deaths
    // in one year) each lot, in chronological order, takes its best position given the lots before it.
    const search = (maxRow: number): { plan: LotPlan | null; greedy: boolean } => {
      const candidates = large.map((g) => {
        const L = laneGeo[g.cause];
        const out: { r: number; s: number; own: number }[] = [];
        for (let s = Math.max(northVirtual ? -1 : 0, L.slot0 - (g.lot - 1)); s <= Math.min(slots - g.lot, L.slot0 + L.depth - 1); s++) {
          const own = Math.min(s + g.lot, L.slot0 + L.depth) - Math.max(s, L.slot0);
          for (let r = 0; r <= maxRow; r++) out.push({ r, s, own });
        }
        return out;
      });
      const consider = (best: LotPlan | null, lots: LotPlan["lots"], own: number): LotPlan | null => {
        const res = fill(lots);
        if (!res) return best;
        const tie = lots.reduce((a, c) => a + c.r * 100 + (c.s + northVirtual), 0);
        if (!best || res.rows < best.rows || (res.rows === best.rows && (own > best.own || (own === best.own && tie < best.tie)))) {
          return { rows: res.rows, own, tie, lots, at: res.at };
        }
        return best;
      };
      const clashes = (lots: LotPlan["lots"], c: { r: number; s: number }, k: number) =>
        lots.some((o) => c.r < o.r + o.g.lot && o.r < c.r + k && c.s < o.s + o.g.lot && o.s < c.s + k);
      const combinations = candidates.reduce((a, c) => a * c.length, 1);
      if (combinations <= PLOT_LAYOUT.lotSearchBudget) {
        let best: LotPlan | null = null;
        const walk = (idx: number, chosen: LotPlan["lots"], own: number) => {
          if (idx === large.length) {
            best = consider(best, chosen, own);
            return;
          }
          for (const c of candidates[idx]) {
            if (!clashes(chosen, c, large[idx].lot)) walk(idx + 1, [...chosen, { g: large[idx], r: c.r, s: c.s }], own + c.own);
          }
        };
        walk(0, [], 0);
        return { plan: best, greedy: false };
      }
      let placed: LotPlan | null = { rows: 0, own: 0, tie: 0, lots: [], at: new Map() };
      for (let idx = 0; idx < large.length && placed; idx++) {
        const before: LotPlan = placed;
        let pick: LotPlan | null = null;
        for (const c of candidates[idx]) {
          if (!clashes(before.lots, c, large[idx].lot)) pick = consider(pick, [...before.lots, { g: large[idx], r: c.r, s: c.s }], before.own + c.own);
        }
        placed = pick;
      }
      return { plan: placed, greedy: true };
    };
    // Large lots start in rows 0…3; only a block that cannot fit them there searches deeper (flagged by
    // validatePlotMapCapacity as "lot-rows").
    let found = search(PLOT_LAYOUT.maxLotRow);
    for (let maxRow = PLOT_LAYOUT.maxLotRow + 1; !found.plan; maxRow++) found = search(maxRow);
    const chosen = found.plan;
    for (const { g, r, s } of chosen.lots) {
      const L = laneGeo[g.cause];
      g.row = r;
      g.slot = s;
      g.overhang = s < L.slot0 || s + g.lot > L.slot0 + L.depth;
    }
    for (const g of small) {
      const at = chosen.at.get(g.id)!;
      g.row = at.r;
      g.slot = at.s;
    }
    blockRows.set(year, chosen.rows);
    if (found.greedy) greedyYears.add(year);
  }

  // ---- year blocks along i, laid from the oldest (east, i = 0) toward the gate (west, negative i).
  const eastToWest: { years: number[]; empty: boolean; rows: number; i0: number; i1: number }[] = [];
  let iCursor = 0;
  for (let y = firstYear; y <= lastYear; y++) {
    const rows = blockRows.get(y);
    if (rows === undefined) {
      const prev = eastToWest[eastToWest.length - 1];
      if (prev && prev.empty) {
        prev.years.push(y);
        continue;
      }
      const i1 = iCursor;
      const i0 = i1 - hundredths(preset.emptyYears);
      eastToWest.push({ years: [y], empty: true, rows: 0, i0, i1 });
      iCursor = i0 - hundredths(preset.yearPath);
      continue;
    }
    const i1 = iCursor;
    const i0 = i1 - rows * RP;
    eastToWest.push({ years: [y], empty: false, rows, i0, i1 });
    iCursor = i0 - hundredths(preset.yearPath);
  }
  const westToEast = eastToWest.reverse();
  const iAvenue = westToEast[0].i0;
  const iWest = iAvenue - hundredths(preset.avenue);
  const iEast = hundredths(preset.eastTerrace);
  const blockOfYear = new Map(westToEast.filter((b) => !b.empty).map((b) => [b.years[0], b]));

  // ---- cells: row 0 (the block's oldest graves) at the block's east edge, so rows added for newer deaths grow
  // the block westward and never move an existing lot.
  for (const g of graves) {
    const B = blockOfYear.get(g.year)!;
    const i1 = B.i1 - g.row * RP;
    const i0 = i1 - g.lot * RP;
    const j0 = jOfSlot(g.slot);
    const j1 = jOfSlot(g.slot + g.lot - 1) + SP;
    g.cell = { i0: i0 / 100, i1: i1 / 100, j0: j0 / 100, j1: j1 / 100 };
    // The stone stands at the west third of its lot; the mound runs east toward the light.
    g.anchor = { i: (i0 + (g.lot === 1 ? 30 : g.lot === 2 ? 78 : 150)) / 100, j: Math.round((j0 + j1) / 2) / 100 };
  }

  const blocks: PlotYearBlock[] = westToEast.map((b) => {
    const ids = graves.filter((g) => !b.empty && g.year === b.years[0]).sort(byRank).map((g) => g.id);
    const lo = b.years[0];
    const hi = b.years[b.years.length - 1];
    const label = b.empty ? (lo === hi ? String(lo) : `${lo}–${String(hi).slice(2)}`) : String(lo);
    return {
      key: b.empty && lo !== hi ? `${lo}-${hi}` : String(lo),
      year: lo,
      years: [...b.years],
      empty: b.empty,
      count: ids.length,
      rows: b.rows,
      i0: b.i0 / 100,
      i1: b.i1 / 100,
      label,
      text: b.empty ? label : `${label} · ${ids.length}`,
      sub: b.empty ? "none recorded" : null,
      stamp: [0, 0],
      span: { y0: 0, y1: 0 },
      ids,
      greedyLots: !b.empty && greedyYears.has(lo),
    };
  });

  const lanes: PlotLane[] = CAUSE_ORDER.map((cause) => {
    const L = laneGeo[cause];
    const mine = laneMembers[cause];
    const bed = mine.length ? { i0: Math.min(...mine.map((g) => g.cell.i0)), i1: Math.max(...mine.map((g) => g.cell.i1)) } : null;
    return {
      cause,
      label: CAUSE_META[cause].label,
      hex: CAUSE_HEX[cause],
      hexDark: CAUSE_HEX_DARK[cause],
      depth: L.depth,
      slot0: L.slot0,
      j0: L.j0 / 100,
      j1: L.j1 / 100,
      count: mine.length,
      bed,
      cells: bed
        ? blocks.filter((b) => !b.empty && !(b.i1 <= bed.i0 + 1e-6 || b.i0 >= bed.i1 - 1e-6)).map((b) => ({ year: b.year, i0: b.i0, i1: b.i1 }))
        : [],
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

  // ---- screen geometry of every grave
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
      plaque: `${total} interred · first recorded death ${firstYear}`,
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
    return graves.map(({ t: _t, rank: _rank, ...g }) => ({ ...g, draw: drawIndex.get(`grave:${g.id}`) as number }));
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
  // Phones: no lighthouse or sea block, only a thin sea-wall strip above the newest block.
  const top = site.iAvenue - 0.3;
  const I = site.iOldest;
  const J = site.jSouth;
  const ext: PlotPoint[] = [project(proj, top - 0.55, -0.35, 0), project(proj, I + 0.35, J + 0.35, -0.6), project(proj, I + 0.35, -0.35, -0.6), project(proj, top - 0.55, J + 0.35, 0)];
  for (const g of graves) ext.push(...geo.get(g.id)!.pts);
  const eb = bbox(ext);
  const viewBox: [number, number, number, number] = [round1(eb.x0 - 2), round1(eb.y0 - 2), round1(eb.x1 - eb.x0 + 4), round1(eb.y1 - eb.y0 + 4)];
  // Back to front: higher on the page (smaller i) first; ties by j descending (south faces show on the left).
  const order = graves
    .slice()
    .sort((a, b) => Math.round((a.cell.i0 - b.cell.i0) * 100) || Math.round((b.cell.j0 - a.cell.j0) * 100))
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
  const gate = { i0: w2(W + 0.12), i1: w2(W + AV - 0.12), j: J };
  addObject("gate", { i0: gate.i0, i1: gate.i1, j0: J, j1: J + 0.34 }, gateGeometry(proj, gate.i0, gate.i1, J).pts);
  const LH = { i: w2(I - PLOT_SCENE.lighthouseInset), j: PLOT_SCENE.lighthouseJ };
  const lh = lighthouseGeometry(proj, LH.i, LH.j);
  addObject("lighthouse", { i0: LH.i - 1.18, i1: LH.i + 1.18, j0: LH.j - 1.18, j1: LH.j + 1.18 }, lh.pts);
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
    const n = countByYear.get(y) ?? 0;
    const B = blocks.find((b) => b.years.includes(y))!;
    // In a multi-year strip, years run newest (west) → oldest (east) like the blocks.
    const k = B.years.length - 1 - B.years.indexOf(y);
    const i = hundredths(B.years.length > 1 ? B.i0 + ((k + 0.5) / B.years.length) * (B.i1 - B.i0) : (B.i0 + B.i1) / 2) / 100;
    const height = n ? hundredths(0.35 + (1.05 * n) / maxYear) / 100 : 0;
    const tree = cypressGeometry(proj, i, frame.jVerge, height);
    cypress.push({ year: y, count: n, i, j: frame.jVerge, height, foot: roundPoint(P(i, frame.jVerge, 0)), top: roundPoint(tree.top), label: `${y} · ${n} ${n === 1 ? "death" : "deaths"}` });
  }

  for (const b of blocks) b.stamp = roundPoint(P((b.i0 + b.i1) / 2, frame.jB, -slab));

  // Extents: tight crop from the gate corner to the lighthouse rock, UST top to the slab bottom.
  const { iA, iB, jN, jB } = frame;
  const ext: PlotPoint[] = [P(iA, jB, -slab), P(iB, jB, -slab), P(iB, jN, 0.5), P(iA, jN, 0.5), P(iA, jB, 0.5)];
  for (const o of objs) ext.push(...o.pts);
  for (const c of cypress) ext.push(cypressGeometry(proj, c.i, c.j, c.height).top);
  const eb = bbox(ext);
  const pad = 6;
  const viewBox: [number, number, number, number] = [round1(eb.x0 - pad), round1(eb.y0 - pad * 2.2), round1(eb.x1 - eb.x0 + 2 * pad), round1(eb.y1 - eb.y0 + pad * 6)];

  // Skyline: the wall crest (west and north) plus every drawn point; `edges` keeps only what `obstacles` misses.
  const crest: PlotPoint[] = [];
  for (let q = 0; q <= 60; q++) crest.push(P(iA, jB - (q / 60) * (jB - jN), 0.5));
  for (let q = 0; q <= 80; q++) crest.push(P(iA + (q / 80) * (iB - iA), jN, 0.5));
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
    viewBox,
    graves: finalGraves(drawOrder),
    drawOrder,
    frame,
    signposts,
    cypress,
    lamps,
    gate,
    lighthouse: { i: LH.i, j: LH.j, lantern: roundPoint(lh.lantern), top: roundPoint(lh.top) },
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

// ---------------------------------------------------------------------------
// Section zoom
// ---------------------------------------------------------------------------

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
  const needZ = L.zoomTargetFacePx / (faceUnits * scale);
  const years = [...new Set(list.map((g) => g.year))].sort((a, b) => a - b);
  const fit = (ms: PlotGrave[]): CameraFit => {
    const x0 = Math.min(...ms.map((m) => m.screen.box.x0));
    const x1 = Math.max(...ms.map((m) => m.screen.box.x1));
    const y0 = Math.min(...ms.map((m) => m.screen.box.y0));
    const y1 = Math.max(...ms.map((m) => m.screen.box.y1));
    return { x0, x1, y0, y1, z: Math.min(availW / ((x1 - x0) * scale), availH / ((y1 - y0) * scale), L.zoomMaxScale), ms };
  };
  let best = fit(list);
  let span: [number, number] = [years[0], years[years.length - 1]];
  if (best.z < needZ) {
    let cand: { f: CameraFit; a: number; b: number } | null = null;
    for (let a = 0; a < years.length; a++) {
      for (let b = a; b < years.length; b++) {
        const f = fit(list.filter((g) => g.year >= years[a] && g.year <= years[b]));
        if (f.z >= needZ && (!cand || f.ms.length > cand.f.ms.length || (f.ms.length === cand.f.ms.length && f.z > cand.f.z))) cand = { f, a: years[a], b: years[b] };
      }
    }
    if (cand) {
      best = cand.f;
      span = [cand.a, cand.b];
    }
  }
  const s = best.z;
  const cx = (best.x0 + best.x1) / 2;
  const cy = (best.y0 + best.y1) / 2;
  const tcx = viewport.frameWidth / 2 / scale;
  const tcy = (L.zoomBar + availH / 2 + L.zoomCentreOffset) / scale;
  const shown = best.ms.slice().sort((a, b) => a.laneIndex - b.laneIndex);
  return {
    cause,
    box: roundBox(best),
    zoom: Math.round(s * 1000) / 1000,
    facePx: round1(s * scale * faceUnits),
    translate: [round1(tcx - s * (cx - vbX)), round1(tcy - s * (cy - vbY))],
    total: list.length,
    shown: shown.length,
    span,
    partial: shown.length < list.length,
    ids: shown.map((g) => g.id),
  };
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export type PlotCapacityIssueKind = "overlap" | "lane-overflow" | "block-overflow" | "lot-rows" | "lot-search" | "empty-run" | "face-floor" | "zoom-floor";

export interface PlotCapacityIssue {
  kind: PlotCapacityIssueKind;
  message: string;
}

export interface PlotCapacityReport {
  ok: boolean;
  issues: PlotCapacityIssue[];
  /** Plain-stone face at the R1 reference viewport (desktop only). */
  facePx: number | null;
}

/**
 * Checks the plan constants against the data: no two lots overlap; every 1×1 grave stays inside its own lane
 * and every lot inside its year block and the site; large lots start in rows 0…3; and, on the desktop, no in-bed
 * empty run longer than the preset's R11 budget (3 rows), the plain stone keeps the 15 px floor at 1440×800 and
 * every section zoom reaches 28 px. A failing report means data growth needs a re-tune of the depths or pitches.
 */
export function validatePlotMapCapacity(map: CemeteryPlotMap): PlotCapacityReport {
  const issues: PlotCapacityIssue[] = [];
  const eps = 1e-6;
  const lane = Object.fromEntries(map.lanes.map((L) => [L.cause, L])) as Record<CauseOfDeath, PlotLane>;
  const block = new Map(map.blocks.filter((b) => !b.empty).map((b) => [b.year, b]));
  const { site } = map;
  for (let a = 0; a < map.graves.length; a++) {
    const A = map.graves[a].cell;
    for (let b = a + 1; b < map.graves.length; b++) {
      const B = map.graves[b].cell;
      if (A.i0 < B.i1 - eps && B.i0 < A.i1 - eps && A.j0 < B.j1 - eps && B.j0 < A.j1 - eps) {
        issues.push({ kind: "overlap", message: `${map.graves[a].id} overlaps ${map.graves[b].id}` });
      }
    }
  }
  for (const g of map.graves) {
    const L = lane[g.cause];
    const B = block.get(g.year)!;
    const { cell } = g;
    const inLane = g.lot === 1 ? cell.j0 >= L.j0 - eps && cell.j1 <= L.j1 + eps : cell.j0 < L.j1 - eps && cell.j1 > L.j0 + eps;
    if (!inLane || cell.j0 < -eps || cell.j1 > site.jFront + eps) {
      issues.push({ kind: "lane-overflow", message: `${g.id} (${g.lot}×${g.lot}) leaves the ${L.label} lane or the site` });
    }
    if (cell.i0 < B.i0 - eps || cell.i1 > B.i1 + eps) issues.push({ kind: "block-overflow", message: `${g.id} leaves its ${g.year} block` });
    if (g.lot > 1 && g.row > PLOT_LAYOUT.maxLotRow) issues.push({ kind: "lot-rows", message: `${g.id} needed row ${g.row} (> ${PLOT_LAYOUT.maxLotRow}) of its ${g.year} block` });
  }
  for (const b of map.blocks) {
    if (b.greedyLots) issues.push({ kind: "lot-search", message: `the ${b.year} block has too many ≥ $1B lots for the exhaustive search` });
  }
  const maxEmptyRows = PLOT_MAP_PRESETS[map.preset].maxEmptyBedRows;
  for (const r of map.emptyRuns) {
    if (maxEmptyRows !== null && r.maxEmptyRowsInBed > maxEmptyRows) {
      issues.push({ kind: "empty-run", message: `${CAUSE_META[r.cause].label} bed has ${r.maxEmptyRowsInBed} empty rows (> ${maxEmptyRows})` });
    }
  }
  let facePx: number | null = null;
  if (map.preset === "desktop") {
    facePx = round1((PLOT_LAYOUT.plainFace * PLOT_UNIT * PLOT_LAYOUT.reference.frameWidth) / map.viewBox[2]);
    if (facePx < PLOT_LAYOUT.faceFloorPx) issues.push({ kind: "face-floor", message: `plain stone ${facePx} px at 1440×800 (< ${PLOT_LAYOUT.faceFloorPx})` });
    for (const c of map.sectionCameras) {
      if (c.facePx < PLOT_LAYOUT.zoomFloorFacePx) issues.push({ kind: "zoom-floor", message: `${CAUSE_META[c.cause].label} zoom reaches ${c.facePx} px (< ${PLOT_LAYOUT.zoomFloorFacePx})` });
    }
  }
  return { ok: issues.length === 0, issues, facePx };
}

// ---------------------------------------------------------------------------
// Placement helpers (runtime inputs are measured sizes; everything else is pure)
// ---------------------------------------------------------------------------

/** Rectangle in CSS px relative to the plan frame (or the viewport, where stated). */
export interface PlotRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const rectsHit = (a: PlotRect, b: PlotRect, m: number) => a.left < b.right + m && a.right > b.left - m && a.top < b.bottom + m && a.bottom > b.top - m;

/** An SVG-unit box as frame px, for a frame showing `viewBox` at `scale` px per unit. */
export function plotBoxToFrameRect(box: PlotBox, viewBox: readonly number[], scale: number): PlotRect {
  return { left: (box.x0 - viewBox[0]) * scale, top: (box.y0 - viewBox[1]) * scale, right: (box.x1 - viewBox[0]) * scale, bottom: (box.y1 - viewBox[1]) * scale };
}

/**
 * Hover tag (R6): tries above, above-right, above-left, right, left, below the stone and takes the first
 * position clear of every obstacle (signposts, figure, plaque, zoom button, inspector; padded 3 px) inside the
 * frame, else the one with the fewest hits. `collisions` is −1 when no candidate fits the frame.
 */
export function placePlotTag(input: { stone: PlotRect; tag: { width: number; height: number }; frame: { width: number; height: number }; obstacles: readonly PlotRect[] }): {
  x: number;
  y: number;
  collisions: number;
} {
  const { stone, tag, frame } = input;
  const tw = tag.width;
  const th = tag.height;
  const cx = (stone.left + stone.right) / 2;
  const midY = (stone.top + stone.bottom) / 2;
  const cands: PlotPoint[] = [
    [cx - tw / 2, stone.top - th - 6],
    [stone.right + 4, stone.top - th + 4],
    [stone.left - tw - 4, stone.top - th + 4],
    [stone.right + 6, midY - th / 2],
    [stone.left - tw - 6, midY - th / 2],
    [cx - tw / 2, stone.bottom + 6],
  ];
  const obstacles = input.obstacles.map((o) => ({ x0: o.left - 3, y0: o.top - 3, x1: o.right + 3, y1: o.bottom + 3 }));
  let chosen = cands[0];
  let bestHits = Infinity;
  for (const [x, y] of cands) {
    if (x < 0 || y < 0 || x + tw > frame.width || y + th > frame.height) continue;
    const hits = obstacles.filter((o) => x < o.x1 && x + tw > o.x0 && y < o.y1 && y + th > o.y0).length;
    if (hits < bestHits) {
      bestHits = hits;
      chosen = [x, y];
      if (!hits) break;
    }
  }
  return { x: chosen[0], y: chosen[1], collisions: bestHits === Infinity ? -1 : bestHits };
}

export interface PlotChipPlacement {
  id: string;
  x: number;
  y: number;
  /** Hairline leader from the chip edge to just above the monument top. */
  leader: { x1: number; y1: number; x2: number; y2: number };
  placement: "clear" | "fallback";
}

/**
 * Colossus chips (fix D): each chip goes to the first candidate (stacked above the monument top, then beside it)
 * that stays inside the frame, clear of text (`taken`, 4 px), of drawn volumes (`volumes`, 2 px), and whose leader
 * crosses no text. Chips are placed in order and each placed chip joins `taken`. All rects in frame px.
 */
export function placeColossusChips(input: {
  chips: readonly { id: string; top: PlotPoint; width: number; height: number }[];
  frameWidth: number;
  taken: readonly PlotRect[];
  volumes: readonly PlotRect[];
}): PlotChipPlacement[] {
  const taken = [...input.taken];
  const out: PlotChipPlacement[] = [];
  for (const chip of input.chips) {
    const [tx, ty] = chip.top;
    const w = chip.width;
    const h = chip.height;
    const cands: PlotPoint[] = [];
    for (const dy of [-26, -46, -66, -86, -106]) for (const dx of [-w / 2, -w + 24, -24, -w / 2 - 70, -w / 2 + 70]) cands.push([tx + dx, ty + dy - h]);
    for (const dy of [0, 30, -30, 60]) cands.push([tx + 26, ty + dy - h / 2], [tx - 26 - w, ty + dy - h / 2]);
    let best: { x: number; y: number; lx: number; ly: number } | null = null;
    for (const [x, y] of cands) {
      if (x < 2 || x + w > input.frameWidth - 2 || y < -120) continue;
      const r = { left: x, top: y, right: x + w, bottom: y + h };
      if (taken.some((t) => rectsHit(r, t, 4))) continue;
      if (input.volumes.some((v) => rectsHit(r, v, 2))) continue;
      const lx = Math.min(Math.max(tx, x + 10), x + w - 10);
      const ly = y + h <= ty ? y + h : y + h / 2;
      const lr = { left: Math.min(lx, tx), right: Math.max(lx, tx), top: Math.min(ly, ty), bottom: Math.max(ly, ty) };
      if (taken.some((t) => rectsHit(lr, t, 1))) continue;
      best = { x, y, lx, ly };
      break;
    }
    const placement = best ? "clear" : "fallback";
    const at = best ?? { x: Math.max(2, tx - w / 2), y: ty - 26 - h, lx: tx, ly: ty - 26 };
    out.push({ id: chip.id, x: at.x, y: at.y, leader: { x1: at.lx, y1: at.ly, x2: tx, y2: ty - 2 }, placement });
    taken.push({ left: at.x, top: at.y, right: at.x + w, bottom: at.y + h });
  }
  return out;
}

/**
 * One Beam figure: searches the sky left of the lantern, bottom-up from the lantern's height, for the first spot
 * clear of every drawn volume, HTML plate and wall crest point (6 px pad), outside the route head. All inputs in
 * SVG units except `scale` (px per unit). Returns the figure's right-middle anchor, or null (caller falls back to
 * 60 units left of the lantern).
 */
export function placeBeamFigure(input: {
  map: DesktopPlotMap;
  figure: { width: number; height: number };
  scale: number;
  plates: readonly PlotBox[];
  /** Route-head keep-out (SVG units), margins included. */
  head: { right: number; bottom: number };
}): PlotPoint | null {
  const { map, figure, scale, plates, head } = input;
  const [vbX, vbY] = map.viewBox;
  const [lx, ly] = map.beamOrigin;
  const fw = figure.width;
  const fh = figure.height;
  const pad = 6 / scale;
  const boxClear = (b: PlotBox, x0: number, y0: number, x1: number, y1: number) => !(b.x0 < x1 + pad && b.x1 > x0 - pad && b.y0 < y1 + pad && b.y1 > y0 - pad);
  const clear = (x0: number, y0: number, x1: number, y1: number) =>
    map.obstacles.every((o) => boxClear(o, x0, y0, x1, y1)) &&
    plates.every((o) => boxClear(o, x0, y0, x1, y1)) &&
    !map.skyline.edges.some(([sx, sy]) => sx > x0 - pad && sx < x1 + pad && sy > y0 - pad && sy < y1 + pad);
  for (let ay = ly + 10; ay >= vbY - 150 / scale + fh / 2; ay -= 3) {
    for (let ax = lx - 22; ax >= lx - 700; ax -= 4) {
      if (ax - fw < vbX + 4) break;
      if (ax - fw < head.right && ay - fh / 2 < head.bottom) break;
      if (clear(ax - fw, ay - fh / 2, ax, ay + fh / 2)) return [ax, ay];
    }
  }
  return null;
}

/** Top-most drawn y (SVG units) at or left of `x`: how far the header may overlap the plan's empty sky. */
export function skyTopLeftOf(map: DesktopPlotMap, x: number): number {
  let top = Infinity;
  for (const [px, py] of map.skyline.prefixTop) {
    if (px > x) break;
    top = py;
  }
  return top;
}

/**
 * Inspector docking (≥ 1280 px, fix I): beside the grave on the side with room, inside the visible band below the
 * sticky chrome, clear of the Feedback button, joined to the medallion by a hairline connector. Viewport px.
 */
export function placeInspectorCard(input: {
  stone: PlotRect;
  frame: PlotRect;
  medal: PlotPoint;
  card: { width: number; height: number };
  viewport: { width: number; height: number };
}): { x: number; y: number; maxHeight: number; connector: { x1: number; y1: number; x2: number; y2: number } } {
  const { stone, frame, medal, card, viewport } = input;
  const w = card.width;
  const topMin = PLOT_LAYOUT.chromeTop;
  const feedbackTop = viewport.height - 84;
  const roomR = frame.right - stone.right;
  const roomL = stone.left - frame.left;
  const x = roomR >= w + 36 && (roomR >= roomL || roomL < w + 36) ? stone.right + 28 : Math.max(frame.left + 4, stone.left - 28 - w);
  const bottomMax = x + w > viewport.width - 170 ? feedbackTop : viewport.height - 8;
  const h = Math.min(card.height, bottomMax - topMin);
  const y = Math.min(Math.max((stone.top + stone.bottom) / 2 - h / 2, topMin), bottomMax - h);
  const ex = x > medal[0] ? x : x + w;
  const ey = Math.min(Math.max(medal[1], y + 14), y + h - 14);
  return { x, y, maxHeight: h, connector: { x1: medal[0], y1: medal[1], x2: ex, y2: ey } };
}
