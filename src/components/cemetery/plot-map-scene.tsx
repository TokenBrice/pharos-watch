/**
 * Stablecoin Cemetery plot map: the desktop scene (frame, SVG plan, HTML overlays) and its static layout.
 *
 * Server-safe layout helpers are called by `CemeteryHero`; the client island `plot-map-hero.tsx` renders the scene
 * from its browser-built model and interaction state (`PlotSceneState`). The scene renders that state and
 * nothing else; events are delegated to the hero. Everything that depends on the frame width at rest (how far the
 * plan slides under the header, where the colossus chips hang, the beam's rest angle) is solved by
 * {@link desktopPlotLayout} for the viewport bands and handed to CSS as custom properties, so the rest pose needs
 * no measurement or script.
 *
 * Hooks: `data-plot-*` attributes on the frame, svg, world group, layers, rings, beam, signposts and chips; graves are
 * `<a id="grave-<id>" href="#<id>" role="button" aria-pressed>` with `data-grave-id`, `data-cause`, `data-year` and
 * one roving tab stop.
 */
import { useMemo, type Ref, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { CAUSE_META, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { parseCemeteryDeathDate } from "@shared/lib/cemetery";
import { formatDeathDate, formatUtcDayLabel } from "@shared/lib/format";
import { PLOT_PROJECTIONS, desktopSiteMarks, graveGeometry, hull, plotDrawnObjects, project, round1, type PlotMark, type PlotPoint } from "@/lib/cemetery-plot-geometry";
import { PLOT_LAYOUT, skyTopLeftOf, type DesktopPlotMap, type PlotGrave, type PlotRect } from "@/lib/cemetery-plot-map";
import type { PlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import { formatCemeteryPeak } from "@/lib/cemetery-stats";
import {
  PlotFlowers,
  PlotGraveBody,
  PlotMarks,
  graveHitPath,
  graveRingGeometry,
  headlandRockMarks,
  matchesPlotLens,
  plotCauseClass,
  plotGraveClass,
  plotMedallionFace,
  type PlotLens,
} from "./plot-map-shapes";
import styles from "./plot-map.module.css";

/**
 * Frame-width bands the header sky, the colossus chips, the year stamps and the beam's rest angle are solved for
 * (`frameMin` matches the CSS module's `@container (min-width: …)` breakpoints, so height-fitted stages at 1280×720,
 * 1440×900 and 1920×1080 pick the band matching their actual rendered frame width).
 */
export const PLOT_VIEWPORT_BANDS = [
  { minWidth: 761, maxWidth: 899, pad: 16, frameMin: 712, frameMax: 859 },
  { minWidth: 900, maxWidth: 1023, pad: 16, frameMin: 860, frameMax: 979 },
  { minWidth: 1024, maxWidth: 1151, pad: 20, frameMin: 980, frameMax: 1099 },
  { minWidth: 1152, maxWidth: 1279, pad: 20, frameMin: 1100, frameMax: 1199 },
  { minWidth: 1280, maxWidth: 1439, pad: 36, frameMin: 1200, frameMax: 1359 },
  { minWidth: 1440, maxWidth: 1679, pad: 36, frameMin: 1360, frameMax: 1599 },
  { minWidth: 1680, maxWidth: 1920, pad: 36, frameMin: 1600, frameMax: 1848 },
] as const;

/** CSS px of the HTML parts the layout keeps apart, measured at 1440 × 800 and rounded up (system-font tolerant). */
const EST = {
  /** Route head: h1 + two-line lead + whisper + links (~124 px measured). */
  headH: 124,
  /** Route head width (min(360 px, 36 %)) + 24 px keep-out. */
  headKeepW: 384,
  /** Two-column One Beam block: caption lines left of `Recorded deaths / 134` so the beam never crosses text (~456 × 66 measured). */
  figureW: 458,
  figureWCompact: 392,
  figureH: 68,
  /** Upper-centre of the `134` digits below the block top so the SSR/OG fade-out cone lands squarely inside the numerals. */
  figureValueY: 28,
  /** Half-width of the right-aligned `134` digits (used to aim the SSR rest beam squarely onto the numerals). */
  figureDigitsHalfW: 34,
  /** The figure's right edge sits this far left of the lantern. */
  figureGap: 22,
  plateH: 24,
  chipH: 24,
  /** Below {@link COMPACT_BELOW}: 11 px chip text on 2/3 px padding. */
  chipHCompact: 21,
  chipCompactScale: 0.91,
  /** Below {@link MICRO_CHIP_BELOW}: ticker + peak micro-chip (`BUSD · $23.5B`, ~17.6 px rendered). */
  chipHMicro: 18,
} as const;
/** The plan never slides further up than the route head (`--head-keep` in CSS). */
const HEAD_KEEP = EST.headH + 4;
/** Largest frame (1920 px main column − 2 × 36 px) and smallest desktop frame (761 px − 17 px scrollbar − 32 px). */
const FRAME_RANGE = [712, 1848] as const;
/** Frame width below which plates and full chips step down to the compact 11 px style. */
const COMPACT_BELOW = 1200;
/** Frame width below which colossus chips use the ticker micro-chip (`BUSD · $23.5B`). */
const MICRO_CHIP_BELOW = 980;
/** Frame width below which year stamps stack year over count (`2025` / `23`). */
const STAMP_STACK_BELOW = 1100;

/**
 * One ceiling on how far the plan may slide under the header, in frame px: `a·W + b` while every gate `c·W + d`
 * is negative (the constraint applies), no ceiling otherwise. CSS evaluates the same expression with W = 100 %.
 */
interface OverlapTerm {
  a: number;
  b: number;
  gates: { c: number; d: number }[];
}

export interface PlotBandChip {
  /** Chip horizontal anchor offset from monument top (px): left when tx="0%", center when "-50%", right when "-100%". */
  dx: number;
  dy: number;
  /** Horizontal CSS translateX anchor so leaders meet the rendered chip border regardless of font metrics. */
  tx: "0%" | "-50%" | "-100%";
  /** Leader start relative to the monument top (px), its length and angle (deg). */
  lx: number;
  ly: number;
  ll: number;
  la: number;
  /** Obstacles still touched at the band's sampled widths (empty = collision-free). */
  conflicts: string[];
}

export interface PlotBandStamp {
  /** Shift along the rotated rail axis (px) so adjacent stamps stay clear of each other. */
  shift: number;
  /** Neighbouring stamps still overlapping at any sampled width in this band (empty = collision-free). */
  conflicts: string[];
}

export interface PlotDesktopLayout {
  /** Lantern x as a share of the frame width, measured from the right (%). */
  lanternRight: number;
  /** ViewBox aspect ratio (`vbW / vbH`), used by CSS height-fit sizing. */
  aspect: number;
  /** Minimum desktop frame width (CSS px) keeping plain stones ≥ 15 px (`desktopFloorFrameWidth`). */
  floorWidth: number;
  /** Ceilings on the header overlap: the route head's sky (per band), signpost plates, monuments under the figure. */
  overlap: { sky: { a: number; b: number }[]; terms: OverlapTerm[] };
  chips: { id: string; left: number; top: number; bands: PlotBandChip[] }[];
  stamps: { key: string; bands: PlotBandStamp[] }[];
  /** Pairwise signpost-plate collisions per band (empty array = collision-free). */
  plateConflicts: string[][];
  beam: { x: number; y: number; bands: { angle: number; scale: number }[] };
}

const pct = (v: number, total: number) => Math.round((v / total) * 1e5) / 1e3;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Signpost plate dimensions matching the CSS container breakpoints (`< 860`, `< 980`, `< 1200`, `≥ 1200`). */
function plateMetrics(label: string, count: number, frameMin: number): { w: number; h: number } {
  const digits = String(count).length;
  if (frameMin < 860) return { w: 18 + digits * 7.2 + 13 + label.length * 6.2, h: 16 };
  if (frameMin < 980) return { w: 20 + digits * 7.8 + 15 + label.length * 6.8, h: 18 };
  if (frameMin < 1200) return { w: 24 + digits * 8.6 + 19 + label.length * 7.4, h: 21 };
  return { w: 26 + digits * 9.3 + 21 + label.length * 8, h: 24 };
}

/** Full chip width calibrated against live Chrome measurements (UST 241 px, BUSD 257 px at 12 px). */
function chipWidth(name: string, peak: string, month: string): number {
  return 34 + (name.length + month.length + 11) * 6.0 + peak.length * 6.8;
}

/** Ticker micro-chip width below 980 px frame width (`BUSD · $23.5B`: UST 91 px, BUSD 97 px at 10.5 px). */
function microChipWidth(symbol: string, peak: string): number {
  return 20 + (symbol.length + 3) * 5.8 + peak.length * 6.2;
}

function hits(a: PlotRect, b: PlotRect, m: number): boolean {
  return a.left < b.right + m && a.right > b.left - m && a.top < b.bottom + m && a.bottom > b.top - m;
}

/** Separating-axis test: does the rect (grown by `m`) overlap the convex hull? */
function hitsHull(r: PlotRect, m: number, hull: readonly (readonly [number, number])[]): boolean {
  const corners = [
    [r.left - m, r.top - m],
    [r.right + m, r.top - m],
    [r.right + m, r.bottom + m],
    [r.left - m, r.bottom + m],
  ];
  const axes: [number, number][] = [[1, 0], [0, 1]];
  hull.forEach(([x, y], k) => {
    const [nx, ny] = hull[(k + 1) % hull.length];
    if (nx !== x || ny !== y) axes.push([y - ny, nx - x]); // the model's hulls repeat their first point
  });
  return axes.every(([ax, ay]) => {
    const pr = corners.map(([x, y]) => x * ax + y * ay);
    const ph = hull.map(([x, y]) => x * ax + y * ay);
    return Math.max(...pr) > Math.min(...ph) && Math.max(...ph) > Math.min(...pr);
  });
}

/** Frame widths sampled across a band. */
function bandWidths(band: (typeof PLOT_VIEWPORT_BANDS)[number]): number[] {
  const lo = band.frameMin;
  const hi = band.frameMax;
  return Array.from({ length: 9 }, (_, k) => lo + ((hi - lo) * k) / 8);
}

function termAt(t: OverlapTerm, W: number): number {
  return t.gates.every((g) => g.c * W + g.d < 0) ? t.a * W + t.b : Infinity;
}

/**
 * Solves the rest pose: how far the plan slides under the header (the route head's sky and the signpost plates
 * stay ≥ 8 px below the head, no monument reaches into the One Beam block), where the colossus chips hang in each
 * frame-width band (clear of text, drawn volumes, the beam and each other at every sampled width), stamp shifts
 * along the slab rail, signpost plate clearance, and the beam's rest angle onto the `134` digits.
 */
export function desktopPlotLayout(map: DesktopPlotMap): PlotDesktopLayout {
  const [vbX, vbY, vbW, vbH] = map.viewBox;
  const [lanX, lanY] = map.beamOrigin;
  const fx = (x: number) => (x - vbX) / vbW;
  const fy = (y: number) => (y - vbY) / vbW;
  const lanternF = fx(lanX);
  const fullPlates = map.signposts.map((s) => ({ cause: s.cause, label: s.label, count: s.count, top: s.top, ...plateMetrics(s.label, s.count, COMPACT_BELOW) }));
  // graves test against their hit hull; a colossus against the hull of its drawn faces (its box and extent points
  // over-approximate the roof and podium)
  const hullById = new Map<string, readonly PlotPoint[]>(map.graves.map((g) => [`grave:${g.id}`, g.screen.hit]));
  const symbolById = new Map(map.graves.map((g) => [g.id, g.symbol]));
  for (const g of map.graves) {
    if (g.lot !== 3) continue;
    const drawn = graveGeometry(PLOT_PROJECTIONS[map.projection], g).body.flatMap((m) => (m.kind === "polygon" ? m.points : []));
    hullById.set(`grave:${g.id}`, hull(drawn));
  }

  // the route head's sky: the drawn skyline left of the head's right edge, 8 px under the head (per band, lower bound)
  const skyAt = (W: number) => (skyTopLeftOf(map, vbX + (EST.headKeepW * vbW) / W) - vbY) * (W / vbW) - 8;
  const sky = PLOT_VIEWPORT_BANDS.map((band) => {
    const ws = bandWidths(band);
    const lo = ws[0];
    const hi = ws[ws.length - 1];
    const a = (skyAt(hi) - skyAt(lo)) / (hi - lo);
    let b = skyAt(lo) - a * lo;
    for (const w of ws) b -= Math.max(0, a * w + b - skyAt(w));
    return { a: round6(a), b: Math.floor(b * 10) / 10 };
  });
  const terms: OverlapTerm[] = [];
  // a plate whose left edge reaches under the route head stays 8 px below it
  for (const p of fullPlates) {
    terms.push({ a: round6(fy(p.top[1])), b: -EST.plateH - 8, gates: [{ c: round6(fx(p.top[0])), d: 5 - p.w - EST.headKeepW }] });
  }
  // a monument whose box reaches under the One Beam block stays 6 px below the block
  const frameSamples = Array.from({ length: 24 }, (_, k) => FRAME_RANGE[0] + ((FRAME_RANGE[1] - FRAME_RANGE[0]) * k) / 23);
  for (const o of map.obstacles) {
    const t: OverlapTerm = {
      a: round6(fy(o.y0)),
      b: EST.headH - EST.figureH - 6,
      gates: [
        { c: round6(lanternF - fx(o.x1)), d: -(EST.figureGap + EST.figureW) },
        { c: round6(fx(o.x0) - lanternF), d: EST.figureGap },
      ],
    };
    if (frameSamples.some((W) => termAt(t, W) < HEAD_KEEP)) terms.push(t);
  }
  // a colossus under the One Beam block keeps room for its chip, centred 26 px above its top, below the block
  for (const c of map.colossi) {
    const half = chipWidth(c.name, c.peak, c.month) / 2;
    const t: OverlapTerm = {
      a: round6(fy(c.top[1])),
      b: EST.headH - EST.figureH - 4 - 26 - EST.chipH,
      gates: [
        { c: round6(lanternF - fx(c.top[0])), d: -(EST.figureGap + EST.figureW + half) },
        { c: round6(fx(c.top[0]) - lanternF), d: EST.figureGap - half },
      ],
    };
    if (frameSamples.some((W) => termAt(t, W) < HEAD_KEEP)) terms.push(t);
  }
  const bandOf = (W: number) => {
    let k = 0;
    PLOT_VIEWPORT_BANDS.forEach((band, i) => {
      if (W >= band.frameMin) k = i;
    });
    return k;
  };
  const overlapAt = (W: number) => {
    const s = sky[bandOf(W)];
    return Math.min(HEAD_KEEP, Math.max(0, Math.min(s.a * W + s.b, ...terms.map((t) => termAt(t, W)))));
  };
  const frameTopAt = (W: number) => EST.headH - overlapAt(W);

  const chipOrder = [...map.colossi].sort((p, q) => p.top[1] - q.top[1]);
  const chips = chipOrder.map((c) => ({ id: c.id, left: pct(c.top[0] - vbX, vbW), top: pct(c.top[1] - vbY, vbH), bands: [] as PlotBandChip[] }));
  const stamps = map.blocks.map((b) => ({ key: b.key, bands: [] as PlotBandStamp[] }));
  const plateConflicts: string[][] = [];

  const beamBands = PLOT_VIEWPORT_BANDS.map((band) => {
    const W = (band.frameMin + band.frameMax) / 2;
    const s = W / vbW;
    // Aim squarely onto the centre of the `134` digits (right-aligned inside `.figure`, `figureGap` left of lantern).
    const dx = -(EST.figureGap + EST.figureDigitsHalfW) / s;
    const dy = (-frameTopAt(W) + EST.figureValueY - (lanY - vbY) * s) / s;
    return { angle: round2((Math.atan2(dy, dx) * 180) / Math.PI), scale: Math.round((Math.hypot(dx, dy) / 1000) * 1e4) / 1e4 };
  });

  type Placed = { ci: number; left: number; dy: number };

  for (const band of PLOT_VIEWPORT_BANDS) {
    const ws = bandWidths(band);
    const micro = band.frameMin < MICRO_CHIP_BELOW;
    const compact = band.frameMin < COMPACT_BELOW;
    const h = micro ? EST.chipHMicro : compact ? EST.chipHCompact : EST.chipH;
    const bandPlates = map.signposts.map((s) => ({ cause: s.cause, top: s.top, ...plateMetrics(s.label, s.count, band.frameMin) }));

    // Check signpost-plate pairwise clearance across this band.
    const bandPlateHits = new Set<string>();
    for (const W of ws) {
      const rects = bandPlates.map((p) => {
        const right = Math.max(fx(p.top[0]) * W + 5, 2 + p.w);
        const bottom = fy(p.top[1]) * W;
        return { cause: p.cause, left: right - p.w, top: bottom - p.h, right, bottom };
      });
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          if (hits(rects[i], rects[j], 1)) bandPlateHits.add(`${rects[i].cause}×${rects[j].cause}`);
        }
      }
    }
    plateConflicts.push([...bandPlateHits]);

    // Solve year-stamp shifts along the slab rail so adjacent stamps never overlap at any width in this band.
    const stacked = band.frameMin < STAMP_STACK_BELOW;
    const stampSpan = (b: DesktopPlotMap["blocks"][number]): [number, number] => {
      if (b.empty) {
        const w = (b.text.length + (b.sub ? b.sub.length + 1 : 0)) * (stacked ? 5.6 : 6.2);
        return [-w - 4, -4];
      }
      if (stacked) {
        // Below 1100 px `.stampSub` is hidden so merged stamps stay two tidy lines (`2018–21` / `6`); empty-years
        // disclosure stays in hover tag and SVG `<desc>`.
        const half = (b.label.length * 6.4) / 2;
        return [-half, half];
      }
      const charW = band.frameMin < COMPACT_BELOW ? 6.2 : 6.9;
      const mainW = (b.label.length + 3 + String(b.count).length) * charW;
      const subW = b.sub ? b.sub.length * 5.1 : 0;
      const half = Math.max(mainW, subW) / 2;
      return [-half, half];
    };
    const stampShifts = map.blocks.map(() => 0);
    if (map.blocks.length > 1) {
      const Wlo = ws[0];
      const scaleLo = Wlo / vbW;
      const rad = ((map.blocks[0].stampAngle ?? 26.57) * Math.PI) / 180;
      const ux = Math.cos(rad);
      const uy = Math.sin(rad);
      const pos = map.blocks.map((b) => (b.stamp[0] * ux + b.stamp[1] * uy) * scaleLo);
      const spans = map.blocks.map(stampSpan);
      const gap = 4;
      for (let k = 1; k < map.blocks.length; k++) {
        const prevRight = pos[k - 1] + stampShifts[k - 1] + spans[k - 1][1];
        const currLeft = pos[k] + stampShifts[k] + spans[k][0];
        if (currLeft < prevRight + gap) {
          stampShifts[k] = Math.ceil(prevRight + gap - (pos[k] + spans[k][0]));
        }
      }
      for (let k = 0; k < map.blocks.length; k++) {
        const conflicts: string[] = [];
        for (const W of ws) {
          const s = W / vbW;
          const p = map.blocks.map((b, idx) => (b.stamp[0] * ux + b.stamp[1] * uy) * s + stampShifts[idx]);
          const cx = fx(map.blocks[k].stamp[0]) * W + stampShifts[k] * ux;
          const cy = fy(map.blocks[k].stamp[1]) * W + stampShifts[k] * uy;
          const stampDepth = 7 + (stacked ? 26 : map.blocks[k].sub ? 27 : 14);
          const botY = cy + Math.max(0, spans[k][1]) * uy + stampDepth * ux;
          const frameH = (vbH / vbW) * W;
          if (cx + spans[k][0] * ux < -4 || cx + spans[k][1] * ux > W + 4 || botY > frameH + 2) conflicts.push("frame");
          for (let j = 0; j < map.blocks.length; j++) {
            if (j === k) continue;
            const a0 = p[k] + spans[k][0];
            const a1 = p[k] + spans[k][1];
            const b0 = p[j] + spans[j][0];
            const b1 = p[j] + spans[j][1];
            if (a0 < b1 + 2 && a1 > b0 - 2) conflicts.push(map.blocks[j].key);
          }
        }
        stamps[k].bands.push({ shift: stampShifts[k], conflicts: [...new Set(conflicts)] });
      }
    } else if (map.blocks.length === 1) {
      stamps[0].bands.push({ shift: 0, conflicts: [] });
    }

    const chipGeo = chipOrder.map((c) => {
      const symbol = symbolById.get(c.id) ?? c.name;
      const w = micro ? microChipWidth(symbol, c.peak) : chipWidth(c.name, c.peak, c.month) * (compact ? EST.chipCompactScale : 1);
      const cands: [number, number][] = [];
      // 1. Directly above-centre (short vertical leader), then shifted modestly left over the open sky pocket between
      //    usdkg and UST's column (keeps BUSD steady across the 1280 px boundary without a 146 px jump), then beside
      //    left-of-gable, then right / higher leads as fallback.
      for (const lead of [22, 26, 31, 36, 42, 48, 54, 62, 72]) {
        cands.push([Math.round(-w / 2), -lead - h]);
        for (const rightEdge of [96, 84, 72, 56, 46, 36, 26, 16, 6, -6, -16, -26, -38, -50, -64]) cands.push([Math.round(rightEdge - w), -lead - h]);
      }
      for (const rightEdge of [-14, -22, -32]) {
        for (const dy of [-Math.round(h / 2) - 10, -Math.round(h / 2), -Math.round(h / 2) + 12, -Math.round(h / 2) + 24]) {
          cands.push([Math.round(rightEdge - w), dy]);
        }
      }
      for (const lead of [14, 18, 70, 86, 106, 126]) {
        for (const left of [-w / 2, 44 - w, 24 - w, 16 - w, -16 - w, -24, 16, -w / 2 - 40, -w / 2 + 40]) {
          cands.push([Math.round(left), -lead - h]);
        }
      }
      for (const dy of [0, 30, -30, 60]) cands.push([22, Math.round(dy - h / 2)], [Math.round(-22 - w), Math.round(dy - h / 2)]);
      return { c, w, cands };
    });
    // everything a chip must avoid at each sampled width, in frame px (chips placed so far are added per call)
    const scenes = ws.map((W) => {
      const frameTop = frameTopAt(W);
      const lanternX = lanternF * W;
      const figRight = lanternX - EST.figureGap;
      const figW = W < MICRO_CHIP_BELOW ? EST.figureWCompact : EST.figureW;
      const text: (PlotRect & { key: string })[] = [
        { key: "head", left: 0, top: -frameTop, right: EST.headKeepW - 16, bottom: -frameTop + EST.headH + 8 },
        { key: "figure", left: figRight - figW, top: -frameTop, right: figRight, bottom: -frameTop + EST.figureH },
        ...bandPlates.map((p) => {
          const right = Math.max(fx(p.top[0]) * W + 5, 2 + p.w);
          const bottom = fy(p.top[1]) * W;
          return { key: `plate:${p.cause}`, left: right - p.w, top: bottom - p.h, right, bottom };
        }),
      ];
      const volumes = map.obstacles.map((o) => {
        const shape = hullById.get(o.key);
        return { key: o.key, left: fx(o.x0) * W, top: fy(o.y0) * W, right: fx(o.x1) * W, bottom: fy(o.y1) * W, hull: shape?.map(([x, y]) => [fx(x) * W, fy(y) * W] as const) };
      });
      const beamTopX = figRight - EST.figureDigitsHalfW;
      const beamTopY = -frameTop + EST.figureValueY;
      const beamBotY = fy(lanY) * W;
      const beamHull: (readonly [number, number])[] = [
        [beamTopX - 18, beamTopY],
        [beamTopX + 18, beamTopY],
        [lanternX + 6, beamBotY],
        [lanternX - 6, beamBotY],
      ];
      volumes.push({
        key: "beam",
        left: Math.min(beamTopX - 18, lanternX - 6),
        top: Math.min(beamTopY, beamBotY),
        right: Math.max(beamTopX + 18, lanternX + 6),
        bottom: Math.max(beamTopY, beamBotY),
        hull: beamHull,
      });
      return { W, frameTop, text, volumes };
    });
    const anchorOf = (left: number, dy: number, w: number): { dx: number; tx: "0%" | "-50%" | "-100%"; lx: number; ly: number } => {
      const right = left + w;
      const above = dy + h <= -4;
      // Tuck the leader's chip end 2 px behind the z-index: 3 chip box so font/DPR rounding never leaves a hairline gap.
      if (0 >= left + 14 && 0 <= right - 14 && dy + h <= 0) {
        return { dx: Math.round(left + w / 2), tx: "-50%", lx: 0, ly: Math.round(dy + h) - 2 };
      }
      if (right <= 24) {
        const dx = Math.round(right);
        const lx = dx <= 4 ? dx - (above ? 0 : 2) : 0;
        const ly = above ? Math.round(dy + h) - 2 : Math.round(dy + h / 2);
        return { dx, tx: "-100%", lx, ly };
      }
      const dx = Math.round(left);
      const lx = dx >= -4 ? dx + (above ? 0 : 2) : 0;
      const ly = above ? Math.round(dy + h) - 2 : Math.round(dy + h / 2);
      return { dx, tx: "0%", lx, ly };
    };
    /** Everything the chip at `cand` touches at any sampled width (`first`: stop at the first hit). */
    const conflictsOf = (ci: number, [left, dy]: [number, number], placed: readonly Placed[], first = false) => {
      const { c, w } = chipGeo[ci];
      const { lx, ly } = anchorOf(left, dy, w);
      const out = new Set<string>();
      for (const { W, frameTop, text: base, volumes } of scenes) {
        const tx = fx(c.top[0]) * W;
        const ty = fy(c.top[1]) * W;
        const r = { left: tx + left, top: ty + dy, right: tx + left + w, bottom: ty + dy + h };
        if (r.left < 2 || r.right > W - 2 || r.top < -frameTop + 2) out.add("frame");
        const text = [
          ...base,
          ...placed.map((q) => {
            const g = chipGeo[q.ci];
            const qx = fx(g.c.top[0]) * W + q.left;
            const qy = fy(g.c.top[1]) * W + q.dy;
            return { key: `chip:${g.c.id}`, left: qx, top: qy, right: qx + g.w, bottom: qy + h };
          }),
        ];
        for (const t of text) if (hits(r, t, 4)) out.add(t.key);
        for (const v of volumes) if (hits(r, v, 2) && (!v.hull || hitsHull(r, 2, v.hull))) out.add(v.key);
        const lr = { left: Math.min(tx + lx, tx), right: Math.max(tx + lx, tx), top: Math.min(ty + ly, ty), bottom: Math.max(ty + ly, ty) };
        for (const t of text) if (hits(lr, t, 1)) out.add(`leader×${t.key}`);
        if (first && out.size) break;
      }
      return [...out];
    };
    const solve = (ci: number, placed: readonly Placed[]): Placed[] | null => {
      if (ci === chipGeo.length) return [];
      for (const [left, dy] of chipGeo[ci].cands) {
        if (conflictsOf(ci, [left, dy], placed, true).length) continue;
        const rest = solve(ci + 1, [...placed, { ci, left, dy }]);
        if (rest) return [{ ci, left, dy }, ...rest];
      }
      return null;
    };
    // no clean combination: place greedily, each chip at its least-conflicted candidate
    const greedy = () =>
      chipGeo.reduce<Placed[]>((placed, g, ci) => {
        const best = g.cands.reduce((a, b) => (conflictsOf(ci, b, placed).length < conflictsOf(ci, a, placed).length ? b : a));
        return [...placed, { ci, left: best[0], dy: best[1] }];
      }, []);
    const solution = solve(0, []) ?? greedy();
    for (const p of solution) {
      const { w } = chipGeo[p.ci];
      const { dx, tx, lx, ly } = anchorOf(p.left, p.dy, w);
      chips[p.ci].bands.push({
        dx,
        dy: Math.round(p.dy),
        tx,
        lx,
        ly,
        ll: round2(Math.hypot(lx, 2 + ly)),
        la: round2((Math.atan2(-2 - ly, -lx) * 180) / Math.PI),
        conflicts: conflictsOf(p.ci, [p.left, p.dy], solution.filter((q) => q.ci < p.ci)),
      });
    }
  }

  return {
    lanternRight: round2(100 - pct(lanX - vbX, vbW)),
    aspect: Math.round((vbW / vbH) * 1e4) / 1e4,
    floorWidth: map.floorWidth,
    overlap: { sky, terms },
    chips,
    stamps,
    plateConflicts,
    beam: { x: lanX, y: lanY, bands: beamBands },
  };
}

/** A term as CSS: `a·100% + b` plus one 0-or-huge step per gate (W = the containing block's width). */
function termCss(t: OverlapTerm): string {
  const gates = t.gates.map((g) => ` + clamp(0px, (${g.c} * 100% + ${g.d}px) * 1000, 9999px)`).join("");
  return `calc(${t.a} * 100% + ${t.b}px${gates})`;
}

/** Custom properties the hero root carries for the stage (header overlap, floor-clamped height-fit) and the figure. */
export function desktopLayoutStyle(layout: PlotDesktopLayout): CSSProperties {
  const vars: Record<string, string> = {
    "--lantern-right": `${layout.lanternRight}%`,
    "--lantern-right-ratio": String(round6(layout.lanternRight / 100)),
    "--floor-w": `${layout.floorWidth}px`,
    "--fit-chrome": `${PLOT_LAYOUT.fitChromePx}px`,
    "--head-keep": `${HEAD_KEEP}px`,
    "--plot-ar": String(layout.aspect),
  };
  layout.overlap.sky.forEach((o, k) => {
    vars[`--sky${k}`] = `calc(${o.a} * 100% + ${o.b}px)`;
  });
  vars["--ov-terms"] = layout.overlap.terms.map(termCss).join(", ");
  return vars as CSSProperties;
}

/** "May 2022" (month precision) or "Aug 27, 2026" (day precision), as the register prints it. */
export function plotDeathDateLabel(deathDate: string): string {
  const parsed = parseCemeteryDeathDate(deathDate);
  if (!parsed || parsed.month === null || parsed.day === null) return formatDeathDate(deathDate);
  return formatUtcDayLabel(new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)));
}

/** Full accessible name: "TerraUSD (UST), algorithmic failure, died May 2022, peak $18.8B". */
export function plotGraveLabel(g: PlotGrave): string {
  const peak = g.peak === null ? "not recorded" : formatCemeteryPeak(g.peak);
  const archive = g.archived ? ", Pharos archive page" : "";
  return `${g.name} (${g.symbol}), ${CAUSE_META[g.cause].label.toLowerCase()}, died ${plotDeathDateLabel(g.deathDate)}, peak ${peak}${archive}`;
}

function bandVars(prefix: readonly string[], rows: readonly (readonly (string | number)[])[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  rows.forEach((row, k) => row.forEach((v, q) => (out[`--${prefix[q]}${k}`] = v)));
  return out;
}

/**
 * Dimming mode on the scene:
 * - `lane`: signpost hover/focus or section zoom (one cause section)
 * - `year`: cypress or year-stamp hover (one calendar year or merged block span)
 * - `lens`: interactive legend toggle, optionally intersected with an active section zoom `cause` (E9)
 * - `spotlight`: hover/focus/pin spotlight on one or two graves (E3)
 */
export type PlotDim =
  | { kind: "lane"; cause: CauseOfDeath }
  | { kind: "year"; years: readonly number[] }
  | { kind: "lens"; lens: PlotLens; cause?: CauseOfDeath }
  | { kind: "spotlight"; ids: readonly string[] };

/** Interaction state the hero island hands the scene; the scene only renders it. */
export interface PlotSceneState {
  hotId: string | null;
  /** The hot grave holds keyboard focus (dashed ring). */
  hotFocus: boolean;
  pinnedId: string | null;
  /** The roving tab stop. */
  tabId: string;
  dim: PlotDim | null;
  /** The beam aims at a grave (else it rests on the `134`); its angle is written by the island. */
  beamAimed: boolean;
  /** True once interaction has moved the beam (enables smooth glide; initial rest snaps cleanly). */
  beamMoved?: boolean;
  /** Section zoom: the world group's CSS transform about user (0, 0). */
  zoom: { cause: CauseOfDeath; transform: string } | null;
  /** Session flowers by grave id. */
  flowers: Readonly<Record<string, number>>;
}

export interface PlotMapSceneHandle {
  frame(): HTMLElement | null;
  stage(): HTMLElement | null;
  beam(): SVGGElement | null;
  grave(id: string): Pick<SVGElement, "focus"> | null;
  signpost(cause: CauseOfDeath): HTMLElement | null;
  graveOf(target: EventTarget | null): { element: SVGAElement; id: string } | null;
  signpostOf(target: EventTarget | null): { element: HTMLElement; cause: CauseOfDeath } | null;
  yearOf(target: EventTarget | null): { element: Element; years: number[] } | null;
  coverableLabels(): { element: HTMLElement; chipId?: string; leaderId?: string }[];
  tagObstacles(root: HTMLElement): Element[];
  isBackground(target: EventTarget | null): boolean;
}

export function createPlotMapSceneHandle(
  stage: () => HTMLElement | null,
  graves: ReadonlyMap<string, Pick<SVGElement, "focus">>,
): PlotMapSceneHandle {
  const query = <T extends Element>(selector: string) => stage()?.querySelector<T>(selector) ?? null;
  const closest = <T extends Element>(target: EventTarget | null, selector: string) => target instanceof Element ? target.closest<T>(selector) : null;
  return {
    frame: () => query<HTMLElement>("[data-plot-frame]"),
    stage: () => stage(),
    beam: () => query<SVGGElement>("[data-plot-beam] > g"),
    grave: (id) => graves.get(id) ?? null,
    signpost: (cause) => query<HTMLElement>(`[data-plot-signpost="${cause}"]`),
    graveOf: (target) => {
      const element = closest<SVGAElement>(target, 'a[id^="grave-"]');
      return element?.dataset.graveId ? { element, id: element.dataset.graveId } : null;
    },
    signpostOf: (target) => {
      const element = closest<HTMLElement>(target, "[data-plot-signpost]");
      return element ? { element, cause: element.dataset.plotSignpost as CauseOfDeath } : null;
    },
    yearOf: (target) => {
      const element = closest(target, "[data-plot-year], [data-plot-years]");
      if (!element) return null;
      const multi = element.getAttribute("data-plot-years");
      if (multi) {
        const years = multi.split(",").map(Number).filter(Number.isFinite);
        return years.length ? { element, years } : null;
      }
      const year = Number(element.getAttribute("data-plot-year"));
      return Number.isFinite(year) ? { element, years: [year] } : null;
    },
    coverableLabels: () => [...(stage()?.querySelectorAll<HTMLElement>("[data-plot-signpost], [data-plot-chip], [data-plot-leader], [data-plot-overlay] > [data-year]") ?? [])].map((element) => ({ element, chipId: element.dataset.plotChip, leaderId: element.dataset.plotLeader })),
    tagObstacles: (root) => [...root.querySelectorAll("[data-plot-signpost], [data-plot-chip], [data-plot-leader], [data-plot-head], [data-plot-figure], [data-plot-zoombar], [data-plot-inspector]")],
    isBackground: (target) => !!closest(target, "[data-plot-svg]"),
  };
}

export interface PlotMapSceneProps {
  stageRef?: Ref<HTMLDivElement>;
  registerGrave?: (id: string, element: Pick<SVGElement, "focus"> | null) => void;
  map: DesktopPlotMap;
  layout: PlotDesktopLayout;
  atlas: PlotLogoAtlas;
  state: PlotSceneState;
  /**
   * True once hydrated on desktop: mounts the dedicated A4 `hits` polygon layer and E3 top `focus` layer.
   * False during SSR / static OG rendering so HTML stays slim while every grave still carries a real `#<id>` anchor.
   */
  interactive?: boolean;
  /** Frame-top toolbar (the zoom row): first in DOM and tab order, before the plan. */
  toolbar?: ReactNode;
  /** Extra frame overlay content (the hover tag). */
  overlay?: ReactNode;
  /** Stage content after the frame (the inspector and its connector). */
  children?: ReactNode;
}

const SE_LAWN_LANE_NAME: Readonly<Record<CauseOfDeath, string>> = {
  abandoned: "ABANDONED",
  "counterparty-failure": "COUNTERPARTY",
  "liquidity-drain": "LIQUIDITY",
  "algorithmic-failure": "ALGORITHMIC",
  regulatory: "REGULATORY",
};

/**
 * Quiet, data-driven treatment for an empty SE lawn pocket where the oldest block has no graves in the front lanes
 * (D11): continues a slender east-margin gravel walk and inscribes a lane-scoped isometric note directly on the turf
 * naming the specific front lanes that had no deaths before the next newer block — never claiming zero across all causes.
 */
function emptySeLawnArt(map: DesktopPlotMap): { walk: PlotMark[]; note: { lines: readonly [string, string]; transform: string } | null } {
  const blocks = map.blocks.filter((b) => !b.empty);
  if (blocks.length < 2) return { walk: [], note: null };
  const oldest = blocks[blocks.length - 1];
  const nextNewer = blocks[blocks.length - 2];
  const emptyFrontLanes: DesktopPlotMap["lanes"][number][] = [];
  for (const lane of map.lanes) {
    if (!lane.bed || lane.bed.i1 <= oldest.i0 + 1e-6) emptyFrontLanes.push(lane);
    else break;
  }
  if (emptyFrontLanes.length === 0) return { walk: [], note: null };
  const i0 = oldest.i0 + 0.04;
  const i1 = map.site.iOldest;
  const j0 = Math.min(...emptyFrontLanes.map((l) => l.j0));
  const j1 = Math.max(...emptyFrontLanes.map((l) => l.j1));
  if ((i1 - i0) * (j1 - j0) < 12) return { walk: [], note: null };
  const p = PLOT_PROJECTIONS[map.projection];
  const quad = (a0: number, a1: number, b0: number, b1: number, z: number, cls: string): PlotMark => ({
    kind: "polygon",
    cls,
    points: [project(p, a0, b0, z), project(p, a1, b0, z), project(p, a1, b1, z), project(p, a0, b1, z)].map(([x, y]) => [round1(x), round1(y)]),
  });
  const walk: PlotMark[] = [];
  const eastWalk0 = map.site.iOldest + 0.08;
  const eastWalk1 = map.site.iEast - 0.12;
  if (eastWalk1 - eastWalk0 >= 0.18) {
    walk.push(quad(eastWalk0, eastWalk1, j0, j1 + 0.12, 0.002, "gravel"));
  }
  walk.push(quad(i0 + 0.16, i1 - 0.12, j0 + 0.2, j1 - 0.2, 0.002, "lawn-frame"));
  const midI = (i0 + i1) / 2;
  const midJ = (j0 + j1) / 2;
  const [ox, oy] = project(p, midI, midJ, 0.003);
  // Right-handed isometric ground frame aligned along −j (reads left→right going up-right parallel to the cross-path).
  const u = [-p.B[0], -p.B[1]];
  const v = [p.A[0], p.A[1]];
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const transform = `matrix(${r3(u[0])} ${r3(u[1])} ${r3(v[0])} ${r3(v[1])} ${round1(ox)} ${round1(oy)}) scale(0.28)`;
  const names = emptyFrontLanes.map((l) => SE_LAWN_LANE_NAME[l.cause]);
  const lines: readonly [string, string] =
    names.length === 1
      ? [`NO ${names[0]} DEATHS`, `RECORDED BEFORE ${nextNewer.year}`]
      : names.length === 2
        ? [`NO ${names[0]} OR ${names[1]}`, `DEATHS RECORDED BEFORE ${nextNewer.year}`]
        : [`NO ${names.slice(0, -1).join(", ")} OR ${names[names.length - 1]}`, `DEATHS RECORDED BEFORE ${nextNewer.year}`];
  return {
    walk,
    note: { lines, transform },
  };
}

/**
 * The scene's drawn marks as React elements, built once per model: re-renders for hover, pin or zoom reuse these
 * element objects, so React skips the ~2,400 static nodes and only revisits the grave wrappers.
 */
function useSceneArt(map: DesktopPlotMap, atlas: PlotLogoAtlas, interactive: boolean) {
  return useMemo(() => {
    const p = PLOT_PROJECTIONS[map.projection];
    const site = desktopSiteMarks(map);
    const objects = plotDrawnObjects(map);
    const isSeaMark = (m: (typeof site.back)[number]) => "cls" in m && /\b(sea|swell)\b/.test(m.cls);
    const seaMarks = site.back.filter(isSeaMark);
    const backStructureMarks = site.back.filter((m) => !isSeaMark(m));
    const seLawn = emptySeLawnArt(map);
    const graveArtById = new Map<
      string,
      { grave: PlotGrave; body: ReactElement; ring: { cx: number; cy: number; rx: number; ry: number } }
    >();
    const hits: { grave: PlotGrave; path: string }[] = [];
    const renderedObjects = objects.map((o) => {
      if (o.kind === "grave") {
        const g = o.grave;
        const body = <PlotGraveBody geometry={o.geometry} face={plotMedallionFace(atlas, g.id, g.symbol)} />;
        if (interactive) {
          const ring = graveRingGeometry(g, o.geometry);
          graveArtById.set(g.id, { grave: g, body, ring });
          hits.push({ grave: g, path: graveHitPath(p, g, o.geometry) });
        }
        return { key: o.key, grave: g, art: body };
      }
      if (o.kind === "lighthouse") {
        const towerMarks = o.geometry.marks.filter((m) => !/^rock(-s)?\b/.test(m.cls));
        const marks = [...headlandRockMarks(p, map.lighthouse), ...towerMarks];
        return {
          key: o.key,
          grave: null,
          art: (
            <g key={o.key} aria-hidden="true" data-plot-object="lighthouse">
              <PlotMarks marks={marks} />
            </g>
          ),
        };
      }
      const art =
        o.kind === "lamp" ? (
          <g key={o.key} className={styles.lamp} aria-hidden="true" data-year={o.year}>
            <PlotMarks marks={o.geometry.marks} />
          </g>
        ) : (
          <g key={o.key} aria-hidden="true" data-plot-object={o.kind === "post" ? `post:${o.cause}` : o.kind}>
            <PlotMarks marks={o.geometry.marks} />
          </g>
        );
      return { key: o.key, grave: null, art };
    });
    return {
      sea: <PlotMarks marks={seaMarks} />,
      backStructure: <PlotMarks marks={backStructureMarks} />,
      ground: <PlotMarks marks={[...site.ground, ...seLawn.walk]} />,
      seLawnNote: seLawn.note,
      beds: site.beds.map((bed) => ({ cause: bed.cause, marks: <PlotMarks marks={bed.marks} /> })),
      graveGround: objects
        .flatMap((o) => (o.kind === "grave" ? [o] : []))
        .sort((a, b) => (a.grave.id < b.grave.id ? -1 : 1))
        .map(({ grave, geometry }) => ({ grave, marks: <PlotMarks marks={geometry.ground} /> })),
      pools: <PlotMarks marks={site.pools} />,
      objects: renderedObjects,
      hits,
      graveArtById,
      front: <PlotMarks marks={site.front} />,
      trees: site.trees.map((t) => ({ year: t.year, marks: <PlotMarks marks={t.marks} /> })),
    };
  }, [map, atlas, interactive]);
}

/** Desktop plan (≥ 761 px fine pointer, or ≥ 1025 px): the framed SVG scene and its HTML overlays. */
export function PlotMapScene({ map, layout, atlas, state, interactive = false, toolbar, overlay, children, stageRef, registerGrave }: PlotMapSceneProps): ReactElement {
  const [vbX, vbY, vbW, vbH] = map.viewBox;
  const art = useSceneArt(map, atlas, interactive);
  const { dim, zoom } = state;
  const at = (x: number, y: number): CSSProperties => ({ left: `${pct(x - vbX, vbW)}%`, top: `${pct(y - vbY, vbH)}%` });
  const lit = (g: PlotGrave): "true" | undefined => {
    if (dim === null) return undefined;
    if (dim.kind === "lane") return g.cause === dim.cause ? "true" : undefined;
    if (dim.kind === "year") return dim.years.includes(g.year) ? "true" : undefined;
    if (dim.kind === "spotlight") return dim.ids.includes(g.id) ? "true" : undefined;
    const causeMatch = dim.cause ? g.cause === dim.cause : true;
    return causeMatch && matchesPlotLens(g, dim.lens) ? "true" : undefined;
  };
  const bedLit = (cause: CauseOfDeath): "true" | undefined => {
    if (dim === null) return undefined;
    if (dim.kind === "lane") return dim.cause === cause ? "true" : undefined;
    if (dim.kind === "lens") {
      if (dim.cause) return dim.cause === cause ? "true" : undefined;
      if (dim.lens.kind === "cause") return dim.lens.cause === cause ? "true" : undefined;
    }
    return undefined;
  };
  // F17: never pop a ghosted non-member to full colour on pointer hover while zoomed or lensed.
  const filterDimmed = dim?.kind === "lane" || dim?.kind === "lens";
  const hotArt = state.hotId ? art.graveArtById.get(state.hotId) : null;
  const hotVisible = Boolean(
    hotArt && (!filterDimmed || state.hotFocus || lit(hotArt.grave) === "true" || state.pinnedId === state.hotId),
  );
  const effectiveHotId = hotVisible ? state.hotId : null;
  const focusEntries = [
    ...(state.pinnedId ? [{ id: state.pinnedId, kind: "pin" as const, focus: false }] : []),
    ...(effectiveHotId && effectiveHotId !== state.pinnedId ? [{ id: effectiveHotId, kind: "hot" as const, focus: state.hotFocus }] : []),
  ]
    .map((entry) => {
      const found = art.graveArtById.get(entry.id);
      return found ? { ...entry, ...found } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const ringProps = (id: string | null, focus = false) => {
    const entry = id ? art.graveArtById.get(id) : null;
    return entry
      ? { cx: entry.ring.cx, cy: entry.ring.cy, rx: entry.ring.rx, ry: entry.ring.ry, "data-on": "true", "data-focus": focus || undefined }
      : { rx: 0, ry: 0 };
  };
  const emptyDisclosure = map.blocks
    .filter((b) => b.sub)
    .map((b) => (b.empty ? `${b.label} ${b.sub}` : `${b.label} (${b.sub})`))
    .join("; ");
  const beamStyle = {
    "--bx": `${layout.beam.x}px`,
    "--by": `${layout.beam.y}px`,
    ...bandVars(["ba", "bs"], layout.beam.bands.map((b) => [`${b.angle}deg`, b.scale])),
  } as CSSProperties;

  return (
    <div ref={stageRef} className={styles.stage} data-plot-stage>
      <div className={styles.frame} style={{ aspectRatio: `${vbW} / ${vbH}` }} data-plot-frame data-zoomed={zoom ? "true" : undefined}>
        {toolbar}
        {/* the plan's keyboard contract, read when focus enters the group (a hidden description target) */}
        <p id="cem-map-keys" hidden>
          One grave takes Tab; the arrow keys walk the rest: left and right through a section by date of death, up and down to the nearest date in the
          next section, Home and End to a section&apos;s first and last. Enter or Space pins a grave&apos;s record; Escape closes it.
        </p>
        <svg
          className={styles.map}
          viewBox={map.viewBox.join(" ")}
          role="group"
          aria-label="Stablecoin Cemetery plot map"
          aria-describedby="cem-map-keys cem-map-desc"
          data-plot-svg
          data-dim={dim?.kind}
        >
          <desc id="cem-map-desc">
            {`${map.counts.total} graves in five sections by cause of death, from Abandoned at the front to Regulatory under the sea wall. ` +
              `Year blocks run from the newest (${map.lastYear}) at the gate back to the oldest (${map.firstYear}) under the lighthouse` +
              (emptyDisclosure ? ` (${emptyDisclosure})` : "") +
              ". Stone shape is the cause of death; plinth steps count orders of magnitude of peak market cap; weathering is years since death. " +
              "The Autopsy Register below lists every grave."}
          </desc>
          <defs>
            <clipPath id="cem-world-clip">
              <rect x={vbX} y={vbY} width={vbW} height={vbH} />
            </clipPath>
            <linearGradient id="cem-sea-fade-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#000" />
              <stop offset="8%" stopColor="#fff" />
              <stop offset="91%" stopColor="#fff" />
              <stop offset="100%" stopColor="#000" />
            </linearGradient>
            <linearGradient id="cem-sea-fade-top-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#000" />
              <stop offset="11%" stopColor="#fff" />
              <stop offset="100%" stopColor="#fff" />
            </linearGradient>
            <mask id="cem-sea-fade" maskUnits="userSpaceOnUse" x={vbX} y={vbY} width={vbW} height={vbH}>
              <rect x={vbX} y={vbY} width={vbW} height={vbH} fill="url(#cem-sea-fade-grad)" />
            </mask>
            <mask id="cem-sea-fade-top" maskUnits="userSpaceOnUse" x={vbX} y={vbY} width={vbW} height={vbH}>
              <rect x={vbX} y={vbY} width={vbW} height={vbH} fill="url(#cem-sea-fade-top-grad)" />
            </mask>
          </defs>
          <g clipPath="url(#cem-world-clip)">
            <g className={styles.world} style={zoom ? { transform: zoom.transform } : undefined} data-plot-world>
              <g aria-hidden="true" data-plot-layer="back">
                <g mask="url(#cem-sea-fade)">
                  <g mask="url(#cem-sea-fade-top)">{art.sea}</g>
                </g>
                {art.backStructure}
              </g>
              <g aria-hidden="true" data-plot-layer="ground">
                {art.ground}
                {art.seLawnNote ? (
                  <text className={styles.lawnNote} transform={art.seLawnNote.transform} fontSize={1} textAnchor="middle" data-plot-lawn-note>
                    <tspan x={0} dy="-0.35em">
                      {art.seLawnNote.lines[0]}
                    </tspan>
                    <tspan x={0} dy="1.35em">
                      {art.seLawnNote.lines[1]}
                    </tspan>
                  </text>
                ) : null}
                {art.beds.map((bed) => (
                  <g key={bed.cause} className={`${styles.bedG} ${plotCauseClass(bed.cause)}`} data-cause={bed.cause} data-lit={bedLit(bed.cause)}>
                    {bed.marks}
                  </g>
                ))}
                {art.graveGround.map(({ grave: g, marks }) => (
                  <g key={g.id} className={plotGraveClass(styles.gm, g.cause, g.weather)} data-lit={lit(g)}>
                    {marks}
                  </g>
                ))}
                {art.pools}
              </g>
              <g
                aria-hidden={interactive ? "true" : undefined}
                data-plot-layer="objects"
                className={interactive ? styles.objectsLayer : undefined}
              >
                {art.objects.map(({ key, grave: g, art: body }) =>
                  g ? (
                    interactive ? (
                      <g
                        key={key}
                        className={plotGraveClass(styles.grave, g.cause, g.weather)}
                        data-grave-art={g.id}
                        data-cause={g.cause}
                        data-year={g.year}
                        data-hot={effectiveHotId === g.id ? "true" : undefined}
                        data-pinned={state.pinnedId === g.id ? "true" : undefined}
                        data-lit={lit(g)}
                      >
                        {body}
                        <PlotFlowers id={g.id} count={state.flowers[g.id] ?? 0} x={g.screen.medal.x} y={g.screen.medal.y} />
                      </g>
                    ) : (
                      <a
                        key={key}
                        ref={(element) => registerGrave?.(g.id, element)}
                        id={`grave-${g.id}`}
                        href={`#${g.id}`}
                        role="button"
                        aria-pressed={state.pinnedId === g.id}
                        aria-label={plotGraveLabel(g)}
                        tabIndex={g.id === state.tabId ? 0 : -1}
                        className={plotGraveClass(styles.grave, g.cause, g.weather)}
                        data-grave-id={g.id}
                        data-cause={g.cause}
                        data-year={g.year}
                        data-lit={lit(g)}
                      >
                        {body}
                      </a>
                    )
                  ) : (
                    body
                  ),
                )}
              </g>
              <g aria-hidden="true" data-plot-layer="front">
                {art.front}
                {art.trees.map((t) => (
                  <g
                    key={t.year}
                    className={styles.tree}
                    data-year={t.year}
                    data-plot-year={t.year}
                    data-lit={dim?.kind === "year" && dim.years.includes(t.year) ? "true" : undefined}
                  >
                    {t.marks}
                  </g>
                ))}
              </g>
              {/* A4 + E3: once hydrated on desktop, mount the dedicated hit hulls (zero pointer theft) and top spotlight layer */}
              {interactive ? (
                <>
                  <g data-plot-layer="hits">
                    {art.hits.map(({ grave: g, path }) => (
                      <a
                        key={g.id}
                        ref={(element) => registerGrave?.(g.id, element)}
                        className={styles.graveHit}
                        id={`grave-${g.id}`}
                        href={`#${g.id}`}
                        role="button"
                        aria-pressed={state.pinnedId === g.id}
                        aria-label={plotGraveLabel(g)}
                        tabIndex={g.id === state.tabId ? 0 : -1}
                        data-grave-id={g.id}
                        data-cause={g.cause}
                        data-year={g.year}
                        data-lit={lit(g)}
                      >
                        <path className={styles.hit} d={path} />
                      </a>
                    ))}
                  </g>
                  <g aria-hidden="true" data-plot-layer="focus" className={styles.focusLayer}>
                    <ellipse className={styles.ring} {...ringProps(state.pinnedId)} data-plot-ring="pin" />
                    <ellipse className={styles.ring} {...ringProps(effectiveHotId, state.hotFocus)} data-plot-ring="hot" />
                    {focusEntries.map(({ grave: g, body, kind, focus }) => (
                      <g
                        key={`${kind}-${g.id}`}
                        className={plotGraveClass(styles.grave, g.cause, g.weather)}
                        data-focus-copy={g.id}
                        data-hot="true"
                        data-pinned={kind === "pin" ? "true" : undefined}
                        data-focus={focus ? "true" : undefined}
                        data-lit="true"
                      >
                        {body}
                        <PlotFlowers id={g.id} count={state.flowers[g.id] ?? 0} x={g.screen.medal.x} y={g.screen.medal.y} />
                      </g>
                    ))}
                  </g>
                </>
              ) : null}
            </g>
          </g>
          <g
            className={styles.beamG}
            style={beamStyle}
            aria-hidden="true"
            data-plot-beam
            data-beam={state.beamAimed ? "aim" : "rest"}
            data-beam-moved={state.beamMoved ? "true" : undefined}
          >
            <g className={styles.beamRot}>
              <polygon className={styles.beam} points="0,0 1000,-38 1000,38" />
              <ellipse className={styles.beamEnd} cx="1000" cy="0" rx="40" ry="40" />
            </g>
          </g>
        </svg>

        <div className={styles.overlay} data-plot-overlay>
          {map.signposts.map((s) => (
            <button
              key={s.cause}
              type="button"
              className={`${styles.signpost} ${plotCauseClass(s.cause)}`}
              style={{ ...at(s.top[0], s.top[1]), "--post-x": pct(s.top[0] - vbX, vbW) } as CSSProperties}
              aria-label={`${s.label}: ${s.count} graves. Zoom to this section.`}
              data-plot-signpost={s.cause}
            >
              <span className={styles.n}>{s.count}</span>
              <span className={styles.sw} />
              {s.label}
            </button>
          ))}
          {map.blocks.map((b) => {
            const merged = !b.empty && b.years.length > 1;
            const stampLayout = layout.stamps.find((s) => s.key === b.key);
            const stampStyle = {
              ...at(b.stamp[0], b.stamp[1]),
              "--stamp-angle": `${b.stampAngle}deg`,
              ...(stampLayout ? bandVars(["sx"], stampLayout.bands.map((sb) => [`${sb.shift}px`])) : {}),
            } as CSSProperties;
            return (
              <span
                key={b.key}
                className={styles.yearStamp}
                style={stampStyle}
                aria-hidden="true"
                data-year={b.year}
                data-plot-year={b.empty || merged ? undefined : b.year}
                data-plot-years={merged ? b.years.join(",") : undefined}
                data-empty={b.empty || undefined}
                data-merged={merged || undefined}
                data-lit={!b.empty && dim?.kind === "year" && dim.years.some((y) => b.years.includes(y)) ? "true" : undefined}
              >
                {b.empty ? (
                  <>
                    <span className={styles.mono}>{b.text}</span>
                    {b.sub ? <small>{` ${b.sub}`}</small> : null}
                  </>
                ) : (
                  <>
                    <span className={styles.stampMain}>
                      <span className={styles.mono}>{b.label}</span>
                      <span className={styles.stampSep}> · </span>
                      <span className={`${styles.mono} ${styles.stampCount}`}>{b.count}</span>
                    </span>
                    {b.sub ? <small className={styles.stampSub}>{b.sub}</small> : null}
                  </>
                )}
              </span>
            );
          })}
          {layout.chips.map((chip) => {
            const c = map.colossi.find((x) => x.id === chip.id);
            if (!c) return null;
            const symbol = map.graves.find((g) => g.id === c.id)?.symbol ?? c.name;
            const vars = {
              "--ax": `${chip.left}%`,
              "--ay": `${chip.top}%`,
              ...bandVars(
                ["dx", "dy", "tx", "lx", "ly", "ll", "la"],
                chip.bands.map((b) => [`${b.dx}px`, `${b.dy}px`, b.tx, `${b.lx}px`, `${b.ly}px`, `${b.ll}px`, `${b.la}deg`]),
              ),
            } as CSSProperties;
            return [
              <span
                key={`${c.id}-leader`}
                className={styles.leader}
                style={vars}
                aria-hidden="true"
                data-plot-leader={c.id}
                data-pinned={state.pinnedId === c.id ? "true" : undefined}
              />,
              <span
                key={c.id}
                className={`${styles.chip} ${plotCauseClass(c.cause)}`}
                style={vars}
                aria-hidden="true"
                data-plot-chip={c.id}
                data-hot={effectiveHotId === c.id ? "true" : undefined}
                data-pinned={state.pinnedId === c.id ? "true" : undefined}
              >
                <span className={styles.sw} />
                <span className={styles.chipFull}>
                  {c.name} · peak <span className={styles.mono}>{c.peak}</span> · {c.month}
                </span>
                <span className={styles.chipMicro}>
                  <span className={styles.mono}>{symbol}</span> · <span className={styles.mono}>{c.peak}</span>
                </span>
              </span>,
            ];
          })}
          {overlay}
        </div>
      </div>
      {children}
    </div>
  );
}
