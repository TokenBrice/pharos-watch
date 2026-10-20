/**
 * Harbor 2.0 geometry: turns a {@link HarborScene} into scene-kit marks for the light isometric harbor.
 *
 * Ships moor side by side like piano keys, every bow on one quay line (i = 0), so hull length is read on a common
 * baseline; the largest ship lies furthest north. Containers sit one tier high in bays of 10 with a gap between
 * bays (wide: 5 along × 2 across; narrow: 2 along × 5 across so a container top stays ≥ 5 px on a phone). Lengths
 * along the hull are linear in supply; the fractional last container is drawn at `drawLength` (sliver floor).
 *
 * Pure and deterministic: same scene → byte-identical marks. Marks carry class tokens only; colour lives in CSS
 * (`src/components/harbor/harbor.module.css`) or in the OG paint resolver.
 */
import { lighthouseGeometry, type LighthouseGeometry } from "./scene/objects/lighthouse";
import { worldPolygon, type SceneMark } from "./scene/marks";
import { bbox, hull, project, round1, round3, SCENE_DIMETRIC, SCENE_UNIT, type SceneBox, type ScenePoint, type SceneProjection } from "./scene/projection";
import { boxMarks, boxPoints, faceMatrixG } from "./scene/solids";
import {
  CONTAINERS_PER_BAY,
  MAX_BAYS_PER_TIER,
  WAKE_HUE_PCT,
  type HarborCargoKind,
  type HarborContainer,
  type HarborFlag,
  type HarborScene,
  type HarborVessel,
  type HarborWake,
} from "./harbor-scene";

export type HarborPreset = "wide" | "narrow";

const S = SCENE_UNIT;
const HARBOR_PROJECTIONS: Readonly<Record<HarborPreset, SceneProjection>> = {
  wide: SCENE_DIMETRIC,
  // Plan view for phones: hulls run left → right, berths stack down the page, a small shear shows the south faces.
  narrow: { name: "harbor-portrait", A: [S, 0], B: [S * 0.04, S * 0.55], C: [0, -S * 0.55], shadow: [-0.3, 0.3] },
};

interface HarborLayout {
  /** Container length along the hull and width across it (world units). */
  L: number;
  W: number;
  /** Containers along the hull per bay column-run; the rest stack across the beam. */
  along: number;
  gap: number;
  bayGap: number;
  bowPad: number;
  sternPad: number;
  beamPad: number;
  /** World j between berth rows (water between hulls). */
  rowGap: number;
  /** Craft per row (two rows per jetty) and their stride along i. */
  craftStride: number;
  craftPerRow: number;
  wakeMax: number;
  /** Display floors the capacity check enforces (top-face px at the reference frame width). */
  faceFloorPx: number;
  referenceFramePx: number;
  heightBudgetPx: number;
}

const ACROSS = (layout: HarborLayout) => CONTAINERS_PER_BAY / layout.along;

export const HARBOR_LAYOUTS: Readonly<Record<HarborPreset, HarborLayout>> = {
  wide: {
    L: 0.5, W: 0.42, along: 5, gap: 0.04, bayGap: 0.24, bowPad: 0.55, sternPad: 0.3, beamPad: 0.12, rowGap: 0.85,
    craftStride: 1.7, craftPerRow: 12, wakeMax: 4, faceFloorPx: 6, referenceFramePx: 1360, heightBudgetPx: 900,
  },
  narrow: {
    L: 0.5, W: 0.76, along: 2, gap: 0.04, bayGap: 0.22, bowPad: 0.45, sternPad: 0.25, beamPad: 0.1, rowGap: 2.7,
    craftStride: 1.5, craftPerRow: 10, wakeMax: 3, faceFloorPx: 5, referenceFramePx: 358, heightBudgetPx: 1600,
  },
};

/** Container deck height, container height and quay height (world z). */
const DECK_Z = 0.3;
const KEEL_Z = -0.12;
const BOX_H = 0.34;
const QUAY_Z = 0.5;
const MAST_I = -0.4;
const MAST_H = 1.5;
/** Quay-side label anchor (text ends here, west of the mast). */
const LABEL_I = -2.8;
const JETTY_W = 0.24;
const JETTY_GAP = 0.6;

const CARGO_CLASS: Record<HarborCargoKind, string> = {
  usdt: "cg-usdt",
  usdc: "cg-usdc",
  other: "cg-other",
  pool: "cg-pool",
  unattributed: "cg-unattr",
};

export interface HarborBerthGeometry {
  id: string;
  kind: HarborVessel["kind"];
  /** Hull, containers (deck tier first), stern cap, in paint order. */
  marks: SceneMark[];
  /** Signal flag (mast, flag, pennants) or NR plate; painted after the hull. */
  flag: SceneMark[];
  /** Wake chevrons astern (ships only). */
  wake: SceneMark[];
  /** Selection ring on the water around the hull. */
  ring: ScenePoint[];
  /** Hit polygon (screen hull of hull + cargo + flag). */
  hit: ScenePoint[];
  /** Quay-side label anchor (wide: text ends here; narrow: text starts here, above the bow). */
  label: ScenePoint;
  /** Above the tallest point near the stern: tag / card anchor. */
  tag: ScenePoint;
  /** Deck centre: where the lighthouse beam lands. */
  beamTarget: ScenePoint;
  /** Wake end (for the % label), or null when no wake is drawn. */
  wakeEnd: ScenePoint | null;
  /** World footprint (capacity overlap check). */
  footprint: { i0: number; i1: number; j0: number; j1: number };
  containerCount: number;
}

export interface HarborGeometry {
  preset: HarborPreset;
  viewBox: SceneBox;
  /** Water, quay, jetty and breakwater, in paint order. */
  ground: SceneMark[];
  berths: HarborBerthGeometry[];
  lighthouse: LighthouseGeometry;
  /** Quay-side anchor for the jetty's row label (craft are labelled by tag only). */
  jettyLabel: ScenePoint | null;
  /** Container top-face size in world units (capacity check). */
  containerFace: { L: number; W: number };
}

/** Slot → world offset from the bow/beam origin. */
function slotOffset(layout: HarborLayout, position: number): { di: number; dj: number } {
  const across = ACROSS(layout);
  const bay = Math.floor(position / CONTAINERS_PER_BAY);
  const q = position % CONTAINERS_PER_BAY;
  const column = Math.floor(q / across);
  const row = q % across;
  const bayLen = layout.along * (layout.L + layout.gap) - layout.gap + layout.bayGap;
  return { di: layout.bowPad + bay * bayLen + column * (layout.L + layout.gap), dj: layout.beamPad + row * (layout.W + layout.gap) };
}

function hullLength(layout: HarborLayout, containers: readonly HarborContainer[]): number {
  let end = layout.bowPad;
  for (const c of containers) {
    if (c.tier !== 0) continue;
    end = Math.max(end, slotOffset(layout, c.position).di + c.drawLength * layout.L);
  }
  return end + layout.sternPad;
}

function containerMarks(p: SceneProjection, layout: HarborLayout, i0: number, j0: number, c: HarborContainer): SceneMark[] {
  const { di, dj } = slotOffset(layout, c.position);
  const z0 = DECK_Z + c.tier * BOX_H;
  const scale = c.length > 0 ? c.drawLength / c.length : 1;
  const out: SceneMark[] = [];
  for (const band of c.bands) {
    const from = band.from * scale * layout.L;
    const to = band.to * scale * layout.L;
    out.push(...boxMarks(p, i0 + di + from, j0 + dj, z0, to - from, layout.W, BOX_H, CARGO_CLASS[band.kind]));
    // Unattributed supply is "not assigned", drawn with the kit hatch over a plain plate.
    if (band.kind === "unattributed") out.push(...boxMarks(p, i0 + di + from, j0 + dj, z0, to - from, layout.W, BOX_H, "hatch", ""));
  }
  if (c.stencil) {
    out.push({
      kind: "glyph",
      cls: "stencil",
      text: c.stencil,
      transform: faceMatrixG(p, i0 + di + layout.L * 0.3, j0 + dj + layout.W * 0.78, z0 + BOX_H),
      scale: Math.min(layout.W, layout.L) * 0.62,
    });
  }
  return out;
}

/** Hull: south side, stern (east) and deck with a pointed bow on the quay side. */
function hullMarks(p: SceneProjection, i0: number, j0: number, length: number, beam: number, barge: boolean): SceneMark[] {
  const i1 = i0 + length;
  const j1 = j0 + beam;
  const jm = j0 + beam / 2;
  const bow = barge ? 0 : Math.min(0.5, length * 0.3);
  const stem = barge ? "barge" : "hull";
  return [
    worldPolygon(p, `${stem}-s e`, [[i0 + bow, j1, KEEL_Z], [i1, j1, KEEL_Z], [i1, j1, DECK_Z], [i0 + bow, j1, DECK_Z]]),
    ...(bow > 0 ? [worldPolygon(p, `${stem}-s e`, [[i0, jm, DECK_Z + 0.08], [i0 + bow, j1, DECK_Z], [i0 + bow, j1, KEEL_Z]])] : []),
    worldPolygon(p, `${stem}-e e`, [[i1, j0, KEEL_Z], [i1, j1, KEEL_Z], [i1, j1, DECK_Z], [i1, j0, DECK_Z]]),
    worldPolygon(p, `${stem}-t e`, bow > 0
      ? [[i0, jm, DECK_Z + 0.08], [i0 + bow, j0, DECK_Z], [i1, j0, DECK_Z], [i1, j1, DECK_Z], [i0 + bow, j1, DECK_Z]]
      : [[i0, j0, DECK_Z], [i1, j0, DECK_Z], [i1, j1, DECK_Z], [i0, j1, DECK_Z]]),
  ];
}

/** Signal flag on a mast at (i, jm): band hue + pennant count; unrated = bare mast + NR plate. */
export function harborFlagMarks(p: SceneProjection, i: number, jm: number, z0: number, flag: HarborFlag, size = 1): SceneMark[] {
  const h = MAST_H * size;
  const top = z0 + h;
  const mast = project(p, i, jm, z0);
  const mastTop = project(p, i, jm, top);
  const out: SceneMark[] = [{ kind: "line", cls: "mast", x1: round1(mast[0]), y1: round1(mast[1]), x2: round1(mastTop[0]), y2: round1(mastTop[1]) }];
  const fw = 0.8 * size;
  const fh = 0.4 * size;
  if (flag.kind === "unrated") {
    out.push(worldPolygon(p, "nr-plate e", [[i + 0.04, jm, top - fh], [i + 0.04 + fw, jm, top - fh], [i + 0.04 + fw, jm, top], [i + 0.04, jm, top]]));
    out.push({ kind: "glyph", cls: "nr-text", text: "NR", transform: southMatrix(p, i + 0.04 + fw * 0.16, jm, top - fh * 0.78), scale: fh * 0.62 });
    return out;
  }
  const cls = `flag-${flag.band}`;
  // Robust flies a swallowtail (forked fly), so it reads apart from Healthy's plain flag + pennant by shape, not only by green.
  const fly: [number, number, number][] = flag.band === "robust"
    ? [[i + 0.04 + fw, jm, top - fh], [i + 0.04 + fw * 0.8, jm, top - fh / 2], [i + 0.04 + fw, jm, top]]
    : [[i + 0.04 + fw, jm, top - fh], [i + 0.04 + fw, jm, top]];
  out.push(worldPolygon(p, `${cls} e`, [[i + 0.04, jm, top - fh], ...fly, [i + 0.04, jm, top]]));
  if (flag.score != null) {
    out.push({ kind: "glyph", cls: "flag-text", text: String(flag.score), transform: southMatrix(p, i + 0.04 + fw * 0.14, jm, top - fh * 0.8), scale: fh * 0.66 });
  }
  const ph = 0.14 * size;
  for (let k = 0; k < flag.pennants; k++) {
    const z = top - fh - 0.04 * size - k * (ph + 0.04 * size);
    out.push(worldPolygon(p, `${cls} e`, [[i + 0.04, jm, z], [i + 0.04 + 0.42 * size, jm, z - ph / 2], [i + 0.04, jm, z - ph]]));
  }
  return out;
}

/** Text frame on a south-facing vertical plane: u → +i, v → −z. */
function southMatrix(p: SceneProjection, i: number, j: number, z: number): [number, number, number, number, number, number] {
  const o = project(p, i, j, z);
  return [round3(p.A[0]), round3(p.A[1]), round3(-p.C[0]), round3(-p.C[1]), round1(o[0]), round1(o[1])];
}

/** Wake chevrons astern: length linear in |%| up to the break, chevrons point downstream for growth. */
function wakeMarks(p: SceneProjection, layout: HarborLayout, i0: number, jm: number, half: number, wake: HarborWake): { marks: SceneMark[]; end: ScenePoint | null } {
  if (wake.kind !== "wake") return { marks: [], end: null };
  const length = wake.magnitude * layout.wakeMax;
  // Small moves draw in neutral ink; only |%| ≥ WAKE_HUE_PCT takes the growth/decline hue.
  const cls = `${wake.direction === "up" ? "wake-up" : "wake-down"}${Math.abs(wake.pct) >= WAKE_HUE_PCT ? " wake-hue" : ""}`;
  const step = 0.42;
  const marks: SceneMark[] = [];
  const n = Math.max(1, Math.round(length / step));
  for (let k = 0; k < n; k++) {
    const a = i0 + 0.25 + k * step;
    const tipOut = wake.direction === "up";
    const back = tipOut ? a : a + 0.26;
    const tip = tipOut ? a + 0.26 : a;
    const w = half * (1 - 0.35 * (k / n));
    marks.push({ kind: "polyline", cls, points: [project(p, back, jm - w, 0), project(p, tip, jm, 0), project(p, back, jm + w, 0)].map(([x, y]) => [round1(x), round1(y)] as ScenePoint) });
  }
  const endI = i0 + 0.25 + n * step;
  if (wake.broken) {
    for (const d of [0, 0.14]) {
      const a = project(p, endI + d, jm - half * 0.7, 0);
      const b = project(p, endI + d + 0.12, jm + half * 0.7, 0);
      marks.push({ kind: "line", cls: `wake-break ${cls}`, x1: round1(a[0]), y1: round1(a[1]), x2: round1(b[0]), y2: round1(b[1]) });
    }
  }
  return { marks, end: project(p, endI + (wake.broken ? 0.35 : 0.1), jm, 0) };
}

function berthGeometry(
  p: SceneProjection,
  layout: HarborLayout,
  vessel: HarborVessel,
  i0: number,
  j0: number,
  quaySide: boolean,
): HarborBerthGeometry {
  const isChain = vessel.kind === "ship" || vessel.kind === "craft";
  const beam = vessel.kind === "craft"
    ? layout.W + 2 * layout.beamPad
    : ACROSS(layout) * (layout.W + layout.gap) - layout.gap + 2 * layout.beamPad;
  const length = vessel.kind === "craft"
    ? layout.bowPad * 0.6 + Math.max(...vessel.containers.map((c) => c.drawLength), 0.06) * layout.L + layout.sternPad
    : hullLength(layout, vessel.containers);
  const jm = j0 + beam / 2;
  const barge = vessel.kind === "tail" || vessel.kind === "unattributed";
  const marks = hullMarks(p, i0, j0, length, beam, barge);
  const craftShift = vessel.kind === "craft" ? layout.bowPad * 0.6 - layout.bowPad : 0;
  const sorted = vessel.containers.slice().sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const sa = slotOffset(layout, a.position);
    const sb = slotOffset(layout, b.position);
    return sa.dj - sb.dj || sa.di - sb.di;
  });
  for (const c of sorted) marks.push(...containerMarks(p, layout, i0 + craftShift, j0, c));
  if (isChain && vessel.partialRows > 0) {
    // Hatched end cap on the stern: the hull is a lower bound.
    marks.push(...boxMarks(p, i0 + length - 0.16, j0, DECK_Z, 0.16, beam, 0.12, "partial"));
    marks.push(...boxMarks(p, i0 + length - 0.16, j0, DECK_Z, 0.16, beam, 0.12, "hatch", ""));
  }
  const maxTier = vessel.containers.reduce((m, c) => Math.max(m, c.tier), 0);
  const topZ = DECK_Z + (vessel.containers.length ? (maxTier + 1) * BOX_H : 0);

  let flag: SceneMark[] = [];
  if (isChain) {
    flag = vessel.kind === "craft"
      ? harborFlagMarks(p, i0 + 0.08, jm, DECK_Z, vessel.flag, 0.55)
      : harborFlagMarks(p, quaySide ? MAST_I : i0 - 0.45, jm, quaySide ? QUAY_Z : DECK_Z, vessel.flag);
  }
  const wake = vessel.kind === "ship" ? wakeMarks(p, layout, i0 + length, jm, beam * 0.42, vessel.wake) : { marks: [], end: null };

  const pts = [
    ...boxPoints(p, i0, j0, KEEL_Z, length, beam, topZ - KEEL_Z),
    ...flag.flatMap((m) => (m.kind === "polygon" ? m.points : m.kind === "line" ? [[m.x1, m.y1] as ScenePoint, [m.x2, m.y2] as ScenePoint] : [])),
  ];
  const ringPad = 0.18;
  const ring = [
    project(p, i0 - ringPad, j0 - ringPad, 0),
    project(p, i0 + length + ringPad, j0 - ringPad, 0),
    project(p, i0 + length + ringPad, j0 + beam + ringPad, 0),
    project(p, i0 - ringPad, j0 + beam + ringPad, 0),
  ].map(([x, y]) => [round1(x), round1(y)] as ScenePoint);
  // Wide: labels sit on the quay, west of the mast. Narrow: above the bow, in the water between rows.
  const labelPt = quaySide && p === HARBOR_PROJECTIONS.wide ? project(p, LABEL_I, jm, QUAY_Z) : project(p, i0 + (quaySide ? 0.7 : 0), j0, topZ);
  return {
    id: vessel.id,
    kind: vessel.kind,
    marks,
    flag,
    wake: wake.marks,
    ring,
    hit: hull(pts).map(([x, y]) => [round1(x), round1(y)] as ScenePoint),
    label: [round1(labelPt[0]), round1(labelPt[1])],
    tag: roundPt(project(p, i0 + length * 0.75, jm, topZ + 0.4)),
    beamTarget: roundPt(project(p, i0 + length / 2, jm, topZ)),
    wakeEnd: wake.end ? roundPt(wake.end) : null,
    footprint: { i0: round3(i0), i1: round3(i0 + length), j0: round3(j0), j1: round3(j0 + beam) },
    containerCount: vessel.containers.length,
  };
}

const roundPt = (pt: ScenePoint): ScenePoint => [round1(pt[0]), round1(pt[1])];

export function buildHarborGeometry(scene: HarborScene, preset: HarborPreset): HarborGeometry {
  const p = HARBOR_PROJECTIONS[preset];
  const layout = HARBOR_LAYOUTS[preset];
  const shipBeam = ACROSS(layout) * (layout.W + layout.gap) - layout.gap + 2 * layout.beamPad;
  const craftBeam = layout.W + 2 * layout.beamPad;
  const berths: HarborBerthGeometry[] = [];
  let j = 0.6;
  for (const ship of scene.ships) {
    berths.push(berthGeometry(p, layout, ship, 0, j, true));
    j += shipBeam + layout.rowGap;
  }
  let jettyLabel: ScenePoint | null = null;
  const jetties: { j: number; i1: number }[] = [];
  if (scene.craft.length > 0) {
    // Craft moor in rank order west → east on both sides of a jetty (north row, jetty, south row), wrapping into
    // further jetties when a row fills.
    const rowPitch = craftBeam + JETTY_GAP;
    const rows = Math.ceil(scene.craft.length / layout.craftPerRow);
    jettyLabel = roundPt(preset === "wide" ? project(p, LABEL_I, j + craftBeam + JETTY_GAP / 2, QUAY_Z) : project(p, 0.2, j, DECK_Z + BOX_H));
    scene.craft.forEach((craft, k) => {
      const row = Math.floor(k / layout.craftPerRow);
      const col = k % layout.craftPerRow;
      const j0 = j + Math.floor(row / 2) * (2 * rowPitch + layout.rowGap) + (row % 2) * rowPitch;
      berths.push(berthGeometry(p, layout, craft, 0.2 + col * layout.craftStride, j0, false));
    });
    for (let pair = 0; pair < Math.ceil(rows / 2); pair++) {
      const inPair = scene.craft.slice(pair * 2 * layout.craftPerRow, (pair + 1) * 2 * layout.craftPerRow).length;
      const cols = Math.min(layout.craftPerRow, inPair);
      jetties.push({ j: j + pair * (2 * rowPitch + layout.rowGap) + craftBeam + (JETTY_GAP - JETTY_W) / 2, i1: 0.2 + cols * layout.craftStride });
    }
    j += Math.ceil(rows / 2) * (2 * rowPitch + layout.rowGap) - (rows % 2 === 1 ? rowPitch : 0);
  }
  for (const barge of [scene.tail, scene.unattributed]) {
    if (!barge) continue;
    berths.push(berthGeometry(p, layout, barge, 0, j, true));
    j += shipBeam + layout.rowGap;
  }

  const wakeRoom = layout.wakeMax + 0.8;
  const maxJ = j - layout.rowGap + 0.5;
  const quayI0 = preset === "wide" ? -9 : -1.4;
  const ground: SceneMark[] = [];
  // Basin: the world hull of every berth row (plus wake room) and the breakwater, so the coast follows the berths.
  const lhJ = maxJ + 1.4;
  const southRows = berths.filter((b) => b.footprint.j0 > maxJ * 0.6).map((b) => b.footprint.i1 + 1);
  const lhI = Math.max(preset === "wide" ? 16 : 10, Math.max(0, ...southRows) + 2.5);
  const basinPts: ScenePoint[] = [[-0.3, -0.4], [-0.3, lhJ + 1.4], [lhI + 1.6, lhJ + 1.4], [lhI + 1.6, maxJ - 0.6]];
  for (const b of berths) {
    const end = b.footprint.i1 + (b.kind === "ship" ? wakeRoom : 1);
    basinPts.push([end, b.footprint.j0 - 0.4], [end, b.footprint.j1 + 0.4]);
  }
  basinPts.push([basinPts[basinPts.length - 2][0], -0.4]);
  const basin = hull(basinPts).map(([i, jj]) => [i, jj, 0]);
  ground.push(worldPolygon(p, "sea", basin));
  ground.push(...boxMarks(p, quayI0, -0.4, -0.4, -0.3 - quayI0, lhJ + 1.8, QUAY_Z + 0.4, "quay"));
  for (const b of berths) {
    if (b.kind !== "ship") continue;
    const jm = (b.footprint.j0 + b.footprint.j1) / 2;
    ground.push(...boxMarks(p, MAST_I - 0.1, jm - 0.1, QUAY_Z, 0.2, 0.2, 0.12, "bollard"));
  }
  for (const jetty of jetties) ground.push(...boxMarks(p, -0.3, jetty.j, -0.2, jetty.i1 + 0.3, JETTY_W, 0.55, "jetty"));
  // Breakwater from the quay toward the harbor mouth; the lighthouse stands on its seaward head.
  ground.push(...boxMarks(p, -0.3, lhJ - 0.45, -0.3, lhI + 0.3, 0.9, 0.62, "breakwater"));
  const lighthouse = lighthouseGeometry(p, lhI, lhJ);

  const extent = [
    ...ground.flatMap((m) => (m.kind === "polygon" ? m.points : [])),
    ...berths.flatMap((b) => [...b.hit, ...(b.wakeEnd ? [b.wakeEnd] : [])]),
    ...lighthouse.pts,
    project(p, LABEL_I, 0, QUAY_Z),
  ];
  const box = bbox(extent);
  const pad = preset === "wide" ? 12 : 8;
  const viewBox = {
    x0: round1(box.x0 - pad),
    y0: round1(box.y0 - pad - (preset === "narrow" ? 14 : 0)),
    x1: round1(box.x1 + pad),
    y1: round1(box.y1 + pad),
  };
  return { preset, viewBox, ground, berths, lighthouse, jettyLabel, containerFace: { L: layout.L, W: layout.W } };
}

export interface HarborCapacityIssue {
  kind: "face-floor" | "berth-overlap" | "height-budget" | "conservation";
  detail: string;
}

export interface HarborCapacityReport {
  ok: boolean | null;
  issues: HarborCapacityIssue[];
  /** Smallest container top-face edge in CSS px at the preset's reference frame width. */
  facePx: number;
  heightPx: number;
  /** Longest ship exceeds {@link MAX_BAYS_PER_TIER} bays: containers stack (stated in the legend). */
  tiered: boolean;
}

/** Projected screen length of a world vector. */
const screenLen = (p: SceneProjection, di: number, dj: number): number => {
  const a = project(p, di, dj, 0);
  const o = project(p, 0, 0, 0);
  return Math.hypot(a[0] - o[0], a[1] - o[1]);
};

/**
 * Legibility and layout floors for a scene at a preset: container top face ≥ the preset floor at the reference
 * frame width, no berth footprints overlap, the drawn height fits the budget, and supply is conserved. Growth past
 * {@link MAX_BAYS_PER_TIER} bays tiers instead of rescaling the unit and is reported, not failed.
 */
export function validateHarborCapacity(scene: HarborScene, preset: HarborPreset, geometry = buildHarborGeometry(scene, preset)): HarborCapacityReport {
  const p = HARBOR_PROJECTIONS[preset];
  const layout = HARBOR_LAYOUTS[preset];
  const issues: HarborCapacityIssue[] = [];
  const vbW = geometry.viewBox.x1 - geometry.viewBox.x0;
  const vbH = geometry.viewBox.y1 - geometry.viewBox.y0;
  const scale = layout.referenceFramePx / vbW;
  // Narrow: the across-beam edge is foreshortened by B, so its vertical extent is the binding size.
  const across = preset === "narrow" ? Math.abs(p.B[1]) * layout.W : screenLen(p, 0, layout.W);
  const minFace = Math.min(screenLen(p, layout.L, 0), across) * scale;
  if (minFace < layout.faceFloorPx) issues.push({ kind: "face-floor", detail: `container face ${minFace.toFixed(2)} px < ${layout.faceFloorPx} px` });
  const fps = geometry.berths.map((b) => ({ id: b.id, ...b.footprint }));
  for (let a = 0; a < fps.length; a++) {
    for (let b = a + 1; b < fps.length; b++) {
      const x = fps[a];
      const y = fps[b];
      if (x.i0 < y.i1 && y.i0 < x.i1 && x.j0 < y.j1 && y.j0 < x.j1) issues.push({ kind: "berth-overlap", detail: `${x.id} overlaps ${y.id}` });
    }
  }
  const heightPx = vbH * scale;
  if (heightPx > layout.heightBudgetPx) issues.push({ kind: "height-budget", detail: `scene ${heightPx.toFixed(0)} px > ${layout.heightBudgetPx} px` });
  if (scene.conservation.ok === false) issues.push({ kind: "conservation", detail: `drawn ${scene.conservation.drawnUsd} ≠ expected ${scene.conservation.expectedUsd}` });
  const tiered = scene.ships.some((s) => s.containers.length > MAX_BAYS_PER_TIER * CONTAINERS_PER_BAY);
  return { ok: issues.length > 0 ? false : scene.conservation.ok, issues, facePx: Math.round(minFace * 100) / 100, heightPx: Math.round(heightPx), tiered };
}
