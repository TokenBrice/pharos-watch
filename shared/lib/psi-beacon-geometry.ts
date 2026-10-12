import type { PsiConditionBand } from "../types/stability";
import type { PsiBeaconModel, PsiBeaconPenaltyKey, PsiBeaconSpan } from "./psi-beacon";
import { formatPath, formatPoints, project, round1, type ScenePoint, type SceneProjection } from "./scene/projection";
import { LIGHTHOUSE_LANTERN_Z, LIGHTHOUSE_TOP_Z } from "./scene/objects/lighthouse";

/**
 * Screen geometry for the hero PSI beacon: a ruler on the sea plane, on one
 * fixed bearing from the lighthouse. Every ruler value maps linearly to a world
 * radius and is projected identically, so lengths compare along that ray only.
 * The kit lighthouse stands at world (0, 0); the projection is the scene kit's camera.
 */

type Point = ScenePoint;
type PsiBeaconProjection = SceneProjection;

/** World radius of ruler 0 (clear of the lighthouse rock) and of ruler 100. */
const R0 = 1.45;
const R100 = 12.95;
/** Bearing from +i toward −j (the ruler falls gently toward the viewer), and the range-arc sector either side. */
const BEARING = (12 * Math.PI) / 180;
const ARC_HALF = (15 * Math.PI) / 180;
/**
 * The beam is a cone of light with a fixed spread: its half-width at a radius depends only on that radius, never on
 * the score, so lit length stays the one data channel (a longer beam is only ever the same cone, cut later).
 * BEAM_W0 is the half-width at ruler 0.
 */
const BEAM_W0 = 0.22;
const BEAM_SPREAD = Math.tan((3.2 * Math.PI) / 180);
/** The dark-mode glow: the same cone, wider; also constant. */
const HALO_SCALE = 1.75;
/** Label rows, measured from the cone edge. */
const LABEL_ROW_1 = 0.8;
const LABEL_ROW_2 = 1.5;

const projectPoint = project;
const formatPolygon = formatPoints;

export function psiBeaconRadius(value: number): number {
  return R0 + ((R100 - R0) * Math.min(100, Math.max(0, value))) / 100;
}

export interface PsiBeaconLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PsiBeaconLabel {
  x: number;
  y: number;
  text: string;
}

export interface PsiBeaconLayout {
  /** Lighthouse world origin (i, j); the kit tower is drawn there. */
  origin: { i: number; j: number };
  lantern: Point;
  /** Ruler axis (0 → 100) as a hairline under the beam; also the beam gradient's fixed vector. */
  axis: PsiBeaconLine;
  rings: { value: number; d: string; label: PsiBeaconLabel }[];
  zones: { band: PsiConditionBand; label: PsiBeaconLabel }[];
  /** Lit cone from 0 to the score, its constant-geometry glow, and the crisp terminating edge at the score. */
  beam: { points: string; halo: string; tip: PsiBeaconLine } | null;
  gain: string | null;
  drag: string | null;
  fog: { key: PsiBeaconPenaltyKey; points: string; title: string; lowerBound: PsiBeaconLabel | null }[];
  unknown: { points: string; label: PsiBeaconLabel } | null;
  avgTick: { line: PsiBeaconLine; label: PsiBeaconLabel } | null;
  clampTick: { line: PsiBeaconLine; label: PsiBeaconLabel } | null;
  /** Zero-score marker: a real 0 is labelled, not left as an empty ruler. */
  zeroLabel: PsiBeaconLabel | null;
}

export function psiBeaconViewBox(p: PsiBeaconProjection): { x: number; y: number; width: number; height: number } {
  // Fixed frame: the tower top, the 100 ring's ends and two label rows below the ruler.
  const pad = 12;
  const pts: Point[] = [
    projectPoint(p, 0, 0, LIGHTHOUSE_TOP_Z + 0.35),
    projectPoint(p, -1.6, 0, 0),
    projectPoint(p, 0, 1.6, 0),
    arcPoint(p, R100, BEARING + ARC_HALF),
    arcPoint(p, R100, BEARING - ARC_HALF),
    offset(p, R100, coneHalfWidth(R100) + LABEL_ROW_2 + 0.6),
  ];
  const xs = pts.map((pt) => pt[0]);
  const ys = pts.map((pt) => pt[1]);
  const x = Math.floor(Math.min(...xs) - pad);
  const y = Math.floor(Math.min(...ys) - pad);
  return { x, y, width: Math.ceil(Math.max(...xs) + pad + 14) - x, height: Math.ceil(Math.max(...ys) + pad) - y };
}

function arcPoint(p: PsiBeaconProjection, r: number, theta: number): Point {
  return projectPoint(p, r * Math.cos(theta), -r * Math.sin(theta), 0);
}

/** Point at ruler radius r, displaced `side` world units across the bearing (+ = toward the viewer). */
function offset(p: PsiBeaconProjection, r: number, side: number): Point {
  const ci = Math.cos(BEARING);
  const cj = -Math.sin(BEARING);
  // Normal on the sea plane, pointing toward the viewer (screen down-left).
  const ni = Math.sin(BEARING);
  const nj = Math.cos(BEARING);
  return projectPoint(p, r * ci + side * ni, r * cj + side * nj, 0);
}

type Width = (r: number) => number;

function coneHalfWidth(r: number): number {
  return BEAM_W0 + (r - R0) * BEAM_SPREAD;
}

/** The cone between two ruler values (a trapezoid on the sea plane). */
function strip(p: PsiBeaconProjection, from: number, to: number, w: Width): string {
  const r0 = psiBeaconRadius(from);
  const r1 = psiBeaconRadius(to);
  return formatPolygon([offset(p, r0, -w(r0)), offset(p, r1, -w(r1)), offset(p, r1, w(r1)), offset(p, r0, w(r0))]);
}

function cross(p: PsiBeaconProjection, value: number, halfLength: number): PsiBeaconLine {
  const r = psiBeaconRadius(value);
  const [x1, y1] = offset(p, r, -halfLength);
  const [x2, y2] = offset(p, r, halfLength);
  return { x1: round1(x1), y1: round1(y1), x2: round1(x2), y2: round1(y2) };
}

function label(pt: Point, text: string): PsiBeaconLabel {
  return { x: round1(pt[0]), y: round1(pt[1]), text };
}

function drawn(span: PsiBeaconSpan): [number, number] {
  return [span.drawFrom, span.drawTo];
}

const FOG_TITLES: Record<PsiBeaconPenaltyKey, string> = {
  severity: "Severity",
  breadth: "Breadth",
  stressBreadth: "Stress breadth",
};

export function layoutPsiBeacon(model: PsiBeaconModel, p: PsiBeaconProjection): PsiBeaconLayout {
  const lantern = projectPoint(p, 0, 0, LIGHTHOUSE_LANTERN_Z);
  const ringArc = (r: number): string => {
    const pts: Point[] = [];
    for (let k = 0; k <= 12; k++) pts.push(arcPoint(p, r, BEARING - ARC_HALF + (2 * ARC_HALF * k) / 12));
    return formatPath(pts);
  };
  const rings = model.rings.map(({ value }) => {
    const r = psiBeaconRadius(value);
    // Numerals sit just past the far (upper) end of each arc, clear of the beam.
    return { value, d: ringArc(r), label: label(arcPoint(p, r, BEARING + ARC_HALF + 0.05), String(value)) };
  });
  // Band names alternate between two rows below the ruler so narrow zones never collide.
  const w: Width = coneHalfWidth;
  const side = (value: number, row: number): Point => {
    const r = psiBeaconRadius(value);
    return offset(p, r, Math.sign(row) * (w(r) + Math.abs(row)));
  };
  const zones = model.zones.map((zone, index) => ({
    band: zone.band,
    label: label(side((zone.from + zone.to) / 2, index % 2 === 0 ? LABEL_ROW_2 + 0.15 : LABEL_ROW_1 + 0.15), zone.band),
  }));

  const axisFrom = offset(p, psiBeaconRadius(0), 0);
  const axisTo = offset(p, psiBeaconRadius(100), 0);
  const base = {
    origin: { i: 0, j: 0 },
    lantern,
    axis: { x1: round1(axisFrom[0]), y1: round1(axisFrom[1]), x2: round1(axisTo[0]), y2: round1(axisTo[1]) },
    rings,
    zones,
  };

  if (!model.beam) {
    return {
      ...base,
      beam: null,
      gain: null,
      drag: null,
      fog: [],
      unknown: null,
      avgTick: null,
      clampTick: null,
      zeroLabel: null,
    };
  }

  const fog = model.fog.map((bank) => {
    const [from, to] = drawn(bank);
    const value = bank.belowFloor ? "<0.3" : bank.value.toFixed(2);
    const lowerBound = bank.lowerBound
      ? label(side((bank.from + bank.to) / 2, -LABEL_ROW_2), `≥ · ${bank.lowerBound.unpricedCount ?? "some"} unpriced`)
      : null;
    return { key: bank.key, points: strip(p, from, to, w), title: `${FOG_TITLES[bank.key]}: ${value} points of light lost`, lowerBound };
  });
  const unknown = model.unknown
    ? {
        points: strip(p, model.unknown.drawFrom, model.unknown.drawTo, w),
        label: label(side((model.unknown.from + model.unknown.to) / 2, -LABEL_ROW_2), "?"),
      }
    : null;
  const tipR = psiBeaconRadius(model.beam.to);
  const tip = cross(p, model.beam.to, w(tipR));
  const halo: Width = (r) => w(r) * HALO_SCALE;
  return {
    ...base,
    beam: { points: strip(p, 0, model.beam.to, w), halo: strip(p, 0, model.beam.to, halo), tip },
    gain: model.gain ? strip(p, ...drawn(model.gain), w) : null,
    drag: model.drag ? strip(p, ...drawn(model.drag), w) : null,
    fog,
    unknown,
    avgTick: model.avgTick
      ? {
          line: cross(p, model.avgTick.value, w(psiBeaconRadius(model.avgTick.value)) + 0.4),
          label: label(side(model.avgTick.value, -LABEL_ROW_1), `24h avg ${model.avgTick.value.toFixed(1)}`),
        }
      : null,
    clampTick: model.clamp
      ? {
          line: cross(p, model.clamp.at, w(psiBeaconRadius(model.clamp.at)) + 0.4),
          label: label(side(model.clamp.at, -LABEL_ROW_2), `clamped at ${model.clamp.at}`),
        }
      : null,
    zeroLabel: model.beam.to === 0 ? label(side(0, -LABEL_ROW_1), "0") : null,
  };
}
