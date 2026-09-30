/**
 * Stablecoin Cemetery plot map: the desktop scene (frame, SVG plan, HTML overlays) and its static layout.
 *
 * No client directive: imported only by the client hero (`plot-map-hero.tsx`), which renders it from the model it
 * builds in the browser and hands it the interaction state (`PlotSceneState`). The scene renders that state and
 * nothing else; events are delegated to the hero. Everything that depends on the frame width at rest (how far the
 * plan slides under the header, where the colossus chips hang, the beam's rest angle) is solved by
 * {@link desktopPlotLayout} for the viewport bands and handed to CSS as custom properties, so the rest pose needs
 * no measurement or script.
 *
 * Hooks: `data-plot-*` attributes on the frame, svg, world group, layers, rings, beam, signposts and chips; graves are
 * `<a id="grave-<id>" href="#<id>" role="button" aria-pressed>` with `data-grave-id`, `data-cause`, `data-year` and
 * one roving tab stop.
 */
import { useMemo, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { CAUSE_META, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { parseCemeteryDeathDate } from "@shared/lib/cemetery";
import { formatDeathDate, formatUtcDayLabel } from "@shared/lib/format";
import { PLOT_PROJECTIONS, desktopSiteMarks, graveGeometry, hull, plotDrawnObjects, type PlotPoint } from "@/lib/cemetery-plot-geometry";
import { skyTopLeftOf, type DesktopPlotMap, type PlotGrave, type PlotRect } from "@/lib/cemetery-plot-map";
import type { PlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import { formatCemeteryPeak } from "@/lib/cemetery-stats";
import { PlotFlowers, PlotGraveBody, PlotMarks, plotCauseClass, plotGraveClass, plotMedallionFace } from "./plot-map-shapes";
import styles from "./plot-map.module.css";

// ---------------------------------------------------------------------------
// Static layout (pure)
// ---------------------------------------------------------------------------

/**
 * Viewport bands the header sky, the chips and the beam's rest angle are solved for (min-widths match the CSS
 * module's band media queries). The frame is the page content box: viewport − 2 × page padding (px-4 / lg:px-5 /
 * xl:px-9), capped by the 120 rem main column.
 */
export const PLOT_VIEWPORT_BANDS = [
  { minWidth: 761, maxWidth: 899, pad: 16 },
  { minWidth: 900, maxWidth: 1023, pad: 16 },
  { minWidth: 1024, maxWidth: 1151, pad: 20 },
  { minWidth: 1152, maxWidth: 1279, pad: 20 },
  { minWidth: 1280, maxWidth: 1439, pad: 36 },
  { minWidth: 1440, maxWidth: 1679, pad: 36 },
  { minWidth: 1680, maxWidth: 1920, pad: 36 },
] as const;

/** CSS px of the HTML parts the layout keeps apart, measured at 1440 × 800 and rounded up (system-font tolerant). */
const EST = {
  /** Route head: h1 + two-line lead + links (117 px measured). */
  headH: 118,
  /** Route head width (min(360 px, 36 %)) + 24 px keep-out. */
  headKeepW: 384,
  /** One Beam block: label, 113, sub-line, plaque, at-rest line (318 × 126 measured). */
  figureW: 330,
  figureH: 128,
  /** Centre of the `113` digits below the block top (label 24 px + 55 % of the 39.2 px digits). */
  figureValueY: 46,
  /** The figure's right edge sits this far left of the lantern. */
  figureGap: 22,
  plateH: 24,
  chipH: 24,
  /** Below {@link COMPACT_BELOW}: 11 px chip text on 2/3 px padding. */
  chipHCompact: 21,
  chipCompactScale: 0.9,
  /** Classic scrollbars take this much from the viewport. */
  scrollbar: 17,
} as const;
/** The plan never slides further up than the route head (`--head-keep` in CSS). */
const HEAD_KEEP = EST.headH + 10;
/** Largest frame (1920 px main column − 2 × 36 px) and smallest desktop frame (761 px − 17 px scrollbar − 32 px). */
const FRAME_RANGE = [712, 1848] as const;
/** Viewport width below which plates and chips use the compact plate (the CSS module's `max-width: 1279px`). */
const COMPACT_BELOW = 1280;

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
  /** Chip top-left relative to the monument top (px). */
  dx: number;
  dy: number;
  /** Leader start relative to the monument top (px), its length and angle (deg). */
  lx: number;
  ly: number;
  ll: number;
  la: number;
  /** Obstacles still touched at the band's sampled widths (empty = collision-free). */
  conflicts: string[];
}

export interface PlotDesktopLayout {
  /** Lantern x as a share of the frame width, measured from the right (%). */
  lanternRight: number;
  /** Ceilings on the header overlap: the route head's sky (per band), signpost plates, monuments under the figure. */
  overlap: { sky: { a: number; b: number }[]; terms: OverlapTerm[] };
  chips: { id: string; left: number; top: number; bands: PlotBandChip[] }[];
  beam: { x: number; y: number; bands: { angle: number; scale: number }[] };
}

const pct = (v: number, total: number) => Math.round((v / total) * 1e5) / 1e3;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Plate width: 12 px padding × 2 + border, mono count, swatch and gaps, small-caps label (measured ≤ 7.6 px/char). */
function plateWidth(label: string, count: number): number {
  return 26 + String(count).length * 9.3 + 21 + label.length * 8;
}

/** Chip width: padding, swatch and gap, 12 px sans text (≤ 6.7 px/char) and the mono peak. */
function chipWidth(name: string, peak: string, month: string): number {
  return 39 + (name.length + month.length + 11) * 6.7 + peak.length * 7.4;
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

/** Frame widths sampled across a band (including a classic scrollbar at its narrow end). */
function bandWidths(band: (typeof PLOT_VIEWPORT_BANDS)[number]): number[] {
  const lo = band.minWidth - EST.scrollbar - 2 * band.pad;
  const hi = band.maxWidth - 2 * band.pad;
  return Array.from({ length: 9 }, (_, k) => lo + ((hi - lo) * k) / 8);
}

function termAt(t: OverlapTerm, W: number): number {
  return t.gates.every((g) => g.c * W + g.d < 0) ? t.a * W + t.b : Infinity;
}

/**
 * Solves the rest pose: how far the plan slides under the header (the route head's sky and the signpost plates
 * stay ≥ 14 px below the head, no monument reaches into the One Beam block), where the colossus chips hang in each
 * viewport band (clear of text, drawn volumes, the beam and each other at every sampled width), and the beam's rest
 * angle onto the `113` digits.
 */
export function desktopPlotLayout(map: DesktopPlotMap): PlotDesktopLayout {
  const [vbX, vbY, vbW] = map.viewBox;
  const [lanX, lanY] = map.beamOrigin;
  const fx = (x: number) => (x - vbX) / vbW;
  const fy = (y: number) => (y - vbY) / vbW;
  const lanternF = fx(lanX);
  const plates = map.signposts.map((s) => ({ cause: s.cause, top: s.top, w: plateWidth(s.label, s.count) }));
  // graves test against their hit hull; a colossus against the hull of its drawn faces (its box and extent points
  // over-approximate the roof and podium)
  const hullById = new Map<string, readonly PlotPoint[]>(map.graves.map((g) => [`grave:${g.id}`, g.screen.hit]));
  for (const g of map.graves) {
    if (g.lot !== 3) continue;
    const drawn = graveGeometry(PLOT_PROJECTIONS[map.projection], g).body.flatMap((m) => (m.kind === "polygon" ? m.points : []));
    hullById.set(`grave:${g.id}`, hull(drawn));
  }

  // the route head's sky: the drawn skyline left of the head's right edge, 14 px under the head (per band, lower bound)
  const skyAt = (W: number) => (skyTopLeftOf(map, vbX + (EST.headKeepW * vbW) / W) - vbY) * (W / vbW) - 14;
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
  // a plate whose left edge reaches under the route head stays 14 px below it
  for (const p of plates) {
    terms.push({ a: round6(fy(p.top[1])), b: -EST.plateH - 14, gates: [{ c: round6(fx(p.top[0])), d: 5 - p.w - EST.headKeepW }] });
  }
  // a monument whose box reaches under the One Beam block stays 6 px below the block
  const frameSamples = Array.from({ length: 24 }, (_, k) => FRAME_RANGE[0] + ((FRAME_RANGE[1] - FRAME_RANGE[0]) * k) / 23);
  for (const o of map.obstacles) {
    const t: OverlapTerm = {
      a: round6(fy(o.y0)),
      b: EST.headH + 10 - EST.figureH - 6,
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
      b: EST.headH + 10 - EST.figureH - 4 - 26 - EST.chipH,
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
      if (W >= band.minWidth - 2 * band.pad - EST.scrollbar) k = i;
    });
    return k;
  };
  const overlapAt = (W: number) => {
    const s = sky[bandOf(W)];
    return Math.min(HEAD_KEEP, Math.max(0, Math.min(s.a * W + s.b, ...terms.map((t) => termAt(t, W)))));
  };
  const frameTopAt = (W: number) => EST.headH + 10 - overlapAt(W);

  const chipOrder = [...map.colossi].sort((p, q) => p.top[1] - q.top[1]);
  const chips = chipOrder.map((c) => ({ id: c.id, left: pct(c.top[0] - vbX, vbW), top: pct(c.top[1] - vbY, map.viewBox[3]), bands: [] as PlotBandChip[] }));

  const beamBands = PLOT_VIEWPORT_BANDS.map((band) => {
    const W = bandWidths(band)[4];
    const s = W / vbW;
    const dx = -10 / s;
    const dy = (-frameTopAt(W) + EST.figureValueY - (lanY - vbY) * s) / s;
    return { angle: round2((Math.atan2(dy, dx) * 180) / Math.PI), scale: Math.round((Math.hypot(dx, dy) / 1000) * 1e4) / 1e4 };
  });

  type Placed = { ci: number; dx: number; dy: number };

  for (const band of PLOT_VIEWPORT_BANDS) {
    // below 1280 px chips (and plates) set on a flatter, 11 px plate (`.chip` in the CSS module)
    const compact = band.minWidth < COMPACT_BELOW;
    const h = compact ? EST.chipHCompact : EST.chipH;
    const chipGeo = chipOrder.map((c) => {
      const w = chipWidth(c.name, c.peak, c.month) * (compact ? EST.chipCompactScale : 1);
      const cands: [number, number][] = [];
      // above the monument top (leader 26 px first, then higher rows, then shorter leaders), then beside it
      for (const lead of [26, 31, 36, 41, 46, 51, 56, 66, 86, 106, 126, 146, 21, 16, 10]) {
        for (const dx of [-w / 2, -w + 24, -24, -w / 2 - 35, -w / 2 + 35, -w / 2 - 70, -w / 2 + 70, -w - 20, 20, -w - 40, -w - 60, -w - 100]) {
          cands.push([Math.round(dx), -lead - h]);
        }
      }
      for (const dy of [0, 30, -30, 60]) cands.push([26, Math.round(dy - h / 2)], [Math.round(-26 - w), Math.round(dy - h / 2)]);
      return { c, w, cands };
    });
    // everything a chip must avoid at each sampled width, in frame px (chips placed so far are added per call)
    const scenes = bandWidths(band).map((W) => {
      const frameTop = frameTopAt(W);
      const lanternX = lanternF * W;
      const figRight = lanternX - EST.figureGap;
      const text: (PlotRect & { key: string })[] = [
        { key: "head", left: 0, top: -frameTop, right: EST.headKeepW - 16, bottom: -frameTop + EST.headH + 8 },
        { key: "figure", left: figRight - EST.figureW, top: -frameTop, right: figRight, bottom: -frameTop + EST.figureH },
        ...plates.map((p) => {
          const right = fx(p.top[0]) * W + 5;
          const bottom = fy(p.top[1]) * W;
          return { key: `plate:${p.cause}`, left: right - p.w, top: bottom - EST.plateH, right, bottom };
        }),
      ];
      const volumes = map.obstacles.map((o) => {
        const shape = hullById.get(o.key);
        return { key: o.key, left: fx(o.x0) * W, top: fy(o.y0) * W, right: fx(o.x1) * W, bottom: fy(o.y1) * W, hull: shape?.map(([x, y]) => [fx(x) * W, fy(y) * W] as const) };
      });
      volumes.push({ key: "beam", left: lanternX - 14, top: -frameTop + EST.figureValueY, right: lanternX + 6, bottom: fy(lanY) * W, hull: undefined });
      return { W, frameTop, text, volumes };
    });
    /** Everything the chip at `cand` touches at any sampled width (`first`: stop at the first hit). */
    const conflictsOf = (ci: number, [dx, dy]: [number, number], placed: readonly Placed[], first = false) => {
      const { c, w } = chipGeo[ci];
      const out = new Set<string>();
      for (const { W, frameTop, text: base, volumes } of scenes) {
        const tx = fx(c.top[0]) * W;
        const ty = fy(c.top[1]) * W;
        const r = { left: tx + dx, top: ty + dy, right: tx + dx + w, bottom: ty + dy + h };
        if (r.left < 2 || r.right > W - 2 || r.top < -frameTop + 2) out.add("frame");
        const text = [
          ...base,
          ...placed.map((q) => {
            const g = chipGeo[q.ci];
            const qx = fx(g.c.top[0]) * W + q.dx;
            const qy = fy(g.c.top[1]) * W + q.dy;
            return { key: `chip:${g.c.id}`, left: qx, top: qy, right: qx + g.w, bottom: qy + h };
          }),
        ];
        for (const t of text) if (hits(r, t, 4)) out.add(t.key);
        for (const v of volumes) if (hits(r, v, 2) && (!v.hull || hitsHull(r, 2, v.hull))) out.add(v.key);
        const lx = Math.min(Math.max(tx, r.left + 10), r.right - 10);
        const ly = r.bottom <= ty ? r.bottom : r.top + h / 2;
        const lr = { left: Math.min(lx, tx), right: Math.max(lx, tx), top: Math.min(ly, ty), bottom: Math.max(ly, ty) };
        for (const t of text) if (hits(lr, t, 1)) out.add(`leader×${t.key}`);
        if (first && out.size) break;
      }
      return [...out];
    };
    // depth-first: the first candidate combination (in preference order) with no conflict for any chip
    const solve = (ci: number, placed: readonly Placed[]): Placed[] | null => {
      if (ci === chipGeo.length) return [];
      for (const [dx, dy] of chipGeo[ci].cands) {
        if (conflictsOf(ci, [dx, dy], placed, true).length) continue;
        const rest = solve(ci + 1, [...placed, { ci, dx, dy }]);
        if (rest) return [{ ci, dx, dy }, ...rest];
      }
      return null;
    };
    // no clean combination: place greedily, each chip at its least-conflicted candidate
    const greedy = () =>
      chipGeo.reduce<Placed[]>((placed, g, ci) => {
        const best = g.cands.reduce((a, b) => (conflictsOf(ci, b, placed).length < conflictsOf(ci, a, placed).length ? b : a));
        return [...placed, { ci, dx: best[0], dy: best[1] }];
      }, []);
    const solution = solve(0, []) ?? greedy();
    for (const p of solution) {
      const { w } = chipGeo[p.ci];
      const lx = Math.min(Math.max(0, p.dx + 10), p.dx + w - 10);
      const ly = p.dy + h <= 0 ? p.dy + h : p.dy + h / 2;
      chips[p.ci].bands.push({
        dx: Math.round(p.dx),
        dy: Math.round(p.dy),
        lx: Math.round(lx),
        ly: Math.round(ly),
        ll: round2(Math.hypot(lx, 2 + ly)),
        la: round2((Math.atan2(-2 - ly, -lx) * 180) / Math.PI),
        conflicts: conflictsOf(p.ci, [p.dx, p.dy], solution.filter((q) => q.ci < p.ci)),
      });
    }
  }

  return {
    lanternRight: round2(100 - pct(lanX - vbX, vbW)),
    overlap: { sky, terms },
    chips,
    beam: { x: lanX, y: lanY, bands: beamBands },
  };
}

/** A term as CSS: `a·100% + b` plus one 0-or-huge step per gate (W = the containing block's width). */
function termCss(t: OverlapTerm): string {
  const gates = t.gates.map((g) => ` + clamp(0px, (${g.c} * 100% + ${g.d}px) * 1000, 9999px)`).join("");
  return `calc(${t.a} * 100% + ${t.b}px${gates})`;
}

/** Custom properties the hero root carries for the stage (header overlap) and the figure. */
export function desktopLayoutStyle(layout: PlotDesktopLayout): CSSProperties {
  const vars: Record<string, string> = { "--lantern-right": `${layout.lanternRight}%`, "--head-keep": `${HEAD_KEEP}px` };
  layout.overlap.sky.forEach((o, k) => {
    vars[`--sky${k}`] = `calc(${o.a} * 100% + ${o.b}px)`;
  });
  vars["--ov-terms"] = layout.overlap.terms.map(termCss).join(", ");
  return vars as CSSProperties;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

function bandVars(prefix: readonly string[], rows: readonly (readonly (string | number)[])[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  rows.forEach((row, k) => row.forEach((v, q) => (out[`--${prefix[q]}${k}`] = v)));
  return out;
}

/** Section focus (signpost hover/focus, zoom) or year highlight (cypress, year stamp hover). */
export type PlotDim = { kind: "lane"; cause: CauseOfDeath } | { kind: "year"; year: number };

/** Interaction state the hero island hands the scene; the scene only renders it. */
export interface PlotSceneState {
  hotId: string | null;
  /** The hot grave holds keyboard focus (dashed ring). */
  hotFocus: boolean;
  pinnedId: string | null;
  /** The roving tab stop. */
  tabId: string;
  dim: PlotDim | null;
  /** The beam aims at a grave (else it rests on the `113`); its angle is written by the island. */
  beamAimed: boolean;
  /** Section zoom: the world group's CSS transform about user (0, 0). */
  zoom: { cause: CauseOfDeath; transform: string } | null;
  /** Session flowers by grave id. */
  flowers: Readonly<Record<string, number>>;
}

export interface PlotMapSceneProps {
  map: DesktopPlotMap;
  layout: PlotDesktopLayout;
  atlas: PlotLogoAtlas;
  state: PlotSceneState;
  /** Frame-top toolbar (the zoom row): first in DOM and tab order, before the plan. */
  toolbar?: ReactNode;
  /** Extra frame overlay content (the hover tag). */
  overlay?: ReactNode;
  /** Stage content after the frame (the inspector and its connector). */
  children?: ReactNode;
}

/**
 * The scene's drawn marks as React elements, built once per model: re-renders for hover, pin or zoom reuse these
 * element objects, so React skips the ~2,400 static nodes and only revisits the grave wrappers.
 */
function useSceneArt(map: DesktopPlotMap, atlas: PlotLogoAtlas) {
  return useMemo(() => {
    const site = desktopSiteMarks(map);
    const objects = plotDrawnObjects(map);
    return {
      back: <PlotMarks marks={site.back} />,
      ground: <PlotMarks marks={site.ground} />,
      beds: site.beds.map((bed) => ({ cause: bed.cause, marks: <PlotMarks marks={bed.marks} /> })),
      graveGround: objects
        .flatMap((o) => (o.kind === "grave" ? [o] : []))
        .sort((p, q) => (p.grave.id < q.grave.id ? -1 : 1))
        .map(({ grave, geometry }) => ({ grave, marks: <PlotMarks marks={geometry.ground} /> })),
      pools: <PlotMarks marks={site.pools} />,
      objects: objects.map((o) => {
        if (o.kind === "grave") {
          const g = o.grave;
          return {
            key: o.key,
            grave: g,
            art: (
              <>
                <polygon className={styles.hit} points={g.screen.hit.map((p) => p.join(",")).join(" ")} />
                <PlotGraveBody geometry={o.geometry} face={plotMedallionFace(atlas, g.id, g.symbol)} />
              </>
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
      }),
      front: <PlotMarks marks={site.front} />,
      trees: site.trees.map((t) => ({ year: t.year, marks: <PlotMarks marks={t.marks} /> })),
    };
  }, [map, atlas]);
}

/** Desktop plan (≥ 761 px): the framed SVG scene and its HTML overlays, rendering the island's interaction state. */
export function PlotMapScene({ map, layout, atlas, state, toolbar, overlay, children }: PlotMapSceneProps): ReactElement {
  const [vbX, vbY, vbW, vbH] = map.viewBox;
  const art = useSceneArt(map, atlas);
  const { dim, zoom } = state;
  const at = (x: number, y: number): CSSProperties => ({ left: `${pct(x - vbX, vbW)}%`, top: `${pct(y - vbY, vbH)}%` });
  const lit = (g: PlotGrave) => (dim === null ? undefined : (dim.kind === "lane" ? g.cause === dim.cause : g.year === dim.year) || undefined);
  const byId = (id: string | null) => (id === null ? null : (map.graves.find((g) => g.id === id) ?? null));
  const ring = (g: PlotGrave | null, focus = false) =>
    g ? { cx: g.screen.ring.cx, cy: g.screen.ring.cy, rx: g.screen.ring.rx, ry: g.screen.ring.ry, "data-on": "true", "data-focus": focus || undefined } : { rx: 0, ry: 0 };
  const beamStyle = {
    "--bx": `${layout.beam.x}px`,
    "--by": `${layout.beam.y}px`,
    ...bandVars(["ba", "bs"], layout.beam.bands.map((b) => [`${b.angle}deg`, b.scale])),
  } as CSSProperties;

  return (
    <div className={styles.stage} data-plot-stage>
      <div className={styles.frame} style={{ aspectRatio: `${vbW} / ${vbH}` }} data-plot-frame data-zoomed={zoom ? "true" : undefined}>
        {toolbar}
        <svg className={styles.map} viewBox={map.viewBox.join(" ")} role="group" aria-labelledby="cem-map-title" aria-describedby="cem-map-desc" data-plot-svg data-dim={dim?.kind}>
          <title id="cem-map-title">Stablecoin Cemetery plot map</title>
          <desc id="cem-map-desc">
            {`${map.counts.total} graves in five sections by cause of death, from Abandoned at the front to Regulatory under the sea wall. ` +
              `Year blocks run from the newest (${map.lastYear}) at the gate back to the oldest (${map.firstYear}) under the lighthouse. ` +
              "Stone shape is the cause of death; plinth steps count orders of magnitude of peak market cap; weathering is years since death. " +
              "The Autopsy Register below lists every grave."}
          </desc>
          <g className={styles.world} style={zoom ? { transform: zoom.transform } : undefined} data-plot-world>
            <g aria-hidden="true" data-plot-layer="back">
              {art.back}
            </g>
            <g aria-hidden="true" data-plot-layer="ground">
              {art.ground}
              {art.beds.map((bed) => (
                <g
                  key={bed.cause}
                  className={`${styles.bedG} ${plotCauseClass(bed.cause)}`}
                  data-cause={bed.cause}
                  data-lit={dim?.kind === "lane" && dim.cause === bed.cause ? "true" : undefined}
                >
                  {bed.marks}
                </g>
              ))}
              {art.graveGround.map(({ grave: g, marks }) => (
                <g key={g.id} className={plotGraveClass(styles.gm, g.cause, g.weather)} data-grave-id={g.id} data-cause={g.cause} data-year={g.year} data-lit={lit(g)}>
                  {marks}
                </g>
              ))}
              {art.pools}
              <ellipse className={styles.ring} {...ring(byId(state.pinnedId))} data-plot-ring="pin" />
              <ellipse className={styles.ring} {...ring(byId(state.hotId), state.hotFocus)} data-plot-ring="hot" />
            </g>
            <g data-plot-layer="objects">
              {art.objects.map(({ key, grave: g, art: body }) =>
                g ? (
                  <a
                    key={key}
                    className={plotGraveClass(styles.grave, g.cause, g.weather)}
                    id={`grave-${g.id}`}
                    href={`#${g.id}`}
                    role="button"
                    aria-pressed={state.pinnedId === g.id}
                    aria-label={plotGraveLabel(g)}
                    tabIndex={g.id === state.tabId ? 0 : -1}
                    data-grave-id={g.id}
                    data-cause={g.cause}
                    data-year={g.year}
                    data-hot={state.hotId === g.id ? "true" : undefined}
                    data-lit={lit(g)}
                  >
                    {body}
                    <PlotFlowers id={g.id} count={state.flowers[g.id] ?? 0} x={g.screen.medal.x} y={g.screen.medal.y} />
                  </a>
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
                  data-lit={dim?.kind === "year" && dim.year === t.year ? "true" : undefined}
                >
                  {t.marks}
                </g>
              ))}
            </g>
          </g>
          <g className={styles.beamG} style={beamStyle} aria-hidden="true" data-plot-beam data-beam={state.beamAimed ? "aim" : "rest"}>
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
          {map.blocks.map((b) => (
            <span
              key={b.key}
              className={styles.yearStamp}
              style={at(b.stamp[0], b.stamp[1])}
              aria-hidden="true"
              data-year={b.year}
              data-plot-year={b.empty ? undefined : b.year}
              data-empty={b.empty || undefined}
              data-lit={!b.empty && dim?.kind === "year" && dim.year === b.year ? "true" : undefined}
            >
              <span className={styles.mono}>{b.text}</span>
              {b.sub ? <small> {b.sub}</small> : null}
            </span>
          ))}
          {layout.chips.map((chip) => {
            const c = map.colossi.find((x) => x.id === chip.id);
            if (!c) return null;
            const vars = {
              "--ax": `${chip.left}%`,
              "--ay": `${chip.top}%`,
              ...bandVars(
                ["dx", "dy", "lx", "ly", "ll", "la"],
                chip.bands.map((b) => [`${b.dx}px`, `${b.dy}px`, `${b.lx}px`, `${b.ly}px`, `${b.ll}px`, `${b.la}deg`]),
              ),
            } as CSSProperties;
            return [
              <span key={`${c.id}-leader`} className={styles.leader} style={vars} aria-hidden="true" />,
              <span key={c.id} className={`${styles.chip} ${plotCauseClass(c.cause)}`} style={vars} aria-hidden="true" data-plot-chip={c.id}>
                <span className={styles.sw} />
                {c.name} · peak <span className={styles.mono}>{c.peak}</span> · {c.month}
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
